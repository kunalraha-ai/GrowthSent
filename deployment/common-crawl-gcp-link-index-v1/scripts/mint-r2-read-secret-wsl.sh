#!/usr/bin/env bash
# Mint a restricted, temporary R2 reader for the GCP link-index catalog.
# The parent token and returned child credentials are never printed or saved to disk.
set -euo pipefail
set +x

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
SECRET_ID="${GROWTHSENT_R2_READ_SECRET_ID:-r2-link-index-input-read}"
CLOUDFLARE_ACCOUNT_ID="${GROWTHSENT_CLOUDFLARE_ACCOUNT_ID:-4a30e8ac877d9f65ee9a0ecc5df16146}"
R2_BUCKET="${GROWTHSENT_R2_BUCKET:-growthsent-data-lake}"
TTL_SECONDS="${GROWTHSENT_R2_READ_TTL_SECONDS:-604800}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ROOTS_PATH="${ROOT_DIR}/config/source-roots.v1.json"
TEMP_DIR="$(mktemp -d)"
VERIFY_RESPONSE="${TEMP_DIR}/verify.json"
MINT_RESPONSE="${TEMP_DIR}/mint.json"

cleanup() {
  unset CF_PARENT_TOKEN PARENT_ACCESS_KEY_ID CHILD_DOCUMENT
  rm -rf -- "${TEMP_DIR}"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

cloudflare_errors() {
  jq -r '.errors[]?.message // empty' "$1" 2>/dev/null | paste -sd ';' -
}

require_command curl
require_command jq
require_command gcloud

[[ -f "${ROOTS_PATH}" ]] || {
  printf 'Missing source-root contract: %s\n' "${ROOTS_PATH}" >&2
  exit 1
}
[[ "${TTL_SECONDS}" =~ ^[0-9]+$ ]] && (( TTL_SECONDS >= 900 && TTL_SECONDS <= 604800 )) || {
  printf 'GROWTHSENT_R2_READ_TTL_SECONDS must be between 900 and 604800.\n' >&2
  exit 1
}

PREFIXES_JSON="$(jq -ce '[.roots[].prefix] | select(length == 7 and (unique | length) == 7)' "${ROOTS_PATH}")" || {
  printf 'The reviewed source-root contract must contain exactly seven unique prefixes.\n' >&2
  exit 1
}

read -r -s -p 'Paste active Cloudflare R2 API token (hidden): ' CF_PARENT_TOKEN
printf '\n'
[[ -n "${CF_PARENT_TOKEN}" ]] || {
  printf 'An R2 API token is required.\n' >&2
  exit 1
}

VERIFY_STATUS="$(curl --silent --show-error --connect-timeout 15 --max-time 45 \
  --output "${VERIFY_RESPONSE}" --write-out '%{http_code}' \
  --header "Authorization: Bearer ${CF_PARENT_TOKEN}" \
  'https://api.cloudflare.com/client/v4/user/tokens/verify')" || {
  printf 'Could not reach Cloudflare while verifying the parent token.\n' >&2
  exit 1
}

PARENT_ACCESS_KEY_ID="$(jq -r 'select(.success == true and .result.status == "active") | .result.id // empty' "${VERIFY_RESPONSE}")"
if [[ "${VERIFY_STATUS}" != "200" || -z "${PARENT_ACCESS_KEY_ID}" ]]; then
  ERROR_MESSAGE="$(cloudflare_errors "${VERIFY_RESPONSE}")"
  printf 'Cloudflare did not accept an active API token (HTTP %s%s).\n' \
    "${VERIFY_STATUS}" "${ERROR_MESSAGE:+: ${ERROR_MESSAGE}}" >&2
  printf 'Use an R2 API token from R2 Object Storage -> Manage API Tokens, not an old temporary child credential, Access Key ID, or Secret Access Key.\n' >&2
  exit 1
fi

REQUEST_JSON="$(jq -cn \
  --arg bucket "${R2_BUCKET}" \
  --arg parentAccessKeyId "${PARENT_ACCESS_KEY_ID}" \
  --argjson ttlSeconds "${TTL_SECONDS}" \
  --argjson prefixes "${PREFIXES_JSON}" \
  '{bucket: $bucket, parentAccessKeyId: $parentAccessKeyId, permission: "object-read-only", ttlSeconds: $ttlSeconds, prefixes: $prefixes}')"

MINT_STATUS="$(curl --silent --show-error --connect-timeout 15 --max-time 60 \
  --output "${MINT_RESPONSE}" --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${CF_PARENT_TOKEN}" \
  --data "${REQUEST_JSON}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/temp-access-credentials")" || {
  printf 'Could not reach Cloudflare while minting the read-only R2 credential.\n' >&2
  exit 1
}

CHILD_DOCUMENT="$(jq -ce \
  --arg account_id "${CLOUDFLARE_ACCOUNT_ID}" \
  --arg bucket "${R2_BUCKET}" \
  'select(.success == true and (.result.accessKeyId | type == "string" and length > 0) and (.result.secretAccessKey | type == "string" and test("^[0-9a-f]{64}$")) and (.result.sessionToken | type == "string" and length > 0))
   | {account_id: $account_id, bucket: $bucket, access_key_id: .result.accessKeyId, secret_access_key: .result.secretAccessKey, session_token: .result.sessionToken}' \
  "${MINT_RESPONSE}")" || {
  ERROR_MESSAGE="$(cloudflare_errors "${MINT_RESPONSE}")"
  printf 'Cloudflare could not mint the R2 child credential (HTTP %s%s).\n' \
    "${MINT_STATUS}" "${ERROR_MESSAGE:+: ${ERROR_MESSAGE}}" >&2
  printf 'The parent must be an active R2 API token with Object Read access to %s.\n' "${R2_BUCKET}" >&2
  exit 1
}

SECRET_VERSION="$(printf '%s' "${CHILD_DOCUMENT}" | gcloud secrets versions add "${SECRET_ID}" \
  --project "${PROJECT_ID}" --data-file=- --format='value(name)')" || {
  printf 'Google Secret Manager did not accept the new child credential version.\n' >&2
  exit 1
}

jq -cn \
  --arg secret "${SECRET_ID}" \
  --arg version "${SECRET_VERSION}" \
  --argjson ttl_seconds "${TTL_SECONDS}" \
  '{status: "published", secret: $secret, version: $version, permission: "object-read-only", prefix_count: 7, ttl_seconds: $ttl_seconds}'
