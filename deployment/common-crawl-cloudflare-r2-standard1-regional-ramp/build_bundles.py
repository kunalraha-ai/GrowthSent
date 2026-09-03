#!/usr/bin/env python3
"""Build local-only regional standard-1 Container ramp bundles.

The build accepts a locked Common Crawl v2 shard manifest, selects a bounded
prefix of its inputs, then emits one independently constrained Worker bundle
for each supported region.  It never calls Cloudflare or R2.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Any, Iterable, Mapping

import sys


ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146"
BUCKET = "growthsent-data-lake"
CRAWL = "CC-MAIN-2026-30"
HARD_TIMEOUT_SECONDS = 6600
REGIONS = ("APAC", "ENAM", "WNAM", "WEUR")
NORMAL_PLAN_KIND = "growthsent-cloudflare-r2-standard1-regional-ramp-plan"
ENAM_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-enam-recovery-plan"
ENAM_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-enam-recovery-contract-v1"
INCOMPLETE_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-incomplete-recovery-plan"
INCOMPLETE_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-incomplete-recovery-contract-v1"
REMAINING_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-remaining-recovery-plan"
REMAINING_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-remaining-recovery-contract-v1"
HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-128-partial-recovery-plan"
HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-128-partial-recovery-contract-v1"
HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan"
HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-plan"
HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-contract-v1"
HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-plan"
HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-contract-v1"
ENAM_RECOVERY_REGION = "ENAM"
DEFAULT_MAX_CONCURRENT = 4
DEFAULT_START_SPACING_SECONDS = 15
CAPACITY_CHECKPOINT_PROFILE = "regional-capacity-checkpoint"
THOUSAND_WAT_PROFILE = "regional-thousand-wat"
TEN_THOUSAND_WAT_PROFILE = "regional-ten-thousand-wat"
HIGH_CAPACITY_CHECKPOINT_PROFILE = "regional-128-capacity-checkpoint"
HIGH_CAPACITY_TEN_THOUSAND_PROFILE = "regional-256-ten-thousand-wat"
ENAM_RECOVERY_PROFILE = "enam-recovery"
INCOMPLETE_RECOVERY_PROFILE = "regional-incomplete-recovery"
REMAINING_RECOVERY_PROFILE = "regional-remaining-recovery"
HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE = "regional-128-partial-recovery"
HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE = "regional-256-ten-thousand-partial-recovery"
HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE = "regional-256-ten-thousand-failed-lane-recovery"
HIGH_CAPACITY_TEN_THOUSAND_LANES = (
    # Each sibling pair shares a physical placement constraint but owns a
    # separate Worker, DO namespace, R2 prefix, and fixed 32-slot pool.  With
    # 30-second lane spacing and a 10-second sibling offset, allocation in
    # each physical region remains roughly one new instance every 15 seconds.
    ("APAC-A", "APAC", 0), ("APAC-B", "APAC", 10),
    ("ENAM-A", "ENAM", 0), ("ENAM-B", "ENAM", 10),
    ("WNAM-A", "WNAM", 0), ("WNAM-B", "WNAM", 10),
    ("WEUR-A", "WEUR", 0), ("WEUR-B", "WEUR", 10),
)
CAPACITY_CHECKPOINT_CREDENTIAL_POLICY = {
    "id": "regional-two-hour-v1",
    "child_ttl_seconds": 7_200,
    "start_guard_seconds": 0,
}
# A worst-case 1,000-WAT run is 62.5 waves of four 110-minute tasks per
# regional lane: just under 115 hours. Six days leaves more than a day of
# bounded allocation/retry headroom while staying below R2's seven-day maximum.
# The 10,000-WAT stage keeps the same limited slots and is intentionally
# guarded by its own fixed profile. It is expected to finish within this
# window from the verified standard-1 throughput; any work still absent after
# expiry is recovered from immutable completion-marker inventory.
THOUSAND_WAT_CREDENTIAL_POLICY = {
    "id": "regional-six-day-v1",
    "child_ttl_seconds": 518_400,
    "start_guard_seconds": 10_800,
}
TEN_THOUSAND_WAT_CREDENTIAL_POLICY = dict(THOUSAND_WAT_CREDENTIAL_POLICY)
# Incomplete recovery retains the conservative six-day, prefix-scoped
# credential window of the original 1,000-WAT run. Its exact task set is
# smaller, but the guard prevents a late task from beginning near expiry.
INCOMPLETE_RECOVERY_CREDENTIAL_POLICY = dict(THOUSAND_WAT_CREDENTIAL_POLICY)
HIGH_CAPACITY_PARTIAL_RECOVERY_CREDENTIAL_POLICY = dict(THOUSAND_WAT_CREDENTIAL_POLICY)
HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CREDENTIAL_POLICY = dict(THOUSAND_WAT_CREDENTIAL_POLICY)
HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CREDENTIAL_POLICY = dict(THOUSAND_WAT_CREDENTIAL_POLICY)
RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
WORKER_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))
import common_crawl_gcp_r2_25k_contract as contract  # noqa: E402
import common_crawl_http_source as http_source  # noqa: E402


TOOL_NAMES = (
    "common_crawl_cloudflare_r2_standard1_regional_ramp.py",
    "common_crawl_gcp_r2_25k_contract.py",
    "common_crawl_http_source.py",
    "common_crawl_r2_store.py",
    "common_crawl_semantic_contract_v2.py",
    "common_crawl_v2_manifest.py",
    "common_crawl_wat_ingest.py",
    "common_crawl_wat_ingest_gcp_25k.py",
)
LOCAL_STATIC = (
    "Dockerfile",
    "requirements.txt",
    "package.json",
    "r2-boto3-preflight.py",
    "regional_ramp_entry.py",
    "regional_ramp_server.py",
    "run-ramp.sh",
)


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise SystemExit(f"missing {label}: {path}")
    return path


def release_sha256(paths: Iterable[Path], output_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.relative_to(output_dir).as_posix()):
        digest.update(path.relative_to(output_dir).as_posix().encode("utf-8") + b"\0")
        digest.update(sha256_file(path).encode("ascii") + b"\n")
    return digest.hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--task-count", type=int, required=True)
    parser.add_argument("--max-concurrent", type=int, default=DEFAULT_MAX_CONCURRENT)
    parser.add_argument("--start-spacing-seconds", type=int, default=DEFAULT_START_SPACING_SECONDS)
    parser.add_argument(
        "--execution-profile",
        choices=(CAPACITY_CHECKPOINT_PROFILE, THOUSAND_WAT_PROFILE, TEN_THOUSAND_WAT_PROFILE, HIGH_CAPACITY_CHECKPOINT_PROFILE, HIGH_CAPACITY_TEN_THOUSAND_PROFILE),
        default=CAPACITY_CHECKPOINT_PROFILE,
        help="local deployment profile; large profiles are accepted only for their exact reviewed task counts",
    )
    parser.add_argument("--recovery-contract", type=Path)
    parser.add_argument("--source-run-context", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def load_source_manifest(path: Path, *, execution_profile: str) -> tuple[dict[str, Any], str]:
    require_file(path, "source manifest")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("source manifest is not valid UTF-8 JSON") from error
    expected_kind = "common-crawl-v2-base-manifest" if execution_profile in (TEN_THOUSAND_WAT_PROFILE, HIGH_CAPACITY_TEN_THOUSAND_PROFILE) else "common-crawl-v2-shard-manifest"
    if not isinstance(document, dict) or document.get("kind") != expected_kind or document.get("crawl") != CRAWL:
        raise SystemExit("source manifest is not the reviewed CC-MAIN-2026-30 v2 input contract")
    inputs = document.get("inputs")
    expected_input_count = 10_000 if execution_profile in (TEN_THOUSAND_WAT_PROFILE, HIGH_CAPACITY_TEN_THOUSAND_PROFILE) else None
    if not isinstance(inputs, list) or document.get("input_count") != len(inputs) or (expected_input_count is not None and len(inputs) != expected_input_count) or (expected_input_count is None and not 1 <= len(inputs) <= 1000):
        raise SystemExit("source manifest does not match the bounded input contract for this execution profile")
    return document, sha256_file(path)


def select_source_inputs(source_document: Mapping[str, Any], indexes: list[int]) -> list[dict[str, str]]:
    inputs = source_document.get("inputs")
    if not isinstance(inputs, list) or not indexes:
        raise SystemExit("selected source input indexes are invalid")
    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for index in indexes:
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(inputs):
            raise SystemExit("selected source input index is outside the locked source manifest")
        raw_source = inputs[index]
        if not isinstance(raw_source, str):
            raise SystemExit(f"source manifest input {index} is not text")
        source_key = http_source.validate_common_crawl_key(raw_source, crawl=contract.CRAWL)
        if source_key in seen:
            raise SystemExit("source manifest contains duplicate selected WAT keys")
        seen.add(source_key)
        selected.append({"source_key": source_key, "deterministic_suffix": contract.part_suffix(source_key)})
    return selected


def read_enam_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    require_file(path, "ENAM recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("ENAM recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != ENAM_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("ENAM recovery contract is not the reviewed CC-MAIN-2026-30 recovery declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256"):
        raise SystemExit("ENAM recovery contract does not bind this exact source shard manifest")
    if document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("ENAM recovery contract source shard differs from this source manifest")
    source_run_id = document.get("source_run_id")
    source_selected_inputs_sha256 = document.get("source_selected_inputs_sha256")
    if not isinstance(source_run_id, str) or not RUN_ID_RE.fullmatch(source_run_id) or not isinstance(source_selected_inputs_sha256, str) or not SHA256_RE.fullmatch(source_selected_inputs_sha256):
        raise SystemExit("ENAM recovery contract source-run identity is invalid")
    if document.get("source_task_count") != 100 or document.get("source_region") != ENAM_RECOVERY_REGION or document.get("source_region_index") != 1 or document.get("source_region_count") != 4:
        raise SystemExit("ENAM recovery contract does not describe the reviewed failed 100-WAT ENAM lane")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or len(indexes) != 18 or document.get("recovery_task_count") != len(indexes):
        raise SystemExit("ENAM recovery contract must contain exactly eighteen source indexes")
    if any(not isinstance(index, int) or isinstance(index, bool) for index in indexes) or indexes != sorted(set(indexes)):
        raise SystemExit("ENAM recovery source indexes must be sorted, unique integers")
    if any(index < 0 or index >= document["source_task_count"] or index % document["source_region_count"] != document["source_region_index"] for index in indexes):
        raise SystemExit("ENAM recovery source indexes are outside the failed ENAM lane")
    if document.get("failed_source_index") not in indexes:
        raise SystemExit("ENAM recovery contract must include the transiently failed source index")
    return document


def expand_incomplete_recovery_indexes(document: Mapping[str, Any]) -> list[int]:
    """Expand the audited missing-index ranges without accepting overlaps."""

    ranges = document.get("recovery_source_index_ranges")
    if not isinstance(ranges, list) or not ranges:
        raise SystemExit("incomplete recovery contract has no source-index ranges")
    region_indexes = {region: index for index, region in enumerate(REGIONS)}
    indexes: list[int] = []
    for item in ranges:
        if not isinstance(item, Mapping):
            raise SystemExit("incomplete recovery contract contains a malformed range")
        region = item.get("source_region")
        start = item.get("start")
        end = item.get("end")
        step = item.get("step")
        if region not in region_indexes or any(not isinstance(value, int) or isinstance(value, bool) for value in (start, end, step)):
            raise SystemExit("incomplete recovery contract range has invalid fields")
        if start < 0 or end < start or step <= 0 or start % len(REGIONS) != region_indexes[region] or end % len(REGIONS) != region_indexes[region] or step != len(REGIONS):
            raise SystemExit("incomplete recovery contract range is outside its original regional lane")
        indexes.extend(range(start, end + 1, step))
    if len(indexes) != len(set(indexes)):
        raise SystemExit("incomplete recovery source index ranges overlap")
    return sorted(indexes)


def read_incomplete_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    require_file(path, "incomplete recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("incomplete recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != INCOMPLETE_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("incomplete recovery contract is not the reviewed CC-MAIN-2026-30 declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("incomplete recovery contract does not bind this exact source shard manifest")
    if document.get("source_run_id") != "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" or document.get("source_task_count") != 1000 or document.get("source_selected_inputs_sha256") != "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5":
        raise SystemExit("incomplete recovery contract does not bind the diagnosed 1,000-WAT run")
    if not SHA256_RE.fullmatch(str(document.get("source_context_sha256"))) or not SHA256_RE.fullmatch(str(document.get("source_plan_sha256"))):
        raise SystemExit("incomplete recovery contract lacks source context hashes")
    indexes = expand_incomplete_recovery_indexes(document)
    if len(indexes) != document.get("recovery_task_count") or len(indexes) != 408 or any(index >= document["source_task_count"] for index in indexes):
        raise SystemExit("incomplete recovery contract does not contain the exact 408 missing source indexes")
    inventory = document.get("inventory")
    if not isinstance(inventory, Mapping) or inventory.get("object_count") != 4144 or inventory.get("completion_marker_count") != 592 or inventory.get("incomplete_task_count") != 408:
        raise SystemExit("incomplete recovery contract does not bind the reviewed R2 inventory")
    return document


def read_remaining_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    """Validate the post-failure inventory of source indexes still missing."""

    require_file(path, "remaining recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("remaining recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != REMAINING_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("remaining recovery contract is not the reviewed CC-MAIN-2026-30 declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("remaining recovery contract does not bind this exact source shard manifest")
    if document.get("source_run_id") != "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" or document.get("source_task_count") != 1000 or document.get("source_selected_inputs_sha256") != "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5":
        raise SystemExit("remaining recovery contract does not bind the diagnosed 1,000-WAT run")
    if not SHA256_RE.fullmatch(str(document.get("source_context_sha256"))) or not SHA256_RE.fullmatch(str(document.get("source_plan_sha256"))):
        raise SystemExit("remaining recovery contract lacks source context hashes")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or document.get("recovery_task_count") != len(indexes) or len(indexes) != 234:
        raise SystemExit("remaining recovery contract must contain exactly 234 source indexes")
    if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= document["source_task_count"] for index in indexes) or indexes != sorted(set(indexes)):
        raise SystemExit("remaining recovery source indexes must be sorted, unique source-manifest indexes")
    if document.get("recovery_source_indexes_sha256") != hashlib.sha256(canonical_json(indexes)).hexdigest():
        raise SystemExit("remaining recovery source-index digest is invalid")
    inventory = document.get("inventory")
    if not isinstance(inventory, Mapping) or inventory.get("original_completion_marker_count") != 592 or inventory.get("prior_recovery_completion_marker_count") != 174 or inventory.get("unique_completed_source_count") != 766 or inventory.get("remaining_task_count") != len(indexes):
        raise SystemExit("remaining recovery contract does not bind the merged R2 completion inventory")
    if inventory.get("original_and_prior_recovery_overlap_count") != 0:
        raise SystemExit("remaining recovery contract has an unsafe overlap in its merged completion inventory")
    prior_recovery = document.get("prior_recovery")
    if not isinstance(prior_recovery, Mapping) or prior_recovery.get("run_id") != "cc-main-2026-30-20260901t015900z-standard1-incomplete-156cf3c4" or prior_recovery.get("completion_marker_count") != 174:
        raise SystemExit("remaining recovery contract does not bind the stopped prior recovery")
    if prior_recovery.get("container_instances_verified_inactive") is not True:
        raise SystemExit("remaining recovery contract does not prove the prior recovery is inactive")
    return document


def read_high_capacity_partial_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    """Validate a read-only inventory contract for a stopped 128-slot run."""

    require_file(path, "128-slot partial recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("128-slot partial recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("128-slot partial recovery contract is not a reviewed CC-MAIN-2026-30 declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("128-slot partial recovery contract does not bind this exact source shard manifest")
    if document.get("source_execution_profile") != HIGH_CAPACITY_CHECKPOINT_PROFILE or document.get("source_task_count") != 1000 or document.get("source_max_concurrent_total") != 128:
        raise SystemExit("128-slot partial recovery contract does not bind a 1,000-WAT, 128-slot source run")
    source_run_id = document.get("source_run_id")
    source_selected_inputs_sha256 = document.get("source_selected_inputs_sha256")
    if not isinstance(source_run_id, str) or not RUN_ID_RE.fullmatch(source_run_id) or not isinstance(source_selected_inputs_sha256, str) or not SHA256_RE.fullmatch(source_selected_inputs_sha256):
        raise SystemExit("128-slot partial recovery contract source-run identity is invalid")
    if not SHA256_RE.fullmatch(str(document.get("source_context_sha256"))) or not SHA256_RE.fullmatch(str(document.get("source_plan_sha256"))):
        raise SystemExit("128-slot partial recovery contract lacks source context hashes")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or not indexes or document.get("recovery_task_count") != len(indexes):
        raise SystemExit("128-slot partial recovery contract must contain a non-empty exact source-index set")
    if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= document["source_task_count"] for index in indexes) or indexes != sorted(set(indexes)):
        raise SystemExit("128-slot partial recovery indexes must be sorted, unique source-manifest indexes")
    if document.get("recovery_source_indexes_sha256") != hashlib.sha256(canonical_json(indexes)).hexdigest():
        raise SystemExit("128-slot partial recovery source-index digest is invalid")
    recovery_regions = document.get("recovery_regions")
    if not isinstance(recovery_regions, list) or not recovery_regions or recovery_regions != [region for region in REGIONS if region in recovery_regions]:
        raise SystemExit("128-slot partial recovery regions must be a non-empty canonical regional subset")
    inventory = document.get("inventory")
    if not isinstance(inventory, Mapping):
        raise SystemExit("128-slot partial recovery contract lacks an immutable completion inventory")
    expected_counts = ("object_count", "completion_marker_count", "completed_source_count", "incomplete_task_count", "partial_task_prefix_count")
    if any(not isinstance(inventory.get(name), int) or isinstance(inventory.get(name), bool) or inventory.get(name) < 0 for name in expected_counts):
        raise SystemExit("128-slot partial recovery inventory has invalid counts")
    if inventory.get("completed_source_count") + inventory.get("incomplete_task_count") != document["source_task_count"] or inventory.get("incomplete_task_count") != len(indexes) or inventory.get("completion_marker_count") != inventory.get("completed_source_count"):
        raise SystemExit("128-slot partial recovery inventory does not partition the source run")
    if inventory.get("partial_task_prefix_count") > inventory.get("incomplete_task_count"):
        raise SystemExit("128-slot partial recovery inventory has an unsafe partial-prefix count")
    region_incomplete_counts = inventory.get("region_incomplete_counts")
    if not isinstance(region_incomplete_counts, Mapping) or any(not isinstance(region_incomplete_counts.get(region), int) or isinstance(region_incomplete_counts.get(region), bool) or region_incomplete_counts.get(region) < 0 for region in REGIONS):
        raise SystemExit("128-slot partial recovery inventory lacks valid per-region incomplete counts")
    if sum(region_incomplete_counts.values()) != len(indexes) or [region for region in REGIONS if region_incomplete_counts[region] > 0] != recovery_regions:
        raise SystemExit("128-slot partial recovery regions do not match the immutable completion inventory")
    source_workers = document.get("source_workers")
    if not isinstance(source_workers, Mapping) or source_workers.get("all_inactive") is not True:
        raise SystemExit("128-slot partial recovery contract does not prove the source Workers are inactive")
    regions = source_workers.get("regions")
    if not isinstance(regions, list) or [item.get("region") if isinstance(item, Mapping) else None for item in regions] != list(REGIONS):
        raise SystemExit("128-slot partial recovery contract lacks the four source Worker status checks")
    return document


def read_high_capacity_ten_thousand_partial_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    """Validate an immutable missing-task inventory for a stopped 256-slot run."""

    require_file(path, "256-slot partial recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("256-slot partial recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("256-slot partial recovery contract is not a reviewed CC-MAIN-2026-30 declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("256-slot partial recovery contract does not bind this exact source manifest")
    lane_names = [lane[0] for lane in HIGH_CAPACITY_TEN_THOUSAND_LANES]
    if document.get("source_execution_profile") != HIGH_CAPACITY_TEN_THOUSAND_PROFILE or document.get("source_task_count") != 10_000 or document.get("source_max_concurrent_total") != 256:
        raise SystemExit("256-slot partial recovery contract does not bind the reviewed 10,000-WAT source run")
    if not isinstance(document.get("source_run_id"), str) or not RUN_ID_RE.fullmatch(document["source_run_id"]) or not isinstance(document.get("source_selected_inputs_sha256"), str) or not SHA256_RE.fullmatch(document["source_selected_inputs_sha256"]):
        raise SystemExit("256-slot partial recovery contract source-run identity is invalid")
    if not SHA256_RE.fullmatch(str(document.get("source_context_sha256"))) or not SHA256_RE.fullmatch(str(document.get("source_plan_sha256"))):
        raise SystemExit("256-slot partial recovery contract lacks source context hashes")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or not indexes or document.get("recovery_task_count") != len(indexes):
        raise SystemExit("256-slot partial recovery contract must contain a non-empty exact source-index set")
    if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= 10_000 for index in indexes) or indexes != sorted(set(indexes)):
        raise SystemExit("256-slot partial recovery indexes must be sorted, unique source-manifest indexes")
    if document.get("recovery_source_indexes_sha256") != hashlib.sha256(canonical_json(indexes)).hexdigest():
        raise SystemExit("256-slot partial recovery source-index digest is invalid")
    recovery_regions = document.get("recovery_regions")
    if not isinstance(recovery_regions, list) or not recovery_regions or recovery_regions != [region for region in lane_names if region in recovery_regions]:
        raise SystemExit("256-slot partial recovery lanes must be a non-empty canonical subset")
    inventory = document.get("inventory")
    required_counts = ("object_count", "completion_marker_count", "completed_source_count", "incomplete_task_count", "partial_task_prefix_count")
    if not isinstance(inventory, Mapping) or any(not isinstance(inventory.get(name), int) or isinstance(inventory.get(name), bool) or inventory.get(name) < 0 for name in required_counts):
        raise SystemExit("256-slot partial recovery inventory has invalid counts")
    if inventory.get("completed_source_count") + inventory.get("incomplete_task_count") != 10_000 or inventory.get("completion_marker_count") != inventory.get("completed_source_count") or inventory.get("incomplete_task_count") != len(indexes) or inventory.get("partial_task_prefix_count") > len(indexes):
        raise SystemExit("256-slot partial recovery inventory does not partition the source run")
    incomplete_by_lane = inventory.get("region_incomplete_counts")
    if not isinstance(incomplete_by_lane, Mapping) or any(not isinstance(incomplete_by_lane.get(region), int) or isinstance(incomplete_by_lane.get(region), bool) or incomplete_by_lane.get(region) < 0 for region in lane_names):
        raise SystemExit("256-slot partial recovery inventory lacks valid per-lane incomplete counts")
    if sum(incomplete_by_lane.values()) != len(indexes) or [region for region in lane_names if incomplete_by_lane[region] > 0] != recovery_regions:
        raise SystemExit("256-slot partial recovery lanes do not match the immutable completion inventory")
    source_workers = document.get("source_workers")
    if not isinstance(source_workers, Mapping) or source_workers.get("all_inactive") is not True:
        raise SystemExit("256-slot partial recovery contract does not prove the source Workers are inactive")
    checks = source_workers.get("regions")
    if not isinstance(checks, list) or [item.get("region") if isinstance(item, Mapping) else None for item in checks] != lane_names:
        raise SystemExit("256-slot partial recovery contract lacks all source Worker status checks")
    return document


def read_high_capacity_ten_thousand_failed_lane_recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_manifest_file_sha256: str) -> dict[str, Any]:
    """Validate a recovery scoped only to terminal lanes of a live 256-slot run."""

    require_file(path, "256-slot failed-lane recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("256-slot failed-lane recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND or document.get("crawl") != CRAWL:
        raise SystemExit("256-slot failed-lane recovery contract is not a reviewed CC-MAIN-2026-30 declaration")
    if document.get("source_manifest_sha256") != source_manifest_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_shard_id") != source_document.get("shard_id"):
        raise SystemExit("256-slot failed-lane recovery contract does not bind this exact source manifest")
    lane_names = [lane[0] for lane in HIGH_CAPACITY_TEN_THOUSAND_LANES]
    if document.get("source_execution_profile") != HIGH_CAPACITY_TEN_THOUSAND_PROFILE or document.get("source_task_count") != 10_000 or document.get("source_max_concurrent_total") != 256:
        raise SystemExit("256-slot failed-lane recovery contract does not bind the reviewed 10,000-WAT source run")
    if not isinstance(document.get("source_run_id"), str) or not RUN_ID_RE.fullmatch(document["source_run_id"]) or not isinstance(document.get("source_selected_inputs_sha256"), str) or not SHA256_RE.fullmatch(document["source_selected_inputs_sha256"]):
        raise SystemExit("256-slot failed-lane recovery contract source-run identity is invalid")
    if not SHA256_RE.fullmatch(str(document.get("source_context_sha256"))) or not SHA256_RE.fullmatch(str(document.get("source_plan_sha256"))):
        raise SystemExit("256-slot failed-lane recovery contract lacks source context hashes")
    recovery_regions = document.get("recovery_regions")
    if not isinstance(recovery_regions, list) or not recovery_regions or recovery_regions != [region for region in lane_names if region in recovery_regions]:
        raise SystemExit("256-slot failed-lane recovery lanes must be a non-empty canonical subset")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or not indexes or document.get("recovery_task_count") != len(indexes):
        raise SystemExit("256-slot failed-lane recovery contract must contain a non-empty exact source-index set")
    if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= 10_000 for index in indexes) or indexes != sorted(set(indexes)):
        raise SystemExit("256-slot failed-lane recovery indexes must be sorted, unique source-manifest indexes")
    if any(lane_names[index % len(lane_names)] not in recovery_regions for index in indexes):
        raise SystemExit("256-slot failed-lane recovery indexes are outside the terminal lane partition")
    if document.get("recovery_source_indexes_sha256") != hashlib.sha256(canonical_json(indexes)).hexdigest():
        raise SystemExit("256-slot failed-lane recovery source-index digest is invalid")
    inventory = document.get("inventory")
    required_counts = ("object_count", "completion_marker_count", "completed_source_count", "incomplete_task_count", "partial_task_prefix_count", "scoped_task_count", "unscoped_task_count")
    if not isinstance(inventory, Mapping) or inventory.get("scope") != "terminal_source_lanes_only" or any(not isinstance(inventory.get(name), int) or isinstance(inventory.get(name), bool) or inventory.get(name) < 0 for name in required_counts):
        raise SystemExit("256-slot failed-lane recovery inventory has invalid counts")
    if inventory.get("scoped_task_count") + inventory.get("unscoped_task_count") != 10_000 or inventory.get("scoped_task_count") != len(recovery_regions) * 1250 or inventory.get("completed_source_count") + inventory.get("incomplete_task_count") != inventory.get("scoped_task_count") or inventory.get("completion_marker_count") != inventory.get("completed_source_count") or inventory.get("incomplete_task_count") != len(indexes) or inventory.get("partial_task_prefix_count") > len(indexes):
        raise SystemExit("256-slot failed-lane recovery inventory does not partition its terminal source lanes")
    incomplete_by_lane = inventory.get("region_incomplete_counts")
    if not isinstance(incomplete_by_lane, Mapping) or any(not isinstance(incomplete_by_lane.get(region), int) or isinstance(incomplete_by_lane.get(region), bool) or incomplete_by_lane.get(region) < 0 for region in lane_names):
        raise SystemExit("256-slot failed-lane recovery inventory lacks valid per-lane incomplete counts")
    if sum(incomplete_by_lane.values()) != len(indexes) or [region for region in lane_names if incomplete_by_lane[region] > 0] != recovery_regions:
        raise SystemExit("256-slot failed-lane recovery lanes do not match the immutable completion inventory")
    source_workers = document.get("source_workers")
    checks = source_workers.get("regions") if isinstance(source_workers, Mapping) else None
    if not isinstance(source_workers, Mapping) or source_workers.get("recovery_lanes_inactive") is not True or source_workers.get("recovery_regions") != recovery_regions or not isinstance(checks, list) or [item.get("region") if isinstance(item, Mapping) else None for item in checks] != lane_names:
        raise SystemExit("256-slot failed-lane recovery contract lacks an exact source Worker state inventory")
    by_region = {item["region"]: item for item in checks if isinstance(item, Mapping)}
    if any(by_region[region].get("safely_inactive") is not True or by_region[region].get("launch_state") not in {"task_failed", "credential_window_elapsed", "completed_with_recoverable_failures"} for region in recovery_regions):
        raise SystemExit("256-slot failed-lane recovery contract does not prove each selected source Worker is terminal")
    return document


def validate_source_run_context(path: Path, recovery: Mapping[str, Any]) -> str:
    require_file(path, "source regional-run context")
    try:
        context = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("source regional-run context is not valid UTF-8 JSON") from error
    if not isinstance(context, Mapping):
        raise SystemExit("source regional-run context is invalid")
    if context.get("run_id") != recovery["source_run_id"] or context.get("task_count") != recovery["source_task_count"] or context.get("selected_inputs_sha256") != recovery["source_selected_inputs_sha256"]:
        raise SystemExit("source regional-run context does not match the reviewed ENAM recovery contract")
    regions = context.get("regions")
    if not isinstance(regions, list) or not any(isinstance(item, Mapping) and item.get("region") == ENAM_RECOVERY_REGION and item.get("regional_task_count") == 25 for item in regions):
        raise SystemExit("source regional-run context lacks the reviewed ENAM lane")
    return sha256_file(path)


def validate_incomplete_source_run_context(path: Path, recovery: Mapping[str, Any]) -> str:
    require_file(path, "source 1,000-WAT regional-run context")
    digest = sha256_file(path)
    if digest != recovery["source_context_sha256"]:
        raise SystemExit("source 1,000-WAT context SHA-256 differs from the recovery contract")
    try:
        context = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("source 1,000-WAT context is not valid UTF-8 JSON") from error
    if not isinstance(context, Mapping) or context.get("run_id") != recovery["source_run_id"] or context.get("task_count") != recovery["source_task_count"] or context.get("selected_inputs_sha256") != recovery["source_selected_inputs_sha256"]:
        raise SystemExit("source 1,000-WAT context does not match the recovery contract")
    regions = context.get("regions")
    if not isinstance(regions, list) or [item.get("region") if isinstance(item, Mapping) else None for item in regions] != list(REGIONS):
        raise SystemExit("source 1,000-WAT context does not contain the reviewed four regional lanes")
    return digest


def validate_high_capacity_source_run_context(path: Path, recovery: Mapping[str, Any]) -> str:
    """Bind the recovery contract to the exact stopped 128-slot source plan."""

    require_file(path, "source 128-slot regional-run context")
    context_digest = sha256_file(path)
    if context_digest != recovery["source_context_sha256"]:
        raise SystemExit("source 128-slot context SHA-256 differs from the recovery contract")
    plan_path = path.parent / "RUN-PLAN.json"
    require_file(plan_path, "source 128-slot regional-run plan")
    if sha256_file(plan_path) != recovery["source_plan_sha256"]:
        raise SystemExit("source 128-slot plan SHA-256 differs from the recovery contract")
    try:
        context = json.loads(path.read_text(encoding="utf-8"))
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("source 128-slot run context or plan is not valid UTF-8 JSON") from error
    if not isinstance(context, Mapping) or not isinstance(plan, Mapping):
        raise SystemExit("source 128-slot run context or plan is invalid")
    required = {
        "run_id": recovery["source_run_id"],
        "execution_profile": HIGH_CAPACITY_CHECKPOINT_PROFILE,
        "task_count": recovery["source_task_count"],
        "selected_inputs_sha256": recovery["source_selected_inputs_sha256"],
        "max_concurrent_total": recovery["source_max_concurrent_total"],
    }
    if any(context.get(key) != value or plan.get(key) != value for key, value in required.items()):
        raise SystemExit("source 128-slot context or plan does not match the recovery contract")
    regions = plan.get("regions")
    if not isinstance(regions, list) or [item.get("region") if isinstance(item, Mapping) else None for item in regions] != list(REGIONS):
        raise SystemExit("source 128-slot plan does not contain the reviewed four regional lanes")
    if any(not isinstance(item, Mapping) or item.get("regional_task_count") != 250 or item.get("max_concurrent") != 32 or item.get("max_instances") != 34 for item in regions):
        raise SystemExit("source 128-slot plan does not bind the reviewed 32-slot regional lanes")
    return context_digest


def validate_high_capacity_ten_thousand_source_run_context(path: Path, recovery: Mapping[str, Any]) -> str:
    """Bind recovery to the exact stopped eight-lane 256-slot source plan."""

    require_file(path, "source 256-slot regional-run context")
    context_digest = sha256_file(path)
    if context_digest != recovery["source_context_sha256"]:
        raise SystemExit("source 256-slot context SHA-256 differs from the recovery contract")
    plan_path = path.parent / "RUN-PLAN.json"
    require_file(plan_path, "source 256-slot regional-run plan")
    if sha256_file(plan_path) != recovery["source_plan_sha256"]:
        raise SystemExit("source 256-slot plan SHA-256 differs from the recovery contract")
    try:
        context = json.loads(path.read_text(encoding="utf-8"))
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("source 256-slot run context or plan is not valid UTF-8 JSON") from error
    required = {
        "run_id": recovery["source_run_id"],
        "execution_profile": HIGH_CAPACITY_TEN_THOUSAND_PROFILE,
        "task_count": 10_000,
        "selected_inputs_sha256": recovery["source_selected_inputs_sha256"],
        "max_concurrent_total": 256,
    }
    if not isinstance(context, Mapping) or not isinstance(plan, Mapping) or any(context.get(key) != value or plan.get(key) != value for key, value in required.items()):
        raise SystemExit("source 256-slot context or plan does not match the recovery contract")
    regions = plan.get("regions")
    if not isinstance(regions, list) or len(regions) != len(HIGH_CAPACITY_TEN_THOUSAND_LANES):
        raise SystemExit("source 256-slot plan does not contain the reviewed eight lanes")
    for index, (region, placement, initial_delay) in enumerate(HIGH_CAPACITY_TEN_THOUSAND_LANES):
        item = regions[index]
        if not isinstance(item, Mapping) or item.get("region") != region or item.get("region_index") != index or item.get("region_count") != len(HIGH_CAPACITY_TEN_THOUSAND_LANES) or item.get("placement_constraint") != placement or item.get("initial_start_delay_seconds") != initial_delay or item.get("regional_task_count") != 1250 or item.get("max_concurrent") != 32 or item.get("max_instances") != 34:
            raise SystemExit("source 256-slot plan does not bind the reviewed 32-slot logical lanes")
    return context_digest


def regional_task_count(total: int, region_index: int, region_count: int) -> int:
    return 0 if total <= region_index else ((total - 1 - region_index) // region_count) + 1


def copy_file(source: Path, destination: Path, copied: list[Path]) -> None:
    require_file(source, source.name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied.append(destination)


def build_region(*, run_id: str, region: str, placement_constraint: str, initial_start_delay_seconds: int, region_index: int, region_count: int, selected_inputs: dict[str, Any], selected_inputs_sha256: str, source_document: Mapping[str, Any], source_manifest_file_sha256: str, max_concurrent: int, start_spacing_seconds: int, plan_kind: str, execution_profile: str, credential_policy: Mapping[str, Any], output_dir: Path) -> dict[str, Any]:
    count = int(selected_inputs["input_count"])
    lane_count = regional_task_count(count, region_index, region_count)
    if lane_count == 0:
        raise SystemExit("every configured regional Worker must own at least one selected WAT")
    worker_name = f"growthsent-regional-{run_id.rsplit('-', 1)[-1]}-{region.lower()}"
    if not WORKER_NAME_RE.fullmatch(worker_name):
        raise SystemExit("derived regional Worker name is invalid")
    bundle = output_dir / "bundles" / region.lower()
    bundle.mkdir(parents=True)
    copied: list[Path] = []
    for name in LOCAL_STATIC:
        copy_file(HERE / name, bundle / name, copied)
    index_source = require_file(HERE / "src" / "index.ts", "regional Worker source")
    copy_file(index_source, bundle / "src" / "index.ts", copied)
    selected_path = bundle / "selected-inputs.json"
    selected_path.write_bytes(canonical_json(selected_inputs))
    copied.append(selected_path)
    tools_destination = bundle / "tools"
    tools_destination.mkdir()
    for name in TOOL_NAMES:
        copy_file(TOOLS / name, tools_destination / name, copied)

    lane_max_concurrent = min(max_concurrent, lane_count)
    release = release_sha256(copied, bundle)
    max_instances = lane_max_concurrent + 2
    config = {
        "$schema": "node_modules/wrangler/config-schema.json",
        "account_id": ACCOUNT_ID,
        "name": worker_name,
        "main": "src/index.ts",
        "compatibility_date": "2026-08-31",
        "compatibility_flags": ["nodejs_compat"],
        "workers_dev": True,
        "observability": {"enabled": True, "logs": {"invocation_logs": True, "head_sampling_rate": 1}},
        "containers": [{
            "class_name": "GrowthSentStandard1RegionalRampContainer",
            "name": worker_name,
            "image": "./Dockerfile",
            "instance_type": "standard-1",
            "max_instances": max_instances,
            "constraints": {"regions": [placement_constraint]},
        }],
        "durable_objects": {"bindings": [
            {"name": "RAMP_CONTAINER", "class_name": "GrowthSentStandard1RegionalRampContainer"},
            {"name": "RAMP_COORDINATOR", "class_name": "GrowthSentStandard1RegionalRampCoordinator"},
        ]},
        "migrations": [{"tag": "v1", "new_sqlite_classes": ["GrowthSentStandard1RegionalRampContainer", "GrowthSentStandard1RegionalRampCoordinator"]}],
        "vars": {
            "GROWTHSENT_R2_ACCOUNT_ID": ACCOUNT_ID,
            "GROWTHSENT_R2_BUCKET": BUCKET,
            "GROWTHSENT_RAMP_ID": run_id,
            "GROWTHSENT_REGION": region,
            "GROWTHSENT_REGION_INDEX": str(region_index),
            "GROWTHSENT_REGION_COUNT": str(region_count),
            "GROWTHSENT_TASK_COUNT": str(count),
            "GROWTHSENT_REGIONAL_TASK_COUNT": str(lane_count),
            "GROWTHSENT_MAX_CONCURRENT": str(lane_max_concurrent),
            "GROWTHSENT_START_SPACING_SECONDS": str(start_spacing_seconds),
            "GROWTHSENT_INITIAL_START_DELAY_SECONDS": str(initial_start_delay_seconds),
            "GROWTHSENT_RELEASE_SHA256": release,
            "GROWTHSENT_SELECTED_INPUTS_SHA256": selected_inputs_sha256,
            "GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS": str(credential_policy["start_guard_seconds"]),
            "GROWTHSENT_CONTAINER_INSTANCE_TYPE": "standard-1",
            "GROWTHSENT_HARD_TIMEOUT_SECONDS": str(HARD_TIMEOUT_SECONDS),
        },
    }
    (bundle / "wrangler.jsonc").write_bytes(canonical_json(config))
    release_document = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-regional-ramp-release",
        "plan_kind": plan_kind,
        "execution_profile": execution_profile,
        "credential_policy": dict(credential_policy),
        "run_id": run_id,
        "region": region,
        "region_index": region_index,
        "region_count": region_count,
        "worker_name": worker_name,
        "source_manifest_claim_sha256": source_document.get("manifest_sha256"),
        "source_manifest_file_sha256": source_manifest_file_sha256,
        "selected_inputs_sha256": selected_inputs_sha256,
        "task_count": count,
        "regional_task_count": lane_count,
        "max_concurrent": lane_max_concurrent,
        "max_instances": max_instances,
        "start_spacing_seconds": start_spacing_seconds,
        "placement_constraint": placement_constraint,
        "release_sha256": release,
        "files": [{"path": path.relative_to(bundle).as_posix(), "sha256": sha256_file(path)} for path in sorted(copied, key=lambda item: item.relative_to(bundle).as_posix())],
    }
    (bundle / "RAMP-RELEASE.json").write_bytes(canonical_json(release_document))
    return {
        "region": region,
        "region_index": region_index,
        "region_count": region_count,
        "worker_name": worker_name,
        "bundle": str(bundle),
        "regional_task_count": lane_count,
        "max_concurrent": lane_max_concurrent,
        "max_instances": max_instances,
        "placement_constraint": placement_constraint,
        "initial_start_delay_seconds": initial_start_delay_seconds,
        "release_sha256": release,
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not RUN_ID_RE.fullmatch(args.run_id):
        raise SystemExit("--run-id must be a lowercase slug of at most 64 characters")
    maximum_task_count = 10_000 if args.execution_profile in (TEN_THOUSAND_WAT_PROFILE, HIGH_CAPACITY_TEN_THOUSAND_PROFILE) else 1000
    if not 1 <= args.task_count <= maximum_task_count:
        raise SystemExit(f"--task-count must be between 1 and {maximum_task_count}")
    if not 1 <= args.max_concurrent <= 32:
        raise SystemExit("--max-concurrent must be between 1 and 32 per regional Worker")
    if not 5 <= args.start_spacing_seconds <= 120:
        raise SystemExit("--start-spacing-seconds must be between 5 and 120")
    if args.execution_profile == HIGH_CAPACITY_CHECKPOINT_PROFILE and (args.task_count != 1000 or args.max_concurrent != 32 or args.start_spacing_seconds != DEFAULT_START_SPACING_SECONDS):
        raise SystemExit("the regional-128-capacity-checkpoint profile requires exactly 1,000 tasks, 32 slots per region, and 15-second spacing")
    if args.execution_profile == HIGH_CAPACITY_TEN_THOUSAND_PROFILE and args.recovery_contract is None and (args.task_count != 10_000 or args.max_concurrent != 32 or args.start_spacing_seconds != 30):
        raise SystemExit("the regional-256-ten-thousand-wat profile requires exactly 10,000 tasks, 32 slots per lane, and 30-second lane spacing")
    if args.source_run_context is not None and args.recovery_contract is None:
        raise SystemExit("--source-run-context is valid only with --recovery-contract")
    if args.output_dir.exists():
        raise SystemExit(f"refusing to overwrite an existing output directory: {args.output_dir}")
    source_document, source_manifest_file_sha256 = load_source_manifest(args.source_manifest, execution_profile=args.execution_profile)
    recovery: dict[str, Any] | None = None
    recovery_kind: str | None = None
    recovery_contract_sha256: str | None = None
    source_context_sha256: str | None = None
    if args.recovery_contract is not None:
        if args.source_run_context is None:
            raise SystemExit("--recovery-contract requires a secret-free source-run context")
        try:
            contract_document = json.loads(args.recovery_contract.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit("recovery contract is not valid UTF-8 JSON") from error
        if not isinstance(contract_document, Mapping):
            raise SystemExit("recovery contract must be a JSON object")
        contract_kind = contract_document.get("kind")
        if contract_kind == ENAM_RECOVERY_CONTRACT_KIND:
            if args.execution_profile != CAPACITY_CHECKPOINT_PROFILE:
                raise SystemExit("the isolated ENAM recovery uses its reviewed two-hour credential profile")
            recovery = read_enam_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_source_run_context(args.source_run_context, recovery)
            selected_indexes = list(recovery["recovery_source_indexes"])
            if args.task_count != len(selected_indexes):
                raise SystemExit("--task-count must equal the exact eighteen-WAT ENAM recovery contract")
            configured_lanes = ((ENAM_RECOVERY_REGION, ENAM_RECOVERY_REGION, 0),)
            plan_kind = ENAM_RECOVERY_PLAN_KIND
            execution_profile = ENAM_RECOVERY_PROFILE
            credential_policy = dict(CAPACITY_CHECKPOINT_CREDENTIAL_POLICY)
            recovery_kind = "enam"
        elif contract_kind == INCOMPLETE_RECOVERY_CONTRACT_KIND:
            recovery = read_incomplete_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_incomplete_source_run_context(args.source_run_context, recovery)
            selected_indexes = expand_incomplete_recovery_indexes(recovery)
            if args.task_count != len(selected_indexes):
                raise SystemExit("--task-count must equal the exact audited incomplete recovery contract")
            configured_lanes = tuple((region, region, index * args.start_spacing_seconds) for index, region in enumerate(REGIONS))
            plan_kind = INCOMPLETE_RECOVERY_PLAN_KIND
            execution_profile = INCOMPLETE_RECOVERY_PROFILE
            credential_policy = dict(INCOMPLETE_RECOVERY_CREDENTIAL_POLICY)
            recovery_kind = "incomplete"
        elif contract_kind == REMAINING_RECOVERY_CONTRACT_KIND:
            recovery = read_remaining_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_incomplete_source_run_context(args.source_run_context, recovery)
            selected_indexes = list(recovery["recovery_source_indexes"])
            if args.task_count != len(selected_indexes):
                raise SystemExit("--task-count must equal the exact audited remaining recovery contract")
            configured_lanes = tuple((region, region, index * args.start_spacing_seconds) for index, region in enumerate(REGIONS))
            plan_kind = REMAINING_RECOVERY_PLAN_KIND
            execution_profile = REMAINING_RECOVERY_PROFILE
            credential_policy = dict(INCOMPLETE_RECOVERY_CREDENTIAL_POLICY)
            recovery_kind = "remaining"
        elif contract_kind == HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND:
            recovery = read_high_capacity_partial_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_high_capacity_source_run_context(args.source_run_context, recovery)
            selected_indexes = list(recovery["recovery_source_indexes"])
            if args.task_count != len(selected_indexes) or args.max_concurrent != 32 or args.start_spacing_seconds != DEFAULT_START_SPACING_SECONDS:
                raise SystemExit("the 128-slot partial recovery requires its exact audited task count, 32 slots per region, and 15-second spacing")
            configured_lanes = tuple((region, region, index * args.start_spacing_seconds) for index, region in enumerate(recovery["recovery_regions"]))
            plan_kind = HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND
            execution_profile = HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE
            credential_policy = dict(HIGH_CAPACITY_PARTIAL_RECOVERY_CREDENTIAL_POLICY)
            recovery_kind = "high-capacity-partial"
        elif contract_kind == HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND:
            recovery = read_high_capacity_ten_thousand_partial_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_high_capacity_ten_thousand_source_run_context(args.source_run_context, recovery)
            selected_indexes = list(recovery["recovery_source_indexes"])
            if args.task_count != len(selected_indexes) or args.max_concurrent != 32 or args.start_spacing_seconds != 30:
                raise SystemExit("the 256-slot partial recovery requires its exact audited task count, 32 slots per lane, and 30-second lane spacing")
            configured_lanes = tuple(lane for lane in HIGH_CAPACITY_TEN_THOUSAND_LANES if lane[0] in recovery["recovery_regions"])
            plan_kind = HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND
            execution_profile = HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE
            credential_policy = dict(HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CREDENTIAL_POLICY)
            recovery_kind = "high-capacity-ten-thousand-partial"
        elif contract_kind == HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND:
            recovery = read_high_capacity_ten_thousand_failed_lane_recovery_contract(
                args.recovery_contract,
                source_document=source_document,
                source_manifest_file_sha256=source_manifest_file_sha256,
            )
            source_context_sha256 = validate_high_capacity_ten_thousand_source_run_context(args.source_run_context, recovery)
            selected_indexes = list(recovery["recovery_source_indexes"])
            if args.task_count != len(selected_indexes) or args.max_concurrent != 32 or args.start_spacing_seconds != 30:
                raise SystemExit("the 256-slot failed-lane recovery requires its exact audited task count, 32 slots per lane, and 30-second lane spacing")
            configured_lanes = tuple(lane for lane in HIGH_CAPACITY_TEN_THOUSAND_LANES if lane[0] in recovery["recovery_regions"])
            plan_kind = HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND
            execution_profile = HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE
            credential_policy = dict(HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CREDENTIAL_POLICY)
            recovery_kind = "high-capacity-ten-thousand-failed-lane"
        else:
            raise SystemExit("recovery contract kind is not reviewed")
        recovery_contract_sha256 = sha256_file(args.recovery_contract)
    else:
        if args.execution_profile == THOUSAND_WAT_PROFILE and args.task_count != 1000:
            raise SystemExit("the regional-thousand-wat profile requires exactly 1,000 tasks")
        if args.execution_profile == TEN_THOUSAND_WAT_PROFILE and args.task_count != 10_000:
            raise SystemExit("the regional-ten-thousand-wat profile requires exactly 10,000 tasks")
        if args.execution_profile == HIGH_CAPACITY_TEN_THOUSAND_PROFILE and args.task_count != 10_000:
            raise SystemExit("the regional-256-ten-thousand-wat profile requires exactly 10,000 tasks")
        selected_indexes = list(range(args.task_count))
        configured_lanes = HIGH_CAPACITY_TEN_THOUSAND_LANES if args.execution_profile == HIGH_CAPACITY_TEN_THOUSAND_PROFILE else tuple((region, region, index * args.start_spacing_seconds) for index, region in enumerate(REGIONS))
        plan_kind = HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND if args.execution_profile == HIGH_CAPACITY_TEN_THOUSAND_PROFILE else NORMAL_PLAN_KIND
        execution_profile = args.execution_profile
        credential_policy = dict(
            THOUSAND_WAT_CREDENTIAL_POLICY
            if execution_profile in (THOUSAND_WAT_PROFILE, TEN_THOUSAND_WAT_PROFILE, HIGH_CAPACITY_CHECKPOINT_PROFILE, HIGH_CAPACITY_TEN_THOUSAND_PROFILE)
            else CAPACITY_CHECKPOINT_CREDENTIAL_POLICY
        )
    selected = select_source_inputs(source_document, selected_indexes)
    selected_inputs = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-regional-inputs-v1",
        "crawl": CRAWL,
        "source_manifest_kind": source_document["kind"],
        "source_manifest_claim_sha256": source_document.get("manifest_sha256"),
        "source_manifest_sha256": source_manifest_file_sha256,
        "source_shard_id": source_document.get("shard_id"),
        "input_count": len(selected),
        "inputs": selected,
        "selected_inputs_sha256": hashlib.sha256(canonical_json(selected)).hexdigest(),
    }
    if recovery is not None:
        recovery_metadata = {
            "contract_kind": recovery["kind"],
            "contract_sha256": recovery_contract_sha256,
            "source_run_id": recovery["source_run_id"],
            "source_task_count": recovery["source_task_count"],
            "source_selected_inputs_sha256": recovery["source_selected_inputs_sha256"],
            "recovery_source_indexes": selected_indexes,
        }
        if recovery_kind == "enam":
            recovery_metadata.update({
                "source_region": recovery["source_region"],
                "source_region_index": recovery["source_region_index"],
                "source_region_count": recovery["source_region_count"],
            })
        elif recovery_kind in ("high-capacity-partial", "high-capacity-ten-thousand-partial", "high-capacity-ten-thousand-failed-lane"):
            recovery_metadata.update({
                "source_execution_profile": recovery["source_execution_profile"],
                "source_max_concurrent_total": recovery["source_max_concurrent_total"],
                "source_context_sha256": source_context_sha256,
                "source_plan_sha256": recovery["source_plan_sha256"],
                "inventory": recovery["inventory"],
                "source_workers": recovery["source_workers"],
                "recovery_task_count": recovery["recovery_task_count"],
                "recovery_regions": recovery["recovery_regions"],
                "recovery_source_indexes_sha256": recovery["recovery_source_indexes_sha256"],
            })
        else:
            recovery_metadata.update({
                "source_context_sha256": source_context_sha256,
                "source_plan_sha256": recovery["source_plan_sha256"],
                "inventory": recovery["inventory"],
            })
            if recovery_kind == "remaining":
                recovery_metadata.update({
                    "prior_recovery": recovery["prior_recovery"],
                    "recovery_source_indexes_sha256": recovery["recovery_source_indexes_sha256"],
                })
        selected_inputs["recovery"] = recovery_metadata
    selected_inputs_sha256 = hashlib.sha256(canonical_json(selected_inputs)).hexdigest()
    args.output_dir.mkdir(parents=True)
    regional_bundles = [
        build_region(
            run_id=args.run_id,
            region=region,
            placement_constraint=placement_constraint,
            initial_start_delay_seconds=initial_start_delay_seconds,
            region_index=index,
            region_count=len(configured_lanes),
            selected_inputs=selected_inputs,
            selected_inputs_sha256=selected_inputs_sha256,
            source_document=source_document,
            source_manifest_file_sha256=source_manifest_file_sha256,
            max_concurrent=args.max_concurrent,
            start_spacing_seconds=args.start_spacing_seconds,
            plan_kind=plan_kind,
            execution_profile=execution_profile,
            credential_policy=credential_policy,
            output_dir=args.output_dir,
        )
        for index, (region, placement_constraint, initial_start_delay_seconds) in enumerate(configured_lanes)
    ]
    plan = {
        "format_version": 1,
        "kind": plan_kind,
        "execution_profile": execution_profile,
        "credential_policy": credential_policy,
        "run_id": args.run_id,
        "r2_root": f"production/common-crawl/cloudflare-r2-regional-ramps/v1/{args.run_id}/",
        "source_manifest": {
            "path": str(args.source_manifest),
            "claim_sha256": source_document.get("manifest_sha256"),
            "file_sha256": source_manifest_file_sha256,
            "source_shard_id": source_document.get("shard_id"),
        },
        "selected_inputs_sha256": selected_inputs_sha256,
        "task_count": len(selected),
        "max_concurrent_total": sum(item["max_concurrent"] for item in regional_bundles),
        "start_spacing_seconds_per_lane": args.start_spacing_seconds,
        "regions": regional_bundles,
        "remote_start": "disabled; this build is a local compilation and configuration artifact only",
    }
    if recovery is not None:
        recovery_metadata = {
            "contract_kind": recovery["kind"],
            "contract_sha256": recovery_contract_sha256,
            "source_context_sha256": source_context_sha256,
            "source_run_id": recovery["source_run_id"],
            "source_task_count": recovery["source_task_count"],
            "source_selected_inputs_sha256": recovery["source_selected_inputs_sha256"],
            "recovery_source_indexes": selected_indexes,
        }
        if recovery_kind == "enam":
            recovery_metadata.update({
                "source_region": recovery["source_region"],
                "source_region_index": recovery["source_region_index"],
                "source_region_count": recovery["source_region_count"],
                "failed_source_index": recovery["failed_source_index"],
            })
        elif recovery_kind in ("high-capacity-partial", "high-capacity-ten-thousand-partial", "high-capacity-ten-thousand-failed-lane"):
            recovery_metadata.update({
                "source_execution_profile": recovery["source_execution_profile"],
                "source_max_concurrent_total": recovery["source_max_concurrent_total"],
                "source_context_sha256": source_context_sha256,
                "source_plan_sha256": recovery["source_plan_sha256"],
                "inventory": recovery["inventory"],
                "source_workers": recovery["source_workers"],
                "recovery_task_count": recovery["recovery_task_count"],
                "recovery_regions": recovery["recovery_regions"],
                "recovery_source_indexes_sha256": recovery["recovery_source_indexes_sha256"],
            })
        else:
            recovery_metadata.update({
                "source_plan_sha256": recovery["source_plan_sha256"],
                "inventory": recovery["inventory"],
            })
            if recovery_kind == "remaining":
                recovery_metadata.update({
                    "prior_recovery": recovery["prior_recovery"],
                    "recovery_source_indexes_sha256": recovery["recovery_source_indexes_sha256"],
                })
        plan["recovery"] = recovery_metadata
    (args.output_dir / "RUN-PLAN.json").write_bytes(canonical_json(plan))
    print(json.dumps(plan, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
