# Common Crawl WAT production v1 runbook

Status: prepared locally only. This runbook does not authorize provisioning,
processing, MongoDB changes, or deployment.

## Scope and baseline

The only production scope is the first 1,000 ordered paths from `cc-main-2026-30.wat.paths.gz`.
Its immutable scope lock is:

```text
crawl: CC-MAIN-2026-30
path count: 1,000
first path: .../CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz
last path:  .../CC-MAIN-20260710070534-20260710100534-00999.warc.wat.gz
SHA-256 of newline-joined selected paths:
6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a
```

The audited 100-file baseline completed in 6,649.422 wall seconds with four
workers, emitted 2,178,846 Pages rows and 307,335,604 Links rows, and had no
failed inputs. Its peak process-tree RSS was 841.09 MiB. Remote resume checked
all 300 objects and left them unchanged.

The Pages and Links Parquet schemas remain exactly as implemented. This plan
does not use or modify the disk-backed dictionary experiment.

## Architecture

Use one disposable, On-Demand EC2 instance in `us-east-1`, close to the
existing data lake. It streams public Common Crawl WAT objects over HTTPS,
runs the existing four-process Python ingestion command, then publishes every
finalized Pages, Links, and metrics part directly to S3. It requires no queue,
container service, database, EFS, NAT gateway, or application deployment.

Use an existing public subnet with an Internet Gateway and a public IPv4
address. The security group has no inbound rules and only outbound HTTPS. This
avoids an otherwise unnecessary NAT gateway and its per-hour/per-GB charges.
Use Session Manager rather than SSH, with the instance role; no long-lived AWS
credentials go on the instance or into the repository.

### Network preflight: required before launch

The actual account configuration must satisfy every item below before an
instance is launched. This is a read-only verification checklist, not a
provisioning command:

- The selected subnet's associated route table has `0.0.0.0/0` targeted at an
  Internet Gateway attached to the same VPC. It has no NAT gateway default
  route.
- The launch request assigns a public IPv4 address. The VPC has DNS support and
  DNS hostnames enabled.
- The instance has only the dedicated ingestion security group. That group has
  **zero inbound rules** and a single outbound `TCP 443` rule to `0.0.0.0/0`.
  No SSH key pair or port 22 rule is used.
- The subnet network ACL is either the default permissive ACL or explicitly
  permits DNS plus outbound HTTPS and the ephemeral return traffic.
- Amazon Linux 2023's SSM Agent is enabled and the instance profile has
  `AmazonSSMManagedInstanceCore`. The public internet path lets the agent
  reach `ssm.us-east-1.amazonaws.com` and
  `ssmmessages.us-east-1.amazonaws.com` on HTTPS; the same TCP 443 egress
  reaches `data.commoncrawl.org`.

The reason this works without a NAT gateway is that an Internet Gateway
provides the IPv4 translation for an instance with a public IPv4 address; a
security group is stateful, so return packets for the instance's outbound
connections do not require an inbound rule. Do not substitute the default
security group: it allows inbound traffic from other resources assigned to it.

With an authenticated AWS CLI profile, capture the actual subnet, route-table,
network-ACL, and security-group output before launch:

```bash
aws ec2 describe-subnets --subnet-ids <public-subnet-id> --region us-east-1
aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<public-subnet-id> --region us-east-1
aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<public-subnet-id> --region us-east-1
aws ec2 describe-security-groups --group-ids <dedicated-security-group-id> --region us-east-1
aws ec2 describe-vpc-attribute --vpc-id <vpc-id> --attribute enableDnsSupport --region us-east-1
aws ec2 describe-vpc-attribute --vpc-id <vpc-id> --attribute enableDnsHostnames --region us-east-1
```

Required resources:

- The existing `growthsent-data-552648196041-us-east-1-an` S3 bucket.
- One `c7i.xlarge` Linux instance: 4 vCPU and 8 GiB RAM.
- One 40 GiB gp3 root EBS volume, `DeleteOnTermination=true`; default gp3 IOPS
  and throughput are sufficient because inputs are streamed and outputs are
  published every eight files.
- One narrowly scoped instance-profile role: Systems Manager core permissions,
  plus `s3:GetObject` and `s3:PutObject` only under the production prefix
  below. Include `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts`
  for safe interrupted multipart uploads. No `s3:DeleteObject` permission is
  needed.
- One no-inbound security group in the selected public subnet. No Elastic IP,
  NAT gateway, load balancer, database, ECS cluster, Lambda, MongoDB, or Atlas
  Data Federation resource.

Four workers match the baseline. The measured full tree was 841 MiB, so 8 GiB
leaves substantial headroom for Amazon Linux, Python, PyArrow, and upload
overlap. Each worker streams its roughly 159 MB compressed WAT input instead
of staging it; it holds at most a Pages and Links temporary part, about 90 MB
for a typical input. Eight-file publication checkpoints cap finalized local
data around 0.7 GB plus concurrent temporary parts. A 40 GiB volume is ample
and avoids needing to retain the roughly 79.1 GiB final dataset locally.

## Estimates

All scale estimates multiply the proven 100-file baseline by ten; actual WAT
content and transfer speed will vary.

| Measure | Estimate for 1,000 paths |
| --- | ---: |
| Compressed WAT input | 158,924,222,830 bytes (148.01 GiB) |
| Pages rows | 21,788,460 |
| Links rows | 3,073,356,040 |
| Pages Parquet | 5,679,215,330 bytes (5.29 GiB) |
| Links Parquet | 79,243,667,990 bytes (73.80 GiB) |
| Total Parquet | 84,922,883,320 bytes (79.09 GiB) |
| Expected runtime, four workers | 18.47 hours; reserve 22 hours |

