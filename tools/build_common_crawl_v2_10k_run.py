#!/usr/bin/env python3
"""Create the immutable 10,000-input Common Crawl production-v2 run lock.

This is a local-only manifest constructor.  It never lists Common Crawl,
downloads a WAT, touches S3, or starts an ingestion.  The only admissible
source is a separately reviewed ordered 100,000-input v2 base manifest; the
new run is exactly its first 10,000 inputs and is split into ten fixed shards
of 1,000 inputs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import common_crawl_v2_manifest as manifests


SOURCE_INPUT_COUNT = 100_000
TARGET_INPUT_COUNT = 10_000
TARGET_SHARD_COUNT = 10
MAX_INPUTS_PER_SHARD = 1_000
RUN_ID = "cc-main-2026-30-first-10000"
CRAWL = "CC-MAIN-2026-30"


def _load_reviewed_source(path: Path) -> dict[str, Any]:
    return manifests.load_base_manifest(path, expected_input_count=SOURCE_INPUT_COUNT)


def build_run(source_base_manifest: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Derive the one permitted 10K run from a validated ordered 100K source."""

    source = _load_reviewed_source(source_base_manifest)
    if source["crawl"] != CRAWL:
        raise manifests.ManifestValidationError(
            f"source base manifest crawl must be {CRAWL}, got {source['crawl']}"
        )
    inputs = source["inputs"][:TARGET_INPUT_COUNT]
    base = manifests.build_base_manifest(
        run_id=RUN_ID,
        crawl=CRAWL,
        inputs=inputs,
        expected_input_count=TARGET_INPUT_COUNT,
    )
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
    return base, shards, plan


def write_run(output_directory: Path, source_base_manifest: Path) -> dict[str, Any]:
    """Write a fail-closed, reproducible run lock and all ten shard artifacts."""

    base, shards, plan = build_run(source_base_manifest)
    output_directory.mkdir(parents=True, exist_ok=True)
    base_path = output_directory / "base-manifest.json"
    shard_directory = output_directory / "shards"
    manifests.write_immutable_json(base_path, base)
    manifests.write_shard_artifacts(shard_directory, shards, plan=plan)
    # Read back from disk so a local caller cannot mistake an in-memory object
    # for a persisted immutable production artifact.
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
        "crawl": locked_base["crawl"],
        "run_id": locked_base["run_id"],
        "input_count": locked_base["input_count"],
        "inputs_sha256": locked_base["inputs_sha256"],
        "base_manifest_sha256": locked_base["manifest_sha256"],
        "shard_count": locked_plan["shard_count"],
        "shard_plan_sha256": locked_plan["plan_sha256"],
        "first_input": locked_base["inputs"][0],
        "last_input": locked_base["inputs"][-1],
        "source_base_manifest_sha256": source_base_manifest_sha256(source_base_manifest),
    }


def source_base_manifest_sha256(path: Path) -> str:
    """Return the reviewed source document identity, not its raw file checksum."""

    return _load_reviewed_source(path)["manifest_sha256"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-base-manifest", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(write_run(args.output_dir, args.source_base_manifest), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
