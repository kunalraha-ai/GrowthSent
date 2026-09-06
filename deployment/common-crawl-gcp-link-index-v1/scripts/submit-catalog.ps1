[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^us-central1-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$')]
  [string]$ImageUri,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string]$ReleaseSha256,
  [string]$ProjectId = "growthsent-link-index",
  [string]$Location = "us-central1"
)

$ErrorActionPreference = "Stop"
$template = Join-Path $PSScriptRoot "..\batch\catalog-job.template.json"
$jobId = "growthsent-link-index-catalog-v1-$(Get-Date -Format 'yyyyMMddHHmmss')"
$temporaryConfig = Join-Path ([IO.Path]::GetTempPath()) "$jobId.json"
try {
  $document = Get-Content -LiteralPath $template -Raw
  $document = $document.Replace("REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE", $ImageUri)
  $document = $document.Replace("REPLACE_WITH_RELEASE_SHA256", $ReleaseSha256)
  if ($document -match "REPLACE_WITH_") { throw "Batch template still has an unresolved placeholder." }
  $document | Set-Content -LiteralPath $temporaryConfig -Encoding UTF8
  & gcloud batch jobs submit $jobId --project $ProjectId --location $Location --config $temporaryConfig --quiet
  if ($LASTEXITCODE -ne 0) { throw "Catalog Batch job submission failed." }
  [pscustomobject]@{
    job_id = $jobId
    project = $ProjectId
    location = $Location
    image = $ImageUri
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}
