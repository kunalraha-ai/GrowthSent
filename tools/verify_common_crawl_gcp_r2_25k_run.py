#!/usr/bin/env python3
"""Read-only verifier for the locked GCP/R2 25K manifests.

It performs no cloud calls.  Operators run this before every GCP Batch wave
and bundle build to prove the exact [10000,35000) source slice remains locked.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import common_crawl_gcp_r2_25k_contract as contract_tools
import common_crawl_v2_manifest as manifests


def verify(base_path: Path, shard_directory: Path) -> dict[str, object]:
    base = manifests.load_base_manifest(base_path, expected_input_count=contract_tools.INPUT_COUNT)
    plan_path = shard_directory / "shard-plan.json"
    plan = manifests.load_shard_plan(
        plan_path,
        base,
        expected_input_count=contract_tools.INPUT_COUNT,
        max_inputs_per_shard=contract_tools.INPUTS_PER_SHARD,
    )
    shards = []
    for shard_id in range(contract_tools.SHARD_COUNT):
        filename = manifests.shard_artifact_stem(shard_id, contract_tools.SHARD_COUNT) + ".json"
        # This verifier has already validated base and plan. Validate each
        # shard against that in-memory base rather than re-reading/re-hashing
        # the 25K base document 25 times. The validation invariants are the
        # same as `load_contract`; this only removes redundant work.
        shard = manifests._validate_shard_manifest_against_validated_base(  # noqa: SLF001 - shared verified-manifest primitive
            manifests._load_json(shard_directory / filename, "shard manifest"),  # noqa: SLF001
            base,
            max_inputs_per_shard=contract_tools.INPUTS_PER_SHARD,
        )
        if shard.get("shard_id") != shard_id or shard.get("shard_count") != contract_tools.SHARD_COUNT:
            raise contract_tools.GcpR2ContractError("shard identity does not match its locked 25K filename/contract")
        entry = plan["shards"][shard_id]
        expected = {
            "inputs_sha256": shard["inputs_sha256"],
            "shard_manifest_sha256": shard["manifest_sha256"],
            "input_count": shard["input_count"],
            "first_input": shard["first_input"],
            "last_input": shard["last_input"],
        }
        if any(entry.get(key) != value for key, value in expected.items()):
            raise contract_tools.GcpR2ContractError("shard-plan entry does not match its shard manifest")
        shards.append(shard)
    manifests.verify_shard_set(
        base,
        shards,
        expected_input_count=contract_tools.INPUT_COUNT,
        max_inputs_per_shard=contract_tools.INPUTS_PER_SHARD,
    )
    return {
        "run_id": base["run_id"],
        "crawl": base["crawl"],
        "input_count": base["input_count"],
        "source_slice": [contract_tools.SOURCE_START_INDEX, contract_tools.SOURCE_END_INDEX_EXCLUSIVE],
        "golden_overlap_count": base["source_provenance"]["overlap_with_golden_input_count"],
        "inputs_sha256": base["inputs_sha256"],
        "base_manifest_sha256": base["manifest_sha256"],
        "shard_count": len(shards),
        "shard_plan_sha256": plan["plan_sha256"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-manifest", type=Path, required=True)
    parser.add_argument("--shard-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(verify(args.base_manifest, args.shard_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
