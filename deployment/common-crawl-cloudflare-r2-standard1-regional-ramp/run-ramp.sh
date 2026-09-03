#!/bin/sh
set -eu

: "${GROWTHSENT_HARD_TIMEOUT_SECONDS:?missing hard timeout}"
: "${GROWTHSENT_RAMP_ID:?missing ramp id}"
: "${GROWTHSENT_REGION:?missing region}"
: "${GROWTHSENT_REGION_INDEX:?missing region index}"
: "${GROWTHSENT_REGION_COUNT:?missing region count}"
: "${GROWTHSENT_TASK_COUNT:?missing task count}"

# The fixed slot stays up and accepts one WAT at a time over its private
# loopback HTTP endpoint. Each child task keeps the reviewed 110-minute
# timeout inside regional_ramp_server.py.
exec python /opt/growthsent/regional_ramp_server.py
