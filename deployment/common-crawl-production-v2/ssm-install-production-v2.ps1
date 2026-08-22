[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern("^i-[0-9a-f]+$")]
    [string]$InstanceId,
    [ValidateSet("us-east-1")]
    [string]$Region = "us-east-1",
    [string]$BundlePath,
    [switch]$ValidateSerializationOnly
)

# This is intentionally an installation-only controller.  It never invokes an
# ingester, creates a shard lease, writes an S3 object, or creates a systemd
# unit.  The separate ssm-production-v2.ps1 controller owns those actions.
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

if ([string]::IsNullOrWhiteSpace($BundlePath)) {
    $BundlePath = Join-Path $PSScriptRoot "growthsent-common-crawl-v2-10k.tar.gz"
}

$BundleRoot = "growthsent-common-crawl-production-v2"
$ExpectedBundleSha256 = "c1396f11e1eaee2d3100fdafa02577023341378922826bc5ab95976978fe27e2"
$ExpectedBundleBytes = 122308
$ExpectedRunId = "cc-main-2026-30-first-10000"
$ExpectedCrawl = "CC-MAIN-2026-30"
$ExpectedBaseInputCount = 10000
$ExpectedShardCount = 10
$ExpectedBaseInputsSha256 = "85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226"
$ExpectedBaseManifestSha256 = "721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0"
$ExpectedShardPlanSha256 = "6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a"
$ChunkCharacters = 6000
# Keep each AWS-RunShellScript JSON request comfortably below the documented
# command-payload boundary.  The v2 archive is larger than v1, so it is sent
# as several SSM control-channel requests rather than one oversized request.
$ChunksPerSsmRequest = 8

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)] [string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\\"')
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
    if (-not $process.Start()) {
        throw "unable to start AWS CLI"
    }
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

    # A temporary JSON file avoids PowerShell/AWS CLI/shell quoting ambiguity,
    # including arbitrary Base64 punctuation and shell command quotes.
    $json = [ordered]@{ commands = [string[]]@($Commands) } | ConvertTo-Json -Compress -Depth 3
    $temporary = New-TemporaryFile
    [System.IO.File]::WriteAllText($temporary.FullName, $json, $utf8)
    return [PSCustomObject]@{
        Path = $temporary.FullName
        Uri = "file://$($temporary.FullName.Replace('\', '/'))"
        Json = $json
    }
}

