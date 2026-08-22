#!/usr/bin/env python3
"""Immutable identity and path contract for the GCP/R2 25K successor run."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Any, Mapping

import common_crawl_v2_manifest as manifests


RUN_ID = "cc-main-2026-30-offset-10000-count-25000"
CRAWL = "CC-MAIN-2026-30"
INPUT_COUNT = 25_000
SHARD_COUNT = 25
INPUTS_PER_SHARD = 1_000
INPUTS_SHA256 = "3625696e98191d77432c62068cfc0bc9eb0fcbc95e80c4d0ba8a62dbe0dd33cb"
BASE_MANIFEST_SHA256 = "33420340c9792d90e03c394cfba8590825777010d3aee2ee659e5010b5fc8d1f"
SHARD_PLAN_SHA256 = "53c452b1015ea69fd419dc5c13ec4534181fba03319243575ff16d89a6ae49d1"
SOURCE_START_INDEX = 10_000
SOURCE_END_INDEX_EXCLUSIVE = 35_000
RAW_PREFIX = "production/common-crawl/wat-pages-links/v2/cc-main-2026-30-offset-10000-count-25000"
DERIVED_PREFIX = "production/common-crawl/backlink-derived/v1/cc-main-2026-30-offset-10000-count-25000"


class GcpR2ContractError(ValueError):
    """A worker does not match the reviewed GCP/R2 25K contract."""


def shard_label(shard_id: int) -> str:
    if isinstance(shard_id, bool) or not isinstance(shard_id, int) or not 0 <= shard_id < SHARD_COUNT:
        raise GcpR2ContractError("shard ID must be in the locked range 0..24")
    return f"shard-{shard_id:03d}-of-{SHARD_COUNT:03d}"


def part_suffix(source_key: str) -> str:
    if (
        not isinstance(source_key, str)
        or not source_key.startswith(f"crawl-data/{CRAWL}/")
        or not source_key.endswith(".wat.gz")
        or source_key != source_key.strip()
        or "\\" in source_key
        or "/../" in f"/{source_key}"
        or "\r" in source_key
        or "\n" in source_key
    ):
        raise GcpR2ContractError("source key is outside the locked Common Crawl WAT namespace")
    return hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:16]


def normalized_key(*parts: str) -> str:
    values = []
    for raw in parts:
        if not isinstance(raw, str) or not raw.strip():
            raise GcpR2ContractError("object key component must be non-empty")
        value = raw.strip("/")
        if not value or "\\" in value or "\r" in value or "\n" in value or ".." in value.split("/"):
            raise GcpR2ContractError("unsafe object key component")
        values.append(value)
    return "/".join(values)


def raw_part_key(dataset: str, source_key: str) -> str:
    if dataset not in {"pages", "links", "metrics"}:
        raise GcpR2ContractError("raw dataset must be pages, links, or metrics")
    suffix = part_suffix(source_key)
    extension = "json" if dataset == "metrics" else "parquet"
    return normalized_key(RAW_PREFIX, f"crawl={CRAWL}", f"dataset={dataset}", f"part-{suffix}.{extension}")


def raw_control_key(shard_id: int, filename: str) -> str:
    if not filename or "/" in filename or "\\" in filename:
        raise GcpR2ContractError("raw control filename must be one safe file name")
    return normalized_key(RAW_PREFIX, "control", "shards", shard_label(shard_id), filename)


def derived_control_key(shard_id: int, filename: str) -> str:
    if not filename or "/" in filename or "\\" in filename:
        raise GcpR2ContractError("derived control filename must be one safe file name")
    return normalized_key(DERIVED_PREFIX, "control", "shards", shard_label(shard_id), filename)


@dataclass(frozen=True)
class ShardContract:
    shard_id: int
    base: dict[str, Any]
    shard: dict[str, Any]
    plan: dict[str, Any]

    @property
    def label(self) -> str:
        return shard_label(self.shard_id)

    @property
    def inputs(self) -> tuple[str, ...]:
        return tuple(self.shard["inputs"])

    def static_metadata(self) -> dict[str, Any]:
        return {
            "format_version": 1,
            "run_id": RUN_ID,
            "crawl": CRAWL,
            "shard": {"id": self.shard_id, "count": SHARD_COUNT, "label": self.label},
            "base_inputs_sha256": INPUTS_SHA256,
            "base_manifest_sha256": BASE_MANIFEST_SHA256,
            "shard_inputs_sha256": self.shard["inputs_sha256"],
            "shard_manifest_sha256": self.shard["manifest_sha256"],
            "shard_input_count": INPUTS_PER_SHARD,
            "first_input": self.shard["first_input"],
            "last_input": self.shard["last_input"],
        }


def load_contract(base_path: Path, shard_path: Path, plan_path: Path, *, shard_id: int) -> ShardContract:
    shard_label(shard_id)
    base = manifests.load_base_manifest(base_path, expected_input_count=INPUT_COUNT)
    if (
        base.get("run_id") != RUN_ID
        or base.get("crawl") != CRAWL
        or base.get("inputs_sha256") != INPUTS_SHA256
        or base.get("manifest_sha256") != BASE_MANIFEST_SHA256
    ):
        raise GcpR2ContractError("base manifest does not match the approved GCP/R2 25K contract")
    provenance = base.get("source_provenance")
    if not isinstance(provenance, Mapping) or provenance.get("source_start_index") != SOURCE_START_INDEX or provenance.get("source_end_index_exclusive") != SOURCE_END_INDEX_EXCLUSIVE or provenance.get("overlap_with_golden_input_count") != 0:
        raise GcpR2ContractError("base manifest lacks the required non-overlap source-slice proof")
    shard = manifests.load_shard_manifest(
        shard_path,
        base,
        expected_input_count=INPUT_COUNT,
        max_inputs_per_shard=INPUTS_PER_SHARD,
    )
    if shard.get("shard_id") != shard_id or shard.get("shard_count") != SHARD_COUNT or shard.get("input_count") != INPUTS_PER_SHARD:
        raise GcpR2ContractError("shard manifest does not own exactly the requested canonical 1,000-input shard")
    plan = manifests.load_shard_plan(
        plan_path,
        base,
        expected_input_count=INPUT_COUNT,
        max_inputs_per_shard=INPUTS_PER_SHARD,
    )
    if plan.get("shard_count") != SHARD_COUNT or plan.get("plan_sha256") != SHARD_PLAN_SHA256:
        raise GcpR2ContractError("shard plan does not match the approved GCP/R2 25K contract")
    entry = next((value for value in plan["shards"] if value.get("shard_id") == shard_id), None)
    expected_plan_entry = {
        "inputs_sha256": shard["inputs_sha256"],
        "shard_manifest_sha256": shard["manifest_sha256"],
        "input_count": shard["input_count"],
        "first_input": shard["first_input"],
        "last_input": shard["last_input"],
    }
    if not isinstance(entry, Mapping) or any(entry.get(key) != value for key, value in expected_plan_entry.items()):
        raise GcpR2ContractError("shard-plan entry does not match the immutable shard manifest")
    return ShardContract(shard_id=shard_id, base=base, shard=shard, plan=plan)


def validate_job_identity(values: Mapping[str, Any], contract: ShardContract, *, release_sha256: str) -> None:
    """Reject mutable platform/job values that disagree with the manifest lock."""

    expected = {
        "run_id": RUN_ID,
        "crawl": CRAWL,
        "shard_id": contract.shard_id,
        "shard_count": SHARD_COUNT,
        "base_inputs_sha256": INPUTS_SHA256,
        "base_manifest_sha256": BASE_MANIFEST_SHA256,
        "shard_inputs_sha256": contract.shard["inputs_sha256"],
        "shard_manifest_sha256": contract.shard["manifest_sha256"],
        "release_sha256": release_sha256,
        "expected_input_count": INPUTS_PER_SHARD,
        "raw_prefix": RAW_PREFIX,
        "derived_prefix": DERIVED_PREFIX,
    }
    for name, expected_value in expected.items():
        if values.get(name) != expected_value:
            raise GcpR2ContractError(f"job identity mismatch: {name}")
