# GrowthSent Common Crawl production-v2 deployment package

This package is a sibling of the proven `production-v1` deployment. It is for
one immutable, ordered 10,000-input CC-MAIN-2026-30 run split into ten fixed,
non-overlapping shards of 1,000 WAT paths each. It does not alter
production-v1, schemas, or deterministic Pages/Links/metrics part names.

## Deliberate safety properties

- A v2 worker never derives an input range from a caller-supplied numeric
  range. It reads only its bundled `shard-<id>-of-<count>.json` manifest.
- The base manifest must contain exactly 10,000 unique ordered paths, and
  every shard contains exactly 1,000 paths. Consequently `shardCount` is
  exactly 10; a caller cannot broaden, repartition, or select a larger run.
- The runner verifies the full base/shard manifest set before it starts a
  shard, then passes the base and shard hashes to
  `tools/common_crawl_wat_ingest_v2.py`.
- Each shard has isolated local lifecycle, log, work, systemd and S3 control
  paths. Final Pages/Links/metrics keys remain deterministic by input hash.
- A per-shard S3 lease is acquired by the v2 ingester. A second instance with
  the same shard identity must not process it concurrently.
- Resume uses the same immutable run ID, shard ID, shard count, release, and
  shard manifest. It never repartitions an active or interrupted run.
- Bare locked `crawl-data/...` inputs are read through authenticated
  `s3://commoncrawl/...`, not the public HTTP endpoint. Retryable Common Crawl
  `SlowDown`/503-style source responses use bounded exponential backoff; the
  original manifest path remains the metrics input and deterministic part-key
  source.

## Expected bundle layout

The approved v2 release must contain these files:

```text
tools/common_crawl_wat_ingest.py       # proven engine, unchanged
tools/common_crawl_wat_ingest_v2.py    # v2 scope/control wrapper
tools/common_crawl_v2_manifest.py
tools/promote_common_crawl_v1_shard0_to_v2.py  # explicit v1-to-v2 shard-0 reuse only
tools/common_crawl_backlink_derive.py
tools/common_crawl_backlink_derive_production_v1.py  # locked 10K derived publication protocol
runners/backlink-derived-canary-run.sh          # validated 1,024-bucket derived runner
runners/backlink-derived-production-10k-run.sh  # locked ten-shard derived worker
runners/launch-template-bootstrap.sh
runners/derive-launch-template-bootstrap.sh
systemd/backlink-derived-production-10k.service.template
config/derive-rollup-hosts.txt
manifests/base-manifest.json
manifests/shards/shard-<id>-of-<count>.json
manifests/shards/shard-plan.json
BUNDLE-MANIFEST.json
```

The manifest builder is responsible for generating and verifying the base
manifest and every shard manifest before a bundle is built. The deployment
runner verifies the installed release and manifest set again; it does not
construct a manifest from Common Crawl listing data.

The manifest builder also produces newline-delimited `.paths` files for local
review. They need not be bundled: the runner re-materializes its one path list
from the validated base/shard JSON into its isolated control directory before
starting the ingester.

For clarity, artifact names use five-digit padding (for example,
`shard-00007-of-00010.json`), while the v2 ingester's canonical S3 control
namespace uses `control/shards/shard-007-of-010/`. Both are deterministic
representations of the same zero-based shard identity and are checked by the
runner before work starts.

The independent local verifier for a reviewed bundle is:

```powershell
python tools/verify_common_crawl_v2_run.py `
  --base-manifest manifests/base-manifest.json `
  --shard-dir manifests/shards `
  --shard-plan manifests/shards/shard-plan.json `
  --expected-input-count 10000
```

## Install the reviewed v2 bundle first

`ssm-install-production-v2.ps1` is deliberately separate from the shard
runner. It transports only the reviewed local release archive through the SSM
control channel (never S3), verifies its SHA-256 before extraction, installs
it at the SHA-named release path, installs the pinned requirements, validates
`BUNDLE-MANIFEST.json`, and runs the complete 10,000-input v2 verifier. It
does **not** start an ingestion, acquire a shard lease, publish data, or create
a systemd service.

