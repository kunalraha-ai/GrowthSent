[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern("^i-[0-9a-f]+$")]
    [string]$InstanceId,
    [string]$Region = "us-east-1",
    [string]$BundlePath = "artifacts/common-crawl-production-v1-deployment/growthsent-common-crawl-production-v1.tar.gz",
    [switch]$ValidateSerializationOnly
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$Bucket = "growthsent-data-552648196041-us-east-1-an"
$Prefix = "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000"
$Crawl = "CC-MAIN-2026-30"
$Source = "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz"
$SourceHash = "a129b99c34135f0dd380a3ac3c29fc331ee4f996c9d2765bfe8bd328706cea8e"
$Part = "a129b99c34135f0d"
$ExpectedBundleSha256 = "4c7e2024efb593d688a927308db26e575d0ecd9d8b84ebf2cf4a000cfdb52b80"

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
    # The UTF-8 environment is set at script scope above and inherited by this
    # child process. Avoid ProcessStartInfo.EnvironmentVariables here because
    # Windows PowerShell can emit a spurious null-array error for that indexer.
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "unable to start AWS CLI"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdoutText = $stdoutTask.GetAwaiter().GetResult()
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutText
        Stderr = $stderrText
    }
}

function New-SsmParametersPayload {
    param([Parameter(Mandatory)] [string[]]$Commands)

    # Writing JSON directly to a file keeps PowerShell, AWS CLI, and the shell
    # from reinterpreting quotes, newlines, pipes, or base64 punctuation.
    $json = [ordered]@{ commands = [string[]]@($Commands) } | ConvertTo-Json -Compress -Depth 3
    $temporary = New-TemporaryFile
    [System.IO.File]::WriteAllText(
        $temporary.FullName, $json, (New-Object System.Text.UTF8Encoding($false))
    )
    return [PSCustomObject]@{
        Path = $temporary.FullName
        Uri = "file://$($temporary.FullName.Replace('\', '/'))"
        Json = $json
    }
}

