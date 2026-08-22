[CmdletBinding()]
param(
    [ValidateSet("InstallShard", "ValidateShardSetup", "Start", "Status", "Resume", "Stop")]
    [string]$Action = "Status",
    [string]$InstanceId,
    [ValidateSet("us-east-1")]
    [string]$Region = "us-east-1",
    [ValidatePattern("^[a-z0-9][a-z0-9-]{2,63}$")]
    [string]$RunId = "cc-main-2026-30-first-10000",
    [ValidateRange(0, 99999)]
    [int]$ShardId = 0,
    [ValidateRange(1, 100000)]
    [int]$ShardCount = 10,
    # Recovery may deliberately reduce source-read concurrency.  Never allow a
    # value above the reviewed four-worker production topology.
    [ValidateSet(1, 2, 4)]
    [int]$Workers = 4,
    [ValidatePattern("^[a-fA-F0-9]{64}$")]
    [string]$ReleaseSha256,
    # A reviewed release change for an already stopped shard must first be
    # materialized through ValidateShardSetup. Normal Start/Resume operations
    # remain fenced to the existing environment contract.
    [switch]$AllowReviewedReleaseUpgrade,
    # An expired running S3 lease is intentionally not taken over by default.
    # This explicit recovery acknowledgement is accepted only by -Action Resume
    # after an operator has confirmed the prior worker is stopped.
    [switch]$AcknowledgeExpiredLeaseTakeover,
    [switch]$ValidateSerializationOnly
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

# These are run-wide safety constants. Shard identity may be supplied only to
# select one already-built immutable shard manifest; it cannot expand scope.
$Crawl = "CC-MAIN-2026-30"
$ExpectedBaseInputCount = 10000
$MaxInputsPerShard = 1000
$FilesPerBatch = 16
$Bucket = "growthsent-data-552648196041-us-east-1-an"
$InputPrefix = "crawl-data/CC-MAIN-2026-30/"
$Python = "/opt/growthsent/venv/bin/python"
$LaunchIdentityFile = "/etc/growthsent/common-crawl-production-v2/launch-identity.env"

function Assert-ProductionV2Arguments {
    if ($ValidateSerializationOnly) { return }
    if ($AcknowledgeExpiredLeaseTakeover -and $Action -ne "Resume") {
        throw "-AcknowledgeExpiredLeaseTakeover is allowed only with -Action Resume"
    }
    if ($AllowReviewedReleaseUpgrade -and $Action -ne "ValidateShardSetup") {
        throw "-AllowReviewedReleaseUpgrade is allowed only with -Action ValidateShardSetup"
    }
    if ([string]::IsNullOrWhiteSpace($InstanceId) -or $InstanceId -notmatch "^i-[0-9a-f]+$") {
        throw "-InstanceId must be an explicit EC2 instance ID"
    }
    if ([string]::IsNullOrWhiteSpace($ReleaseSha256)) {
        throw "-ReleaseSha256 must be the reviewed 64-character v2 bundle SHA-256"
    }
    $requiredShardCount = [math]::Ceiling($ExpectedBaseInputCount / $MaxInputsPerShard)
    if ($ShardCount -ne $requiredShardCount) {
        throw "-ShardCount must be exactly $requiredShardCount for the locked $ExpectedBaseInputCount-input v2 run"
    }
    if ($ShardId -ge $ShardCount) {
        throw "-ShardId must be less than -ShardCount"
    }
}

function Get-ShardLabel {
    param(
        [Parameter(Mandatory)] [int]$Id,
        [Parameter(Mandatory)] [int]$Count
    )

    $width = [math]::Max(5, ([string]($Count - 1)).Length)
    return "shard-$($Id.ToString("D$width"))-of-$($Count.ToString("D$width"))"
}

function New-ProductionV2Contract {
    $release = $ReleaseSha256.ToLowerInvariant()
    $label = Get-ShardLabel -Id $ShardId -Count $ShardCount
    $controlWidth = [math]::Max(3, ([string]$ShardCount).Length)
    $controlLabel = "shard-$($ShardId.ToString("D$controlWidth"))-of-$($ShardCount.ToString("D$controlWidth"))"
    $releasePath = "/opt/growthsent/releases/$release"
    $controlDir = "/opt/growthsent/control/common-crawl-production-v2/$RunId/$label"
    $workDir = "/opt/growthsent/work/common-crawl-production-v2/$RunId/$label"
    return [PSCustomObject]@{
        RunId = $RunId
        ShardId = $ShardId
        ShardCount = $ShardCount
        ShardLabel = $label
        ControlShardLabel = $controlLabel
        ReleaseSha256 = $release
        ReleasePath = $releasePath
        BaseManifest = "$releasePath/manifests/base-manifest.json"
        ShardManifest = "$releasePath/manifests/shards/$label.json"
        ShardPlan = "$releasePath/manifests/shards/shard-plan.json"
        ControlDir = $controlDir
        WorkDir = $workDir
        PathsFile = "$controlDir/$label.paths"
        RunnerPath = "$controlDir/run-production-v2.sh"
        EnvironmentPath = "/etc/growthsent/common-crawl-production-v2/$RunId/$label.env"
        Unit = "growthsent-common-crawl-production-v2-$RunId-$label.service"
        Destination = "s3://$Bucket/production/common-crawl/wat-pages-links/v2/$RunId/"
        ControlPrefix = "control/shards/$controlLabel"
        AllowExpiredLeaseTakeover = [bool]$AcknowledgeExpiredLeaseTakeover
        AllowReviewedReleaseUpgrade = [bool]$AllowReviewedReleaseUpgrade
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)] [string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-AwsCli {
    param([Parameter(Mandatory)] [string[]]$AwsArguments)

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "aws"
    $startInfo.Arguments = (($AwsArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "unable to start AWS CLI" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

function New-SsmParametersPayload {
    param([Parameter(Mandatory)] [string[]]$Commands)

    $json = [ordered]@{ commands = [string[]]@($Commands) } | ConvertTo-Json -Compress -Depth 3
    $temporary = New-TemporaryFile
    [System.IO.File]::WriteAllText($temporary.FullName, $json, $utf8)
    return [PSCustomObject]@{
        Path = $temporary.FullName
        Uri = "file://$($temporary.FullName.Replace('\', '/'))"
        Json = $json
    }
}

function Invoke-SsmShellCommand {
    param(
        [Parameter(Mandatory)] [string]$Comment,
        [Parameter(Mandatory)] [string[]]$Commands
    )

    $payload = New-SsmParametersPayload -Commands $Commands
    try {
        $submitted = Invoke-AwsCli -AwsArguments @(
            "--no-cli-pager", "ssm", "send-command", "--region", $Region,
            "--document-name", "AWS-RunShellScript", "--instance-ids", $InstanceId,
            "--comment", $Comment, "--parameters", $payload.Uri, "--output", "json"
        )
        if ($submitted.ExitCode -ne 0) {
            throw "aws ssm send-command failed with exit code $($submitted.ExitCode). AWS CLI stderr:`n$($submitted.Stderr)"
        }
        try {
            $response = $submitted.Stdout | ConvertFrom-Json
        } catch {
            throw "aws ssm send-command returned invalid JSON. AWS CLI stderr:`n$($submitted.Stderr)`nAWS CLI stdout:`n$($submitted.Stdout)"
        }
        $commandId = [string]$response.Command.CommandId
        if ([string]::IsNullOrWhiteSpace($commandId)) {
            throw "aws ssm send-command returned no CommandId. AWS CLI stderr:`n$($submitted.Stderr)"
        }
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }

    # The SSM action only creates/inspects/stops a detached systemd unit. It
    # never waits for the long-running ingestion itself.
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ($true) {
        Start-Sleep -Seconds 3
        $invocation = Invoke-AwsCli -AwsArguments @(
            "--no-cli-pager", "ssm", "get-command-invocation", "--region", $Region,
            "--command-id", $commandId, "--instance-id", $InstanceId, "--output", "json"
        )
        if ($invocation.ExitCode -ne 0) {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "aws ssm get-command-invocation failed with exit code $($invocation.ExitCode). AWS CLI stderr:`n$($invocation.Stderr)"
            }
            continue
        }
        $result = $invocation.Stdout | ConvertFrom-Json
        if ($result.Status -notin @("Pending", "Delayed", "InProgress")) { break }
    }

    if ($result.Status -ne "Success") {
        throw "SSM command failed: $Comment ($commandId). Remote stderr:`n$($result.StandardErrorContent)`nRemote stdout:`n$($result.StandardOutputContent)"
    }
    return $result
}

function Get-ByteSha256 {
    param([Parameter(Mandatory)] [byte[]]$Bytes)

    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function New-RemoteEnvironmentFile {
    param([Parameter(Mandatory)] $Contract)

    return @"
RUN_ID=$($Contract.RunId)
SHARD_ID=$($Contract.ShardId)
SHARD_COUNT=$($Contract.ShardCount)
SHARD_LABEL=$($Contract.ShardLabel)
RELEASE_SHA256=$($Contract.ReleaseSha256)
RELEASE=$($Contract.ReleasePath)
PYTHON=$Python
CRAWL=$Crawl
INPUT_PREFIX=$InputPrefix
EXPECTED_BASE_INPUT_COUNT=$ExpectedBaseInputCount
MAX_INPUTS_PER_SHARD=$MaxInputsPerShard
WORKERS=$Workers
FILES_PER_BATCH=$FilesPerBatch
SOURCE_S3_BUCKET=commoncrawl
BASE_MANIFEST=$($Contract.BaseManifest)
SHARD_MANIFEST=$($Contract.ShardManifest)
CONTROL_DIR=$($Contract.ControlDir)
WORK_DIR=$($Contract.WorkDir)
PATHS_FILE=$($Contract.PathsFile)
DESTINATION=$($Contract.Destination)
CONTROL_PREFIX=$($Contract.ControlPrefix)
ALLOW_EXPIRED_LEASE_TAKEOVER=$($Contract.AllowExpiredLeaseTakeover.ToString().ToLowerInvariant())
ALLOW_REVIEWED_RELEASE_UPGRADE=$($Contract.AllowReviewedReleaseUpgrade.ToString().ToLowerInvariant())
"@.Replace("`r`n", "`n")
}

function New-RemoteProductionRunner {
    param([Parameter(Mandatory)] $Contract)

    $template = @'
#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="__ENVIRONMENT_PATH__"
if [[ ! -s "$ENV_FILE" ]]; then
  echo "missing protected shard environment: $ENV_FILE" >&2
  exit 2
fi
# This file is written by the SSM setup script with mode 0600 after the
# launch-identity contract is checked. It contains only validated identifiers.
set -a
source "$ENV_FILE"
set +a

readonly LOG_FILE="$CONTROL_DIR/production-v2.log"
readonly STATUS_FILE="$CONTROL_DIR/production-v2-status.json"
readonly MANIFEST_TOOL="$RELEASE/tools/common_crawl_v2_manifest.py"
readonly INGEST_TOOL="$RELEASE/tools/common_crawl_wat_ingest_v2.py"
readonly SHARD_PLAN="$RELEASE/manifests/shards/shard-plan.json"
readonly STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BASE_MANIFEST_SHA256="unavailable"
BASE_INPUTS_SHA256="unavailable"
SHARD_MANIFEST_SHA256="unavailable"
SHARD_INPUTS_SHA256="unavailable"
SHARD_INPUT_COUNT=0

mkdir -p "$CONTROL_DIR" "$WORK_DIR"
touch "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

write_lifecycle() {
  local state="$1"
  local exit_code="${2:-null}"
  "$PYTHON" - "$STATUS_FILE" "$state" "$exit_code" "$STARTED_AT" "$$" \
    "$RUN_ID" "$SHARD_ID" "$SHARD_COUNT" "$BASE_MANIFEST_SHA256" \
    "$SHARD_MANIFEST_SHA256" "$SHARD_INPUTS_SHA256" "$SHARD_INPUT_COUNT" <<'PY'
import datetime
import json
import sys
from pathlib import Path

(
    path, state, raw_exit_code, started_at, pid, run_id, shard_id, shard_count,
    base_sha256, shard_sha256, inputs_sha256, input_count,
) = sys.argv[1:]
payload = {
    "event": state,
    "crawl": "CC-MAIN-2026-30",
    "run_id": run_id,
    "shard": {
        "id": int(shard_id),
        "count": int(shard_count),
        "input_count": int(input_count),
        "inputs_sha256": inputs_sha256,
        "manifest_sha256": shard_sha256,
    },
    "base_manifest_sha256": base_sha256,
    "release_sha256": "__RELEASE_SHA256__",
    "started_at": started_at,
    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "pid": int(pid),
    "exit_code": None if raw_exit_code == "null" else int(raw_exit_code),
}
target = Path(path)
temporary = target.with_name(target.name + ".tmp")
temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
temporary.replace(target)
PY
}

on_signal() {
  write_lifecycle "stopped" 143 || true
  exit 143
}
on_error() {
  local exit_code="$?"
  write_lifecycle "failed" "$exit_code" || true
  exit "$exit_code"
}
trap on_signal INT TERM
trap on_error ERR

validate_environment() {
  [[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{2,63}$ ]] || { log "invalid RUN_ID"; return 2; }
  [[ "$SHARD_ID" =~ ^[0-9]+$ && "$SHARD_COUNT" =~ ^[0-9]+$ ]] || { log "invalid shard identity"; return 2; }
  (( SHARD_COUNT == 10 && SHARD_ID < SHARD_COUNT )) || {
    log "unsafe shard identity"; return 2;
  }
  [[ "$RELEASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { log "invalid release SHA-256"; return 2; }
  [[ "$EXPECTED_BASE_INPUT_COUNT" == "10000" && "$MAX_INPUTS_PER_SHARD" == "1000" ]] || {
    log "unexpected scope ceiling"; return 2;
  }
  [[ "$WORKERS" =~ ^(1|2|4)$ && "$FILES_PER_BATCH" == "16" ]] || { log "unexpected worker configuration"; return 2; }
  [[ "$SOURCE_S3_BUCKET" == "commoncrawl" ]] || { log "unexpected source S3 bucket"; return 2; }
}

verify_manifest_set() {
  local expected_suffix
  expected_suffix="$(printf '%05d' "$SHARD_COUNT")"
  mapfile -t shard_manifests < <(find "$(dirname "$SHARD_MANIFEST")" -maxdepth 1 -type f \
    -name "shard-*-of-${expected_suffix}.json" -print | LC_ALL=C sort)
  if (( ${#shard_manifests[@]} != SHARD_COUNT )); then
    log "locked shard manifest count mismatch expected=$SHARD_COUNT actual=${#shard_manifests[@]}"
    return 2
  fi
  "$PYTHON" "$MANIFEST_TOOL" verify --base-manifest "$BASE_MANIFEST" --shard-manifests "${shard_manifests[@]}" --shard-plan "$SHARD_PLAN" --expected-input-count "$EXPECTED_BASE_INPUT_COUNT"
}

load_shard_metadata() {
  mapfile -t metadata < <("$PYTHON" - "$BASE_MANIFEST" "$SHARD_MANIFEST" \
    "$RUN_ID" "$SHARD_ID" "$SHARD_COUNT" "$EXPECTED_BASE_INPUT_COUNT" "$MAX_INPUTS_PER_SHARD" <<'PY'
import hashlib
import json
import sys

base_path, shard_path, run_id, raw_shard_id, raw_shard_count, raw_total, raw_max = sys.argv[1:]
shard_id, shard_count, total, maximum = map(int, (raw_shard_id, raw_shard_count, raw_total, raw_max))
base = json.load(open(base_path, encoding="utf-8"))
shard = json.load(open(shard_path, encoding="utf-8"))
required_base = {"format_version", "kind", "run_id", "crawl", "input_count", "inputs_sha256", "manifest_sha256", "inputs"}
required_shard = required_base | {"shard_id", "shard_count", "base_manifest_sha256", "base_inputs_sha256", "first_input", "last_input"}
if not required_base.issubset(base) or not required_shard.issubset(shard):
    raise SystemExit("locked manifest is missing required v2 fields")
if base["run_id"] != run_id or shard["run_id"] != run_id or base["crawl"] != "CC-MAIN-2026-30" or shard["crawl"] != "CC-MAIN-2026-30":
    raise SystemExit("locked manifest identity mismatch")
if base["kind"] != "common-crawl-v2-base-manifest" or shard["kind"] != "common-crawl-v2-shard-manifest":
    raise SystemExit("locked manifest kind mismatch")
if base["input_count"] != total or len(base["inputs"]) != total or len(set(base["inputs"])) != total:
    raise SystemExit(f"base manifest is not exactly {total} unique inputs")
if shard["shard_id"] != shard_id or shard["shard_count"] != shard_count:
    raise SystemExit("shard identity does not match launch identity")
inputs = shard["inputs"]
if not 1 <= shard["input_count"] <= maximum or len(inputs) != shard["input_count"] or len(set(inputs)) != len(inputs):
    raise SystemExit("shard input count is unsafe or malformed")
digest = hashlib.sha256("\n".join(inputs).encode("utf-8")).hexdigest()
if digest != shard["inputs_sha256"]:
    raise SystemExit("shard input list hash mismatch")
if inputs[0] != shard["first_input"] or inputs[-1] != shard["last_input"]:
    raise SystemExit("shard first/last input mismatch")
if shard["base_manifest_sha256"] != base["manifest_sha256"] or shard["base_inputs_sha256"] != base["inputs_sha256"]:
    raise SystemExit("shard does not lock this base manifest")
for value in (base["manifest_sha256"], shard["manifest_sha256"], shard["inputs_sha256"]):
    if not isinstance(value, str) or len(value) != 64:
        raise SystemExit("invalid locked SHA-256")
print(base["manifest_sha256"])
print(base["inputs_sha256"])
print(shard["manifest_sha256"])
print(shard["inputs_sha256"])
print(shard["input_count"])
PY
  )
  if (( ${#metadata[@]} != 5 )); then
    log "unable to load locked shard metadata"
    return 2
  fi
  BASE_MANIFEST_SHA256="${metadata[0]}"
  BASE_INPUTS_SHA256="${metadata[1]}"
  SHARD_MANIFEST_SHA256="${metadata[2]}"
  SHARD_INPUTS_SHA256="${metadata[3]}"
  SHARD_INPUT_COUNT="${metadata[4]}"
}

materialize_locked_paths() {
  "$PYTHON" "$MANIFEST_TOOL" materialize-shard --base-manifest "$BASE_MANIFEST" --shard-manifest "$SHARD_MANIFEST" --output "$PATHS_FILE" --expected-input-count "$EXPECTED_BASE_INPUT_COUNT"
  "$PYTHON" - "$PATHS_FILE" "$SHARD_INPUT_COUNT" "$SHARD_INPUTS_SHA256" <<'PY'
import hashlib
import sys

path, expected_count, expected_sha256 = sys.argv[1:]
inputs = open(path, encoding="utf-8").read().splitlines()
actual_sha256 = hashlib.sha256("\n".join(inputs).encode("utf-8")).hexdigest()
if len(inputs) != int(expected_count) or actual_sha256 != expected_sha256 or len(set(inputs)) != len(inputs):
    raise SystemExit("materialized shard paths do not match the locked shard manifest")
PY
}

validate_environment
verify_manifest_set
load_shard_metadata
materialize_locked_paths
write_lifecycle "starting"

LEASE_OWNER="$(hostname -s)-$(cut -c1-8 /proc/sys/kernel/random/boot_id)-$$"
log "SHARD_START run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT inputs=$SHARD_INPUT_COUNT lease_owner=$LEASE_OWNER"
write_lifecycle "running"
lease_takeover_args=()
if [[ "$ALLOW_EXPIRED_LEASE_TAKEOVER" == "true" ]]; then
  log "EXPIRED_LEASE_TAKEOVER_ACKNOWLEDGED run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT"
  lease_takeover_args+=(--allow-expired-lease-takeover)
fi
set +e
"$PYTHON" "$INGEST_TOOL" \
  --max-inputs "$SHARD_INPUT_COUNT" \
  --expected-inputs-sha256 "$SHARD_INPUTS_SHA256" \
  --require-source-prefix "$INPUT_PREFIX" \
  --run-id "$RUN_ID" \
  --shard-id "$SHARD_ID" \
  --shard-count "$SHARD_COUNT" \
  --expected-base-input-count "$EXPECTED_BASE_INPUT_COUNT" \
  --base-manifest-sha256 "$BASE_MANIFEST_SHA256" \
  --base-inputs-sha256 "$BASE_INPUTS_SHA256" \
  --shard-manifest-sha256 "$SHARD_MANIFEST_SHA256" \
  --shard-inputs-sha256 "$SHARD_INPUTS_SHA256" \
  --base-manifest "$BASE_MANIFEST" \
  --shard-manifest "$SHARD_MANIFEST" \
  --shard-plan "$SHARD_PLAN" \
  --control-prefix "$CONTROL_PREFIX" \
  --shard-lease-owner "$LEASE_OWNER" \
  "${lease_takeover_args[@]}" \
  --workers "$WORKERS" \
  --files-per-batch "$FILES_PER_BATCH" \
  --source-s3-bucket "$SOURCE_S3_BUCKET" \
  --output-dir "$WORK_DIR" \
  --resume \
  --upload \
  --remove-uploaded-local \
  --destination "$DESTINATION"
exit_code="$?"
set -e

if [[ "$exit_code" -eq 0 ]]; then
  write_lifecycle "completed" 0
  log "SHARD_COMPLETED run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT"
else
  write_lifecycle "failed" "$exit_code"
  log "SHARD_FAILED run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT exit_code=$exit_code"
fi
exit "$exit_code"
'@
    return $template.Replace("__ENVIRONMENT_PATH__", $Contract.EnvironmentPath).Replace("__RELEASE_SHA256__", $Contract.ReleaseSha256)
}

function New-RemoteSystemdUnit {
    param([Parameter(Mandatory)] $Contract)

    return @"
[Unit]
Description=GrowthSent Common Crawl production-v2 $($Contract.RunId) $($Contract.ShardLabel) bounded ingestion
Wants=network-online.target
After=network-online.target
ConditionPathExists=$($Contract.RunnerPath)
ConditionPathExists=$($Contract.EnvironmentPath)

[Service]
Type=simple
WorkingDirectory=$($Contract.WorkDir)
EnvironmentFile=$($Contract.EnvironmentPath)
ExecStart=$($Contract.RunnerPath)
KillSignal=SIGINT
KillMode=control-group
TimeoutStopSec=120
Restart=no
"@.Replace("`r`n", "`n")
}

function New-RemoteStartSetupScript {
    param([Parameter(Mandatory)] $Contract)

    $template = @'
#!/usr/bin/env bash
set -Eeuo pipefail

MODE="__MODE__"
RUN_ID="__RUN_ID__"
SHARD_ID="__SHARD_ID__"
SHARD_COUNT="__SHARD_COUNT__"
SHARD_LABEL="__SHARD_LABEL__"
RELEASE="__RELEASE__"
PYTHON="__PYTHON__"
EXPECTED_BASE_INPUT_COUNT="__EXPECTED_BASE_INPUT_COUNT__"
CONTROL_DIR="__CONTROL_DIR__"
WORK_DIR="__WORK_DIR__"
PATHS_FILE="__PATHS_FILE__"
BASE_MANIFEST="__BASE_MANIFEST__"
SHARD_MANIFEST="__SHARD_MANIFEST__"
SHARD_PLAN="__SHARD_PLAN__"
MANIFEST_TOOL="$RELEASE/tools/common_crawl_v2_manifest.py"
INGEST_TOOL="$RELEASE/tools/common_crawl_wat_ingest_v2.py"
ENV_PATH="__ENV_PATH__"
RUNNER_PATH="__RUNNER_PATH__"
UNIT="__UNIT__"
UNIT_PATH="/etc/systemd/system/$UNIT"
IDENTITY_FILE="__IDENTITY_FILE__"
RUNNER_B64_PATH="__RUNNER_B64_PATH__"
ENV_B64_PATH="__ENV_B64_PATH__"
UNIT_B64_PATH="__UNIT_B64_PATH__"
RUNNER_SHA256="__RUNNER_SHA256__"
ENV_SHA256="__ENV_SHA256__"
UNIT_SHA256="__UNIT_SHA256__"
ALLOW_REVIEWED_RELEASE_UPGRADE="__ALLOW_REVIEWED_RELEASE_UPGRADE__"

install -d -m 0755 "$CONTROL_DIR"
SETUP_LOG="$CONTROL_DIR/start-setup.log"
touch "$SETUP_LOG"
exec > >(tee -a "$SETUP_LOG") 2>&1

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}
on_error() {
  local exit_code="$?"
  log "SETUP_FAILED exit_code=$exit_code line=$LINENO command=$BASH_COMMAND"
  exit "$exit_code"
}
trap on_error ERR
run_step() {
  local description="$1"
  shift
  local command
  printf -v command '%q ' "$@"
  command="${command% }"
  log "STEP_START description=$description command=$command"
  "$@"
  log "STEP_OK description=$description command=$command"
}
write_checked_file() {
  local label="$1"
  local payload_path="$2"
  local expected_sha256="$3"
  local destination="$4"
  local permissions="$5"
  local temporary
  run_step "verify $label payload exists" test -s "$payload_path"
  temporary="$(mktemp "$(dirname "$destination")/.${label}.XXXXXX")"
  log "STEP_START decode $label payload to $temporary"
  base64 --decode "$payload_path" > "$temporary"
  log "STEP_OK decode $label payload to $temporary"
  log "STEP_START verify $label SHA-256"
  printf '%s  %s\n' "$expected_sha256" "$temporary" | sha256sum --check --status -
  log "STEP_OK verify $label SHA-256"
  run_step "install $label at $destination" install -m "$permissions" "$temporary" "$destination"
  run_step "remove $label temporary file" rm -f "$temporary"
  run_step "verify $label exists at $destination" test -f "$destination"
}
verify_launch_identity() {
  run_step "verify launch identity file" test -s "$IDENTITY_FILE"
  set -a
  # The bootstrap validates values before writing this root-owned file.
  source "$IDENTITY_FILE"
  set +a
  [[ "$RUN_ID" == "__RUN_ID__" ]] || { log "launch RunId mismatch"; return 2; }
  [[ "$SHARD_ID" == "__SHARD_ID__" ]] || { log "launch ShardId mismatch"; return 2; }
  [[ "$SHARD_COUNT" == "__SHARD_COUNT__" ]] || { log "launch ShardCount mismatch"; return 2; }
}
verify_existing_environment_contract() {
  if [[ ! -e "$ENV_PATH" ]]; then
    return 0
  fi
  [[ -f "$ENV_PATH" && ! -L "$ENV_PATH" ]] || {
    log "existing shard environment is not a regular file"
    return 2
  }
  local existing_run existing_shard_id existing_shard_count existing_release
  existing_run="$(sed -n 's/^RUN_ID=//p' "$ENV_PATH")"
  existing_shard_id="$(sed -n 's/^SHARD_ID=//p' "$ENV_PATH")"
  existing_shard_count="$(sed -n 's/^SHARD_COUNT=//p' "$ENV_PATH")"
  existing_release="$(sed -n 's/^RELEASE_SHA256=//p' "$ENV_PATH")"
  [[ "$existing_run" == "__RUN_ID__" ]] || { log "existing shard environment RunId mismatch"; return 2; }
  [[ "$existing_shard_id" == "__SHARD_ID__" ]] || { log "existing shard environment ShardId mismatch"; return 2; }
  [[ "$existing_shard_count" == "__SHARD_COUNT__" ]] || { log "existing shard environment ShardCount mismatch"; return 2; }
  if [[ "$existing_release" != "__RELEASE_SHA256__" ]]; then
    [[ "$ALLOW_REVIEWED_RELEASE_UPGRADE" == "true" ]] || {
      log "existing shard environment release SHA mismatch"
      return 2
    }
    if systemctl is-active --quiet "$UNIT"; then
      log "refusing reviewed release upgrade while shard unit is active"
      return 2
    fi
    log "approved inactive shard release upgrade old=$existing_release new=__RELEASE_SHA256__"
  fi
}
verify_locked_manifest_set() {
  local expected_suffix
  expected_suffix="$(printf '%05d' "$SHARD_COUNT")"
  mapfile -t shard_manifests < <(find "$(dirname "$SHARD_MANIFEST")" -maxdepth 1 -type f \
    -name "shard-*-of-${expected_suffix}.json" -print | LC_ALL=C sort)
  (( ${#shard_manifests[@]} == SHARD_COUNT )) || {
    log "locked shard manifest count mismatch expected=$SHARD_COUNT actual=${#shard_manifests[@]}"
    return 2
  }
  "$PYTHON" "$MANIFEST_TOOL" verify --base-manifest "$BASE_MANIFEST" --shard-manifests "${shard_manifests[@]}" --shard-plan "$SHARD_PLAN" --expected-input-count "$EXPECTED_BASE_INPUT_COUNT"
}

log "SETUP_BEGIN mode=$MODE run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT"
run_step "verify installed release directory" test -d "$RELEASE"
run_step "verify bundle manifest" test -f "$RELEASE/BUNDLE-MANIFEST.json"
run_step "verify v2 manifest tool" test -f "$MANIFEST_TOOL"
run_step "verify v2 ingestion tool" test -f "$INGEST_TOOL"
run_step "verify locked base manifest" test -s "$BASE_MANIFEST"
run_step "verify locked shard manifest" test -s "$SHARD_MANIFEST"
run_step "verify locked shard plan" test -s "$SHARD_PLAN"
run_step "verify Python 3.12 venv" "$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12); print(sys.version)'
run_step "verify launch shard identity" verify_launch_identity
run_step "verify existing shard environment contract" verify_existing_environment_contract
run_step "verify full locked manifest set" verify_locked_manifest_set
run_step "create lifecycle control directory" install -d -m 0755 "$CONTROL_DIR"
run_step "create work control directory" install -d -m 0755 "$WORK_DIR/control"
run_step "create systemd environment directory" install -d -m 0755 "$(dirname "$ENV_PATH")"
write_checked_file "runner" "$RUNNER_B64_PATH" "$RUNNER_SHA256" "$RUNNER_PATH" 0755
write_checked_file "environment" "$ENV_B64_PATH" "$ENV_SHA256" "$ENV_PATH" 0600
write_checked_file "unit" "$UNIT_B64_PATH" "$UNIT_SHA256" "$UNIT_PATH" 0644
run_step "reload systemd manager" systemctl daemon-reload
run_step "verify systemd unit syntax" systemd-analyze verify "$UNIT_PATH"
run_step "verify created unit file" test -f "$UNIT_PATH"
run_step "verify created environment file" test -s "$ENV_PATH"
run_step "show created unit state" systemctl show "$UNIT" --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState

if [[ "$MODE" != "start" ]]; then
  log "SETUP_VALIDATED_NOT_STARTED mode=$MODE"
  exit 0
fi

if systemctl is-active --quiet "$UNIT"; then
  log "SETUP_REFUSES_TO_START active_unit=$UNIT"
  exit 2
fi
run_step "start bounded shard unit" systemctl start "$UNIT"
sleep 2
run_step "verify shard unit active" systemctl is-active --quiet "$UNIT"
run_step "show started shard unit state" systemctl show "$UNIT" --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStartTimestamp
log "SETUP_STARTED run=$RUN_ID shard=$SHARD_ID/$SHARD_COUNT"
'@
    $replacements = [ordered]@{
        "__MODE__" = "__MODE__"
        "__RUN_ID__" = $Contract.RunId
        "__SHARD_ID__" = [string]$Contract.ShardId
        "__SHARD_COUNT__" = [string]$Contract.ShardCount
        "__RELEASE_SHA256__" = $Contract.ReleaseSha256
        "__RELEASE__" = $Contract.ReleasePath
        "__PYTHON__" = $Python
        "__EXPECTED_BASE_INPUT_COUNT__" = [string]$ExpectedBaseInputCount
        "__CONTROL_DIR__" = $Contract.ControlDir
        "__WORK_DIR__" = $Contract.WorkDir
        "__PATHS_FILE__" = $Contract.PathsFile
        "__BASE_MANIFEST__" = $Contract.BaseManifest
        "__SHARD_MANIFEST__" = $Contract.ShardManifest
        "__SHARD_PLAN__" = $Contract.ShardPlan
        "__ENV_PATH__" = $Contract.EnvironmentPath
        "__RUNNER_PATH__" = $Contract.RunnerPath
        "__UNIT__" = $Contract.Unit
        "__IDENTITY_FILE__" = $LaunchIdentityFile
        "__RUNNER_B64_PATH__" = "__RUNNER_B64_PATH__"
        "__ENV_B64_PATH__" = "__ENV_B64_PATH__"
        "__UNIT_B64_PATH__" = "__UNIT_B64_PATH__"
        "__RUNNER_SHA256__" = "__RUNNER_SHA256__"
        "__ENV_SHA256__" = "__ENV_SHA256__"
        "__UNIT_SHA256__" = "__UNIT_SHA256__"
        "__ALLOW_REVIEWED_RELEASE_UPGRADE__" = $Contract.AllowReviewedReleaseUpgrade.ToString().ToLowerInvariant()
    }
    foreach ($entry in $replacements.GetEnumerator()) {
        if ($entry.Key -ne "__MODE__" -and $entry.Value -ne $entry.Key) {
            $template = $template.Replace($entry.Key, $entry.Value)
        }
    }
    return $template
}

function Get-StartSetupCommands {
    param(
        [Parameter(Mandatory)] $Contract,
        [Parameter(Mandatory)] [ValidateSet("install", "validate", "start")] [string]$Mode
    )

    $runner = (New-RemoteProductionRunner -Contract $Contract).Replace("`r`n", "`n")
    $environment = (New-RemoteEnvironmentFile -Contract $Contract).Replace("`r`n", "`n")
    $unit = (New-RemoteSystemdUnit -Contract $Contract).Replace("`r`n", "`n")
    $runnerSha256 = Get-ByteSha256 $utf8.GetBytes($runner)
    $environmentSha256 = Get-ByteSha256 $utf8.GetBytes($environment)
    $unitSha256 = Get-ByteSha256 $utf8.GetBytes($unit)
    $runnerBase64 = [Convert]::ToBase64String($utf8.GetBytes($runner))
    $environmentBase64 = [Convert]::ToBase64String($utf8.GetBytes($environment))
    $unitBase64 = [Convert]::ToBase64String($utf8.GetBytes($unit))
    $runnerBase64Path = "/tmp/growthsent-common-crawl-production-v2-$($Contract.ShardLabel)-runner.b64"
    $environmentBase64Path = "/tmp/growthsent-common-crawl-production-v2-$($Contract.ShardLabel)-environment.b64"
    $unitBase64Path = "/tmp/growthsent-common-crawl-production-v2-$($Contract.ShardLabel)-unit.b64"
    $remoteSetup = "/tmp/growthsent-common-crawl-production-v2-$($Contract.ShardLabel)-setup.sh"
    $setup = (New-RemoteStartSetupScript -Contract $Contract).Replace("`r`n", "`n")
    $setup = $setup.Replace("__MODE__", $Mode).Replace("__RUNNER_B64_PATH__", $runnerBase64Path)
    $setup = $setup.Replace("__ENV_B64_PATH__", $environmentBase64Path).Replace("__UNIT_B64_PATH__", $unitBase64Path)
    $setup = $setup.Replace("__RUNNER_SHA256__", $runnerSha256).Replace("__ENV_SHA256__", $environmentSha256)
    $setup = $setup.Replace("__UNIT_SHA256__", $unitSha256)
    $setupBase64 = [Convert]::ToBase64String($utf8.GetBytes($setup))
    return @(
        "set -Eeuo pipefail",
        "echo 'SSM_SETUP write v2 runner payload'",
        "printf '%s' '$runnerBase64' > '$runnerBase64Path'",
        "echo 'SSM_SETUP write v2 environment payload'",
        "printf '%s' '$environmentBase64' > '$environmentBase64Path'",
        "echo 'SSM_SETUP write v2 unit payload'",
        "printf '%s' '$unitBase64' > '$unitBase64Path'",
        "echo 'SSM_SETUP write v2 setup script'",
        "printf '%s' '$setupBase64' | base64 --decode > '$remoteSetup'",
        "chmod 0700 '$remoteSetup'",
        "echo 'SSM_SETUP execute mode=$Mode; setup log: $($Contract.ControlDir)/start-setup.log'",
        "bash '$remoteSetup'",
        "echo 'SSM_SETUP completed mode=$Mode'"
    )
}

function Get-StatusCommands {
    param([Parameter(Mandatory)] $Contract)

    $summaryCommand = @"
if test -f '$($Contract.WorkDir)/$($Contract.ControlPrefix)/run-summary.json'; then
  '$Python' - '$($Contract.WorkDir)/$($Contract.ControlPrefix)/run-summary.json' <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    summary = json.load(handle)
print(json.dumps({
    "run_id": summary.get("run_id"),
    "shard": summary.get("shard"),
    "manifest": summary.get("manifest"),
    "progress": summary.get("progress"),
    "aggregate": summary.get("aggregate"),
}, indent=2, sort_keys=True))
PY
else
  echo 'no completed shard summary yet'
fi
"@
    return @(
        "set -euo pipefail",
        "echo '--- unit ---'",
        "systemctl show '$($Contract.Unit)' --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStatus --property=ExecMainStartTimestamp --property=ExecMainExitTimestamp || true",
        "echo '--- lifecycle status ---'",
        "test -f '$($Contract.ControlDir)/production-v2-status.json' && cat '$($Contract.ControlDir)/production-v2-status.json' || echo 'no lifecycle status file yet'",
        "echo '--- shard ingestion progress ---'",
        "test -f '$($Contract.WorkDir)/$($Contract.ControlPrefix)/run-progress.json' && cat '$($Contract.WorkDir)/$($Contract.ControlPrefix)/run-progress.json' || echo 'no shard ingestion progress file yet'",
        "echo '--- shard run summary ---'",
        $summaryCommand,
        "echo '--- recent shard log ---'",
        "test -f '$($Contract.ControlDir)/production-v2.log' && tail -n 100 '$($Contract.ControlDir)/production-v2.log' || echo 'no shard production log yet'"
    )
}

function Get-StopCommands {
    param([Parameter(Mandatory)] $Contract)

    return @(
        "set -euo pipefail",
        "if systemctl is-active --quiet '$($Contract.Unit)'; then systemctl stop '$($Contract.Unit)'; echo 'GROWTHSENT_PRODUCTION_V2_SHARD_STOP_REQUESTED'; else echo 'GROWTHSENT_PRODUCTION_V2_SHARD_NOT_RUNNING'; fi",
        "systemctl show '$($Contract.Unit)' --no-pager --property=Id --property=ActiveState --property=SubState --property=MainPID || true",
        "test -f '$($Contract.ControlDir)/production-v2-status.json' && cat '$($Contract.ControlDir)/production-v2-status.json' || true"
    )
}

function Test-LocalBashSyntax {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$ScriptText
    )

    $gitBashCandidates = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files\Git\usr\bin\bash.exe"
    )
    $bash = $gitBashCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $bash) {
        throw "Git Bash is required locally to validate generated $Name shell syntax"
    }
    $temporary = New-TemporaryFile
    try {
        [System.IO.File]::WriteAllText($temporary.FullName, $ScriptText, $utf8)
        $syntaxOutput = & $bash -n $temporary.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "generated $Name shell syntax is invalid: $syntaxOutput"
        }
    } finally {
        Remove-Item -LiteralPath $temporary.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Test-LocalRunStepExecution {
    $gitBashCandidates = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files\Git\usr\bin\bash.exe"
    )
    $bash = $gitBashCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $bash) {
        throw "Git Bash is required locally to execute the representative run_step test"
    }
    $script = @'
#!/usr/bin/env bash
set -Eeuo pipefail
log() { printf '%s\n' "$*"; }
run_step() {
  local description="$1"
  shift
  local command
  printf -v command '%q ' "$@"
  command="${command% }"
  log "STEP_START description=$description command=$command"
  "$@"
  log "STEP_OK description=$description command=$command"
}
RELEASE_DIR="."
run_step "verify installed release directory" test -d "$RELEASE_DIR"
PAYLOAD_PATH="$0"
run_step "verify runner payload exists" test -s "$PAYLOAD_PATH"
'@.Replace("`r`n", "`n")
    $temporary = New-TemporaryFile
    try {
        [System.IO.File]::WriteAllText($temporary.FullName, $script, $utf8)
        $output = & $bash $temporary.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "representative run_step test failed: $output"
        }
        $text = $output -join "`n"
        if ($text -notmatch 'STEP_START description=verify installed release directory command=test -d ' -or
            $text -notmatch 'STEP_OK description=verify runner payload exists command=test -s ') {
            throw "representative run_step test did not execute the command after its description: $text"
        }
    } finally {
        Remove-Item -LiteralPath $temporary.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Test-SsmCommandPayload {
    param([Parameter(Mandatory)] [string[]]$Commands)

    $payload = New-SsmParametersPayload -Commands $Commands
    try {
        $bytes = [System.IO.File]::ReadAllBytes($payload.Path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            throw "SSM parameters payload unexpectedly has a UTF-8 byte-order mark"
        }
        $parsed = ($utf8.GetString($bytes) | ConvertFrom-Json)
        if ($payload.Json -notmatch '^\{"commands":\[' -or @($parsed.commands).Count -ne $Commands.Count) {
            throw "SSM parameters JSON is malformed or lost a command"
        }
        for ($index = 0; $index -lt $Commands.Count; $index++) {
            if ($parsed.commands[$index] -cne $Commands[$index]) {
                throw "SSM command serialization changed at index $index"
            }
            if ($Commands[$index].Length -gt 16000) {
                throw "SSM command exceeds the 16,000-character safety limit"
            }
        }
        if ($payload.Uri -notmatch '^file://[A-Za-z]:/') {
            throw "SSM parameters payload is not a Windows-compatible file URI: $($payload.Uri)"
        }
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ProductionV2RunnerConfiguration {
    $script:ReleaseSha256 = ("a" * 64) -join ""
    $script:RunId = "cc-main-2026-30-first-10000"
    $script:ShardId = 7
    $script:ShardCount = 10
    $script:Workers = 1
    $script:AllowReviewedReleaseUpgrade = $false
    $contract = New-ProductionV2Contract
    if ($contract.ShardLabel -ne "shard-00007-of-00010") {
        throw "v2 shard label is not deterministic: $($contract.ShardLabel)"
    }
    if ($contract.ControlPrefix -ne "control/shards/shard-007-of-010") {
        throw "v2 S3 control prefix does not match the ingester's canonical shard namespace: $($contract.ControlPrefix)"
    }
    $runner = (New-RemoteProductionRunner -Contract $contract).Replace("`r`n", "`n")
    $environment = (New-RemoteEnvironmentFile -Contract $contract).Replace("`r`n", "`n")
    $unit = (New-RemoteSystemdUnit -Contract $contract).Replace("`r`n", "`n")
    $setup = (New-RemoteStartSetupScript -Contract $contract).Replace("`r`n", "`n")
    $setup = $setup.Replace("__MODE__", "validate").Replace("__RUNNER_B64_PATH__", "/tmp/runner.b64")
    $setup = $setup.Replace("__ENV_B64_PATH__", "/tmp/environment.b64").Replace("__UNIT_B64_PATH__", "/tmp/unit.b64")
    $setup = $setup.Replace("__RUNNER_SHA256__", (("0" * 64) -join "")).Replace("__ENV_SHA256__", (("1" * 64) -join ""))
    $setup = $setup.Replace("__UNIT_SHA256__", (("2" * 64) -join ""))
    foreach ($text in @($runner, $environment, $unit, $setup)) {
        if ($text.Contains("`r")) { throw "generated v2 artifact contains CRLF" }
    }
    foreach ($required in @(
        '--max-inputs "$SHARD_INPUT_COUNT"', '--workers "$WORKERS"', "--resume", "--upload",
        "--remove-uploaded-local", "--run-id", "--shard-id", "--shard-count", "--base-manifest-sha256",
        "--base-inputs-sha256", "--shard-manifest-sha256", "--shard-inputs-sha256", "--base-manifest",
        "--shard-manifest", "--shard-plan", "--control-prefix", "--shard-lease-owner", "verify_manifest_set",
        "materialize-shard", "MAX_INPUTS_PER_SHARD", "EXPECTED_BASE_INPUT_COUNT", "--expected-base-input-count", "allow-expired-lease-takeover"
    )) {
        if (-not $runner.Contains($required)) { throw "generated v2 runner is missing required scope/control: $required" }
    }
    foreach ($forbidden in @("--input-list", "--crawl")) {
        if ($runner.Contains($forbidden)) {
            throw "generated v2 runner contains an unsupported v1-only ingestion argument: $forbidden"
        }
    }
    foreach ($required in @("MAX_INPUTS_PER_SHARD=1000", "EXPECTED_BASE_INPUT_COUNT=10000", "WORKERS=1", "SOURCE_S3_BUCKET=commoncrawl", "RUN_ID=$($contract.RunId)", "SHARD_LABEL=$($contract.ShardLabel)", "ALLOW_EXPIRED_LEASE_TAKEOVER=false", "ALLOW_REVIEWED_RELEASE_UPGRADE=false")) {
        if (-not $environment.Contains($required)) { throw "generated v2 environment is missing fixed identity/scope: $required" }
    }
    $script:AcknowledgeExpiredLeaseTakeover = $true
    $recoveryContract = New-ProductionV2Contract
    $recoveryEnvironment = (New-RemoteEnvironmentFile -Contract $recoveryContract).Replace("`r`n", "`n")
    if (-not $recoveryEnvironment.Contains("ALLOW_EXPIRED_LEASE_TAKEOVER=true")) {
        throw "generated v2 recovery environment does not require an explicit expired-lease acknowledgement"
    }
    $script:AcknowledgeExpiredLeaseTakeover = $false
    $script:AllowReviewedReleaseUpgrade = $true
    $upgradeContract = New-ProductionV2Contract
    $upgradeSetup = (New-RemoteStartSetupScript -Contract $upgradeContract).Replace("`r`n", "`n")
    if (-not $upgradeSetup.Contains('ALLOW_REVIEWED_RELEASE_UPGRADE="true"') -or -not $upgradeSetup.Contains('refusing reviewed release upgrade while shard unit is active')) {
        throw "generated v2 release-upgrade gate is missing"
    }
    $script:AllowReviewedReleaseUpgrade = $false
    if (-not $setup.Contains("verify_existing_environment_contract")) {
        throw "generated v2 setup does not fence a resume against a changed shard environment"
    }
    if (-not $unit.Contains("ExecStart=$($contract.RunnerPath)") -or -not $unit.Contains("EnvironmentFile=$($contract.EnvironmentPath)")) {
        throw "generated v2 systemd unit is missing its isolated runner/environment paths"
    }
    $obsoleteStepCalls = [regex]::Matches($setup, '(?m)^\s*step(?:\s|$)')
    if ($obsoleteStepCalls.Count -ne 0) {
        throw "generated v2 setup contains obsolete step invocation(s): $($obsoleteStepCalls.Value -join ', ')"
    }
    Test-LocalBashSyntax -Name "production-v2 runner" -ScriptText $runner
    Test-LocalBashSyntax -Name "production-v2 start setup" -ScriptText $setup
    Test-LocalBashSyntax -Name "production-v2 launch-template bootstrap" -ScriptText (Get-Content -Raw (Join-Path $PSScriptRoot "launch-template-bootstrap.sh"))
    Test-LocalRunStepExecution
    Test-SsmCommandPayload -Commands (Get-StartSetupCommands -Contract $contract -Mode "install")
    Test-SsmCommandPayload -Commands (Get-StartSetupCommands -Contract $contract -Mode "validate")
    Test-SsmCommandPayload -Commands (Get-StartSetupCommands -Contract $contract -Mode "start")
    Test-SsmCommandPayload -Commands (Get-StatusCommands -Contract $contract)
    Test-SsmCommandPayload -Commands (Get-StopCommands -Contract $contract)
    Write-Output "Production-v2 shard runner, launch-template contract, bash syntax, and SSM serialization validation passed."
}

if ($ValidateSerializationOnly) {
    Test-ProductionV2RunnerConfiguration
    exit 0
}

Assert-ProductionV2Arguments
$contract = New-ProductionV2Contract
switch ($Action) {
    "InstallShard" {
        $comment = "Install bounded GrowthSent Common Crawl production-v2 $($contract.ShardLabel) without ingestion"
        $commands = Get-StartSetupCommands -Contract $contract -Mode "install"
    }
    "ValidateShardSetup" {
        $comment = "Validate bounded GrowthSent Common Crawl production-v2 $($contract.ShardLabel) without ingestion"
        $commands = Get-StartSetupCommands -Contract $contract -Mode "validate"
    }
    "Start" {
        $comment = "Start bounded GrowthSent Common Crawl production-v2 $($contract.ShardLabel)"
        $commands = Get-StartSetupCommands -Contract $contract -Mode "start"
    }
    "Resume" {
        $comment = "Resume the same bounded GrowthSent Common Crawl production-v2 $($contract.ShardLabel)"
        $commands = Get-StartSetupCommands -Contract $contract -Mode "start"
    }
    "Status" {
        $comment = "Read-only GrowthSent Common Crawl production-v2 $($contract.ShardLabel) status"
        $commands = Get-StatusCommands -Contract $contract
    }
    "Stop" {
        $comment = "Gracefully stop GrowthSent Common Crawl production-v2 $($contract.ShardLabel)"
        $commands = Get-StopCommands -Contract $contract
    }
}

Invoke-SsmShellCommand -Comment $comment -Commands $commands | ForEach-Object {
    Write-Output $_.StandardOutputContent
}
