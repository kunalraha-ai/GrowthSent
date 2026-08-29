[CmdletBinding()]
param(
  [switch]$ApprovedTenWatCanary,
  [switch]$PreflightOnly,
  [switch]$UseCloudflareTemporaryCredentialsApi
)

$ErrorActionPreference = "Stop"

throw "This PowerShell launcher is retired after the legacy v1 audit contract failed. Use provision-and-start-wsl.sh only after the reviewed public-source baseline v2 has been published. No cloud action was attempted."

if ($ApprovedTenWatCanary -and $PreflightOnly) {
  throw "Choose either -ApprovedTenWatCanary or -PreflightOnly, never both."
}
if (-not $ApprovedTenWatCanary -and -not $PreflightOnly) {
  throw "This guarded launcher requires -ApprovedTenWatCanary. It never deploys or starts a Container without that explicit switch."
}

$accountId = "4a30e8ac877d9f65ee9a0ecc5df16146"
$bucket = "growthsent-data-lake"
$referenceManifest = Join-Path $env:TEMP "growthsent-cloudflare-10-wat-reference\GOLDEN-VERIFICATION-MANIFEST.json"
$expectedReferenceSha256 = "84139ea1a0a40511617648c7771abc023953b7b3138c390c1d01a63a028e0e5f"
$node = "C:\Program Files\nodejs\node.exe"
$npm = "C:\Program Files\nodejs\npm.cmd"
$npx = "C:\Program Files\nodejs\npx.cmd"
$childTtlSeconds = 7200
$hardTimeoutSeconds = 6600
$wslDistribution = "Ubuntu"
$wslNodeRelease = "node-v22.23.2-linux-x64"
$wslPathValue = $null