function Assert-SsmCommandPayload {
    param([Parameter(Mandatory)] [string[]]$Commands)

    if ($Commands.Count -eq 0) {
        throw "SSM command payload must not be empty"
    }
    $payload = New-SsmParametersPayload -Commands $Commands
    try {
        $bytes = [System.IO.File]::ReadAllBytes($payload.Path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            throw "SSM parameters JSON unexpectedly has a UTF-8 byte-order mark"
        }
        $parsed = $utf8.GetString($bytes) | ConvertFrom-Json
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
        if ($bytes.Length -gt 60000) {
            throw "SSM parameters JSON exceeds the conservative 60,000-byte request safety limit"
        }
        if ($payload.Uri -notmatch '^file://[A-Za-z]:/') {
            throw "SSM parameters payload is not a Windows-compatible file URI: $($payload.Uri)"
        }
    } finally {
        Remove-Item -LiteralPath $payload.Path -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-SsmRunShellScript {
    param(
        [Parameter(Mandatory)] [string]$Comment,
        [Parameter(Mandatory)] [string[]]$Commands,
        [int]$DeadlineMinutes = 30
    )

    Assert-SsmCommandPayload -Commands $Commands
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

    $deadline = [DateTime]::UtcNow.AddMinutes($DeadlineMinutes)
    do {
        Start-Sleep -Seconds 5
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
        try {
            $result = $invocation.Stdout | ConvertFrom-Json
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "aws ssm get-command-invocation returned invalid JSON. AWS CLI stderr:`n$($invocation.Stderr)"
            }
            continue
        }
    } while ($result.Status -in @("Pending", "Delayed", "InProgress"))

    if ($result.Status -ne "Success") {
        throw "SSM command failed: $Comment ($commandId). Remote stderr:`n$($result.StandardErrorContent)`nRemote stdout:`n$($result.StandardOutputContent)"
    }
    return $result
}

function Get-LocalPython {
    $command = Get-Command python -ErrorAction Stop
    return $command.Source
}

function Invoke-LocalPython {
    param(
        [Parameter(Mandatory)] [string]$Code,
        [Parameter()] [string[]]$Arguments = @()
    )

    $python = Get-LocalPython
    $scriptPath = New-TemporaryFile
    $stderrPath = New-TemporaryFile
    try {
        [System.IO.File]::WriteAllText($scriptPath.FullName, $Code, $utf8)
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = & $python $scriptPath.FullName @Arguments 2> $stderrPath.FullName
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        $stderr = Get-Content -LiteralPath $stderrPath.FullName -Raw
        if ($exitCode -ne 0) {
            throw "local Python validation failed:`n$($output -join "`n")`n$stderr"
        }
        return ($output -join "`n")
    } finally {
        Remove-Item -LiteralPath $scriptPath.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-LocalProductionManifestVerifier {
    param([Parameter(Mandatory)] [string]$ReleasePath)

    $python = Get-LocalPython
    $output = & $python (Join-Path $ReleasePath "tools/verify_common_crawl_v2_run.py") `
        --base-manifest (Join-Path $ReleasePath "manifests/base-manifest.json") `
        --shard-dir (Join-Path $ReleasePath "manifests/shards") `
        --shard-plan (Join-Path $ReleasePath "manifests/shards/shard-plan.json") `
        --expected-input-count $ExpectedBaseInputCount 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "local v2 production manifest verification failed:`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

function Test-LocalBundleArchive {
    param(
        [Parameter(Mandatory)] [string]$ResolvedBundle,
        [Parameter(Mandatory)] [string]$ArchiveSha256,
        [Parameter(Mandatory)] [long]$ArchiveBytes
    )

    if ($ArchiveSha256 -cne $ExpectedBundleSha256) {
        throw "reviewed bundle SHA-256 mismatch: expected $ExpectedBundleSha256, got $ArchiveSha256"
    }
    if ($ArchiveBytes -ne $ExpectedBundleBytes) {
        throw "reviewed bundle byte-length mismatch: expected $ExpectedBundleBytes, got $ArchiveBytes"
    }

    $archiveValidation = @'
import hashlib
import json
import sys
import tarfile

archive_path, expected_root = sys.argv[1:]
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if not members:
        raise SystemExit("bundle archive is empty")
    if any(not member.isfile() for member in members):
        raise SystemExit("bundle archive must contain only regular files")
    if any(member.name.startswith("/") or ".." in member.name.split("/") for member in members):
        raise SystemExit("bundle archive contains an unsafe member path")
    roots = {member.name.split("/", 1)[0] for member in members}
    if roots != {expected_root}:
        raise SystemExit(f"bundle archive root must be {expected_root!r}, got {sorted(roots)!r}")
    prefix = expected_root + "/"
    if any(not member.name.startswith(prefix) for member in members):
        raise SystemExit("bundle archive member is outside its release root")
    by_relative_path = {member.name[len(prefix):]: member for member in members}
    manifest_member = by_relative_path.get("BUNDLE-MANIFEST.json")
    if manifest_member is None:
        raise SystemExit("bundle archive does not contain BUNDLE-MANIFEST.json")
    manifest = json.load(archive.extractfile(manifest_member))
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise SystemExit("BUNDLE-MANIFEST.json files map is missing")
    payload_paths = set(by_relative_path) - {"BUNDLE-MANIFEST.json"}
    if payload_paths != set(files):
        missing = sorted(set(files) - payload_paths)
        extra = sorted(payload_paths - set(files))
        raise SystemExit(f"bundle payload files mismatch missing={missing[:3]} extra={extra[:3]}")
    for relative_path, expected in files.items():
        member = by_relative_path[relative_path]
        if not isinstance(expected, dict) or member.size != expected.get("bytes"):
            raise SystemExit(f"bundle byte length mismatch for {relative_path}")
        digest = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
        if digest != expected.get("sha256"):
            raise SystemExit(f"bundle SHA-256 mismatch for {relative_path}")
    required = {
        "bundle_format_version": 2,
        "bundle_name": "growthsent-common-crawl-production-v2",
        "run_id": "cc-main-2026-30-first-10000",
        "crawl": "CC-MAIN-2026-30",
        "base_input_count": 10000,
        "shard_count": 10,
        "base_inputs_sha256": "85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226",
        "base_manifest_sha256": "721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0",
        "shard_plan_sha256": "6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a",
    }
    for key, value in required.items():
        if manifest.get(key) != value:
            raise SystemExit(f"BUNDLE-MANIFEST.json {key} does not match the reviewed v2 contract")
    for required_path in (
        "tools/common_crawl_v2_manifest.py",
        "tools/common_crawl_wat_ingest_v2.py",
        "tools/promote_common_crawl_v1_shard0_to_v2.py",
        "tools/common_crawl_backlink_derive.py",
        "tools/common_crawl_backlink_derive_production_v1.py",
        "runners/backlink-derived-canary-run.sh",
        "runners/backlink-derived-production-10k-run.sh",
        "runners/launch-template-bootstrap.sh",
        "runners/derive-launch-template-bootstrap.sh",
        "systemd/backlink-derived-production-10k.service.template",
        "config/derive-rollup-hosts.txt",
        "manifests/base-manifest.json",
        "manifests/shards/shard-plan.json",
        "requirements.txt",
    ):
        if required_path not in files:
            raise SystemExit(f"BUNDLE-MANIFEST.json is missing required file {required_path}")
print(json.dumps({"bundle_files": len(files), "archive_members": len(members)}, sort_keys=True))
'@
    return Invoke-LocalPython -Code $archiveValidation -Arguments @($ResolvedBundle, $BundleRoot)
}

function Resolve-ReviewedBundle {
    if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
        throw "production-v2 bundle was not found: $BundlePath"
    }
    $resolvedBundle = (Resolve-Path -LiteralPath $BundlePath).Path
    $archiveSha256 = (Get-FileHash -LiteralPath $resolvedBundle -Algorithm SHA256).Hash.ToLowerInvariant()
    $archiveBytes = (Get-Item -LiteralPath $resolvedBundle).Length
    $archiveReport = Test-LocalBundleArchive -ResolvedBundle $resolvedBundle -ArchiveSha256 $archiveSha256 -ArchiveBytes $archiveBytes
    return [PSCustomObject]@{
        Path = $resolvedBundle
        Sha256 = $archiveSha256
        Bytes = $archiveBytes
        ReleasePath = "/opt/growthsent/releases/$archiveSha256"
        ArchiveReport = $archiveReport
    }
}

function New-RemoteBundleContractVerifier {
    $template = @'
verify_bundle_contract() {
  /usr/bin/python3.12 - "$RELEASE" "$EXPECTED_ARCHIVE_SHA256" "$EXPECTED_ARCHIVE_BYTES" <<'PY'
import hashlib
import json
import pathlib
import sys

release = pathlib.Path(sys.argv[1])
expected_archive_sha256 = sys.argv[2]
expected_archive_bytes = int(sys.argv[3])
if not release.is_dir() or release.is_symlink():
    raise SystemExit("installed release directory is missing or unsafe")
manifest_path = release / "BUNDLE-MANIFEST.json"
metadata_path = release / "INSTALL-METADATA.json"
if not manifest_path.is_file() or manifest_path.is_symlink():
    raise SystemExit("BUNDLE-MANIFEST.json is missing or unsafe")
if not metadata_path.is_file() or metadata_path.is_symlink():
    raise SystemExit("INSTALL-METADATA.json is missing or unsafe")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
required = {
    "bundle_format_version": 2,
    "bundle_name": "growthsent-common-crawl-production-v2",
    "run_id": "cc-main-2026-30-first-10000",
    "crawl": "CC-MAIN-2026-30",
    "base_input_count": 10000,
    "shard_count": 10,
    "base_inputs_sha256": "85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226",
    "base_manifest_sha256": "721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0",
    "shard_plan_sha256": "6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a",
}
for key, value in required.items():
    if manifest.get(key) != value:
        raise SystemExit(f"BUNDLE-MANIFEST.json {key} does not match the reviewed v2 contract")
if metadata != {
    "archive_bytes": expected_archive_bytes,
    "bundle_sha256": expected_archive_sha256,
    "format_version": 1,
}:
    raise SystemExit("INSTALL-METADATA.json does not bind this release to the reviewed bundle SHA")
files = manifest.get("files")
if not isinstance(files, dict) or not files:
    raise SystemExit("BUNDLE-MANIFEST.json files map is missing")
actual = set()
for path in release.rglob("*"):
    if path.is_symlink():
        raise SystemExit(f"installed release contains a symlink: {path.relative_to(release)}")
    if path.is_file():
        relative = path.relative_to(release).as_posix()
        if relative not in {"BUNDLE-MANIFEST.json", "INSTALL-METADATA.json"}:
            actual.add(relative)
if actual != set(files):
    missing = sorted(set(files) - actual)
    extra = sorted(actual - set(files))
    raise SystemExit(f"installed release payload files mismatch missing={missing[:3]} extra={extra[:3]}")
for relative, expected in files.items():
    path = release / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"installed required file is missing or unsafe: {relative}")
    if path.stat().st_size != expected.get("bytes"):
        raise SystemExit(f"installed file byte length mismatch: {relative}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected.get("sha256"):
        raise SystemExit(f"installed file SHA-256 mismatch: {relative}")
for relative in (
  "tools/common_crawl_v2_manifest.py",
  "tools/common_crawl_wat_ingest_v2.py",
  "tools/promote_common_crawl_v1_shard0_to_v2.py",
  "tools/common_crawl_backlink_derive.py",
  "tools/common_crawl_backlink_derive_production_v1.py",
  "runners/backlink-derived-canary-run.sh",
  "runners/backlink-derived-production-10k-run.sh",
  "runners/launch-template-bootstrap.sh",
  "runners/derive-launch-template-bootstrap.sh",
  "systemd/backlink-derived-production-10k.service.template",
  "config/derive-rollup-hosts.txt",
    "manifests/base-manifest.json",
    "manifests/shards/shard-plan.json",
    "requirements.txt",
):
    if relative not in files:
        raise SystemExit(f"installed release is missing required bundle member: {relative}")
PY
}
'@
    return $template
}

function New-RemoteInstallProbeScript {
    param([Parameter(Mandatory)] $Bundle)

    $verifier = New-RemoteBundleContractVerifier
    $template = @'
#!/usr/bin/env bash
set -Eeuo pipefail
RELEASE="__RELEASE__"
EXPECTED_ARCHIVE_SHA256="__ARCHIVE_SHA256__"
EXPECTED_ARCHIVE_BYTES="__ARCHIVE_BYTES__"
PYTHON="/opt/growthsent/venv/bin/python"
__BUNDLE_VERIFIER__
verify_installed_release() {
  test -x "$PYTHON" || return $?
  "$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12)' || return $?
  verify_bundle_contract || return $?
  mapfile -t shard_manifests < <(find "$RELEASE/manifests/shards" -maxdepth 1 -type f -name 'shard-*-of-00010.json' -print | LC_ALL=C sort)
  test "${#shard_manifests[@]}" -eq 10 || return $?
  "$PYTHON" "$RELEASE/tools/common_crawl_v2_manifest.py" verify \
    --base-manifest "$RELEASE/manifests/base-manifest.json" \
    --shard-manifests "${shard_manifests[@]}" \
    --shard-plan "$RELEASE/manifests/shards/shard-plan.json" --expected-input-count 10000 || return $?
  "$PYTHON" "$RELEASE/tools/verify_common_crawl_v2_run.py" \
    --base-manifest "$RELEASE/manifests/base-manifest.json" \
    --shard-dir "$RELEASE/manifests/shards" \
    --shard-plan "$RELEASE/manifests/shards/shard-plan.json" \
    --expected-input-count 10000 || return $?
  "$PYTHON" -c 'import boto3, botocore, duckdb, jmespath, pyarrow, s3transfer; assert boto3.__version__ == "1.43.67"; assert botocore.__version__ == "1.43.67"; assert duckdb.__version__ == "1.5.5"; assert jmespath.__version__ == "1.1.0"; assert pyarrow.__version__ == "19.0.1"; assert s3transfer.__version__ == "0.19.2"' || return $?
}
if verify_installed_release; then
  printf 'GROWTHSENT_CC_V2_INSTALL_READY bundle_sha256=%s release=%s\n' "$EXPECTED_ARCHIVE_SHA256" "$RELEASE"
else
  if test -e "$RELEASE"; then
    printf 'GROWTHSENT_CC_V2_INSTALL_INCOMPLETE_OR_UNVERIFIED bundle_sha256=%s release=%s\n' "$EXPECTED_ARCHIVE_SHA256" "$RELEASE"
  else
    printf 'GROWTHSENT_CC_V2_INSTALL_NOT_INSTALLED bundle_sha256=%s release=%s\n' "$EXPECTED_ARCHIVE_SHA256" "$RELEASE"
  fi
fi
'@
    return $template.Replace("__RELEASE__", $Bundle.ReleasePath).Replace("__ARCHIVE_SHA256__", $Bundle.Sha256).Replace("__ARCHIVE_BYTES__", [string]$Bundle.Bytes).Replace("__BUNDLE_VERIFIER__", $verifier).Replace("`r`n", "`n")
}

function New-RemoteTransferInitializationCommands {
    param([Parameter(Mandatory)] $Bundle)

    $archive = "/tmp/growthsent-common-crawl-production-v2-$($Bundle.Sha256).tar.gz"
    $base64 = "$archive.b64"
    return @(
        "set -Eeuo pipefail",
        "umask 077",
        "install -d -m 0755 /opt/growthsent/releases",
        ": > '$base64'",
        "printf 'GROWTHSENT_CC_V2_TRANSFER_INITIALIZED bundle_sha256=%s`n' '$($Bundle.Sha256)'"
    )
}

function New-RemoteTransferAppendCommands {
    param(
        [Parameter(Mandatory)] $Bundle,
        [Parameter(Mandatory)] [string[]]$Chunks
    )

    $archive = "/tmp/growthsent-common-crawl-production-v2-$($Bundle.Sha256).tar.gz"
    $base64 = "$archive.b64"
    $commands = @("set -Eeuo pipefail", "umask 077", "test -f '$base64'")
    foreach ($chunk in $Chunks) {
        if ($chunk -notmatch '^[A-Za-z0-9+/=]+$') {
            throw "bundle Base64 chunk contains an unexpected character"
        }
        $commands += "printf '%s' '$chunk' >> '$base64'"
    }
    return $commands
}

function New-RemoteFinalizeInstallScript {
    param([Parameter(Mandatory)] $Bundle)

    $archive = "/tmp/growthsent-common-crawl-production-v2-$($Bundle.Sha256).tar.gz"
    $base64 = "$archive.b64"
    $verifier = New-RemoteBundleContractVerifier
    $template = @'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
RELEASE="__RELEASE__"
EXPECTED_ARCHIVE_SHA256="__ARCHIVE_SHA256__"
EXPECTED_ARCHIVE_BYTES="__ARCHIVE_BYTES__"
ARCHIVE="__ARCHIVE__"
ARCHIVE_B64="__ARCHIVE_B64__"
PYTHON="/opt/growthsent/venv/bin/python"
LOCK_DIR="/opt/growthsent/releases/.install-${EXPECTED_ARCHIVE_SHA256}.lock"
STAGE=""
on_error() {
  local exit_code="$?"
  printf 'GROWTHSENT_CC_V2_INSTALL_FAILED exit_code=%s command=%q\n' "$exit_code" "$BASH_COMMAND" >&2
  exit "$exit_code"
}
trap on_error ERR

if ! test -x /usr/bin/python3.12; then
  dnf install -y python3.12
fi
/usr/bin/python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12); print(sys.version)'

test -s "$ARCHIVE_B64"
base64 --decode "$ARCHIVE_B64" > "$ARCHIVE"
printf '%s  %s\n' "$EXPECTED_ARCHIVE_SHA256" "$ARCHIVE" | sha256sum --check --status -
test "$(stat -c '%s' "$ARCHIVE")" -eq "$EXPECTED_ARCHIVE_BYTES"
if test -e "$RELEASE"; then
  printf 'refusing to overwrite an existing incomplete or unverified v2 release: %s\n' "$RELEASE" >&2
  exit 2
fi
if ! mkdir "$LOCK_DIR"; then
  printf 'another v2 installer owns the release lock: %s\n' "$LOCK_DIR" >&2
  exit 2
fi
cleanup_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_lock EXIT
STAGE="$(mktemp -d /opt/growthsent/releases/.stage-${EXPECTED_ARCHIVE_SHA256}.XXXXXX)"
/usr/bin/python3.12 - "$ARCHIVE" "$STAGE" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
root = "growthsent-common-crawl-production-v2"
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if not members or any(not member.isfile() for member in members):
        raise SystemExit("release archive must contain only regular files")
    if any(member.name.startswith("/") or ".." in member.name.split("/") for member in members):
        raise SystemExit("release archive contains an unsafe member path")
    if {member.name.split("/", 1)[0] for member in members} != {root}:
        raise SystemExit("release archive has an unexpected root directory")
    prefix = root + "/"
    for member in members:
        if not member.name.startswith(prefix):
            raise SystemExit("release archive member escapes its root directory")
        destination = stage / member.name[len(prefix):]
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, destination.open("wb") as target:
            if source is None:
                raise SystemExit("unable to read archive member")
            target.write(source.read())
PY
test -f "$STAGE/BUNDLE-MANIFEST.json"
test -f "$STAGE/tools/common_crawl_v2_manifest.py"
test -f "$STAGE/tools/common_crawl_wat_ingest_v2.py"
test -f "$STAGE/tools/promote_common_crawl_v1_shard0_to_v2.py"
test -f "$STAGE/tools/common_crawl_backlink_derive.py"
test -f "$STAGE/tools/common_crawl_backlink_derive_production_v1.py"
test -f "$STAGE/runners/backlink-derived-canary-run.sh"
test -f "$STAGE/runners/backlink-derived-production-10k-run.sh"
test -f "$STAGE/runners/launch-template-bootstrap.sh"
test -f "$STAGE/runners/derive-launch-template-bootstrap.sh"
test -f "$STAGE/systemd/backlink-derived-production-10k.service.template"
test -f "$STAGE/config/derive-rollup-hosts.txt"
test -f "$STAGE/manifests/base-manifest.json"
test -f "$STAGE/manifests/shards/shard-plan.json"
chmod 0755 "$STAGE/runners/backlink-derived-canary-run.sh" "$STAGE/runners/backlink-derived-production-10k-run.sh" "$STAGE/runners/launch-template-bootstrap.sh" "$STAGE/runners/derive-launch-template-bootstrap.sh"
/usr/bin/python3.12 - "$STAGE/INSTALL-METADATA.json" "$EXPECTED_ARCHIVE_SHA256" "$EXPECTED_ARCHIVE_BYTES" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "archive_bytes": int(sys.argv[3]),
    "bundle_sha256": sys.argv[2],
    "format_version": 1,
}, sort_keys=True) + "\n", encoding="utf-8")
PY
if test -x "$PYTHON"; then
  "$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12)'
