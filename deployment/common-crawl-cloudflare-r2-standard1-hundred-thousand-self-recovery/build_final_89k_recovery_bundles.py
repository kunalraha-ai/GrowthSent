#!/usr/bin/env python3
"""Build a fresh, source-identity-only recovery run for the final 89K WAT campaign.

This builder is local-only.  It accepts a read-only immutable completion-marker
contract and emits fresh Worker/Container bundles for only the missing source
keys.  Recovery tasks deliberately use local task indexes: their immutable
source identity remains the Common Crawl source key carried by every output
marker, while the new R2 root prevents any overwrite of the original run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

import build_self_recovery_bundles as base


RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-final-89k-recovery-plan-v1"
RECOVERY_PROFILE = "regional-1440-final-eighty-nine-thousand-recovery"
RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-final-89k-recovery-contract-v1"
RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


def sha256_file(path: Path) -> str:
    return base.sha256_file(path)


def recovery_contract(path: Path, *, source_document: Mapping[str, Any], source_file_sha256: str) -> dict[str, Any]:
    base.require_file(path, "final 89K recovery contract")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("final 89K recovery contract is not valid UTF-8 JSON") from error
    if not isinstance(document, dict) or document.get("kind") != RECOVERY_CONTRACT_KIND or document.get("crawl") != base.CRAWL:
        raise SystemExit("final 89K recovery contract has an unexpected identity")
    claimed = document.get("contract_sha256")
    payload = dict(document)
    payload.pop("contract_sha256", None)
    if not isinstance(claimed, str) or not re.fullmatch(r"[0-9a-f]{64}", claimed) or claimed != hashlib.sha256(base.canonical_json(payload).rstrip(b"\n")).hexdigest():
        raise SystemExit("final 89K recovery contract digest is invalid")
    if document.get("source_task_count") != base.PROCESSING_TASK_COUNT or document.get("source_processing_window") != {"source_index_start": base.REUSED_SOURCE_PREFIX_COUNT, "source_index_end_exclusive": base.SOURCE_TASK_COUNT}:
        raise SystemExit("final 89K recovery contract does not bind the original 89K source window")
    if document.get("source_manifest_file_sha256") != source_file_sha256 or document.get("source_manifest_claim_sha256") != source_document.get("manifest_sha256") or document.get("source_manifest_inputs_sha256") != source_document.get("inputs_sha256"):
        raise SystemExit("final 89K recovery contract is not bound to the locked 100K manifest")
    reuse = document.get("verified_reuse_proof")
    if not isinstance(reuse, dict) or reuse.get("completed_source_count") != base.REUSED_SOURCE_PREFIX_COUNT or not isinstance(reuse.get("proof_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", reuse["proof_sha256"]):
        raise SystemExit("final 89K recovery contract lacks the verified 11K reuse boundary")
    indexes = document.get("recovery_source_indexes")
    if not isinstance(indexes, list) or not indexes or any(not isinstance(index, int) or isinstance(index, bool) for index in indexes) or indexes != sorted(set(indexes)) or any(index < base.REUSED_SOURCE_PREFIX_COUNT or index >= base.SOURCE_TASK_COUNT for index in indexes):
        raise SystemExit("final 89K recovery source indexes are invalid")
    if document.get("recovery_task_count") != len(indexes) or document.get("recovery_source_indexes_sha256") != hashlib.sha256(base.canonical_json(indexes)).hexdigest():
        raise SystemExit("final 89K recovery task inventory is invalid")
    return document


def recovery_input_manifest(*, source_document: Mapping[str, Any], source_file_sha256: str, indexes: Sequence[int]) -> dict[str, Any]:
    inputs = [base.selected_input(source_document["inputs"][index]) for index in indexes]
    if len(inputs) != len(indexes) or not inputs:
        raise SystemExit("final 89K recovery selection is empty or malformed")
    return {
        "format_version": 2,
        "kind": "growthsent-cloudflare-r2-standard1-regional-inputs-v1",
        "crawl": base.CRAWL,
        "source_manifest_kind": source_document["kind"],
        "source_manifest_claim_sha256": source_document["manifest_sha256"],
        "source_manifest_sha256": source_file_sha256,
        "source_shard_id": None,
        "input_count": len(inputs),
        "inputs": inputs,
        "selected_inputs_sha256": hashlib.sha256(base.canonical_json(inputs)).hexdigest(),
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--recovery-contract", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(argv)


def build(*, run_id: str, source_manifest: Path, recovery_contract_path: Path, output_dir: Path) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise SystemExit("--run-id must be a lowercase slug of at most 64 characters")
    source_document = base.manifest.load_base_manifest(source_manifest, expected_input_count=base.SOURCE_TASK_COUNT)
    source_file_sha256 = sha256_file(source_manifest)
    contract = recovery_contract(recovery_contract_path, source_document=source_document, source_file_sha256=source_file_sha256)
    indexes = contract["recovery_source_indexes"]
    selected = recovery_input_manifest(source_document=source_document, source_file_sha256=source_file_sha256, indexes=indexes)
    base.require_empty_output_dir(output_dir)
    lanes = base.reviewed_lanes()[:min(len(base.reviewed_lanes()), len(indexes))]
    admission = base.build_admission_bundle(run_id=run_id, output_dir=output_dir)
    lane_documents = [
        base.build_lane_bundle(
            run_id=run_id,
            admission_worker_name=admission["worker_name"],
            lane=lane,
            placement_group=placement_group,
            initial_start_delay_seconds=initial_start_delay_seconds,
            lane_index=lane_index,
            lane_count=len(lanes),
            source_document=source_document,
            source_file_sha256=source_file_sha256,
            source_index_start=0,
            processing_task_count=len(indexes),
            output_dir=output_dir,
            selected_inputs_document=selected,
            output_root=f"production/common-crawl/cloudflare-r2-final-recoveries/v1/{run_id}",
            execution_profile=RECOVERY_PROFILE,
        )
        for lane_index, (lane, placement_group, initial_start_delay_seconds) in enumerate(lanes)
    ]
    if sum(item["regional_task_count"] for item in lane_documents) != len(indexes) or sum(item["max_concurrent"] for item in lane_documents) > len(indexes):
        raise SystemExit("final 89K recovery lane partition is invalid")
    group_counts = {
        group: count
        for group in ("APAC", "ENAM", "WNAM", "EEUR", "WEUR", "SAM")
        if (count := sum(1 for item in lane_documents if item["placement_group"] == group)) > 0
    }
    plan: dict[str, Any] = {
        "format_version": 1,
        "kind": RECOVERY_PLAN_KIND,
        "execution_profile": RECOVERY_PROFILE,
        "run_id": run_id,
        "source_manifest": {"path": str(source_manifest), "file_sha256": source_file_sha256, "claim_sha256": source_document["manifest_sha256"], "inputs_sha256": source_document["inputs_sha256"], "input_count": base.SOURCE_TASK_COUNT, "crawl": base.CRAWL},
        "verified_reuse_proof": contract["verified_reuse_proof"],
        "recovery": {"contract_path": str(recovery_contract_path), "contract_sha256": contract["contract_sha256"], "source_run_id": contract["source_run_id"], "source_context_sha256": contract["source_context_sha256"], "source_plan_sha256": contract["source_plan_sha256"], "source_r2_root": contract["source_r2_root"], "recovery_source_indexes": indexes, "recovery_source_indexes_sha256": contract["recovery_source_indexes_sha256"]},
        "processing_window": {"source_index_start": 0, "source_index_end_exclusive": len(indexes), "task_count": len(indexes), "source_identity_rule": "Recovery-local task indexes map to the exact source identities selected by the immutable completion-marker contract."},
        "r2_root": f"production/common-crawl/cloudflare-r2-final-recoveries/v1/{run_id}/",
        "credential_policy": {"id": "regional-six-day-v1", "child_ttl_seconds": base.CHILD_TTL_SECONDS, "start_guard_seconds": base.START_GUARD_SECONDS},
        "topology": {"lane_count": len(lanes), "placement_group_lane_counts": group_counts, "slots_per_lane": base.SLOTS_PER_LANE, "max_concurrent_total": sum(item["max_concurrent"] for item in lane_documents), "max_instances_per_lane": base.SLOTS_PER_LANE + base.LANE_HEADROOM, "start_spacing_seconds_per_lane": base.START_SPACING_SECONDS, "admission_interval_seconds_per_placement_group": base.ADMISSION_INTERVAL_SECONDS, "admission_max_backoff_seconds": base.ADMISSION_MAX_BACKOFF_SECONDS},
        "admission_worker": admission,
        "lanes": lane_documents,
        "remote_start": "disabled; a separately reviewed recovery launcher and explicit approval are required",
        "recovery_policy": {"source_root_read_only": True, "fresh_prefix_only": True, "completion_identity": "TASK-COMPLETED source-key identity is authoritative; coordinator counts are not used to select recovery work."},
    }
    plan["plan_sha256"] = base.plan_sha256(plan)
    plan_path = output_dir / "FINAL-89K-RECOVERY-RUN-PLAN.json"
    plan_path.write_bytes(base.canonical_json(plan))
    if json.loads(plan_path.read_text(encoding="utf-8")).get("plan_sha256") != base.plan_sha256(json.loads(plan_path.read_text(encoding="utf-8"))):
        raise SystemExit("serialized final 89K recovery plan digest is invalid")
    return plan


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    plan = build(run_id=args.run_id, source_manifest=args.source_manifest, recovery_contract_path=args.recovery_contract, output_dir=args.output_dir)
    print(json.dumps({"status": "final_89k_recovery_plan_prepared", "plan": str(args.output_dir / "FINAL-89K-RECOVERY-RUN-PLAN.json"), "task_count": plan["processing_window"]["task_count"], "lane_count": len(plan["lanes"]), "max_concurrent_total": plan["topology"]["max_concurrent_total"], "remote_start": plan["remote_start"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
