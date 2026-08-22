#!/usr/bin/env python3
"""Build the immutable non-overlapping GCP/R2 Common Crawl 25K run lock.

This is local-only.  The only admissible source is the reviewed ordered 100K
manifest already retained in the repository.  It selects the exact source
slice [10,000, 35,000), never discovers Common Crawl paths, and never touches
cloud resources.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import common_crawl_v2_manifest as manifests


SOURCE_INPUT_COUNT = 100_000
SOURCE_MANIFEST_SHA256 = "2cc2f9e80ad8009670e26c74dfaa7081b2d3a155d4f7d0ab3a0d3ee76c367c60"
GOLDEN_INPUT_COUNT = 10_000
START_INDEX = GOLDEN_INPUT_COUNT
END_INDEX_EXCLUSIVE = 35_000
TARGET_INPUT_COUNT = END_INDEX_EXCLUSIVE - START_INDEX
TARGET_SHARD_COUNT = 25
MAX_INPUTS_PER_SHARD = 1_000
RUN_ID = "cc-main-2026-30-offset-10000-count-25000"
CRAWL = "CC-MAIN-2026-30"


def _source(path: Path) -> dict[str, Any]:
    source = manifests.load_base_manifest(path, expected_input_count=SOURCE_INPUT_COUNT)
    if source["run_id"] != "cc-main-2026-30-first-100000":
        raise manifests.ManifestValidationError("source manifest is not the reviewed ordered 100K provenance run")
    if source["crawl"] != CRAWL:
        raise manifests.ManifestValidationError(f"source manifest crawl must be {CRAWL}")
    if source["manifest_sha256"] != SOURCE_MANIFEST_SHA256:
        raise manifests.ManifestValidationError("source manifest SHA-256 is not the reviewed ordered 100K provenance lock")
    return source


def build_run(source_base_manifest: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    source = _source(source_base_manifest)
    golden = source["inputs"][:GOLDEN_INPUT_COUNT]
    selected = source["inputs"][START_INDEX:END_INDEX_EXCLUSIVE]
    if len(selected) != TARGET_INPUT_COUNT:
        raise manifests.ManifestValidationError("source slice does not contain exactly 25,000 inputs")
    overlap = set(golden).intersection(selected)
    if overlap:
        raise manifests.ManifestValidationError("new 25K source slice overlaps the immutable golden 10K")
    if selected != source["inputs"][START_INDEX:END_INDEX_EXCLUSIVE]:
        raise manifests.ManifestValidationError("source ordering changed while selecting the 25K slice")
    base = manifests.build_base_manifest(
        run_id=RUN_ID,
        crawl=CRAWL,
        inputs=selected,
        expected_input_count=TARGET_INPUT_COUNT,
    )
    base["source_provenance"] = {
        "source_run_id": source["run_id"],
        "source_manifest_sha256": source["manifest_sha256"],
        "source_inputs_sha256": source["inputs_sha256"],
        "source_start_index": START_INDEX,
        "source_end_index_exclusive": END_INDEX_EXCLUSIVE,
        "excluded_golden_start_index": 0,
        "excluded_golden_end_index_exclusive": GOLDEN_INPUT_COUNT,
        "overlap_with_golden_input_count": 0,
    }
    base["manifest_sha256"] = manifests.manifest_sha256(base)
    base = manifests.validate_base_manifest(base, expected_input_count=TARGET_INPUT_COUNT)
    shards = manifests.split_shards(
        base,
        TARGET_SHARD_COUNT,
        expected_input_count=TARGET_INPUT_COUNT,
        max_inputs_per_shard=MAX_INPUTS_PER_SHARD,
    )
    plan = manifests.build_shard_plan(
        base,
        shards,
        expected_input_count=TARGET_INPUT_COUNT,
        max_inputs_per_shard=MAX_INPUTS_PER_SHARD,
    )
    manifests.verify_shard_set(
        base,
        shards,
        expected_input_count=TARGET_INPUT_COUNT,
        max_inputs_per_shard=MAX_INPUTS_PER_SHARD,
    )
    if any(set(shard["inputs"]).intersection(golden) for shard in shards):
        raise manifests.ManifestValidationError("a generated shard overlaps the immutable golden 10K")
    return base, shards, plan


def write_run(output_directory: Path, source_base_manifest: Path) -> dict[str, Any]:
    base, shards, plan = build_run(source_base_manifest)
    output_directory.mkdir(parents=True, exist_ok=True)
    base_path = output_directory / "base-manifest.json"
    shard_directory = output_directory / "shards"
    manifests.write_immutable_json(base_path, base)
    manifests.write_shard_artifacts(shard_directory, shards, plan=plan)
    locked_base = manifests.load_base_manifest(base_path, expected_input_count=TARGET_INPUT_COUNT)
    locked_shards = [
        manifests.load_shard_manifest(
            shard_directory / f"{manifests.shard_artifact_stem(shard['shard_id'], shard['shard_count'])}.json",
            locked_base,
            expected_input_count=TARGET_INPUT_COUNT,
            max_inputs_per_shard=MAX_INPUTS_PER_SHARD,
        )
        for shard in shards
    ]
    locked_plan = manifests.load_shard_plan(
        shard_directory / "shard-plan.json",
        locked_base,
        locked_shards,
        expected_input_count=TARGET_INPUT_COUNT,
        max_inputs_per_shard=MAX_INPUTS_PER_SHARD,
    )
    return {
        "run_id": locked_base["run_id"],
        "crawl": locked_base["crawl"],
        "source_slice": [START_INDEX, END_INDEX_EXCLUSIVE],
        "input_count": locked_base["input_count"],
        "inputs_sha256": locked_base["inputs_sha256"],
        "base_manifest_sha256": locked_base["manifest_sha256"],
        "shard_count": locked_plan["shard_count"],
        "shard_plan_sha256": locked_plan["plan_sha256"],
        "first_input": locked_base["inputs"][0],
        "last_input": locked_base["inputs"][-1],
        "golden_overlap_count": 0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-base-manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(write_run(args.output_dir, args.source_base_manifest), indent=2, sort_keys=True))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
