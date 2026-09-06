#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT=/opt/growthsent
readonly PYTHON="${PYTHON:-python}"
readonly RELEASE_LOCK="$ROOT/RELEASE-SHA256"

required=(
  GROWTHSENT_RELEASE_SHA256
  GROWTHSENT_R2_INPUT_READ_SECRET_VERSION
  GROWTHSENT_GCS_BUCKET
  GROWTHSENT_CATALOG_OBJECT
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required setting: $name" >&2; exit 2; }
done
[[ "$GROWTHSENT_R2_INPUT_READ_SECRET_VERSION" == projects/*/versions/* ]] || { echo "R2 secret must be a Secret Manager version resource" >&2; exit 2; }
[[ -r "$RELEASE_LOCK" && "$(tr -d '\r\n' < "$RELEASE_LOCK")" == "$GROWTHSENT_RELEASE_SHA256" ]] || { echo "container release lock does not match reviewed job release" >&2; exit 2; }

exec "$PYTHON" "$ROOT/tools/common_crawl_gcp_secret_runtime.py" \
  --r2-secret-version "$GROWTHSENT_R2_INPUT_READ_SECRET_VERSION" \
  --r2-credential-prefix GROWTHSENT_R2_INPUT_READ_ -- \
  "$PYTHON" "$ROOT/tools/common_crawl_link_index_catalog_v1.py" \
  --source-manifest "$ROOT/manifests/cc-main-2026-30-first-100000.json" \
  --source-roots "$ROOT/config/source-roots.v1.json" \
  --gcs-bucket "$GROWTHSENT_GCS_BUCKET" \
  --gcs-object "$GROWTHSENT_CATALOG_OBJECT"