else
  /usr/bin/python3.12 -m venv /opt/growthsent/venv
fi
PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_PROGRESS_BAR=off "$PYTHON" -m pip install --no-cache-dir --disable-pip-version-check --progress-bar off -r "$STAGE/requirements.txt"
RELEASE="$STAGE"
__BUNDLE_VERIFIER__
verify_bundle_contract
mapfile -t shard_manifests < <(find "$RELEASE/manifests/shards" -maxdepth 1 -type f -name 'shard-*-of-00010.json' -print | LC_ALL=C sort)
test "${#shard_manifests[@]}" -eq 10
"$PYTHON" "$RELEASE/tools/common_crawl_v2_manifest.py" verify \
  --base-manifest "$RELEASE/manifests/base-manifest.json" \
  --shard-manifests "${shard_manifests[@]}" \
  --shard-plan "$RELEASE/manifests/shards/shard-plan.json" --expected-input-count 10000
"$PYTHON" "$RELEASE/tools/verify_common_crawl_v2_run.py" \
  --base-manifest "$RELEASE/manifests/base-manifest.json" \
  --shard-dir "$RELEASE/manifests/shards" \
  --shard-plan "$RELEASE/manifests/shards/shard-plan.json" \
  --expected-input-count 10000
"$PYTHON" -c 'import boto3, botocore, duckdb, jmespath, pyarrow, s3transfer; assert boto3.__version__ == "1.43.67"; assert botocore.__version__ == "1.43.67"; assert duckdb.__version__ == "1.5.5"; assert jmespath.__version__ == "1.1.0"; assert pyarrow.__version__ == "19.0.1"; assert s3transfer.__version__ == "0.19.2"'
FINAL_RELEASE="__FINAL_RELEASE__"
test ! -e "$FINAL_RELEASE"
mv "$STAGE" "$FINAL_RELEASE"
STAGE=""
RELEASE="$FINAL_RELEASE"
verify_bundle_contract
rm -f "$ARCHIVE" "$ARCHIVE_B64"
printf 'GROWTHSENT_CC_V2_INSTALL_READY bundle_sha256=%s release=%s\n' "$EXPECTED_ARCHIVE_SHA256" "$RELEASE"
'@
    return $template.Replace("__RELEASE__", $Bundle.ReleasePath).Replace("__FINAL_RELEASE__", $Bundle.ReleasePath).Replace("__ARCHIVE_SHA256__", $Bundle.Sha256).Replace("__ARCHIVE_BYTES__", [string]$Bundle.Bytes).Replace("__ARCHIVE__", $archive).Replace("__ARCHIVE_B64__", $base64).Replace("__BUNDLE_VERIFIER__", $verifier).Replace("`r`n", "`n")
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
        $output = & $bash -n $temporary.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "generated $Name shell syntax is invalid:`n$($output -join "`n")"
        }
    } finally {
        Remove-Item -LiteralPath $temporary.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReviewedBundleEndToEndLocally {
    param([Parameter(Mandatory)] $Bundle)

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("growthsent-cc-v2-install-" + [Guid]::NewGuid().ToString("N"))
    [System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    try {
        $extractor = @'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
with tarfile.open(archive_path, "r:gz") as archive:
    for member in archive.getmembers():
        if not member.isfile() or member.name.startswith("/") or ".." in member.name.split("/"):
            raise SystemExit("refusing unsafe local bundle extraction")
        target = destination / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, target.open("wb") as output:
            if source is None:
                raise SystemExit("unable to extract local bundle member")
            output.write(source.read())
'@
        Invoke-LocalPython -Code $extractor -Arguments @($Bundle.Path, $temporaryRoot) | Out-Null
        $release = Join-Path $temporaryRoot $BundleRoot
        Invoke-LocalProductionManifestVerifier -ReleasePath $release | Out-Null
    } finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-ProductionV2InstallerLocally {
    $bundle = Resolve-ReviewedBundle
    $archiveBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($bundle.Path))
    $chunks = @([regex]::Matches($archiveBase64, ".{1,$ChunkCharacters}") | ForEach-Object { $_.Value })
    if ($chunks.Count -lt 2) {
        throw "reviewed v2 bundle unexpectedly does not require chunked SSM transport"
    }
    Assert-SsmCommandPayload -Commands (New-RemoteTransferInitializationCommands -Bundle $bundle)
    for ($offset = 0; $offset -lt $chunks.Count; $offset += $ChunksPerSsmRequest) {
        $end = [Math]::Min($offset + $ChunksPerSsmRequest - 1, $chunks.Count - 1)
        Assert-SsmCommandPayload -Commands (New-RemoteTransferAppendCommands -Bundle $bundle -Chunks @($chunks[$offset..$end]))
    }
    Assert-SsmCommandPayload -Commands @(
        "set -Eeuo pipefail",
        ('printf ''%s'' ''quoted=" pipes=| ampersand=& unicode=' + [char]0x2713 + ''' >> /tmp/example'),
        "printf '%s' 'QmFzZTY0Lys9' >> /tmp/archive.b64"
    )
    $probe = New-RemoteInstallProbeScript -Bundle $bundle
    $finalize = New-RemoteFinalizeInstallScript -Bundle $bundle
    foreach ($script in @($probe, $finalize)) {
        if ($script.Contains("`r")) { throw "generated v2 installer shell script contains CRLF" }
    }
    Test-LocalBashSyntax -Name "production-v2 install probe" -ScriptText $probe
    Test-LocalBashSyntax -Name "production-v2 installer" -ScriptText $finalize
    if ($probe -notmatch [regex]::Escape($bundle.ReleasePath) -or $finalize -notmatch [regex]::Escape($bundle.ReleasePath)) {
        throw "generated installer does not bind the release path to the reviewed bundle SHA"
    }
    if ($probe -notmatch 'verify_bundle_contract \|\| return \$\?' -or
        $probe -notmatch 'GROWTHSENT_CC_V2_INSTALL_INCOMPLETE_OR_UNVERIFIED') {
        throw "installer probe could incorrectly treat a failed release verification as ready"
    }
    foreach ($forbidden in @("systemctl", "--upload", "--resume", "--shard-lease-owner", "s3://")) {
        if ($probe.Contains($forbidden) -or $finalize.Contains($forbidden)) {
            throw "generated v2 installer contains forbidden non-install action: $forbidden"
        }
    }
    foreach ($requiredMember in @(
        'tools/common_crawl_wat_ingest_v2.py',
        'tools/promote_common_crawl_v1_shard0_to_v2.py',
        'runners/backlink-derived-canary-run.sh',
        'runners/backlink-derived-production-10k-run.sh',
        'runners/launch-template-bootstrap.sh',
        'runners/derive-launch-template-bootstrap.sh',
        'systemd/backlink-derived-production-10k.service.template',
        'config/derive-rollup-hosts.txt'
    )) {
        if ($finalize -notmatch [regex]::Escape("test -f `"`$STAGE/$requiredMember`"")) {
            throw "installer no longer verifies required reviewed bundle member: $requiredMember"
        }
    }
    Test-ReviewedBundleEndToEndLocally -Bundle $bundle
    Write-Output "Production-v2 bundle installer local validation passed: SHA-256 $($bundle.Sha256), $($bundle.Bytes) bytes, $($chunks.Count) SSM chunks. No AWS command was invoked."
}

