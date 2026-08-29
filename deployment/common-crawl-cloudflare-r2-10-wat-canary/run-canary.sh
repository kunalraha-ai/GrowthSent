#!/bin/sh
set -eu

: "${GROWTHSENT_HARD_TIMEOUT_SECONDS:?missing hard timeout}"
: "${GROWTHSENT_CANARY_ID:?missing canary id}"

exec /usr/bin/timeout --foreground --signal=TERM --kill-after=60s "${GROWTHSENT_HARD_TIMEOUT_SECONDS}s" \
  python /opt/growthsent/container_entry.py
