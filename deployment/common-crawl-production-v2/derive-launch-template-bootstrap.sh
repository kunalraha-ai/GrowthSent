#!/usr/bin/env bash
# User data for the dedicated 10K derived-backlink workers. It never starts a job.
set -Eeuo pipefail
readonly DIR="/etc/growthsent/common-crawl-backlink-derived-v1"
readonly FILE="$DIR/launch-identity.env"
validate_derive_identity() {
  [[ "$RUN_ID" == "cc-main-2026-30-first-10000" ]] || return 2
  [[ "$DERIVE_SHARD_COUNT" == "10" ]] || return 2
  [[ "$DERIVE_SHARD_ID" =~ ^[0-9]+$ ]] && (( DERIVE_SHARD_ID >= 0 && DERIVE_SHARD_ID < 10 )) || return 2
}
token="$(curl --noproxy '*' --fail --silent --show-error --max-time 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')"
read_tag() { curl --noproxy '*' --fail --silent --show-error --max-time 2 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/tags/instance/$1"; }
RUN_ID="$(read_tag RunId)"; DERIVE_SHARD_ID="$(read_tag DeriveShardId)"; DERIVE_SHARD_COUNT="$(read_tag DeriveShardCount)"
validate_derive_identity || exit $?
install -d -m 0755 "$DIR"; temporary="$(mktemp "$DIR/.launch-identity.XXXXXX")"; umask 077
printf 'RUN_ID=%s\nDERIVE_SHARD_ID=%s\nDERIVE_SHARD_COUNT=%s\n' "$RUN_ID" "$DERIVE_SHARD_ID" "$DERIVE_SHARD_COUNT" > "$temporary"
install -m 0600 "$temporary" "$FILE"; rm -f "$temporary"
