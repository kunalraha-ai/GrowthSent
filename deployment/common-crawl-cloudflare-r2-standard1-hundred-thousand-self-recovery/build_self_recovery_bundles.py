#!/usr/bin/env python3
"""Build a launch-disabled, self-healing remaining-89,000-WAT control plane.

This only reads the locked 100,000-WAT manifest and writes local Worker and
Container bundles. It cannot mint credentials, call Cloudflare, write R2,
deploy a Worker, or start a Container.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from typing import Any, Iterable, Mapping, Sequence


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAMP = ROOT / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp"
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_gcp_r2_25k_contract as contract  # noqa: E402
import common_crawl_v2_manifest as manifest  # noqa: E402


ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146"
BUCKET = "growthsent-data-lake"
CRAWL = "CC-MAIN-2026-30"
SOURCE_TASK_COUNT = 100_000
REUSED_SOURCE_PREFIX_COUNT = 11_000
PROCESSING_TASK_COUNT = SOURCE_TASK_COUNT - REUSED_SOURCE_PREFIX_COUNT
SLOTS_PER_LANE = 32
LANE_HEADROOM = 0
START_SPACING_SECONDS = 5
ADMISSION_INTERVAL_SECONDS = 6
ADMISSION_MAX_BACKOFF_SECONDS = 300
CHILD_TTL_SECONDS = 518_400
START_GUARD_SECONDS = 10_800
RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
WORKER_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
PLAN_KIND = "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-plan-v1"
POLICY_KIND = "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-policy-v1"
ADMISSION_RELEASE_KIND = "growthsent-cloudflare-r2-standard1-regional-admission-release-v1"
LANE_RELEASE_KIND = "growthsent-cloudflare-r2-standard1-hundred-thousand-lane-release-v1"
EXECUTION_PROFILE = "regional-1440-remaining-eighty-nine-thousand-self-recovery"
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


def release_sha256(paths: Iterable[Path], output_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.relative_to(output_dir).as_posix()):
        digest.update(path.relative_to(output_dir).as_posix().encode("utf-8") + b"\0")
        digest.update(sha256_file(path).encode("ascii") + b"\n")
    return digest.hexdigest()


def plan_sha256(document: Mapping[str, Any]) -> str:
    payload = dict(document)
    payload.pop("plan_sha256", None)
    return hashlib.sha256(canonical_json(payload).rstrip(b"\n")).hexdigest()


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise SystemExit(f"missing {label}: {path}")
    return path


def copy_file(source: Path, destination: Path, copied: list[Path]) -> None:
    require_file(source, source.name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied.append(destination)


def require_empty_output_dir(path: Path) -> None:
    if path.exists() and not path.is_dir():
        raise SystemExit(f"output path is not a directory: {path}")
    if path.exists() and any(path.iterdir()):
        raise SystemExit("output directory must be empty")
    path.mkdir(parents=True, exist_ok=True)


def load_reuse_proof(path: Path, *, source_document: Mapping[str, Any], source_file_sha256: str) -> dict[str, Any]:
    require_file(path, "verified 11,000-WAT reuse proof")
    try:
        proof = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"verified reuse proof is not valid JSON: {path}") from error
    if not isinstance(proof, dict):
        raise SystemExit("verified reuse proof must be a JSON object")
    if proof.get("kind") != "growthsent-cloudflare-r2-standard1-verified-reuse-proof-v1":
        raise SystemExit("verified reuse proof has an unexpected kind")
    claimed_digest = proof.get("proof_sha256")
    proof_payload = dict(proof)
    proof_payload.pop("proof_sha256", None)
    proof_digest = hashlib.sha256(canonical_json(proof_payload).rstrip(b"\n")).hexdigest()
    if not isinstance(claimed_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", claimed_digest) or claimed_digest != proof_digest:
        raise SystemExit("verified reuse proof digest is invalid")
    source = proof.get("source_manifest")
    if not isinstance(source, dict):
        raise SystemExit("verified reuse proof omits its source manifest binding")
    if source.get("file_sha256") != source_file_sha256 or source.get("claim_sha256") != source_document["manifest_sha256"] or source.get("inputs_sha256") != source_document["inputs_sha256"] or source.get("input_count") != SOURCE_TASK_COUNT:
        raise SystemExit("verified reuse proof is not bound to this locked 100,000-WAT source manifest")
    if proof.get("completed_source_index_ranges") != [{"start": 0, "end_exclusive": REUSED_SOURCE_PREFIX_COUNT}] or proof.get("completed_source_count") != REUSED_SOURCE_PREFIX_COUNT:
        raise SystemExit("verified reuse proof does not prove the exact completed 11,000-WAT prefix")
    if proof.get("remaining_source_index_ranges") != [{"start": REUSED_SOURCE_PREFIX_COUNT, "end_exclusive": SOURCE_TASK_COUNT}] or proof.get("remaining_source_count") != PROCESSING_TASK_COUNT:
        raise SystemExit("verified reuse proof does not authorize the exact remaining 89,000-WAT range")
    return proof


def reviewed_lanes() -> tuple[tuple[str, str, int], ...]:
    # Six non-limited placement groups. A shared per-group admission Durable
    # Object lets many logical lanes warm without recreating the earlier APAC
    # burst; it is not a claim of reserved regional capacity.
    groups = (("APAC", 8), ("ENAM", 8), ("WNAM", 8), ("EEUR", 7), ("WEUR", 7), ("SAM", 7))
    lanes: list[tuple[str, str, int]] = []
    for group, count in groups:
        for ordinal in range(1, count + 1):
            lanes.append((f"{group}-{ordinal:02d}", group, (ordinal - 1) * START_SPACING_SECONDS))
    if len(lanes) != 45 or sum(1 for _lane, group, _delay in lanes if group == "APAC") != 8:
        raise AssertionError("reviewed 100K lane topology is inconsistent")
    return tuple(lanes)


def lane_task_count(total: int, lane_index: int, lane_count: int) -> int:
    return 0 if total <= lane_index else ((total - 1 - lane_index) // lane_count) + 1


def selected_input(source_key: str) -> dict[str, str]:
    return {"source_key": source_key, "deterministic_suffix": contract.part_suffix(source_key)}


def sparse_lane_manifest(*, source_document: Mapping[str, Any], source_file_sha256: str, source_index_start: int, processing_task_count: int, lane_index: int, lane_count: int) -> dict[str, Any]:
    source_inputs = source_document["inputs"]
    indexes = list(range(source_index_start + lane_index, source_index_start + processing_task_count, lane_count))
    inputs = [selected_input(source_inputs[index]) for index in indexes]
    if len(indexes) != lane_task_count(processing_task_count, lane_index, lane_count):
        raise SystemExit("sparse lane allocation differs from the deterministic global partition")
    return {
        "format_version": 2,
        "kind": "growthsent-cloudflare-r2-standard1-regional-inputs-v1",
        "crawl": CRAWL,
        "source_manifest_kind": source_document["kind"],
        "source_manifest_claim_sha256": source_document["manifest_sha256"],
        "source_manifest_sha256": source_file_sha256,
        "source_shard_id": None,
        "input_count": SOURCE_TASK_COUNT,
        "source_indexes": indexes,
        "inputs": inputs,
        "selected_inputs_sha256": hashlib.sha256(canonical_json(inputs)).hexdigest(),
    }


def build_admission_bundle(*, run_id: str, output_dir: Path) -> dict[str, Any]:
    suffix = run_id.rsplit("-", 1)[-1]
    worker_name = f"growthsent-h100k-admission-{suffix}"
    if not WORKER_NAME_RE.fullmatch(worker_name):
        raise SystemExit("derived admission Worker name is invalid")
    bundle = output_dir / "admission"
    bundle.mkdir(parents=True)
    copied: list[Path] = []
    copy_file(RAMP / "package.json", bundle / "package.json", copied)
    copy_file(HERE / "src" / "admission.ts", bundle / "src" / "admission.ts", copied)
    release = release_sha256(copied, bundle)
    config = {
        "$schema": "node_modules/wrangler/config-schema.json",
        "account_id": ACCOUNT_ID,
        "name": worker_name,
        "main": "src/admission.ts",
        "compatibility_date": "2026-09-02",
        "compatibility_flags": ["nodejs_compat"],
        "workers_dev": True,
        "observability": {"enabled": True, "logs": {"invocation_logs": True, "head_sampling_rate": 1}},
        "durable_objects": {"bindings": [{"name": "REGIONAL_ADMISSION", "class_name": "GrowthSentStandard1RegionalStartAdmission"}]},
        "migrations": [{"tag": "v1", "new_sqlite_classes": ["GrowthSentStandard1RegionalStartAdmission"]}],
        "vars": {
            "GROWTHSENT_ADMISSION_INTERVAL_SECONDS": str(ADMISSION_INTERVAL_SECONDS),
            "GROWTHSENT_ADMISSION_MAX_BACKOFF_SECONDS": str(ADMISSION_MAX_BACKOFF_SECONDS),
            "GROWTHSENT_RELEASE_SHA256": release,
        },
    }
    (bundle / "wrangler.jsonc").write_bytes(canonical_json(config))
    release_document = {
        "format_version": 1,
        "kind": ADMISSION_RELEASE_KIND,
        "run_id": run_id,
        "worker_name": worker_name,
        "admission_interval_seconds": ADMISSION_INTERVAL_SECONDS,
        "admission_max_backoff_seconds": ADMISSION_MAX_BACKOFF_SECONDS,
        "release_sha256": release,
        "files": [{"path": path.relative_to(bundle).as_posix(), "sha256": sha256_file(path)} for path in sorted(copied, key=lambda item: item.relative_to(bundle).as_posix())],
    }
    (bundle / "ADMISSION-RELEASE.json").write_bytes(canonical_json(release_document))
    return {"bundle": str(bundle), "worker_name": worker_name, "release_sha256": release}


def build_lane_bundle(*, run_id: str, admission_worker_name: str, lane: str, placement_group: str, initial_start_delay_seconds: int, lane_index: int, lane_count: int, source_document: Mapping[str, Any], source_file_sha256: str, source_index_start: int, processing_task_count: int, output_dir: Path) -> dict[str, Any]:
    suffix = run_id.rsplit("-", 1)[-1]
    worker_name = f"growthsent-h100k-{suffix}-{lane.lower()}"
    if not WORKER_NAME_RE.fullmatch(worker_name):
        raise SystemExit("derived 100K lane Worker name is invalid")
    bundle = output_dir / "lanes" / lane.lower()
    bundle.mkdir(parents=True)
    copied: list[Path] = []
    for name in LOCAL_STATIC:
        copy_file(RAMP / name, bundle / name, copied)
    copy_file(RAMP / "src" / "index.ts", bundle / "src" / "index.ts", copied)
    sparse_inputs = sparse_lane_manifest(
        source_document=source_document,
        source_file_sha256=source_file_sha256,
        source_index_start=source_index_start,
        processing_task_count=processing_task_count,
        lane_index=lane_index,
        lane_count=lane_count,
    )
    selected_path = bundle / "selected-inputs.json"
    selected_path.write_bytes(canonical_json(sparse_inputs))
    copied.append(selected_path)
    tools_destination = bundle / "tools"
    tools_destination.mkdir()
    for name in TOOL_NAMES:
        copy_file(TOOLS / name, tools_destination / name, copied)
    release = release_sha256(copied, bundle)
    lane_inputs_sha256 = sha256_file(selected_path)
    regional_task_count = lane_task_count(processing_task_count, lane_index, lane_count)
    config = {
        "$schema": "node_modules/wrangler/config-schema.json",
        "account_id": ACCOUNT_ID,
        "name": worker_name,
        "main": "src/index.ts",
        "compatibility_date": "2026-09-02",
        "compatibility_flags": ["nodejs_compat"],
        "workers_dev": True,
        "observability": {"enabled": True, "logs": {"invocation_logs": True, "head_sampling_rate": 1}},
        "containers": [{
            "class_name": "GrowthSentStandard1RegionalRampContainer",
            "name": worker_name,
            "image": "./Dockerfile",
            "instance_type": "standard-1",
            "max_instances": SLOTS_PER_LANE + LANE_HEADROOM,
            "constraints": {"regions": [placement_group]},
        }],
        "durable_objects": {"bindings": [
            {"name": "RAMP_CONTAINER", "class_name": "GrowthSentStandard1RegionalRampContainer"},
            {"name": "RAMP_COORDINATOR", "class_name": "GrowthSentStandard1RegionalRampCoordinator"},
            {"name": "REGIONAL_ADMISSION", "class_name": "GrowthSentStandard1RegionalStartAdmission", "script_name": admission_worker_name},
        ]},
        "migrations": [{"tag": "v1", "new_sqlite_classes": ["GrowthSentStandard1RegionalRampContainer", "GrowthSentStandard1RegionalRampCoordinator"]}],
        "vars": {
            "GROWTHSENT_R2_ACCOUNT_ID": ACCOUNT_ID,
            "GROWTHSENT_R2_BUCKET": BUCKET,
            "GROWTHSENT_RAMP_ID": run_id,
            "GROWTHSENT_REGION": lane,
            "GROWTHSENT_PLACEMENT_GROUP": placement_group,
            "GROWTHSENT_REGION_INDEX": str(lane_index),
            "GROWTHSENT_REGION_COUNT": str(lane_count),
            "GROWTHSENT_SOURCE_INDEX_START": str(source_index_start),
            "GROWTHSENT_TASK_COUNT": str(processing_task_count),
            "GROWTHSENT_REGIONAL_TASK_COUNT": str(regional_task_count),
            "GROWTHSENT_MAX_CONCURRENT": str(SLOTS_PER_LANE),
            "GROWTHSENT_START_SPACING_SECONDS": str(START_SPACING_SECONDS),
            "GROWTHSENT_INITIAL_START_DELAY_SECONDS": str(initial_start_delay_seconds),
            "GROWTHSENT_RELEASE_SHA256": release,
            "GROWTHSENT_SELECTED_INPUTS_SHA256": lane_inputs_sha256,
            "GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS": str(START_GUARD_SECONDS),
            "GROWTHSENT_CONTAINER_INSTANCE_TYPE": "standard-1",
            "GROWTHSENT_HARD_TIMEOUT_SECONDS": "6600",
        },
    }
    (bundle / "wrangler.jsonc").write_bytes(canonical_json(config))
    release_document = {
        "format_version": 1,
        "kind": LANE_RELEASE_KIND,
        "execution_profile": EXECUTION_PROFILE,
        "run_id": run_id,
        "lane": lane,
        "placement_group": placement_group,
        "lane_index": lane_index,
        "lane_count": lane_count,
        "worker_name": worker_name,
        "admission_worker_name": admission_worker_name,
        "source_manifest_claim_sha256": source_document["manifest_sha256"],
        "source_manifest_file_sha256": source_file_sha256,
        "source_indexes_sha256": hashlib.sha256(canonical_json(sparse_inputs["source_indexes"])).hexdigest(),
        "selected_inputs_sha256": lane_inputs_sha256,
        "source_index_start": source_index_start,
        "task_count": processing_task_count,
        "regional_task_count": regional_task_count,
        "max_concurrent": SLOTS_PER_LANE,
        "max_instances": SLOTS_PER_LANE + LANE_HEADROOM,
        "start_spacing_seconds": START_SPACING_SECONDS,
        "initial_start_delay_seconds": initial_start_delay_seconds,
        "release_sha256": release,
        "files": [{"path": path.relative_to(bundle).as_posix(), "sha256": sha256_file(path)} for path in sorted(copied, key=lambda item: item.relative_to(bundle).as_posix())],
    }
    (bundle / "LANE-RELEASE.json").write_bytes(canonical_json(release_document))
    return {
        "lane": lane,
        "placement_group": placement_group,
        "lane_index": lane_index,
        "lane_count": lane_count,
        "source_index_start": source_index_start,
        "worker_name": worker_name,
        "bundle": str(bundle),
        "regional_task_count": regional_task_count,
        "selected_inputs_sha256": lane_inputs_sha256,
        "max_concurrent": SLOTS_PER_LANE,
        "max_instances": SLOTS_PER_LANE + LANE_HEADROOM,
        "initial_start_delay_seconds": initial_start_delay_seconds,
        "release_sha256": release,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--reuse-proof", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(argv)


def build(*, run_id: str, source_manifest: Path, reuse_proof: Path, output_dir: Path) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise SystemExit("--run-id must be a lowercase slug of at most 64 characters")
    source_document = manifest.load_base_manifest(source_manifest, expected_input_count=SOURCE_TASK_COUNT)
    if source_document["crawl"] != CRAWL or len(source_document["inputs"]) != SOURCE_TASK_COUNT:
        raise SystemExit("source manifest is not the locked CC-MAIN-2026-30 100,000-WAT declaration")
    source_file_sha256 = sha256_file(source_manifest)
    reuse = load_reuse_proof(reuse_proof, source_document=source_document, source_file_sha256=source_file_sha256)
    require_empty_output_dir(output_dir)
    lanes = reviewed_lanes()
    admission = build_admission_bundle(run_id=run_id, output_dir=output_dir)
    lane_documents = [
        build_lane_bundle(
            run_id=run_id,
            admission_worker_name=admission["worker_name"],
            lane=lane,
            placement_group=placement_group,
            initial_start_delay_seconds=initial_start_delay_seconds,
            lane_index=lane_index,
            lane_count=len(lanes),
            source_document=source_document,
            source_file_sha256=source_file_sha256,
            source_index_start=REUSED_SOURCE_PREFIX_COUNT,
            processing_task_count=PROCESSING_TASK_COUNT,
            output_dir=output_dir,
        )
        for lane_index, (lane, placement_group, initial_start_delay_seconds) in enumerate(lanes)
    ]
    assigned_count = sum(item["regional_task_count"] for item in lane_documents)
    if assigned_count != PROCESSING_TASK_COUNT or sum(item["max_concurrent"] for item in lane_documents) != len(lanes) * SLOTS_PER_LANE:
        raise SystemExit("remaining 89,000-WAT self-recovery lane partition is incomplete")
    policy = {
        "format_version": 1,
        "kind": POLICY_KIND,
        "execution_profile": EXECUTION_PROFILE,
        "automatic_in_run": {
            "fixed_slot_restarts": "Coordinator alarms retry a stopped, errored, or uncertain fixed slot against the same task identity.",
            "safe_input_only_resume": "A prefix containing only TASK-INPUT-MANIFEST.json is reused after identity verification.",
            "regional_start_admission": "All sibling lane cold starts request a persisted permit from one placement-group Durable Object.",
            "capacity_backoff": "Observed NO_CONTAINER_AVAILABLE/max_instances failures exponentially pause further starts only for that placement group.",
            "completion_proof": "TASK-COMPLETED.json is immutable and written last; an observed marker makes a retried task a no-op.",
        },
        "authorized_fresh_recovery_required": {
            "trigger": "Any payload after TASK-INPUT-MANIFEST.json but before TASK-COMPLETED.json.",
            "reason": "Immutable partial evidence must never be overwritten or mixed with a retry.",
            "procedure": "After affected source lanes are terminal, inventory their completion markers and create a fresh prefix-scoped child credential plus a disjoint recovery plan.",
            "remote_automation": "intentionally disabled: a Worker/Container never receives the parent credential needed to mint a new recovery scope or deploy replacement Workers.",
        },
    }
    (output_dir / "SELF-RECOVERY-POLICY.json").write_bytes(canonical_json(policy))
    group_lane_counts = {group: sum(1 for item in lane_documents if item["placement_group"] == group) for group in ("APAC", "ENAM", "WNAM", "EEUR", "WEUR", "SAM")}
    plan: dict[str, Any] = {
        "format_version": 1,
        "kind": PLAN_KIND,
        "execution_profile": EXECUTION_PROFILE,
        "run_id": run_id,
        "source_manifest": {
            "path": str(source_manifest),
            "file_sha256": source_file_sha256,
            "claim_sha256": source_document["manifest_sha256"],
            "inputs_sha256": source_document["inputs_sha256"],
            "input_count": SOURCE_TASK_COUNT,
            "crawl": CRAWL,
        },
        "verified_reuse_proof": {
            "path": str(reuse_proof),
            "file_sha256": sha256_file(reuse_proof),
            "proof_sha256": reuse["proof_sha256"],
            "completed_source_count": REUSED_SOURCE_PREFIX_COUNT,
        },
        "processing_window": {
            "source_index_start": REUSED_SOURCE_PREFIX_COUNT,
            "source_index_end_exclusive": SOURCE_TASK_COUNT,
            "task_count": PROCESSING_TASK_COUNT,
            "source_identity_rule": "Every scheduled task uses its immutable global source index; indexes 0 through 10,999 are excluded.",
        },
        "r2_root": f"production/common-crawl/cloudflare-r2-final-campaigns/v1/{run_id}/",
        "credential_policy": {"id": "regional-six-day-v1", "child_ttl_seconds": CHILD_TTL_SECONDS, "start_guard_seconds": START_GUARD_SECONDS},
        "topology": {
            "lane_count": len(lanes),
            "placement_group_lane_counts": group_lane_counts,
            "slots_per_lane": SLOTS_PER_LANE,
            "max_concurrent_total": len(lanes) * SLOTS_PER_LANE,
            "max_instances_per_lane": SLOTS_PER_LANE + LANE_HEADROOM,
            "start_spacing_seconds_per_lane": START_SPACING_SECONDS,
            "admission_interval_seconds_per_placement_group": ADMISSION_INTERVAL_SECONDS,
            "admission_max_backoff_seconds": ADMISSION_MAX_BACKOFF_SECONDS,
        },
        "twenty_four_hour_envelope": {
            "target_wall_seconds": 86_400,
            "max_lane_task_count": max(item["regional_task_count"] for item in lane_documents),
            "waves_per_lane": 62,
            "p95_wat_budget_seconds": 1_200,
            "cold_start_admission_budget_seconds": 1_600,
            "isolated_recovery_headroom_seconds": 7_200,
            "planned_wall_seconds": 83_200,
            "condition": "Planning envelope only: assumes observed P95 WAT duration at or below 20 minutes. Staged admission, capacity backoff, and isolated recovery protect transient regional allocation loss but do not guarantee completion.",
        },
        "admission_worker": admission,
        "lanes": lane_documents,
        "self_recovery_policy": "SELF-RECOVERY-POLICY.json",
        "remote_start": "disabled; a separately reviewed launcher and explicit approval are required",
        "published_limit_basis": "The 45 fixed lanes each reserve exactly their 32 assigned standard-1 slots: 1,440 instances, 720 vCPU, 5.625 TiB memory, and 11.25 TiB (11.52 TB) disk. This stays within Cloudflare's published account limits and retains 384 GiB of memory headroom; admission pacing and recovery remain required because published limits do not eliminate transient regional allocation failures.",
    }
    plan["plan_sha256"] = plan_sha256(plan)
    plan_path = output_dir / "SELF-RECOVERY-RUN-PLAN.json"
    plan_path.write_bytes(canonical_json(plan))
    serialized = json.loads(plan_path.read_text(encoding="utf-8"))
    if serialized.get("plan_sha256") != plan_sha256(serialized):
        raise SystemExit("serialized remaining-89,000-WAT self-recovery plan digest is invalid")
    if len(serialized["lanes"]) != 45 or serialized["topology"]["max_concurrent_total"] != 1440:
        raise SystemExit("serialized remaining-89,000-WAT self-recovery topology is invalid")
    if serialized["processing_window"]["task_count"] != PROCESSING_TASK_COUNT or serialized["processing_window"]["source_index_start"] != REUSED_SOURCE_PREFIX_COUNT:
        raise SystemExit("serialized remaining-89,000-WAT source window is invalid")
    return serialized


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    plan = build(run_id=args.run_id, source_manifest=args.source_manifest, reuse_proof=args.reuse_proof, output_dir=args.output_dir)
    print(json.dumps({
        "status": "remaining_eighty_nine_thousand_self_recovery_plan_prepared",
        "plan": str(args.output_dir / "SELF-RECOVERY-RUN-PLAN.json"),
        "plan_sha256": plan["plan_sha256"],
        "task_count": PROCESSING_TASK_COUNT,
        "lane_count": len(plan["lanes"]),
        "max_concurrent_total": plan["topology"]["max_concurrent_total"],
        "remote_start": plan["remote_start"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
