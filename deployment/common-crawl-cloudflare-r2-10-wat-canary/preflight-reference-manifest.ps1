[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

throw "This PowerShell v1 manifest preflight is retired. It must not be used with the legacy audit contract. No cloud action was attempted."

$accountId = "4a30e8ac877d9f65ee9a0ecc5df16146"
$bucket = "growthsent-data-lake"
$manifestKey = "production/common-crawl/audit/golden-verification/v1/cc-main-2026-30-10-wat/GOLDEN-VERIFICATION-MANIFEST.json"
$expectedSha256 = "84139ea1a0a40511617648c7771abc023953b7b3138c390c1d01a63a028e0e5f"
$node = "C:\Program Files\nodejs\node.exe"
$npm = "C:\Program Files\nodejs\npm.cmd"
$outputDirectory = Join-Path $env:TEMP "growthsent-cloudflare-10-wat-reference"
$destination = Join-Path $outputDirectory "GOLDEN-VERIFICATION-MANIFEST.json"

function ConvertTo-Plaintext([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Invoke-NodeJson([string]$ScriptPath, [string]$InputJson) {
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $node
  $processInfo.Arguments = ('"' + $ScriptPath + '"')
  $processInfo.WorkingDirectory = $PSScriptRoot
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
      throw "The local read-only R2 manifest fetch failed. $stderr"
    }
    return $output | ConvertFrom-Json -ErrorAction Stop
  } finally {
    $process.Dispose()
    Remove-Variable output,stderr -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $npm)) {
  throw "Node.js is required at C:\Program Files\nodejs. No cloud action was attempted."
}
if (Test-Path -LiteralPath $destination) {
  throw "Refusing to overwrite an existing local audit manifest: $destination"
}

Write-Host "GrowthSent 10-WAT audit-manifest preflight" -ForegroundColor Cyan
Write-Host "This performs one read-only R2 GetObject. It does not deploy a Worker, start a Container, or modify R2." -ForegroundColor Yellow
Write-Host "Audit key: $manifestKey" -ForegroundColor Yellow
Read-Host "Press Enter to continue" | Out-Null

$parentAccessKeyId = ConvertTo-Plaintext (Read-Host "Paste the temporary parent R2 Access Key ID" -AsSecureString)
$parentSecretAccessKey = ConvertTo-Plaintext (Read-Host "Paste the temporary parent R2 Secret Access Key" -AsSecureString)
if (-not $parentAccessKeyId -or -not $parentSecretAccessKey) {
  throw "Both temporary parent credentials are required."
}

$success = $false
try {
  Write-Host "Installing the local request signer in a temporary dependency folder..." -ForegroundColor Cyan
  & $npm --prefix $PSScriptRoot install --no-package-lock --ignore-scripts --omit=dev | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "npm could not install the local request signer. No cloud action was attempted."
  }

  $request = [ordered]@{
    endpoint = "https://$accountId.r2.cloudflarestorage.com"
    bucket = $bucket
    key = $manifestKey
    accessKeyId = $parentAccessKeyId
    secretAccessKey = $parentSecretAccessKey
    destination = $destination
  } | ConvertTo-Json -Compress
  $result = Invoke-NodeJson (Join-Path $PSScriptRoot "read-r2-json-to-file.mjs") $request
  $safe = [pscustomobject]@{
    operation = $result.operation
    http_status = $result.http_status
    key = $result.key
    content_length = $result.content_length
    sha256 = $result.sha256
    destination = $result.destination
  }
  $safe | ConvertTo-Json -Compress
  if ($result.http_status -ne 200 -or $result.sha256 -ne $expectedSha256 -or $result.content_length -ne 24817) {
    throw "REFERENCE PREFLIGHT FAILED: the local manifest was not accepted; no Worker or Container was created."
  }
  $success = $true
  Write-Host "SUCCESS: the verified read-only audit manifest is ready for the canary build." -ForegroundColor Green
} finally {
  Remove-Variable parentAccessKeyId,parentSecretAccessKey,request,result -ErrorAction SilentlyContinue
}

Read-Host "Press Enter to close this window" | Out-Null
if (-not $success) {
  exit 1
}
