[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $BaseImageDigest,
  [Parameter(Mandatory = $true)] [string] $ImageTag,
  [Parameter(Mandatory = $true)] [string] $ReleaseSha256,
  [Parameter(Mandatory = $true)] [string] $ReleaseDirectory
)

$ErrorActionPreference = "Stop"
if ($BaseImageDigest -notmatch '^.+@sha256:[0-9a-f]{64}$') {
  throw "BaseImageDigest must be an immutable OCI image reference with sha256 digest."
}
if ($ReleaseSha256 -notmatch '^[0-9a-f]{64}$') {
  throw "ReleaseSha256 must be the reviewed archive SHA-256."
}
if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory "BUNDLE-MANIFEST.json"))) {
  throw "ReleaseDirectory must be an extracted, reviewed GCP/R2 release."
}

# This is local image preparation only. It does not push to Artifact Registry.
docker build --pull=false --build-arg "PYTHON_IMAGE=$BaseImageDigest" --build-arg "GROWTHSENT_RELEASE_SHA256=$ReleaseSha256" --tag $ImageTag $ReleaseDirectory