Installation is a prerequisite for `ValidateShardSetup`. Run it once on a
reviewed canary worker before invoking the v2 shard controller:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\deployment\common-crawl-production-v2\ssm-install-production-v2.ps1 `
  -InstanceId i-<canary-worker-instance-id> `
  -Region us-east-1
```

The installer source contains the reviewed archive SHA-256. Verify the local
bundle with `Get-FileHash` before using it; the SHA cannot be embedded in this
bundled README without making the archive self-referential. The installer
derives the matching immutable release path:

```text
<reviewed-64-character-10k-bundle-sha256>
/opt/growthsent/releases/<reviewed-64-character-10k-bundle-sha256>
```

If that release is already fully verified, the installer reports it and makes
no changes. If the SHA-named release exists but cannot be completely verified,
the installer fails closed and never overwrites it.

## Local-only validation

This executes PowerShell, generated-Bash/SSM-payload, full bundle-manifest,
and 10,000-input manifest checks only. It sends no SSM command, calls no AWS
API, and starts no instance:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  deployment/common-crawl-production-v2/ssm-install-production-v2.ps1 `
  -ValidateSerializationOnly

pwsh -NoProfile -File deployment/common-crawl-production-v2/ssm-production-v2.ps1 `
  -ValidateSerializationOnly
```

Use `powershell` instead of `pwsh` if Windows PowerShell is the local shell.

## Launch-template contract

Use `launch-template-bootstrap.sh` only as EC2 user data after reviewing the
actual template. It requires IMDSv2 and instance metadata tags. Each instance
must have exactly one immutable tag tuple:

```text
RunId=cc-main-2026-30-first-10000
ShardId=<zero-based shard id>
ShardCount=10
```

The bootstrap writes only `/etc/growthsent/common-crawl-production-v2/launch-identity.env`.
It does not run ingestion. The SSM runner compares the launch identity with
its requested shard before writing the systemd unit or starting it.

Do not use an Auto Scaling Group that can replace a worker with a different
shard identity. A replacement must retain the exact same tag tuple and then
use `-Action Resume` for that shard.

If a previous worker crashed and left an expired **running** lease, do not
take it over automatically. First confirm the prior instance/service is
stopped, then use `-Action Resume -AcknowledgeExpiredLeaseTakeover`. A normal
graceful `Stop` marks the lease stopped and does not need this acknowledgement.

## Controlled SSM actions

After an approved release SHA and an EC2 instance exist, the controller is
used with an explicit shard identity. These commands are examples only; do
not execute them before the manifest/release/IAM review.

```powershell
$release = '<approved-64-character-release-sha256>'
$common = @{
  InstanceId = 'i-<worker-instance-id>'
  RunId = 'cc-main-2026-30-first-10000'
  ShardId = 0
  ShardCount = 10
  ReleaseSha256 = $release
}

# Creates and validates the per-shard unit without starting ingestion.
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 `
  -Action ValidateShardSetup @common

# Starts exactly the preassigned shard. It uses --resume by design.
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 `
  -Action Start @common

# Reads only systemd/local status and the namespaced shard progress/summary.
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 `
  -Action Status @common

# Stops one systemd shard gracefully; it never removes remote output.
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 `
  -Action Stop @common

# Recovery only after confirming the prior worker is stopped. This remains the
# same shard; it does not repartition or broaden the manifest.
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 `
  -Action Resume -AcknowledgeExpiredLeaseTakeover @common
