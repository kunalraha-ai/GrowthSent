[CmdletBinding()]
param(
  [string]$ProjectId = "growthsent-link-index",
  [string]$SecretId = "r2-link-index-input-read",
  [string]$CloudflareAccountId = "4a30e8ac877d9f65ee9a0ecc5df16146",
  [string]$R2Bucket = "growthsent-data-lake",
  [ValidateRange(900, 604800)]
  [int]$TtlSeconds = 604800
)

$ErrorActionPreference = "Stop"

function ConvertTo-Plaintext([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-HttpStatus([System.Management.Automation.ErrorRecord]$ErrorRecord) {
  $response = $ErrorRecord.Exception.Response
  if ($null -eq $response) { return $null }
  try { return [int]$response.StatusCode } catch { return $null }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$rootsPath = Join-Path $root "config\source-roots.v1.json"
$roots = (Get-Content -LiteralPath $rootsPath -Raw | ConvertFrom-Json).roots
$prefixes = @($roots | ForEach-Object prefix)
if ($prefixes.Count -ne 7 -or @($prefixes | Select-Object -Unique).Count -ne 7) {
  throw "The reviewed source-root contract must contain exactly seven unique prefixes."
}

$secureToken = Read-Host "Paste the parent Cloudflare API token (hidden)" -AsSecureString
$parentToken = ConvertTo-Plaintext $secureToken
try {
  if (-not $parentToken) { throw "A parent Cloudflare API token is required." }
  $headers = @{ Authorization = "Bearer $parentToken"; "Content-Type" = "application/json" }
  $parent = $null
  foreach ($path in @("/accounts/$CloudflareAccountId/tokens/verify", "/user/tokens/verify")) {
    try {
      $candidate = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4$path" -Headers $headers
      if ($candidate.success -and $candidate.result.status -eq "active" -and $candidate.result.id) {
        $parent = $candidate.result
        break
      }
    } catch {
      # The alternate verification endpoint supports user-scoped tokens.
    }
  }
  if ($null -eq $parent) { throw "The parent Cloudflare API token could not be verified as active." }
  $request = [ordered]@{
    bucket = $R2Bucket
    parentAccessKeyId = [string]$parent.id
    permission = "object-read-only"
    ttlSeconds = $TtlSeconds
    prefixes = $prefixes
  } | ConvertTo-Json -Compress
  try {
    $response = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/accounts/$CloudflareAccountId/r2/temp-access-credentials" -Headers $headers -Body $request
  } catch {
    $status = Get-HttpStatus $_
    if ($null -ne $status) { throw "Cloudflare temporary-credential mint failed with HTTP $status." }
    throw "Cloudflare temporary-credential mint failed."
  }
  $child = $response.result
  if (-not $response.success -or -not $child.accessKeyId -or ([string]$child.secretAccessKey -notmatch '^[0-9a-f]{64}$') -or -not $child.sessionToken) {
    throw "Cloudflare returned an invalid temporary R2 credential."
  }
  $secretDocument = [ordered]@{
    account_id = $CloudflareAccountId
    bucket = $R2Bucket
    access_key_id = [string]$child.accessKeyId
    secret_access_key = [string]$child.secretAccessKey
    session_token = [string]$child.sessionToken
  } | ConvertTo-Json -Compress
  $version = $secretDocument | & gcloud secrets versions add $SecretId --project $ProjectId --data-file=- --format="value(name)"
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Secret Manager did not accept the new temporary R2 credential version." }
  [pscustomobject]@{
    status = "published"
    secret = $SecretId
    version = $version.Trim()
    permission = "object-read-only"
    prefix_count = $prefixes.Count
    ttl_seconds = $TtlSeconds
  } | ConvertTo-Json -Compress
} finally {
  Remove-Variable parentToken,secureToken,parent,headers,request,child,secretDocument -ErrorAction SilentlyContinue
}
