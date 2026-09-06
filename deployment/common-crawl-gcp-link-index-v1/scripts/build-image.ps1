[CmdletBinding()]
param(
  [string]$ProjectId = "growthsent-link-index",
  [string]$Region = "us-central1",
  [string]$Repository = "growthsent-containers",
  [string]$ImageName = "link-index-v1",
  [string]$PythonImage = "python@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$releaseRoots = @(
  "tools/common_crawl_r2_store.py",
  "tools/common_crawl_gcp_secret_runtime.py",
  "tools/common_crawl_link_index_catalog_v1.py",
  "tools/common_crawl_link_index_materialize_v1.py",
  "tools/common_crawl_link_index_compact_v1.py",
  "deployment/common-crawl-gcp-link-index-v1",
  "deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json"
) | ForEach-Object { Join-Path $root $_ }
$releaseFiles = foreach ($releaseRoot in $releaseRoots) {
  if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
    Get-ChildItem -LiteralPath $releaseRoot -File -Recurse | Select-Object -ExpandProperty FullName
  } else {
    $releaseRoot
  }
}
$releaseHashLines = foreach ($releaseFile in ($releaseFiles | Sort-Object)) {
  (Get-FileHash -LiteralPath $releaseFile -Algorithm SHA256).Hash
}
$releaseSha = ($releaseHashLines | Sort-Object | Out-String)
$releaseBytes = [Text.Encoding]::UTF8.GetBytes($releaseSha)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $releaseDigest = ([BitConverter]::ToString($sha256.ComputeHash($releaseBytes))).Replace("-", "").ToLowerInvariant() }
finally { $sha256.Dispose() }

$registryHost = "$Region-docker.pkg.dev"
$tag = "$registryHost/$ProjectId/$Repository/$ImageName`:$releaseDigest"
if (Get-Command docker -ErrorAction SilentlyContinue) {
  & gcloud auth configure-docker $registryHost --quiet
  if ($LASTEXITCODE -ne 0) { throw "gcloud could not configure the Docker credential helper." }
  & docker build --file (Join-Path $root "deployment/common-crawl-gcp-link-index-v1/container/Dockerfile") --build-arg "PYTHON_IMAGE=$PythonImage" --build-arg "GROWTHSENT_RELEASE_SHA256=$releaseDigest" --tag $tag $root
  if ($LASTEXITCODE -ne 0) { throw "Docker image build failed." }
  & docker push $tag
  if ($LASTEXITCODE -ne 0) { throw "Docker image push failed." }
} else {
  & gcloud builds submit $root --project $ProjectId --config (Join-Path $root "deployment/common-crawl-gcp-link-index-v1/container/cloudbuild.yaml") --substitutions "_IMAGE_URI=$tag,_PYTHON_IMAGE=$PythonImage,_GROWTHSENT_RELEASE_SHA256=$releaseDigest" --quiet
  if ($LASTEXITCODE -ne 0) { throw "Cloud Build image publication failed." }
}
$digest = (gcloud artifacts docker images describe $tag --project $ProjectId --format="value(image_summary.digest)").Trim()
if ($digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Artifact Registry did not return a digest-pinned image." }
[pscustomobject]@{
  release_sha256 = $releaseDigest
  image = "$registryHost/$ProjectId/$Repository/$ImageName@$digest"
} | ConvertTo-Json -Compress
