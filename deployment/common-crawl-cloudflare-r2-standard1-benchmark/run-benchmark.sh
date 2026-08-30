#!/bin/sh
set -eu

: "${GROWTHSENT_HARD_TIMEOUT_SECONDS:?missing hard timeout}"
: "${GROWTHSENT_BENCHMARK_ID:?missing benchmark id}"

exec /usr/bin/timeout --foreground --signal=TERM --kill-after=60s "${GROWTHSENT_HARD_TIMEOUT_SECONDS}s" \
  python /opt/growthsent/standard1_benchmark_entry.py