function ConvertTo-Plaintext([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function New-RandomHex([int]$ByteCount) {
  $bytes = [byte[]]::new($ByteCount)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return (-join ($bytes | ForEach-Object { $_.ToString("x2") }))
  } finally {
    $generator.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Invoke-NodeJson([string]$ScriptPath, [string]$InputJson, [string]$WorkingDirectory) {
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $node
  $processInfo.Arguments = ('"' + $ScriptPath + '"')
  $processInfo.WorkingDirectory = $WorkingDirectory
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($processInfo)
  try {
    $process.StandardInput.WriteLine($InputJson)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "A local R2 helper failed. $stderr"
    }
    return $output | ConvertFrom-Json -ErrorAction Stop
  } finally {
    $process.Dispose()
    Remove-Variable output,stderr -ErrorAction SilentlyContinue
  }
}

function ConvertTo-WslPath([string]$WindowsPath) {
  $resolved = [IO.Path]::GetFullPath($WindowsPath)
  if ($resolved -notmatch "^([A-Za-z]):\\") {
    throw "Only an absolute local drive path may be used for the WSL canary build. No cloud action was attempted."
  }
  $drive = $Matches[1].ToLowerInvariant()
  $relative = $resolved.Substring(3).Replace("\", "/")
  return "/mnt/$drive/$relative"
}

function Invoke-WslTool([string]$ToolPath, [string[]]$ToolArguments, [string]$WorkingDirectory, [string]$StandardInput = $null) {
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $wsl.Source
  $processInfo.WorkingDirectory = $WorkingDirectory
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  foreach ($argument in @("--distribution", $wslDistribution, "--cd", (ConvertTo-WslPath $WorkingDirectory), "--", "env", "PATH=$wslPathValue", $ToolPath) + $ToolArguments) {
    [void]$processInfo.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::Start($processInfo)
  try {
    if ($null -ne $StandardInput) { $process.StandardInput.WriteLine($StandardInput) }
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ exit_code = $process.ExitCode; output = $output; stderr = $stderr }
  } finally {
    $process.Dispose()
    Remove-Variable output,stderr -ErrorAction SilentlyContinue
  }
}

function Mint-ChildCredentials([string]$ParentAccessKeyId, [string]$ParentSecretAccessKey, [string]$CanaryPrefix, [string]$BundleDirectory) {
  $request = [ordered]@{
    endpoint = "https://$accountId.r2.cloudflarestorage.com"
    accountId = $accountId
    parentAccessKeyId = $ParentAccessKeyId
    parentSecretAccessKey = $ParentSecretAccessKey
    bucket = $bucket
    prefix = $CanaryPrefix
    scope = "object-read-write"
    actions = @()
    ttlSeconds = $childTtlSeconds
    sessionEncoding = "base64"
  } | ConvertTo-Json -Compress
  $result = Invoke-NodeJson (Join-Path $BundleDirectory "mint-r2-temp-credentials.mjs") $request $BundleDirectory
  if (-not $result.accessKeyId -or $result.secretAccessKey -notmatch "^[0-9a-f]{64}$" -or -not $result.sessionToken) {
    throw "The local child-credential signer returned an invalid result."
  }
  return $result
}

function Invoke-CloudflareTemporaryCredentialsApi([string]$ParentApiToken, [string]$CanaryPrefix) {
  # This is intentionally the server-minted alternative to local JWT signing.
  # The parent API token exists only in this PowerShell process and is never
  # printed, written to disk, or installed as a Worker secret.
  $headers = @{ Authorization = "Bearer $ParentApiToken" }
  try {
    # A custom token may be user-owned or account-owned. Both are valid
    # Cloudflare API tokens, but their token-verify endpoints differ.
    $verification = $null
    $verificationKind = $null
    foreach ($candidate in @(
      [pscustomobject]@{ kind = "account"; uri = "https://api.cloudflare.com/client/v4/accounts/$accountId/tokens/verify" },
      [pscustomobject]@{ kind = "user"; uri = "https://api.cloudflare.com/client/v4/user/tokens/verify" }
    )) {
      try {
        $candidateResult = Invoke-RestMethod -Method Get -Uri $candidate.uri -Headers $headers
        if ($candidateResult.success -and $candidateResult.result.id -and $candidateResult.result.status -eq "active") {
          $verification = $candidateResult
          $verificationKind = $candidate.kind
          break
        }
      } catch {
        # Try the other ownership-specific verification endpoint. Never emit
        # the request object or exception because it carries a bearer token.
      }
    }
    if ($null -eq $verification) {
      throw "The Cloudflare parent API token is not active or cannot be verified."
    }
    $request = [ordered]@{
      bucket = $bucket
      parentAccessKeyId = [string]$verification.result.id
      permission = "object-read-write"
      ttlSeconds = $childTtlSeconds
      prefixes = @($CanaryPrefix)
    } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/r2/temp-access-credentials" -Headers $headers -ContentType "application/json" -Body $request
    if (-not $response.success -or -not $response.result.accessKeyId -or $response.result.secretAccessKey -notmatch "^[0-9a-f]{64}$" -or -not $response.result.sessionToken) {
      throw "Cloudflare did not return a valid scoped child credential."
    }
    return [pscustomobject]@{ credentials = $response.result; token_kind = $verificationKind }
  } catch {
    # Do not attach the original exception: PowerShell may include request
    # details. The safe diagnostic remains available from the response status.
    $status = Get-HttpStatus $_.Exception
    if ($status) { throw "Cloudflare Temporary Credentials API mint failed with HTTP $status. No Worker was deployed." }
    throw "Cloudflare Temporary Credentials API mint failed. No Worker was deployed."
  } finally {
    Remove-Variable verification,verificationKind,candidate,candidateResult,request,response -ErrorAction SilentlyContinue
  }
}

function Invoke-R2Preflight([string]$AccessKeyId, [string]$SecretAccessKey, [string]$CanaryPrefix, [string]$BundleDirectory, [string]$SessionToken = $null) {
  $request = [ordered]@{
    endpoint = "https://$accountId.r2.cloudflarestorage.com"
    bucket = $bucket
    key = "$CanaryPrefix" + "CANARY-COMPLETED.json"
    accessKeyId = $AccessKeyId
    secretAccessKey = $SecretAccessKey
  }
  if ($SessionToken) { $request.sessionToken = $SessionToken }
  return Invoke-NodeJson (Join-Path $BundleDirectory "r2-s3-preflight.mjs") ($request | ConvertTo-Json -Compress) $BundleDirectory
}

function Invoke-Boto3R2Preflight([string]$AccessKeyId, [string]$SecretAccessKey, [string]$SessionToken, [string]$CanaryPrefix, [string]$BundleDirectory) {
  $request = [ordered]@{
    account_id = $accountId
    bucket = $bucket
    key = "$CanaryPrefix" + "CANARY-COMPLETED.json"
    prefix = $CanaryPrefix
    access_key_id = $AccessKeyId
    secret_access_key = $SecretAccessKey
    session_token = $SessionToken
  } | ConvertTo-Json -Compress
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = "python"
  $processInfo.Arguments = ('"' + (Join-Path $BundleDirectory "r2-boto3-preflight.py") + '"')
  $processInfo.WorkingDirectory = $BundleDirectory
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($processInfo)
  try {
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if (-not $output) { throw "boto3 R2 preflight returned no safe diagnostic output. $stderr" }
    $result = $output | ConvertFrom-Json -ErrorAction Stop
    if ($process.ExitCode -ne 0) { return $result }
    return $result
  } finally {
    $process.Dispose()
    Remove-Variable request,output,stderr,result -ErrorAction SilentlyContinue
  }
}

function Invoke-R2ListPrefix([string]$AccessKeyId, [string]$SecretAccessKey, [string]$CanaryPrefix, [string]$BundleDirectory, [string]$SessionToken = $null) {
  $request = [ordered]@{
    endpoint = "https://$accountId.r2.cloudflarestorage.com"
    bucket = $bucket
    prefix = $CanaryPrefix
    maxKeys = 1000
    accessKeyId = $AccessKeyId
    secretAccessKey = $SecretAccessKey
  }
  if ($SessionToken) { $request.sessionToken = $SessionToken }
  $request = $request | ConvertTo-Json -Compress
  return Invoke-NodeJson (Join-Path $BundleDirectory "r2-s3-list-prefix.mjs") $request $BundleDirectory
}

function Write-WorkerSecrets([string]$Json, [string]$WorkerName, [string]$BundleDirectory) {
  $result = Invoke-WslTool $wslNpx @("--offline", "--yes", "wrangler@4.126.0", "secret", "bulk", "--name", $WorkerName) $BundleDirectory $Json
  if ($result.exit_code -ne 0) {
    throw "Wrangler could not install the scoped child secrets. $($result.stderr)"
  }
}

function Get-HttpStatus($Exception) {
  if ($Exception -and $Exception.Response -and $Exception.Response.StatusCode) {
    return [int]$Exception.Response.StatusCode
  }
  return $null
}

function Is-ExpectedMissingObject($Result) {
  return $Result.http_status -eq 404 -and $Result.r2_error_code -eq "NoSuchKey" -and -not $Result.object_exists
}

if (-not (Test-Path -LiteralPath $referenceManifest)) {
  throw "Missing verified audit manifest. Run preflight-reference-manifest.ps1 first; no cloud action was attempted."
}
if ((Get-FileHash -LiteralPath $referenceManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedReferenceSha256) {
  throw "The local audit manifest hash is not approved. No cloud action was attempted."
}
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $npm) -or -not (Test-Path -LiteralPath $npx)) {
  throw "Node.js/npm/npx are required at C:\Program Files\nodejs. No cloud action was attempted."
}
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
  throw "WSL Ubuntu is required for the canary Container build. No cloud action was attempted."
}
$wslUser = (& $wsl.Source --distribution $wslDistribution -- id -un | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $wslUser -ne "kunalkunal") {
  throw "The reviewed Ubuntu WSL identity was not available. No cloud action was attempted."
}
$wslNodeBin = "/home/$wslUser/.local/share/growthsent-tools/$wslNodeRelease/bin"
$wslNpm = "$wslNodeBin/npm"
$wslNpx = "$wslNodeBin/npx"
$wslPathValue = "${wslNodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
& $wsl.Source --distribution $wslDistribution -- test -x $wslNpm
if ($LASTEXITCODE -ne 0) {
  throw "The reviewed WSL-local Node runtime is unavailable. No cloud action was attempted."
}
& $wsl.Source --distribution $wslDistribution -- docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Engine is not reachable from WSL Ubuntu. No cloud action was attempted."
}