if ($ValidateSerializationOnly) {
    Test-ProductionV2InstallerLocally
    exit 0
}

if ([string]::IsNullOrWhiteSpace($InstanceId)) {
    throw "-InstanceId is required unless -ValidateSerializationOnly is supplied"
}

$bundle = Resolve-ReviewedBundle
$probe = Invoke-SsmRunShellScript -Comment "Check reviewed GrowthSent Common Crawl production-v2 installation" -Commands @(New-RemoteInstallProbeScript -Bundle $bundle)
if ($probe.StandardOutputContent -match "GROWTHSENT_CC_V2_INSTALL_READY bundle_sha256=$([regex]::Escape($bundle.Sha256))") {
    Write-Output "Reviewed production-v2 bundle $($bundle.Sha256) is already fully verified at $($bundle.ReleasePath); no install action was taken."
    exit 0
}
if ($probe.StandardOutputContent -match "GROWTHSENT_CC_V2_INSTALL_INCOMPLETE_OR_UNVERIFIED") {
    throw "the reviewed v2 release path already exists but is incomplete or cannot be fully verified. Refusing to overwrite it: $($bundle.ReleasePath)"
}
if ($probe.StandardOutputContent -notmatch "GROWTHSENT_CC_V2_INSTALL_NOT_INSTALLED bundle_sha256=$([regex]::Escape($bundle.Sha256))") {
    throw "production-v2 installation probe did not return an expected state. Remote stdout:`n$($probe.StandardOutputContent)"
}

$archiveBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($bundle.Path))
$chunks = @([regex]::Matches($archiveBase64, ".{1,$ChunkCharacters}") | ForEach-Object { $_.Value })
Invoke-SsmRunShellScript -Comment "Initialize reviewed GrowthSent Common Crawl production-v2 bundle transfer" -Commands (New-RemoteTransferInitializationCommands -Bundle $bundle) | Out-Null
for ($offset = 0; $offset -lt $chunks.Count; $offset += $ChunksPerSsmRequest) {
    $end = [Math]::Min($offset + $ChunksPerSsmRequest - 1, $chunks.Count - 1)
    $batchNumber = [int]($offset / $ChunksPerSsmRequest) + 1
    $batchCount = [int][Math]::Ceiling($chunks.Count / [double]$ChunksPerSsmRequest)
    Write-Host "Transferring reviewed production-v2 bundle through SSM batch $batchNumber of $batchCount."
    Invoke-SsmRunShellScript -Comment "Transfer reviewed GrowthSent Common Crawl production-v2 bundle batch $batchNumber of $batchCount" -Commands (New-RemoteTransferAppendCommands -Bundle $bundle -Chunks @($chunks[$offset..$end])) | Out-Null
}
$final = Invoke-SsmRunShellScript -Comment "Install and verify reviewed GrowthSent Common Crawl production-v2 bundle" -Commands @(New-RemoteFinalizeInstallScript -Bundle $bundle) -DeadlineMinutes 45
if ($final.StandardOutputContent -notmatch "GROWTHSENT_CC_V2_INSTALL_READY bundle_sha256=$([regex]::Escape($bundle.Sha256))") {
    throw "production-v2 installer did not return the expected verified-release marker. Remote stdout:`n$($final.StandardOutputContent)"
}
Write-Output $final.StandardOutputContent
