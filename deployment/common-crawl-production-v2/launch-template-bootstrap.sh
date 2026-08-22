#!/usr/bin/env bash
# GrowthSent Common Crawl production-v2 launch-template bootstrap.
#
# This script intentionally does NOT install a release, start systemd, invoke
# SSM, download Common Crawl data, or access S3. It only persists the immutable
# run/shard identity supplied as EC2 instance tags. The SSM control runner
# refuses to install or start a shard whose requested identity differs from
# this file.
#
# Launch Template requirements:
# - HttpTokens=required (IMDSv2 only)
# - InstanceMetadataTags=enabled
# - distinct immutable tags RunId, ShardId, ShardCount on every worker
# - the instance role must not be able to mutate these identity tags
set -Eeuo pipefail

IDENTITY_DIR="/etc/growthsent/common-crawl-production-v2"
IDENTITY_FILE="$IDENTITY_DIR/launch-identity.env"
IMDS_TOKEN_URL="http://169.254.169.254/latest/api/token"
IMDS_TAG_URL="http://169.254.169.254/latest/meta-data/tags/instance"

validate_launch_identity() {
  [[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{2,63}$ ]] || { echo "invalid RunId tag" >&2; return 2; }
  [[ "$RUN_ID" == "cc-main-2026-30-first-10000" ]] || { echo "unexpected RunId tag" >&2; return 2; }
  [[ "$SHARD_ID" =~ ^[0-9]+$ ]] || { echo "invalid ShardId tag" >&2; return 2; }
  [[ "$SHARD_COUNT" =~ ^[0-9]+$ ]] || { echo "invalid ShardCount tag" >&2; return 2; }
  (( SHARD_COUNT == 10 )) || { echo "invalid shard count" >&2; return 2; }
  (( SHARD_ID >= 0 && SHARD_ID < 10 )) || { echo "invalid shard identity" >&2; return 2; }
}

token="$(curl --noproxy '*' --fail --silent --show-error --max-time 2 \
  --request PUT "$IMDS_TOKEN_URL" \
  --header "X-aws-ec2-metadata-token-ttl-seconds: 21600")"

read_tag() {
  local name="$1"
  curl --noproxy '*' --fail --silent --show-error --max-time 2 \
    --header "X-aws-ec2-metadata-token: $token" \
    "$IMDS_TAG_URL/$name"
}

RUN_ID="$(read_tag RunId)"
SHARD_ID="$(read_tag ShardId)"
SHARD_COUNT="$(read_tag ShardCount)"

validate_launch_identity || exit $?

install -d -m 0755 "$IDENTITY_DIR"
temporary="$(mktemp "$IDENTITY_DIR/.launch-identity.XXXXXX")"
umask 077
printf 'RUN_ID=%s\nSHARD_ID=%s\nSHARD_COUNT=%s\n' "$RUN_ID" "$SHARD_ID" "$SHARD_COUNT" > "$temporary"
install -m 0600 "$temporary" "$IDENTITY_FILE"
rm -f "$temporary"

echo "GrowthSent Common Crawl v2 launch identity recorded: run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT"