$nonce = New-RandomHex 4
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ").ToLowerInvariant()
$canaryId = "cc-main-2026-30-$timestamp-10-wat-cf-$nonce"
$workerName = "growthsent-10wat-$nonce"
$containerName = "growthsent-10wat-$nonce"
$canaryPrefix = "production/common-crawl/cloudflare-r2-canaries/v1/$canaryId/"
$bundleDirectory = Join-Path $env:TEMP "growthsent-cloudflare-10-wat-$canaryId"

if (Test-Path -LiteralPath $bundleDirectory) {
  throw "Refusing to reuse an existing temporary bundle directory: $bundleDirectory"
}

Write-Host "GrowthSent Cloudflare Container 10-WAT canary" -ForegroundColor Cyan
Write-Host "Canary ID: $canaryId" -ForegroundColor Yellow
Write-Host "R2 prefix: $canaryPrefix" -ForegroundColor Yellow
if ($PreflightOnly) {
  if ($UseCloudflareTemporaryCredentialsApi) {
    Write-Host "Mode: credential preflight. It mints one short-lived child credential, but does not deploy a Worker, start a Container, or write R2." -ForegroundColor Yellow
  } else {
    Write-Host "Mode: read-only credential preflight. It will not deploy a Worker, start a Container, or write R2." -ForegroundColor Yellow
  }
} else {
  Write-Host "Scope: exactly ten audit-manifest WATs, one Container instance, one HTTPS stream at a time, 110-minute hard timeout." -ForegroundColor Yellow
}
if ($UseCloudflareTemporaryCredentialsApi) {
  Write-Host "Credential mode: Cloudflare server-minted child. The locally entered parent Cloudflare API token is never installed remotely." -ForegroundColor Yellow
} else {
  Write-Host "Credential mode: locally signed child. The parent secret is never installed remotely." -ForegroundColor Yellow
}
Write-Host "The Worker receives only a two-hour child credential scoped to this new canary prefix." -ForegroundColor Yellow
Read-Host "Press Enter to continue" | Out-Null