Cost estimate, `us-east-1`, excluding tax, uses On-Demand `c7i.xlarge` at
$0.1785/hour and gp3 at $0.08/GiB-month. Recheck the AWS price list immediately
before approval because prices can change.

| Item | Estimated one-run cost |
| --- | ---: |
| EC2 for 18.47 hours | $3.30 |
| 40 GiB gp3 EBS for 18.47 hours | $0.08 |
| Public IPv4 for 18.47 hours | about $0.09 |
| S3 PUT/multipart requests (about 12,500) | about $0.07 |
| S3 Standard storage, first month | about $1.82 |
| First-month total | about $5.36 |

The production run has no planned data-transfer-out charge. Avoid a NAT
gateway: it would add a material hourly and per-GB cost while carrying roughly
148 GiB of Common Crawl ingress.

## S3 layout

Use a new immutable run prefix, distinct from the 100-file benchmark:

```text
s3://growthsent-data-552648196041-us-east-1-an/
  production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/
    control/input-manifest.json
    control/run-progress.json
    control/run-summary.json
    crawl=CC-MAIN-2026-30/
      dataset=pages/part-<stable-input-sha256-prefix>.parquet
      dataset=links/part-<stable-input-sha256-prefix>.parquet
      metrics/part-<stable-input-sha256-prefix>.json
```

Pages and Links remain separate, crawler-partitioned Parquet datasets. The
`control/` objects are outside the dataset tree so a later Atlas Data
Federation configuration can expose the Pages and Links prefixes separately,
while retaining the run manifest and metrics for audit.

An input is remotely complete only when its deterministic Pages part, Links
part, and metrics sidecar all exist and the sidecar names the same source. The
metrics sidecar is uploaded last. A restart therefore skips only complete
triples; it safely reprocesses any partial upload. `input-manifest.json` is
checked before processing and prevents reuse of this prefix for a different
ordered input set. A single-file smoke manifest can be promoted only to a
larger manifest whose inputs retain that smoke path as the exact first ordered
prefix; this lets the later 1,000-file run remote-resume the verified smoke
part without permitting unrelated scope reuse.

## Readiness safeguards and observability

The ingestion command now:

- refuses a path list without `--max-inputs` and refuses any scope over 1,000;
- locks the selected ordered paths with `--expected-inputs-sha256` and rejects
  a source outside `--require-source-prefix` before a WAT read;
- logs a JSON progress event after every input with completed, remaining,
  failures, rows, bytes, throughput, and ETA;
- persists and publishes a control manifest, batch progress checkpoint, and
  final run summary;
- preserves deterministic part names and remote resume behavior; and
- can remove only locally finalized artifacts *after* their successful remote
  publication, keeping ephemeral disk bounded. This is opt-in and does not
  touch the existing benchmark artifacts.

## Commands for the approved run only

Do not execute these until approval. Launch the EC2 instance with the resources
above, an Amazon Linux 2023 AMI, its instance profile, and the no-inbound
security group. The exact subnet, security group, and instance-profile IDs are
account-specific and must be supplied at approval time:

```bash
aws ec2 run-instances \
  --region us-east-1 \
  --image-id <al2023-ami-id> \
  --instance-type c7i.xlarge \
  --iam-instance-profile Name=<growthsent-cc-wat-v1-role> \
  --subnet-id <public-subnet-id> \
  --security-group-ids <no-inbound-security-group-id> \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":40,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=growthsent-cc-wat-v1-first-1000}]'
```

On the instance, install the pinned Python dependencies in a virtual
environment, check out the reviewed repository revision, and run:

```bash
python tools/common_crawl_wat_ingest.py \
  --crawl CC-MAIN-2026-30 \
  --input-list cc-main-2026-30.wat.paths.gz \
  --max-inputs 1000 \
  --expected-inputs-sha256 6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a \
  --require-source-prefix crawl-data/CC-MAIN-2026-30/ \
  --workers 4 \
  --files-per-batch 8 \
  --output-dir /mnt/growthsent-cc-wat-v1 \
  --resume \
  --upload \
  --remove-uploaded-local \
  --destination s3://growthsent-data-552648196041-us-east-1-an/production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/
```

Use the exact same command to resume after interruption. It has no credential
arguments; the instance role supplies short-lived credentials. Monitor the
instance log and `control/run-progress.json`. The final success condition is
`control/run-summary.json` with `failed_inputs: 0`, 1,000 inputs, and the
expected 2,000 Parquet parts plus 1,000 metrics sidecars.

## Stop, resume, and cleanup

For an interruption or capacity issue, terminate the instance. The published
S3 parts and the control manifest stay intact; a replacement instance resumes
from them. Do not delete the production prefix to recover from interruption.

After verified success, terminate the tagged instance; the 40 GiB EBS volume
is deleted automatically. Retain the S3 production prefix. Delete the
dedicated security group and instance role only if they were created solely
for this run and are no longer needed. Any data-deletion request must name the
exact production prefix and be separately approved; this runbook deliberately
contains no bulk S3 deletion command.

## Risks and blockers

- The estimate assumes the first 1,000 files resemble the proven first 100;
  network throttling or a content shift can extend the 18.47-hour estimate.
- Verify `c7i.xlarge` capacity and the account's On-Demand vCPU quota before
  launch. Fall back to `m7i.xlarge` (same four vCPUs, 16 GiB) only after
  re-estimating its current price.
- The instance role must be limited to this prefix and must support multipart
  upload; no static credential is acceptable.
- The selected subnet must have Internet Gateway egress and no NAT gateway.
- MongoDB and Atlas Data Federation remain intentionally untouched. Atlas Data
  Federation configuration is a follow-on after validating this S3 run.