```

## Required AWS work before a canary

This package deliberately performs none of the following:

1. Build and review a release bundle containing the immutable 10,000 base
   manifest and all shard manifests.
2. Grant the worker role only the new v2 run prefix, including the conditional
   lease/control objects and multipart-upload actions; retain no broad S3
   permission.
3. Create a new v2 output prefix. Never reuse the completed v1 prefix.
4. Create/review a launch template with no inbound security-group rules,
   outbound HTTPS, public IPv4/Internet Gateway egress, IMDSv2 required, and
   the per-instance identity tags above.
5. Run `ValidateShardSetup` on a single canary shard before using `Start`.

The configured worker remains four bounded ingestion processes and exactly
1,000 inputs per shard. No queue, cluster, or unbounded fleet controller is
introduced. The separate derived-data process never changes the raw Pages,
Links, or metrics schemas and must use a new derived prefix after raw-shard
completion.

## Derived-backlink v1 production workers

The raw v2 run and derived layout are deliberately separate. The latter is
locked to `cc-main-2026-30-first-10000`, exactly ten derive shards, and this
immutable schema/layout prefix:

```text
production/common-crawl/backlink-derived/v1/cc-main-2026-30-first-10000/
```

Use the dedicated `r6i.xlarge` / 1.5 TiB gp3 launch specification and the
least-privilege policy in the sibling derived-production files. A derive
worker receives only its matching 1,000 raw Links parts, creates all 1,024
`target_host_bucket` partitions locally, then publishes only its own
`input_shard=shard-<id>-of-010` paths. Its completion marker is written after
all artifacts and the publication manifest have been verified. See
`README-backlink-derived-production-10k.md` for the layout and worker
contract. These local configuration files do not create AWS resources or
start a derive job.

## Reusing the proven v1 first 1,000 inputs as v2 shard 0

The reviewed v2 shard 0 exactly matches the proven v1 first-1,000 manifest.
It must be promoted before any v2 shard worker is started; do not reprocess
those WAT files. The promotion tool is hard-locked to these prefixes and to
shard 0:

```text
source:      production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/
destination: production/common-crawl/wat-pages-links/v2/cc-main-2026-30-first-10000/
```

It validates the immutable v1 manifest, all 1,000 Pages/Links/Metrics
triplets, every metric's input path, and the destination before performing
any write. Its only write mode uses S3 server-side copy with a source ETag
precondition; it never writes or deletes a v1 key. It neither writes v2 shard
completion state nor takes a v2 shard lease. The normal v2 runner must run
after a verified promotion so its own `--resume` and lease/control path records
the completed shard.

Run these commands from the installed reviewed v2 release on the designated
shard-0 worker. The first command is local-only; the second is read-only S3
verification. Do not run the third command without explicit approval.

```bash
PYTHON=/opt/growthsent/venv/bin/python
RELEASE=/opt/growthsent/releases/<reviewed-10k-release-sha256>

$PYTHON "$RELEASE/tools/promote_common_crawl_v1_shard0_to_v2.py" \
  --base-manifest "$RELEASE/manifests/base-manifest.json" \
  --shard-manifest "$RELEASE/manifests/shards/shard-00000-of-00010.json" \
  --shard-plan "$RELEASE/manifests/shards/shard-plan.json" \
  --validate-local

$PYTHON "$RELEASE/tools/promote_common_crawl_v1_shard0_to_v2.py" \
  --base-manifest "$RELEASE/manifests/base-manifest.json" \
  --shard-manifest "$RELEASE/manifests/shards/shard-00000-of-00010.json" \
  --shard-plan "$RELEASE/manifests/shards/shard-plan.json" \
  --verify

# Approved write mode only: exactly 3,000 v1->v2 server-side artifact copies.
$PYTHON "$RELEASE/tools/promote_common_crawl_v1_shard0_to_v2.py" \
  --base-manifest "$RELEASE/manifests/base-manifest.json" \
  --shard-manifest "$RELEASE/manifests/shards/shard-00000-of-00010.json" \
  --shard-plan "$RELEASE/manifests/shards/shard-plan.json" \
  --apply
```

If any v2 object already exists, it is accepted only when its size plus an
available SHA-256 checksum, a valid plain ETag, or the tool's own provenance
metadata proves it is the same source artifact. Any other existing object,
missing source artifact, unexpected artifact, or metric/input mismatch aborts
the operation. After `--apply`, use the ordinary v2 `ValidateShardSetup` then
`Start` action for shard 0; that runner performs the actual resume discovery
and writes the shard lifecycle/progress/summary objects.