& python (Join-Path $PSScriptRoot "build_bundle.py") --run-id $canaryId --worker-name $workerName --container-name $containerName --reference-manifest $referenceManifest --output-dir $bundleDirectory
if ($LASTEXITCODE -ne 0) { throw "The local canary bundle build failed. No cloud action was attempted." }
$npmResult = Invoke-WslTool $wslNpm @("install", "--no-package-lock", "--ignore-scripts", "--omit=dev") $bundleDirectory
if ($npmResult.exit_code -ne 0) { throw "npm could not prepare the local canary bundle. $($npmResult.stderr)" }

if ($UseCloudflareTemporaryCredentialsApi) {
  $parentCloudflareApiToken = ConvertTo-Plaintext (Read-Host "Paste the short-lived parent Cloudflare API token" -AsSecureString)
  if (-not $parentCloudflareApiToken) { throw "A short-lived parent Cloudflare API token is required." }
} else {
  $parentAccessKeyId = ConvertTo-Plaintext (Read-Host "Paste the temporary parent R2 Access Key ID" -AsSecureString)
  $parentSecretAccessKey = ConvertTo-Plaintext (Read-Host "Paste the temporary parent R2 Secret Access Key" -AsSecureString)
  if (-not $parentAccessKeyId -or -not $parentSecretAccessKey) { throw "Both temporary parent credentials are required." }
}

$triggerBytes = [byte[]]::new(32)
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($triggerBytes) } finally { $generator.Dispose() }
$triggerToken = ConvertTo-Base64Url $triggerBytes
$success = $false

