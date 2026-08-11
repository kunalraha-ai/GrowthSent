[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^i-[0-9a-f]+$")]
    [string]$InstanceId,
    [string]$Region = "us-east-1",
    [string]$VerifierPath = "tools/verify_common_crawl_s3_objects.py",
    [switch]$ValidateSerializationOnly
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

# This script has exactly one permitted remote action: install this verifier
# override and use it to HEAD/GET the known completed smoke-test triplet.
$Bucket = "growthsent-data-552648196041-us-east-1-an"
$Prefix = "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000"
$Crawl = "CC-MAIN-2026-30"
$Source = "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz"
$RemoteVerifier = "/opt/growthsent/overrides/verify_common_crawl_s3_objects.py"

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)] [string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-AwsCli {
    param([Parameter(Mandatory)] [string[]]$AwsArguments)

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "aws"
    $startInfo.Arguments = (($AwsArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "unable to start AWS CLI" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

function New-SsmParametersPayload {
    param([Parameter(Mandatory)] [string[]]$Commands)

    # A JSON file prevents PowerShell, cmd.exe, and the AWS CLI from
    # reinterpreting shell metacharacters or base64 payloads.
    $json = [ordered]@{ commands = [string[]]@($Commands) } | ConvertTo-Json -Compress -Depth 3
    $temporary = New-TemporaryFile
    [System.IO.File]::WriteAllText($temporary.FullName, $json, $utf8)
    return [PSCustomObject]@{
        Path = $temporary.FullName
        Uri = "file://$($temporary.FullName.Replace('\', '/'))"
        Json = $json
    }
}

function Invoke-SsmShellCommand {
    param(
        [Parameter(Mandatory)] [string]$Comment,
        [Parameter(Mandatory)] [string[]]$Commands
    )

    $payload = New-SsmParametersPayload -Commands $Commands
    try {
        $submitted = Invoke-AwsCli -AwsArguments @(
            "--no-cli-pager", "ssm", "send-command", "--region", $Region,
            "--document-name", "AWS-RunShellScript", "--instance-ids", $InstanceId,
            "--comment", $Comment, "--parameters", $payload.Uri, "--output", "json"
        )
        if ($submitted.ExitCode -ne 0) {
            throw "aws ssm send-command failed with exit code $($submitted.ExitCode). AWS CLI stderr:`n$($submitted.Stderr)"
        }
        try {
            $response = $submitted.Stdout | ConvertFrom-Json
        } catch {
            throw "aws ssm send-command returned invalid JSON. AWS CLI stderr:`n$($submitted.Stderr)`nAWS CLI stdout:`n$($submitted.Stdout)"
        }
        $commandId = [string]$response.Command.CommandId
        if ([string]::IsNullOrWhiteSpace($commandId)) {
            throw "aws ssm send-command returned no CommandId. AWS CLI stderr:`n$($submitted.Stderr)"
        }
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    do {
        Start-Sleep -Seconds 3
        $invocation = Invoke-AwsCli -AwsArguments @(
            "--no-cli-pager", "ssm", "get-command-invocation", "--region", $Region,
            "--command-id", $commandId, "--instance-id", $InstanceId, "--output", "json"
        )
        if ($invocation.ExitCode -ne 0) {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "aws ssm get-command-invocation failed with exit code $($invocation.ExitCode). AWS CLI stderr:`n$($invocation.Stderr)"
            }
            continue
        }
        $result = $invocation.Stdout | ConvertFrom-Json
    } while ($result.Status -in @("Pending", "Delayed", "InProgress"))

    if ($result.Status -ne "Success") {
        throw "SSM command failed: $Comment ($commandId)"
    }
    return $result
}

function Test-SsmParametersPayload {
    $commands = @(
        "set -euo pipefail",
        ('printf ''%s'' ''quotes=" pipes=| ampersand=& progress=' + [char]0x2713 + ''''),
        "printf '%s' 'QmFzZTY0Lys9' | base64 --decode"
    )
    $payload = New-SsmParametersPayload -Commands $commands
    try {
        $raw = [System.IO.File]::ReadAllText($payload.Path, $utf8)
        $parsed = $raw | ConvertFrom-Json
        if ($payload.Json -notmatch '^\{"commands":\[') {
            throw "SSM parameters JSON does not have a quoted commands key"
        }
        for ($index = 0; $index -lt $commands.Count; $index++) {
            if ($parsed.commands[$index] -cne $commands[$index]) {
                throw "SSM command serialization changed at index $index"
            }
        }
        Write-Output "SSM verifier-only parameters JSON validation passed: $($payload.Json)"
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }
}

if ($ValidateSerializationOnly) {
    Test-SsmParametersPayload
    exit 0
}

$resolvedVerifier = (Resolve-Path -LiteralPath $VerifierPath).Path
$verifierBytes = [System.IO.File]::ReadAllBytes($resolvedVerifier)
$verifierBase64 = [Convert]::ToBase64String($verifierBytes)
$verifierSha256 = (Get-FileHash -LiteralPath $resolvedVerifier -Algorithm SHA256).Hash.ToLowerInvariant()

$commands = @(
    "set -euo pipefail",
    "install -d -m 0755 /opt/growthsent/overrides",
    "printf '%s' '$verifierBase64' | base64 --decode > '$RemoteVerifier'",
    "echo '$verifierSha256  $RemoteVerifier' | sha256sum --check --status -",
    "chmod 0644 '$RemoteVerifier'",
    "/opt/growthsent/venv/bin/python -m py_compile '$RemoteVerifier'",
    "/opt/growthsent/venv/bin/python '$RemoteVerifier' --bucket '$Bucket' --prefix '$Prefix' --crawl '$Crawl' --source '$Source'"
)

$result = Invoke-SsmShellCommand -Comment "Verify existing GrowthSent Common Crawl smoke S3 triplet" -Commands $commands
if ([string]::IsNullOrWhiteSpace($result.StandardOutputContent)) {
    throw "SSM verifier command succeeded but returned no verifier output"
}
Write-Output $result.StandardOutputContent
Write-Output "Existing smoke-test S3 triplet verified; no ingestion was run."
