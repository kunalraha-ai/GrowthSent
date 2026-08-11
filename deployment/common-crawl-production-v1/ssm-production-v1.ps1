[CmdletBinding()]
param(
    [ValidateSet("Start", "ValidateStartSetup", "Status", "Resume", "Stop")]
    [string]$Action = "Status",
    [ValidatePattern("^i-[0-9a-f]+$")]
    [string]$InstanceId = "i-0c169b6d31906aac4",
    [ValidateSet("us-east-1")]
    [string]$Region = "us-east-1",
    [switch]$ValidateSerializationOnly
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

# These values are intentionally constants, not parameters.  A caller cannot
# turn this control runner into another crawl, another prefix, or a larger run.
$ExpectedInstanceId = "i-0c169b6d31906aac4"
$ReleaseSha256 = "4c7e2024efb593d688a927308db26e575d0ecd9d8b84ebf2cf4a000cfdb52b80"
$ManifestSha256 = "6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a"
$Bucket = "growthsent-data-552648196041-us-east-1-an"
$Prefix = "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000"
$Crawl = "CC-MAIN-2026-30"
$InputPrefix = "crawl-data/CC-MAIN-2026-30/"
$MaxInputs = 1000
$Workers = 4
$FilesPerBatch = 16
$Unit = "growthsent-common-crawl-production-v1.service"
$UnitPath = "/etc/systemd/system/$Unit"
$ReleasePath = "/opt/growthsent/releases/$ReleaseSha256"
$Python = "/opt/growthsent/venv/bin/python"
$ControlDir = "/opt/growthsent/control/common-crawl-production-v1"
$WorkDir = "/opt/growthsent/work/common-crawl-production-v1"
$RemoteRunner = "$ControlDir/run-production-v1.sh"

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

    # This waits only for the short SSM control action (launch/status/stop),
    # never for the detached ingestion unit itself.
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

function New-RemoteProductionRunner {
    return @'
#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE="/opt/growthsent/releases/4c7e2024efb593d688a927308db26e575d0ecd9d8b84ebf2cf4a000cfdb52b80"
PYTHON="/opt/growthsent/venv/bin/python"
CONTROL_DIR="/opt/growthsent/control/common-crawl-production-v1"
WORK_DIR="/opt/growthsent/work/common-crawl-production-v1"
PATHS_FILE="$CONTROL_DIR/cc-main-2026-30-first-1000.paths"
LOG_FILE="$CONTROL_DIR/production-v1.log"
STATUS_FILE="$CONTROL_DIR/production-v1-status.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$CONTROL_DIR" "$WORK_DIR"
touch "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

write_lifecycle() {
  local state="$1"
  local exit_code="${2:-null}"
  "$PYTHON" - "$STATUS_FILE" "$state" "$exit_code" "$STARTED_AT" "$$" <<'PY'
import datetime
import json
import sys
from pathlib import Path

path, state, raw_exit_code, started_at, pid = sys.argv[1:]
exit_code = None if raw_exit_code == "null" else int(raw_exit_code)
payload = {
    "event": state,
    "crawl": "CC-MAIN-2026-30",
    "locked_input_count": 1000,
    "locked_inputs_sha256": "6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a",
    "release_sha256": "4c7e2024efb593d688a927308db26e575d0ecd9d8b84ebf2cf4a000cfdb52b80",
    "started_at": started_at,
    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "pid": int(pid),
    "exit_code": exit_code,
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

write_lifecycle "starting"
"$PYTHON" "$RELEASE/tools/common_crawl_v1_manifest.py" \
  --manifest "$RELEASE/manifests/cc-main-2026-30-first-1000.json" \
  --count 1000 \
  --output "$PATHS_FILE"

write_lifecycle "running"
set +e
"$PYTHON" "$RELEASE/tools/common_crawl_wat_ingest.py" \
  --crawl "CC-MAIN-2026-30" \
  --input-list "$PATHS_FILE" \
  --max-inputs 1000 \
  --expected-inputs-sha256 "6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a" \
  --require-source-prefix "crawl-data/CC-MAIN-2026-30/" \
  --workers 4 \
  --files-per-batch 16 \
  --output-dir "$WORK_DIR" \
  --resume \
  --upload \
  --remove-uploaded-local \
  --destination "s3://growthsent-data-552648196041-us-east-1-an/production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
exit_code="$?"
set -e

if [[ "$exit_code" -eq 0 ]]; then
  write_lifecycle "completed" 0
else
  write_lifecycle "failed" "$exit_code"
fi
exit "$exit_code"
'@
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

function New-RemoteSystemdUnit {
    return @'
[Unit]
Description=GrowthSent Common Crawl production-v1 bounded first-1000 ingestion
Wants=network-online.target
After=network-online.target
ConditionPathExists=/opt/growthsent/control/common-crawl-production-v1/run-production-v1.sh

[Service]
Type=simple
WorkingDirectory=/opt/growthsent/work/common-crawl-production-v1
ExecStart=/opt/growthsent/control/common-crawl-production-v1/run-production-v1.sh
KillSignal=SIGINT
KillMode=control-group
TimeoutStopSec=120
Restart=no
'@
}

function New-RemoteStartSetupScript {
    $template = @'
#!/usr/bin/env bash
set -Eeuo pipefail

MODE="__MODE__"
RELEASE="/opt/growthsent/releases/4c7e2024efb593d688a927308db26e575d0ecd9d8b84ebf2cf4a000cfdb52b80"
PYTHON="/opt/growthsent/venv/bin/python"
CONTROL_DIR="/opt/growthsent/control/common-crawl-production-v1"
WORK_DIR="/opt/growthsent/work/common-crawl-production-v1"
PATHS_FILE="$CONTROL_DIR/cc-main-2026-30-first-1000.paths"
RUNNER_PATH="$CONTROL_DIR/run-production-v1.sh"
UNIT="growthsent-common-crawl-production-v1.service"
UNIT_PATH="/etc/systemd/system/$UNIT"
RUNNER_B64_PATH="__RUNNER_B64_PATH__"
UNIT_B64_PATH="__UNIT_B64_PATH__"
RUNNER_SHA256="__RUNNER_SHA256__"
UNIT_SHA256="__UNIT_SHA256__"

mkdir -p "$CONTROL_DIR"
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

log "SETUP_BEGIN mode=$MODE"
run_step "verify installed release directory" test -d "$RELEASE"
run_step "verify bundle manifest" test -f "$RELEASE/BUNDLE-MANIFEST.json"
run_step "verify locked manifest file" test -f "$RELEASE/manifests/cc-main-2026-30-first-1000.json"
run_step "verify Python 3.12 venv" "$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12); print(sys.version)'
run_step "create lifecycle control directory" install -d -m 0755 "$CONTROL_DIR"
run_step "create work control directory" install -d -m 0755 "$WORK_DIR/control"
run_step "verify lifecycle control directory" test -d "$CONTROL_DIR"
run_step "verify work control directory" test -d "$WORK_DIR/control"
run_step "materialize locked first-1000 paths" "$PYTHON" "$RELEASE/tools/common_crawl_v1_manifest.py" --manifest "$RELEASE/manifests/cc-main-2026-30-first-1000.json" --count 1000 --output "$PATHS_FILE"
run_step "verify locked path list" test -s "$PATHS_FILE"
write_checked_file "runner" "$RUNNER_B64_PATH" "$RUNNER_SHA256" "$RUNNER_PATH" 0755
write_checked_file "unit" "$UNIT_B64_PATH" "$UNIT_SHA256" "$UNIT_PATH" 0644
run_step "reload systemd manager" systemctl daemon-reload
run_step "verify systemd unit syntax" systemd-analyze verify "$UNIT_PATH"
run_step "verify created unit file" test -f "$UNIT_PATH"
run_step "show created unit state" systemctl show "$UNIT" --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState

if [[ "$MODE" == "validate" ]]; then
  log "SETUP_VALIDATED_NOT_STARTED"
  exit 0
fi

if systemctl is-active --quiet "$UNIT"; then
  log "SETUP_REFUSES_TO_START active_unit=$UNIT"
  exit 2
fi
run_step "start production unit" systemctl start "$UNIT"
sleep 2
run_step "verify production unit active" systemctl is-active --quiet "$UNIT"
run_step "show started unit state" systemctl show "$UNIT" --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStartTimestamp
log "SETUP_STARTED"
'@
    return $template
}

function Get-StartSetupCommands {
    param([Parameter(Mandatory)] [ValidateSet("validate", "start")] [string]$Mode)

    # PowerShell source uses CRLF on Windows; the EC2 bash interpreter needs an
    # LF-only shebang and script body.
    $runner = (New-RemoteProductionRunner).Replace("`r`n", "`n")
    $unit = (New-RemoteSystemdUnit).Replace("`r`n", "`n")
    $runnerSha256 = Get-ByteSha256 $utf8.GetBytes($runner)
    $unitSha256 = Get-ByteSha256 $utf8.GetBytes($unit)
    $runnerBase64 = [Convert]::ToBase64String($utf8.GetBytes($runner))
    $unitBase64 = [Convert]::ToBase64String($utf8.GetBytes($unit))
    $runnerBase64Path = "/tmp/growthsent-common-crawl-production-v1-runner.b64"
    $unitBase64Path = "/tmp/growthsent-common-crawl-production-v1-unit.b64"
    $remoteSetup = "/tmp/growthsent-common-crawl-production-v1-setup.sh"
    $setup = (New-RemoteStartSetupScript).Replace("`r`n", "`n")
    $setup = $setup.Replace("__MODE__", $Mode).Replace("__RUNNER_B64_PATH__", $runnerBase64Path)
    $setup = $setup.Replace("__UNIT_B64_PATH__", $unitBase64Path).Replace("__RUNNER_SHA256__", $runnerSha256)
    $setup = $setup.Replace("__UNIT_SHA256__", $unitSha256)
    $setupBase64 = [Convert]::ToBase64String($utf8.GetBytes($setup))
    return @(
        "set -Eeuo pipefail",
        "echo 'SSM_SETUP write runner payload'",
        "printf '%s' '$runnerBase64' > '$runnerBase64Path'",
        "echo 'SSM_SETUP write unit payload'",
        "printf '%s' '$unitBase64' > '$unitBase64Path'",
        "echo 'SSM_SETUP write setup script'",
        "printf '%s' '$setupBase64' | base64 --decode > '$remoteSetup'",
        "chmod 0700 '$remoteSetup'",
        "echo 'SSM_SETUP execute mode=$Mode; setup log: $ControlDir/start-setup.log'",
        "bash '$remoteSetup'",
        "echo 'SSM_SETUP completed mode=$Mode'"
    )
}

function Get-StatusCommands {
    $summaryCommand = @"
if test -f '$WorkDir/control/run-summary.json'; then
  '$Python' - '$WorkDir/control/run-summary.json' <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    summary = json.load(handle)
print(json.dumps({
    "crawl": summary.get("crawl"),
    "workers": summary.get("workers"),
    "effective_workers": summary.get("effective_workers"),
    "manifest": summary.get("manifest"),
    "progress": summary.get("progress"),
    "aggregate": summary.get("aggregate"),
}, indent=2, sort_keys=True))
PY
else
  echo 'no completed run summary yet'
fi
"@
    return @(
        "set -euo pipefail",
        "echo '--- unit ---'",
        "systemctl show '$Unit' --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStatus --property=ExecMainStartTimestamp --property=ExecMainExitTimestamp || true",
        "echo '--- lifecycle status ---'",
        "test -f '$ControlDir/production-v1-status.json' && cat '$ControlDir/production-v1-status.json' || echo 'no lifecycle status file yet'",
        "echo '--- ingestion progress ---'",
        "test -f '$WorkDir/control/run-progress.json' && cat '$WorkDir/control/run-progress.json' || echo 'no ingestion progress file yet'",
        "echo '--- run summary ---'",
        $summaryCommand,
        "echo '--- recent production log ---'",
        "test -f '$ControlDir/production-v1.log' && tail -n 100 '$ControlDir/production-v1.log' || echo 'no production log yet'"
    )
}

function Get-StopCommands {
    return @(
        "set -euo pipefail",
        "if systemctl is-active --quiet '$Unit'; then systemctl stop '$Unit'; echo 'GROWTHSENT_PRODUCTION_V1_STOP_REQUESTED'; else echo 'GROWTHSENT_PRODUCTION_V1_NOT_RUNNING'; fi",
        "systemctl show '$Unit' --no-pager --property=Id --property=ActiveState --property=SubState --property=MainPID || true",
        "test -f '$ControlDir/production-v1-status.json' && cat '$ControlDir/production-v1-status.json' || true"
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
log() {
  printf '%s\n' "$*"
}
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
            $text -notmatch 'STEP_OK description=verify installed release directory command=test -d ') {
            throw "representative run_step test did not execute test -d: $text"
        }
        if ($text -notmatch 'STEP_START description=verify runner payload exists command=test -s ' -or
            $text -notmatch 'STEP_OK description=verify runner payload exists command=test -s ') {
            throw "representative run_step test did not execute test -s: $text"
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
        }
        if ($payload.Uri -notmatch '^file://[A-Za-z]:/') {
            throw "SSM parameters payload is not a Windows-compatible file URI: $($payload.Uri)"
        }
        foreach ($command in $Commands) {
            if ($command.Length -gt 16000) {
                throw "SSM command exceeds the 16,000-character safety limit"
            }
        }
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }
}

function Test-ProductionRunnerConfiguration {
    $runner = (New-RemoteProductionRunner).Replace("`r`n", "`n")
    if ($runner.Contains("`r") -or -not $runner.StartsWith("#!/usr/bin/env bash`n")) {
        throw "remote production runner is not an LF-only bash script"
    }
    $unit = (New-RemoteSystemdUnit).Replace("`r`n", "`n")
    if ($unit.Contains("`r") -or -not $unit.Contains("ExecStart=$RemoteRunner")) {
        throw "generated systemd unit is missing its fixed production runner"
    }
    $setup = (New-RemoteStartSetupScript).Replace("`r`n", "`n")
    $setup = $setup.Replace("__MODE__", "validate").Replace("__RUNNER_B64_PATH__", "/tmp/runner.b64")
    $setup = $setup.Replace("__UNIT_B64_PATH__", "/tmp/unit.b64").Replace("__RUNNER_SHA256__", (("0" * 64) -join ""))
    $setup = $setup.Replace("__UNIT_SHA256__", (("1" * 64) -join ""))
    if ($setup.Contains("`r") -or -not $setup.Contains("systemd-analyze verify")) {
        throw "generated start setup script is incomplete"
    }
    $obsoleteStepCalls = [regex]::Matches($setup, '(?m)^\s*step(?:\s|$)')
    if ($obsoleteStepCalls.Count -ne 0) {
        throw "generated start setup script contains obsolete step invocation(s): $($obsoleteStepCalls.Value -join ', ')"
    }
    Test-LocalBashSyntax -Name "production runner" -ScriptText $runner
    Test-LocalBashSyntax -Name "start setup" -ScriptText $setup
    Test-LocalRunStepExecution
    foreach ($required in @(
        "--count 1000", "--max-inputs 1000", "--workers 4", "--resume", "--upload",
        "--remove-uploaded-local", $ReleaseSha256, $ManifestSha256, $Prefix, $InputPrefix
    )) {
        if (-not $runner.Contains($required)) {
            throw "remote production runner is missing required scope lock: $required"
        }
    }
    foreach ($forbidden in @("dictionary", "MongoDB", "Atlas", "GrowthSent")) {
        if ($runner -cmatch [regex]::Escape($forbidden)) {
            throw "remote production runner contains out-of-scope text: $forbidden"
        }
    }
    Test-SsmCommandPayload -Commands (Get-StartSetupCommands -Mode "validate")
    Test-SsmCommandPayload -Commands (Get-StartSetupCommands -Mode "start")
    Test-SsmCommandPayload -Commands (Get-StatusCommands)
    Test-SsmCommandPayload -Commands (Get-StopCommands)
    Write-Output "Production-v1 scope, bash syntax, systemd unit, and SSM serialization validation passed."
}

if ($ValidateSerializationOnly) {
    Test-ProductionRunnerConfiguration
    exit 0
}
if ($InstanceId -cne $ExpectedInstanceId) {
    throw "this runner is locked to $ExpectedInstanceId, not $InstanceId"
}

switch ($Action) {
    "Start" {
        $comment = "Start bounded GrowthSent Common Crawl production-v1 first-1000 run"
        $commands = Get-StartSetupCommands -Mode "start"
    }
    "ValidateStartSetup" {
        $comment = "Validate GrowthSent Common Crawl production-v1 start setup without ingestion"
        $commands = Get-StartSetupCommands -Mode "validate"
    }
    "Status" {
        $comment = "Read-only GrowthSent Common Crawl production-v1 status"
        $commands = Get-StatusCommands
    }
    "Resume" {
        $comment = "Resume bounded GrowthSent Common Crawl production-v1 first-1000 run"
        $commands = Get-StartSetupCommands -Mode "start"
    }
    "Stop" {
        $comment = "Gracefully stop GrowthSent Common Crawl production-v1 run"
        $commands = Get-StopCommands
    }
}

$result = Invoke-SsmShellCommand -Comment $comment -Commands $commands
if (-not [string]::IsNullOrWhiteSpace($result.StandardOutputContent)) {
    Write-Output $result.StandardOutputContent
}
if (-not [string]::IsNullOrWhiteSpace($result.StandardErrorContent)) {
    Write-Warning $result.StandardErrorContent
}