try {
  if ($UseCloudflareTemporaryCredentialsApi) {
    $serverMint = Invoke-CloudflareTemporaryCredentialsApi $parentCloudflareApiToken $canaryPrefix
    $childCredentials = $serverMint.credentials
    [pscustomobject]@{ stage = "server_minted_child"; accepted = $true; parent_token_kind = $serverMint.token_kind; scope = "object-read-write"; ttl_seconds = $childTtlSeconds; prefix = $canaryPrefix } | ConvertTo-Json -Compress
  } else {
    $parentList = Invoke-R2ListPrefix $parentAccessKeyId $parentSecretAccessKey $canaryPrefix $bundleDirectory
    $parentKeyCount = if ($null -eq $parentList.keys) { 0 } else { @($parentList.keys).Count }
    [pscustomobject]@{ stage = "parent_list"; http_status = $parentList.http_status; key_count = $parentKeyCount; truncated = [bool]$parentList.truncated } | ConvertTo-Json -Compress
    if ($parentList.http_status -ne 200 -or $parentKeyCount -ne 0 -or $parentList.truncated) {
      throw "PARENT PREFIX PRECHECK FAILED: the new canary prefix is not proven empty; no Worker was deployed."
    }

    $parentProbe = Invoke-R2Preflight $parentAccessKeyId $parentSecretAccessKey $canaryPrefix $bundleDirectory
    [pscustomobject]@{ stage = "parent_get"; result = $parentProbe } | ConvertTo-Json -Compress
    if (-not (Is-ExpectedMissingObject $parentProbe)) {
      throw "PARENT GET PRECHECK FAILED: no Worker was deployed."
    }

    $childCredentials = Mint-ChildCredentials $parentAccessKeyId $parentSecretAccessKey $canaryPrefix $bundleDirectory
  }
  $temporarySecretAccessKey = $childCredentials.secretAccessKey
  $temporarySessionToken = $childCredentials.sessionToken
  $childAccessKeyId = $childCredentials.accessKeyId
  $childList = Invoke-R2ListPrefix $childAccessKeyId $temporarySecretAccessKey $canaryPrefix $bundleDirectory $temporarySessionToken
  $childKeyCount = if ($null -eq $childList.keys) { 0 } else { @($childList.keys).Count }
  [pscustomobject]@{ stage = "child_list"; http_status = $childList.http_status; key_count = $childKeyCount; truncated = [bool]$childList.truncated } | ConvertTo-Json -Compress
  if ($childList.http_status -ne 200 -or $childKeyCount -ne 0 -or $childList.truncated) {
    throw "CHILD PREFIX PRECHECK FAILED: the new canary prefix is not proven empty; no Worker was deployed."
  }
  $childProbe = Invoke-R2Preflight $childAccessKeyId $temporarySecretAccessKey $canaryPrefix $bundleDirectory $temporarySessionToken
  [pscustomobject]@{ stage = "derived_child"; result = $childProbe } | ConvertTo-Json -Compress
  if (-not (Is-ExpectedMissingObject $childProbe)) {
    throw "CHILD PRECHECK FAILED: no Worker was deployed."
  }

  $botoChildProbe = Invoke-Boto3R2Preflight $childAccessKeyId $temporarySecretAccessKey $temporarySessionToken $canaryPrefix $bundleDirectory
  [pscustomobject]@{ stage = "derived_child_boto3"; result = $botoChildProbe } | ConvertTo-Json -Compress
  if ($botoChildProbe.get_http_status -ne 404 -or $botoChildProbe.get_error_code -ne "NoSuchKey" -or $botoChildProbe.list_http_status -ne 200 -or $botoChildProbe.key_count -ne 0 -or $botoChildProbe.truncated) {
    throw "CHILD BOTO3 PRECHECK FAILED: no Worker was deployed."
  }
  if ($PreflightOnly) {
    $success = $true
    Write-Host "SUCCESS: aws4fetch and boto3 both accepted the scoped child credential. No Worker, Container, or R2 object was created." -ForegroundColor Green
    return
  }

  $checkResult = Invoke-WslTool $wslNpx @("--offline", "--yes", "wrangler@4.126.0", "deploy", "--dry-run", "--config", "wrangler.jsonc") $bundleDirectory
  if ($checkResult.exit_code -ne 0) { throw "Wrangler configuration validation failed. $($checkResult.stderr)" }

  Write-Host "Deploying the temporary one-instance Container Worker..." -ForegroundColor Cyan
  $deployResult = Invoke-WslTool $wslNpx @("--offline", "--yes", "wrangler@4.126.0", "deploy", "--config", "wrangler.jsonc") $bundleDirectory
  $deployOutput = $deployResult.output + $deployResult.stderr
  if ($deployResult.exit_code -ne 0) { throw "Wrangler deployment failed. $deployOutput" }
  $workerUrlMatch = [regex]::Match($deployOutput, "https://[a-z0-9][a-z0-9.-]*\.workers\.dev", [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $workerUrlMatch.Success) { throw "Worker deployed but Wrangler did not report a workers.dev URL; do not install secrets or start it." }
  $workerUrl = $workerUrlMatch.Value

  $context = [ordered]@{
    canary_id = $canaryId
    worker_name = $workerName
    container_name = $containerName
    worker_url = $workerUrl
    r2_prefix = $canaryPrefix
    reference_manifest_sha256 = $expectedReferenceSha256
    hard_timeout_seconds = $hardTimeoutSeconds
    child_credential_ttl_seconds = $childTtlSeconds
  }
  $context | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bundleDirectory "CANARY-CONTEXT.json") -Encoding utf8NoBOM

  $secretsJson = [ordered]@{
    GROWTHSENT_R2_ACCESS_KEY_ID = $childAccessKeyId
    GROWTHSENT_R2_SECRET_ACCESS_KEY = $temporarySecretAccessKey
    GROWTHSENT_R2_SESSION_TOKEN = $temporarySessionToken
    CANARY_TRIGGER_TOKEN = $triggerToken
  } | ConvertTo-Json -Compress
  Write-Host "Installing scoped child credentials atomically..." -ForegroundColor Cyan
  Write-WorkerSecrets $secretsJson $workerName $bundleDirectory

  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  $status = $null
  do {
    Start-Sleep -Seconds 2
    try { $status = Invoke-RestMethod -Method Get -Uri "$workerUrl/_growthsent_canary/status" } catch { $status = $null }
  } until ($status -and $status.control_secret_configured -or [DateTime]::UtcNow -ge $deadline)
  if (-not $status -or -not $status.control_secret_configured -or $status.canary_id -ne $canaryId -or $status.state -ne "stopped" -or $null -ne $status.terminal) {
    throw "The fresh Worker/Container state was not safe to start. No Container start request was sent."
  }

  try {
    $startResult = Invoke-RestMethod -Method Post -Uri "$workerUrl/_growthsent_canary/start" -ContentType "application/octet-stream" -Body $triggerToken
    [pscustomobject]@{ stage = "start"; http_status = 202; accepted = [bool]$startResult.accepted; canary_id = $startResult.canary_id } | ConvertTo-Json -Compress
    if (-not $startResult.accepted -or $startResult.canary_id -ne $canaryId) { throw "The only start request was not accepted." }
  } catch {
    $httpStatus = Get-HttpStatus $_.Exception
    [pscustomobject]@{ stage = "start"; http_status = $httpStatus; accepted = $false; canary_id = $canaryId } | ConvertTo-Json -Compress
    throw "LIVE START FAILED: no retry was attempted."
  }
  $success = $true
  Write-Host "LIVE START ACCEPTED: exactly one Container start was requested. Do not run this launcher again." -ForegroundColor Green
  Write-Host "Bundle context (no secrets): $bundleDirectory\CANARY-CONTEXT.json" -ForegroundColor Green
} finally {
  [Array]::Clear($triggerBytes, 0, $triggerBytes.Length)
  Remove-Variable parentAccessKeyId,parentSecretAccessKey,parentCloudflareApiToken,serverMint,childAccessKeyId,temporarySecretAccessKey,temporarySessionToken,childCredentials,triggerToken,secretsJson,parentList,parentKeyCount,parentProbe,childList,childKeyCount,childProbe,botoChildProbe,startResult,status,deployOutput -ErrorAction SilentlyContinue
}

Read-Host "Press Enter to close this window" | Out-Null
if (-not $success) { exit 1 }