function Test-SsmParametersPayload {
    $commands = @(
        "set -euo pipefail",
        ('printf ''%s'' ''quotes=" pipes=| ampersand=& progress=' + [char]0x2713 + ''' >> /tmp/example'),
        "printf '%s' 'QmFzZTY0Lys9' >> /tmp/archive.b64"
    )
    $payload = New-SsmParametersPayload -Commands $commands
    try {
        $bytes = [System.IO.File]::ReadAllBytes($payload.Path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            throw "SSM parameters payload unexpectedly has a UTF-8 byte-order mark"
        }
        $rawJson = $utf8.GetString($bytes)
        $parsed = $rawJson | ConvertFrom-Json
        if ($null -eq $parsed.commands -or @($parsed.commands).Count -ne $commands.Count) {
            throw "serialized SSM commands are missing or have the wrong count"
        }
        for ($index = 0; $index -lt $commands.Count; $index++) {
            if ($parsed.commands[$index] -cne $commands[$index]) {
                throw "serialized SSM command changed at index $index"
            }
        }
        if ($payload.Json -notmatch '^\{"commands":\[') {
            throw "SSM parameters JSON does not have the expected quoted commands key"
        }
        if ($payload.Uri -notmatch '^file://[A-Za-z]:/') {
            throw "SSM parameters payload is not a Windows-compatible file URI: $($payload.Uri)"
        }
        if ($env:PYTHONUTF8 -ne "1" -or $env:PYTHONIOENCODING -ne "utf-8") {
            throw "AWS CLI UTF-8 environment variables are not set"
        }
        $awsVersion = Invoke-AwsCli -AwsArguments @("--version")
        if ($awsVersion.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($awsVersion.Stdout + $awsVersion.Stderr)) {
            throw "AWS CLI UTF-8 subprocess validation failed: $($awsVersion.Stderr)"
        }
        Write-Output "SSM UTF-8 parameters JSON validation passed: $($payload.Json)"
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-RunShellScript {
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
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    do {
        Start-Sleep -Seconds 10
        try {
            $invocation = Invoke-AwsCli -AwsArguments @(
                "--no-cli-pager", "ssm", "get-command-invocation", "--region", $Region,
                "--command-id", $commandId, "--instance-id", $InstanceId, "--output", "json"
            )
            if ($invocation.ExitCode -ne 0) {
                throw "aws ssm get-command-invocation failed with exit code $($invocation.ExitCode). AWS CLI stderr:`n$($invocation.Stderr)"
            }
            $result = $invocation.Stdout | ConvertFrom-Json
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            continue
        }
    } while ($result.Status -in @("Pending", "Delayed", "InProgress"))
    Write-Host ($result | ConvertTo-Json -Depth 8)
    if ($result.Status -ne "Success") {
        throw "SSM command failed: $Comment ($commandId)"
    }
    return $result
}

if ($ValidateSerializationOnly) {
    Test-SsmParametersPayload
    exit 0
}
if ([string]::IsNullOrWhiteSpace($InstanceId)) {
    throw "-InstanceId is required unless -ValidateSerializationOnly is supplied"
}

$releasePath = "/opt/growthsent/releases/$ExpectedBundleSha256"
$installProbeTemplate = @'
if test -f '{0}/BUNDLE-MANIFEST.json' && test -f '{0}/manifests/smoke-1.paths' && test -x /opt/growthsent/venv/bin/python; then
  if /opt/growthsent/venv/bin/python -c 'import boto3, botocore, jmespath, pyarrow, s3transfer; assert boto3.__version__ == "1.43.67"; assert botocore.__version__ == "1.43.67"; assert jmespath.__version__ == "1.1.0"; assert pyarrow.__version__ == "19.0.1"; assert s3transfer.__version__ == "0.19.2"'; then
    echo GROWTHSENT_CC_V1_INSTALL_READY
  else
    echo GROWTHSENT_CC_V1_INSTALL_INCOMPLETE
  fi
else
  echo GROWTHSENT_CC_V1_INSTALL_INCOMPLETE
fi
'@
$installProbeCommand = $installProbeTemplate -f $releasePath
$probeResult = Invoke-RunShellScript -Comment "Check GrowthSent Common Crawl production-v1 installation" -Commands @($installProbeCommand)
$isInstalled = $probeResult.StandardOutputContent -match "GROWTHSENT_CC_V1_INSTALL_READY"

if ($isInstalled) {
    Write-Host "Bundle $ExpectedBundleSha256 is already installed and dependency-verified at $releasePath; skipping install."
} else {
    $resolvedBundle = (Resolve-Path -LiteralPath $BundlePath).Path
    $archiveSha256 = (Get-FileHash -LiteralPath $resolvedBundle -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveSha256 -cne $ExpectedBundleSha256) {
        throw "bundle SHA-256 mismatch: expected $ExpectedBundleSha256, got $archiveSha256"
    }
    $archiveBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($resolvedBundle))

    # Upload is transported through the SSM control channel, not S3, so the
    # instance role remains restricted to the production data prefix.
    $installCommands = @(
        "set -euo pipefail",
        "install -d -m 0755 /opt/growthsent/releases",
        "rm -f /tmp/growthsent-common-crawl-production-v1.tar.gz /tmp/growthsent-common-crawl-production-v1.tar.gz.b64"
    )
    foreach ($chunk in [regex]::Matches($archiveBase64, ".{1,6000}")) {
        $installCommands += "printf '%s' '$($chunk.Value)' >> /tmp/growthsent-common-crawl-production-v1.tar.gz.b64"
    }
    $installCommands += @(
        "base64 --decode /tmp/growthsent-common-crawl-production-v1.tar.gz.b64 > /tmp/growthsent-common-crawl-production-v1.tar.gz",
        "echo '$archiveSha256  /tmp/growthsent-common-crawl-production-v1.tar.gz' | sha256sum --check --status -",
        "install -d -m 0755 '$releasePath'",
        "tar -xzf /tmp/growthsent-common-crawl-production-v1.tar.gz -C '$releasePath' --strip-components=1",
        "test -f '$releasePath/BUNDLE-MANIFEST.json'",
        "/usr/bin/python3.12 -m venv /opt/growthsent/venv",
        "/opt/growthsent/venv/bin/python -m pip install --no-cache-dir -r '$releasePath/requirements.txt'",
        "/opt/growthsent/venv/bin/python '$releasePath/tools/common_crawl_v1_manifest.py' --manifest '$releasePath/manifests/cc-main-2026-30-first-1000.json' --count 1 --output '$releasePath/manifests/smoke-1.paths'"
    )
    Invoke-RunShellScript -Comment "Install GrowthSent Common Crawl production-v1 bundle" -Commands $installCommands | Out-Null
}

$smokeCommands = @(
    "set -euo pipefail",
    "install -d -m 0755 /opt/growthsent/work/smoke",
    "/opt/growthsent/venv/bin/python '$releasePath/tools/common_crawl_wat_ingest.py' --crawl '$Crawl' --input-list '$releasePath/manifests/smoke-1.paths' --max-inputs 1 --expected-inputs-sha256 '$SourceHash' --require-source-prefix 'crawl-data/CC-MAIN-2026-30/' --workers 1 --files-per-batch 1 --output-dir /opt/growthsent/work/smoke --resume --upload --remove-uploaded-local --destination 's3://$Bucket/$Prefix/'"
)
Invoke-RunShellScript -Comment "Smoke test one locked Common Crawl WAT input" -Commands $smokeCommands

$verifyCommands = @(
    "set -euo pipefail",
    "/opt/growthsent/venv/bin/python '$releasePath/tools/verify_common_crawl_s3_objects.py' --bucket '$Bucket' --prefix '$Prefix' --crawl '$Crawl' --source '$Source'"
)
Invoke-RunShellScript -Comment "Verify Common Crawl smoke-test S3 objects" -Commands $verifyCommands

Write-Output "Smoke test verified. Deterministic part: $Part"
