#!/usr/bin/env python3
"""Build a capacity-neutral, one-lane recovery for a prepared final-89K run.

The tool is intentionally local-only.  It reuses an already deployed but
never-started APAC-01 recovery Worker application, retaining its existing
32-instance reservation rather than attempting to reserve more account memory.
All missing source identities remain bound to the immutable recovery contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import build_final_89k_recovery_bundles as recovery
import build_self_recovery_bundles as base


CONSOLIDATED_PLAN_KIND = recovery.RECOVERY_PLAN_KIND
CONSOLIDATED_PROFILE = recovery.RECOVERY_PROFILE
REUSED_LANE = "APAC-01"
REUSED_PLACEMENT_GROUP = "APAC"


def require_source_plan(path: Path) -> dict[str, Any]:
    base.require_file(path, "prepared final 89K recovery plan")
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("prepared final 89K recovery plan is not valid UTF-8 JSON") from error
    payload = dict(plan)
    claimed = payload.pop("plan_sha256", None)
    if (
        not isinstance(plan, dict)
        or plan.get("kind") != recovery.RECOVERY_PLAN_KIND
        or plan.get("execution_profile") != recovery.RECOVERY_PROFILE
        or not isinstance(claimed, str)
        or claimed != base.plan_sha256(plan)
        or not base.RUN_ID_RE.fullmatch(plan.get("run_id", ""))
    ):
        raise SystemExit("prepared final 89K recovery plan identity or digest is invalid")
    if plan.get("r2_root") != f"production/common-crawl/cloudflare-r2-final-recoveries/v1/{plan['run_id']}/":
        raise SystemExit("prepared final 89K recovery plan has an invalid recovery root")
    lanes = plan.get("lanes")
    if not isinstance(lanes, list) or not lanes:
        raise SystemExit("prepared final 89K recovery plan has no reviewed lanes")
    first = lanes[0]
    expected_worker = f"growthsent-h100k-{plan['run_id'].rsplit('-', 1)[-1]}-{REUSED_LANE.lower()}"
    if (
        not isinstance(first, dict)
        or first.get("lane") != REUSED_LANE
        or first.get("placement_group") != REUSED_PLACEMENT_GROUP
        or first.get("lane_index") != 0
        or first.get("worker_name") != expected_worker
        or not isinstance(first.get("bundle"), str)
    ):
        raise SystemExit("prepared recovery plan does not bind the reviewed, never-started APAC-01 lane")
    try:
        config = json.loads((Path(first["bundle"]) / "wrangler.jsonc").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("prepared APAC-01 recovery bundle is unavailable") from error
    container = (config.get("containers") or [None])[0]
    if (
        config.get("name") != expected_worker
        or not isinstance(container, dict)
        or container.get("name") != expected_worker
        or container.get("max_instances") != base.SLOTS_PER_LANE
        or container.get("constraints", {}).get("regions") != [REUSED_PLACEMENT_GROUP]
    ):
        raise SystemExit("prepared APAC-01 does not retain the reviewed 32-slot container reservation")
    return plan


def build(*, source_plan_path: Path, output_dir: Path) -> dict[str, Any]:
    source_plan = require_source_plan(source_plan_path)
    source_manifest = Path(source_plan["source_manifest"]["path"])
    source_document = base.manifest.load_base_manifest(source_manifest, expected_input_count=base.SOURCE_TASK_COUNT)
    source_file_sha256 = base.sha256_file(source_manifest)
    contract_path = Path((source_plan.get("recovery") or {}).get("contract_path", ""))
    contract = recovery.recovery_contract(contract_path, source_document=source_document, source_file_sha256=source_file_sha256)
    if source_plan.get("recovery", {}).get("contract_sha256") != contract["contract_sha256"]:
        raise SystemExit("prepared recovery plan is not bound to its immutable recovery contract")
    indexes = contract["recovery_source_indexes"]
    if len(indexes) != contract["recovery_task_count"] or not indexes:
        raise SystemExit("immutable recovery contract has no valid missing source identities")

    base.require_empty_output_dir(output_dir)
    run_id = source_plan["run_id"]
    selected = recovery.recovery_input_manifest(source_document=source_document, source_file_sha256=source_file_sha256, indexes=indexes)
    admission = base.build_admission_bundle(run_id=run_id, output_dir=output_dir)
    lane = base.build_lane_bundle(
        run_id=run_id,
        admission_worker_name=admission["worker_name"],
        lane=REUSED_LANE,
        placement_group=REUSED_PLACEMENT_GROUP,
        initial_start_delay_seconds=0,
        lane_index=0,
        lane_count=1,
        source_document=source_document,
        source_file_sha256=source_file_sha256,
        source_index_start=0,
        processing_task_count=len(indexes),
        output_dir=output_dir,
        selected_inputs_document=selected,
        output_root=source_plan["r2_root"].rstrip("/"),
        execution_profile=CONSOLIDATED_PROFILE,
    )
    if lane["worker_name"] != source_plan["lanes"][0]["worker_name"] or lane["max_instances"] != base.SLOTS_PER_LANE or lane["max_concurrent"] != min(base.SLOTS_PER_LANE, len(indexes)):
        raise SystemExit("consolidated recovery would not reuse exactly the existing APAC-01 reservation")

    plan: dict[str, Any] = {
        "format_version": 1,
        "kind": CONSOLIDATED_PLAN_KIND,
        "execution_profile": CONSOLIDATED_PROFILE,
        "run_id": run_id,
        "source_manifest": {
            "path": str(source_manifest),
            "file_sha256": source_file_sha256,
            "claim_sha256": source_document["manifest_sha256"],
            "inputs_sha256": source_document["inputs_sha256"],
            "input_count": base.SOURCE_TASK_COUNT,
            "crawl": base.CRAWL,
        },
        "verified_reuse_proof": contract["verified_reuse_proof"],
        "recovery": {
            "contract_path": str(contract_path),
            "contract_sha256": contract["contract_sha256"],
            "source_run_id": contract["source_run_id"],
            "source_context_sha256": contract["source_context_sha256"],
            "source_plan_sha256": contract["source_plan_sha256"],
            "source_r2_root": contract["source_r2_root"],
            "recovery_source_indexes": indexes,
            "recovery_source_indexes_sha256": contract["recovery_source_indexes_sha256"],
            "consolidation_source_plan_path": str(source_plan_path),
            "consolidation_source_plan_sha256": source_plan["plan_sha256"],
            "reused_never_started_lane": REUSED_LANE,
        },
        "processing_window": {
            "source_index_start": 0,
            "source_index_end_exclusive": len(indexes),
            "task_count": len(indexes),
            "source_identity_rule": "One capacity-neutral recovery lane maps local task indexes to exactly the missing source identities in the immutable recovery contract.",
        },
        "r2_root": source_plan["r2_root"],
        "credential_policy": {"id": "regional-six-day-v1", "child_ttl_seconds": base.CHILD_TTL_SECONDS, "start_guard_seconds": base.START_GUARD_SECONDS},
        "topology": {
            "lane_count": 1,
            "placement_group_lane_counts": {REUSED_PLACEMENT_GROUP: 1},
            "slots_per_lane": base.SLOTS_PER_LANE,
            "max_concurrent_total": lane["max_concurrent"],
            "max_instances_per_lane": base.SLOTS_PER_LANE,
            "start_spacing_seconds_per_lane": base.START_SPACING_SECONDS,
            "admission_interval_seconds_per_placement_group": base.ADMISSION_INTERVAL_SECONDS,
            "admission_max_backoff_seconds": base.ADMISSION_MAX_BACKOFF_SECONDS,
        },
        "admission_worker": admission,
        "lanes": [lane],
        "remote_start": "disabled; a separately reviewed recovery launcher and explicit approval are required",
        "recovery_policy": {
            "source_root_read_only": True,
            "fresh_prefix_only": True,
            "capacity_neutral_worker_reuse": "Only APAC-01 is updated. Its existing 32-instance application reservation is retained; no additional container application is created.",
            "completion_identity": "TASK-COMPLETED source-key identity is authoritative; coordinator counts are not used to select recovery work.",
        },
    }
    plan["plan_sha256"] = base.plan_sha256(plan)
    plan_path = output_dir / "FINAL-89K-RECOVERY-RUN-PLAN.json"
    plan_path.write_bytes(base.canonical_json(plan))
    serialized = json.loads(plan_path.read_text(encoding="utf-8"))
    if serialized.get("plan_sha256") != base.plan_sha256(serialized):
        raise SystemExit("serialized consolidated final recovery plan digest is invalid")
    return serialized


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-plan", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    plan = build(source_plan_path=args.source_plan, output_dir=args.output_dir)
    print(json.dumps({
        "status": "final_89k_capacity_neutral_recovery_plan_prepared",
        "plan": str(args.output_dir / "FINAL-89K-RECOVERY-RUN-PLAN.json"),
        "run_id": plan["run_id"],
        "task_count": plan["processing_window"]["task_count"],
        "reused_lane": REUSED_LANE,
        "max_concurrent_total": plan["topology"]["max_concurrent_total"],
        "remote_start": plan["remote_start"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
