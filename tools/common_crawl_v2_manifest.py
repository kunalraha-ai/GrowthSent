#!/usr/bin/env python3
"""Create, split, and verify immutable Common Crawl production-v2 manifests.

Production-v2 deliberately accepts only an explicit, ordered list of at most
100,000 Common Crawl WAT paths.  A run profile supplies its exact reviewed
input count (for example 10,000); the tool never discovers paths from Common
Crawl and it never accepts a larger input list.  A base manifest is split into
deterministic contiguous shards so a fixed shard identity can safely be
resumed without repartitioning the run.

The module uses only the Python standard library so it can be bundled with the
existing ingestion worker.  Its public functions are also used by the v2
ingester and verifier.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


FORMAT_VERSION = 2
PRODUCTION_INPUT_COUNT = 100_000
MAX_SAFE_INPUTS = PRODUCTION_INPUT_COUNT
MAX_SAFE_INPUTS_PER_SHARD = 1_000
PART_HASH_LENGTH = 16
BASE_MANIFEST_KIND = "common-crawl-v2-base-manifest"
SHARD_MANIFEST_KIND = "common-crawl-v2-shard-manifest"
SHARD_PLAN_KIND = "common-crawl-v2-shard-plan"

_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")


class ManifestValidationError(ValueError):
    """Raised when a manifest is not a valid immutable production-v2 artifact."""


def inputs_sha256(paths: Sequence[str]) -> str:
    """Return the canonical ordered-input-list SHA-256 used by all v2 artifacts."""

    return hashlib.sha256("\n".join(paths).encode("utf-8")).hexdigest()


def input_key(path: str) -> str:
    """Return the stable 16-hex output suffix used by the proven ingester."""

    if not isinstance(path, str):
        raise ManifestValidationError("input path must be a string")
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:PART_HASH_LENGTH]


def manifest_sha256(document: Mapping[str, Any]) -> str:
    """Hash a manifest document without its self-referential hash field."""

    payload = dict(document)
    payload.pop("manifest_sha256", None)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def shard_plan_sha256(document: Mapping[str, Any]) -> str:
    """Hash a shard-plan document without its self-referential hash field."""

    payload = dict(document)
    payload.pop("plan_sha256", None)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestValidationError(f"{label} must be a JSON object")
    return value


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ManifestValidationError(f"{label} must be a non-empty string")
    return value


def _require_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManifestValidationError(f"{label} must be an integer >= {minimum}")
    return value


def _require_sha256(value: Any, label: str) -> str:
    value = _require_string(value, label)
    if not _SHA256_RE.fullmatch(value):
        raise ManifestValidationError(f"{label} must be a lowercase SHA-256 hex digest")
    return value


def _validate_run_id(run_id: Any) -> str:
    run_id = _require_string(run_id, "run_id")
    if not _RUN_ID_RE.fullmatch(run_id):
        raise ManifestValidationError(
            "run_id must use lowercase letters, digits, '.', '_', or '-' and start with alphanumeric"
        )
    return run_id


def _validate_crawl(crawl: Any) -> str:
    crawl = _require_string(crawl, "crawl")
    if any(character in crawl for character in "\r\n/\\"):
        raise ManifestValidationError("crawl must not contain a path separator or newline")
    return crawl


def _validate_input_paths(
    paths: Any,
    *,
    crawl: str,
    expected_count: int | None,
) -> list[str]:
    if not isinstance(paths, list):
        raise ManifestValidationError("inputs must be a JSON array")
    if not paths:
        raise ManifestValidationError("inputs must not be empty")
    if len(paths) > MAX_SAFE_INPUTS:
        raise ManifestValidationError(
            f"input count exceeds hard production-v2 ceiling of {MAX_SAFE_INPUTS:,}"
        )
    if expected_count is not None and len(paths) != expected_count:
        raise ManifestValidationError(
            f"input count must be exactly {expected_count:,}, got {len(paths):,}"
        )

    required_prefix = f"crawl-data/{crawl}/"
    seen_paths: set[str] = set()
    seen_keys: dict[str, str] = {}
    normalized: list[str] = []
    for index, path in enumerate(paths):
        path = _require_string(path, f"inputs[{index}]")
        if path != path.strip() or "\r" in path or "\n" in path:
            raise ManifestValidationError(f"inputs[{index}] contains unsafe surrounding whitespace or newline")
        if not path.startswith(required_prefix) or not path.endswith(".wat.gz"):
            raise ManifestValidationError(
                f"inputs[{index}] must be a {crawl} WAT path under {required_prefix}"
            )
        if path in seen_paths:
            raise ManifestValidationError(f"duplicate input path: {path}")
        seen_paths.add(path)
        part_key = input_key(path)
        prior = seen_keys.get(part_key)
        if prior is not None:
            raise ManifestValidationError(
                "16-hex deterministic output suffix collision between "
                f"{prior!r} and {path!r}: {part_key}"
            )
        seen_keys[part_key] = path
        normalized.append(path)
    return normalized


def _verify_document_sha(document: Mapping[str, Any], field: str) -> str:
    expected = _require_sha256(document.get(field), field)
    actual = manifest_sha256(document)
    if actual != expected:
        raise ManifestValidationError(f"{field} does not match canonical document SHA-256")
    return actual


def _required(document: Mapping[str, Any], required: set[str], label: str) -> None:
    missing = required.difference(document)
    if missing:
        raise ManifestValidationError(
            f"{label} is missing required fields: {', '.join(sorted(missing))}"
        )


def build_base_manifest(
    *,
    run_id: str,
    crawl: str,
    inputs: Sequence[str],
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
) -> dict[str, Any]:
    """Build an immutable explicit-input base manifest.

    ``expected_input_count`` exists for synthetic, non-production unit tests.
    The command-line interface always uses the hard production count.
    """

    run_id = _validate_run_id(run_id)
    crawl = _validate_crawl(crawl)
    copied_inputs = list(inputs)
    _validate_input_paths(copied_inputs, crawl=crawl, expected_count=expected_input_count)
    document: dict[str, Any] = {
        "format_version": FORMAT_VERSION,
        "kind": BASE_MANIFEST_KIND,
        "run_id": run_id,
        "crawl": crawl,
        "input_count": len(copied_inputs),
        "inputs_sha256": inputs_sha256(copied_inputs),
        "inputs": copied_inputs,
    }
    document["manifest_sha256"] = manifest_sha256(document)
    validate_base_manifest(document, expected_input_count=expected_input_count)
    return document


def validate_base_manifest(
    document: Mapping[str, Any],
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
) -> dict[str, Any]:
    """Validate a base manifest, its ordered source list, and all hash invariants."""

    document = _require_mapping(document, "base manifest")
    _required(
        document,
        {
            "format_version",
            "kind",
            "run_id",
            "crawl",
            "input_count",
            "inputs_sha256",
            "manifest_sha256",
            "inputs",
        },
        "base manifest",
    )
    if document["format_version"] != FORMAT_VERSION:
        raise ManifestValidationError("unsupported base manifest format_version")
    if document["kind"] != BASE_MANIFEST_KIND:
        raise ManifestValidationError("base manifest has the wrong kind")
    _validate_run_id(document["run_id"])
    crawl = _validate_crawl(document["crawl"])
    input_count = _require_int(document["input_count"], "input_count", minimum=1)
    if input_count != expected_input_count:
        raise ManifestValidationError(
            f"base manifest input_count must be exactly {expected_input_count:,}, got {input_count:,}"
        )
    paths = _validate_input_paths(document["inputs"], crawl=crawl, expected_count=input_count)
    expected_inputs_sha = _require_sha256(document["inputs_sha256"], "inputs_sha256")
    actual_inputs_sha = inputs_sha256(paths)
    if actual_inputs_sha != expected_inputs_sha:
        raise ManifestValidationError("inputs_sha256 does not match the ordered input list")
    _verify_document_sha(document, "manifest_sha256")
    return dict(document)


def load_base_manifest(
    path: Path,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
) -> dict[str, Any]:
    """Load and fully validate a production-v2 base manifest from disk."""

    return validate_base_manifest(
        _load_json(path, "base manifest"), expected_input_count=expected_input_count
    )


def shard_bounds(total_inputs: int, shard_count: int, shard_id: int) -> tuple[int, int]:
    """Return the deterministic contiguous [start, end) range for one zero-based shard."""

    total_inputs = _require_int(total_inputs, "total_inputs", minimum=1)
    shard_count = _require_int(shard_count, "shard_count", minimum=1)
    shard_id = _require_int(shard_id, "shard_id", minimum=0)
    if shard_count > total_inputs:
        raise ManifestValidationError("shard_count cannot exceed the number of inputs")
    if shard_id >= shard_count:
        raise ManifestValidationError("shard_id must be less than shard_count")
    quotient, remainder = divmod(total_inputs, shard_count)
    start = shard_id * quotient + min(shard_id, remainder)
    end = start + quotient + (1 if shard_id < remainder else 0)
    return start, end


def _validate_shard_capacity(
    total_inputs: int,
    shard_count: int,
    max_inputs_per_shard: int,
) -> None:
    """Enforce the proven per-worker input bound before any shard is materialized."""

    total_inputs = _require_int(total_inputs, "total_inputs", minimum=1)
    shard_count = _require_int(shard_count, "shard_count", minimum=1)
    max_inputs_per_shard = _require_int(
        max_inputs_per_shard, "max_inputs_per_shard", minimum=1
    )
    if shard_count > total_inputs:
        raise ManifestValidationError("shard_count cannot exceed the number of inputs")
    largest_shard = (total_inputs + shard_count - 1) // shard_count
    if largest_shard > max_inputs_per_shard:
        minimum_shard_count = (total_inputs + max_inputs_per_shard - 1) // max_inputs_per_shard
        raise ManifestValidationError(
            f"shard_count {shard_count} would create a shard with {largest_shard:,} inputs; "
            f"the hard per-shard ceiling is {max_inputs_per_shard:,} "
            f"(use at least {minimum_shard_count} shards)"
        )


def _expected_shard_document_from_validated_base(
    base: Mapping[str, Any],
    *,
    shard_id: int,
    shard_count: int,
    max_inputs_per_shard: int,
) -> dict[str, Any]:
    """Derive the only valid shard document from a validated base and shard identity."""

    _validate_shard_capacity(base["input_count"], shard_count, max_inputs_per_shard)
    start, end = shard_bounds(base["input_count"], shard_count, shard_id)
    paths = list(base["inputs"][start:end])
    document: dict[str, Any] = {
        "format_version": FORMAT_VERSION,
        "kind": SHARD_MANIFEST_KIND,
        "run_id": base["run_id"],
        "crawl": base["crawl"],
        "shard_id": shard_id,
        "shard_count": shard_count,
        "base_manifest_sha256": base["manifest_sha256"],
        "base_inputs_sha256": base["inputs_sha256"],
        "input_count": len(paths),
        "inputs_sha256": inputs_sha256(paths),
        "first_input": paths[0],
        "last_input": paths[-1],
        "inputs": paths,
    }
    document["manifest_sha256"] = manifest_sha256(document)
    return document


def _build_shard_manifest_from_validated_base(
    base: Mapping[str, Any],
    *,
    shard_id: int,
    shard_count: int,
    max_inputs_per_shard: int,
) -> dict[str, Any]:
    """Build and validate a shard after the caller has already validated the base list."""

    document = _expected_shard_document_from_validated_base(
        base,
        shard_id=shard_id,
        shard_count=shard_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )
    _validate_shard_manifest_against_validated_base(
        document, base, max_inputs_per_shard=max_inputs_per_shard
    )
    return document


def build_shard_manifest(
    base_manifest: Mapping[str, Any],
    *,
    shard_id: int,
    shard_count: int,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Build one immutable, contiguous shard from a validated base manifest."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    return _build_shard_manifest_from_validated_base(
        base,
        shard_id=shard_id,
        shard_count=shard_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )


def split_shards(
    base_manifest: Mapping[str, Any],
    shard_count: int,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> list[dict[str, Any]]:
    """Split a base manifest into deterministic non-overlapping contiguous shards."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    shard_count = _require_int(shard_count, "shard_count", minimum=1)
    _validate_shard_capacity(base["input_count"], shard_count, max_inputs_per_shard)
    shards = [
        _build_shard_manifest_from_validated_base(
            base,
            shard_id=shard_id,
            shard_count=shard_count,
            max_inputs_per_shard=max_inputs_per_shard,
        )
        for shard_id in range(shard_count)
    ]
    verify_shard_set(
        base,
        shards,
        expected_input_count=expected_input_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )
    return shards


def _validate_shard_manifest_against_validated_base(
    document: Mapping[str, Any],
    base: Mapping[str, Any],
    *,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Validate a shard against a base list the caller has already validated."""
    document = _require_mapping(document, "shard manifest")
    _required(
        document,
        {
            "format_version",
            "kind",
            "run_id",
            "crawl",
            "shard_id",
            "shard_count",
            "base_manifest_sha256",
            "base_inputs_sha256",
            "input_count",
            "inputs_sha256",
            "manifest_sha256",
            "first_input",
            "last_input",
            "inputs",
        },
        "shard manifest",
    )
    if document["format_version"] != FORMAT_VERSION:
        raise ManifestValidationError("unsupported shard manifest format_version")
    if document["kind"] != SHARD_MANIFEST_KIND:
        raise ManifestValidationError("shard manifest has the wrong kind")
    if _validate_run_id(document["run_id"]) != base["run_id"]:
        raise ManifestValidationError("shard run_id does not match the base manifest")
    if _validate_crawl(document["crawl"]) != base["crawl"]:
        raise ManifestValidationError("shard crawl does not match the base manifest")
    shard_count = _require_int(document["shard_count"], "shard_count", minimum=1)
    shard_id = _require_int(document["shard_id"], "shard_id", minimum=0)
    _validate_shard_capacity(base["input_count"], shard_count, max_inputs_per_shard)
    start, end = shard_bounds(base["input_count"], shard_count, shard_id)
    if _require_sha256(document["base_manifest_sha256"], "base_manifest_sha256") != base["manifest_sha256"]:
        raise ManifestValidationError("base_manifest_sha256 does not match the base manifest")
    if _require_sha256(document["base_inputs_sha256"], "base_inputs_sha256") != base["inputs_sha256"]:
        raise ManifestValidationError("base_inputs_sha256 does not match the base manifest")
    input_count = _require_int(document["input_count"], "input_count", minimum=1)
    expected_paths = base["inputs"][start:end]
    if input_count != len(expected_paths):
        raise ManifestValidationError("shard input_count does not match its deterministic slice")
    paths = _validate_input_paths(document["inputs"], crawl=base["crawl"], expected_count=input_count)
    if paths != expected_paths:
        raise ManifestValidationError("shard inputs do not exactly match their contiguous base-manifest slice")
    if _require_string(document["first_input"], "first_input") != paths[0]:
        raise ManifestValidationError("shard first_input does not match its first input")
    if _require_string(document["last_input"], "last_input") != paths[-1]:
        raise ManifestValidationError("shard last_input does not match its last input")
    if _require_sha256(document["inputs_sha256"], "inputs_sha256") != inputs_sha256(paths):
        raise ManifestValidationError("shard inputs_sha256 does not match its ordered input list")
    _verify_document_sha(document, "manifest_sha256")
    return dict(document)


def validate_shard_manifest(
    document: Mapping[str, Any],
    base_manifest: Mapping[str, Any],
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Validate one shard against the immutable base manifest and its exact slice."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    return _validate_shard_manifest_against_validated_base(
        document,
        base,
        max_inputs_per_shard=max_inputs_per_shard,
    )


def load_shard_manifest(
    path: Path,
    base_manifest: Mapping[str, Any],
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Load and fully validate a shard against its base manifest."""

    return validate_shard_manifest(
        _load_json(path, "shard manifest"),
        base_manifest,
        expected_input_count=expected_input_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )


def _shard_summary(shard: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "shard_id": shard["shard_id"],
        "input_count": shard["input_count"],
        "first_input": shard["first_input"],
        "last_input": shard["last_input"],
        "inputs_sha256": shard["inputs_sha256"],
        "shard_manifest_sha256": shard["manifest_sha256"],
    }


def build_shard_plan(
    base_manifest: Mapping[str, Any],
    shards: Sequence[Mapping[str, Any]],
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Build the immutable global shard-plan metadata document."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    checked_shards = verify_shard_set(
        base,
        shards,
        expected_input_count=expected_input_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )
    document: dict[str, Any] = {
        "format_version": FORMAT_VERSION,
        "kind": SHARD_PLAN_KIND,
        "run_id": base["run_id"],
        "crawl": base["crawl"],
        "shard_count": len(checked_shards),
        "base_manifest_sha256": base["manifest_sha256"],
        "base_inputs_sha256": base["inputs_sha256"],
        "shards": [_shard_summary(shard) for shard in checked_shards],
    }
    document["plan_sha256"] = shard_plan_sha256(document)
    validate_shard_plan(
        document,
        base,
        checked_shards,
        expected_input_count=expected_input_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )
    return document


def validate_shard_plan(
    document: Mapping[str, Any],
    base_manifest: Mapping[str, Any],
    shards: Sequence[Mapping[str, Any]] | None = None,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Validate immutable plan metadata, and optionally bind it to shard documents."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    document = _require_mapping(document, "shard plan")
    _required(
        document,
        {
            "format_version",
            "kind",
            "run_id",
            "crawl",
            "shard_count",
            "base_manifest_sha256",
            "base_inputs_sha256",
            "shards",
            "plan_sha256",
        },
        "shard plan",
    )
    if document["format_version"] != FORMAT_VERSION:
        raise ManifestValidationError("unsupported shard plan format_version")
    if document["kind"] != SHARD_PLAN_KIND:
        raise ManifestValidationError("shard plan has the wrong kind")
    if _validate_run_id(document["run_id"]) != base["run_id"]:
        raise ManifestValidationError("shard plan run_id does not match the base manifest")
    if _validate_crawl(document["crawl"]) != base["crawl"]:
        raise ManifestValidationError("shard plan crawl does not match the base manifest")
    shard_count = _require_int(document["shard_count"], "shard_count", minimum=1)
    if shard_count > base["input_count"]:
        raise ManifestValidationError("shard plan shard_count exceeds base input_count")
    _validate_shard_capacity(base["input_count"], shard_count, max_inputs_per_shard)
    if _require_sha256(document["base_manifest_sha256"], "base_manifest_sha256") != base["manifest_sha256"]:
        raise ManifestValidationError("shard plan base_manifest_sha256 does not match the base manifest")
    if _require_sha256(document["base_inputs_sha256"], "base_inputs_sha256") != base["inputs_sha256"]:
        raise ManifestValidationError("shard plan base_inputs_sha256 does not match the base manifest")
    summaries = document["shards"]
    if not isinstance(summaries, list) or len(summaries) != shard_count:
        raise ManifestValidationError("shard plan shards must contain exactly shard_count summaries")
    seen_ids: set[int] = set()
    expected_summaries: list[dict[str, Any]] = []
    for summary in summaries:
        summary = _require_mapping(summary, "shard plan shard summary")
        _required(
            summary,
            {
                "shard_id",
                "input_count",
                "first_input",
                "last_input",
                "inputs_sha256",
                "shard_manifest_sha256",
            },
            "shard plan shard summary",
        )
        shard_id = _require_int(summary["shard_id"], "shard plan shard_id", minimum=0)
        if shard_id in seen_ids:
            raise ManifestValidationError("shard plan contains a duplicate shard_id")
        seen_ids.add(shard_id)
        start, end = shard_bounds(base["input_count"], shard_count, shard_id)
        if _require_int(summary["input_count"], "shard plan input_count", minimum=1) != end - start:
            raise ManifestValidationError("shard plan input_count does not match its deterministic slice")
        expected_paths = base["inputs"][start:end]
        if _require_string(summary["first_input"], "shard plan first_input") != expected_paths[0]:
            raise ManifestValidationError("shard plan first_input does not match its deterministic slice")
        if _require_string(summary["last_input"], "shard plan last_input") != expected_paths[-1]:
            raise ManifestValidationError("shard plan last_input does not match its deterministic slice")
        expected_shard = _expected_shard_document_from_validated_base(
            base,
            shard_id=shard_id,
            shard_count=shard_count,
            max_inputs_per_shard=max_inputs_per_shard,
        )
        if _require_sha256(summary["inputs_sha256"], "shard plan inputs_sha256") != expected_shard["inputs_sha256"]:
            raise ManifestValidationError(
                "shard plan inputs_sha256 does not match its deterministic base-manifest slice"
            )
        if _require_sha256(
            summary["shard_manifest_sha256"],
            "shard plan shard_manifest_sha256",
        ) != expected_shard["manifest_sha256"]:
            raise ManifestValidationError(
                "shard plan shard_manifest_sha256 does not match its deterministic shard document"
            )
        expected_summaries.append(dict(summary))
    if seen_ids != set(range(shard_count)):
        raise ManifestValidationError("shard plan shard_ids must be exactly the zero-based shard range")
    if [summary["shard_id"] for summary in expected_summaries] != list(range(shard_count)):
        raise ManifestValidationError("shard plan summaries must be sorted by shard_id")
    expected_plan_sha = _require_sha256(document["plan_sha256"], "plan_sha256")
    if shard_plan_sha256(document) != expected_plan_sha:
        raise ManifestValidationError("plan_sha256 does not match canonical shard-plan SHA-256")
    if shards is not None:
        checked_shards = verify_shard_set(
            base,
            shards,
            expected_input_count=expected_input_count,
            max_inputs_per_shard=max_inputs_per_shard,
        )
        actual_summaries = [_shard_summary(shard) for shard in checked_shards]
        if expected_summaries != actual_summaries:
            raise ManifestValidationError("shard plan metadata does not match the supplied shard manifests")
    return dict(document)


def load_shard_plan(
    path: Path,
    base_manifest: Mapping[str, Any],
    shards: Sequence[Mapping[str, Any]] | None = None,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> dict[str, Any]:
    """Load and validate global shard-plan metadata from disk."""

    return validate_shard_plan(
        _load_json(path, "shard plan"),
        base_manifest,
        shards,
        expected_input_count=expected_input_count,
        max_inputs_per_shard=max_inputs_per_shard,
    )


def verify_shard_set(
    base_manifest: Mapping[str, Any],
    shards: Sequence[Mapping[str, Any]],
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    max_inputs_per_shard: int = MAX_SAFE_INPUTS_PER_SHARD,
) -> list[dict[str, Any]]:
    """Prove exact shard coverage: hashes, IDs, no overlap, and exact union."""

    base = validate_base_manifest(
        base_manifest, expected_input_count=expected_input_count
    )
    if not isinstance(shards, Sequence) or isinstance(shards, (str, bytes)) or not shards:
        raise ManifestValidationError("shards must be a non-empty sequence of shard manifests")
    first = _require_mapping(shards[0], "shard manifest")
    shard_count = _require_int(first.get("shard_count"), "shard_count", minimum=1)
    if len(shards) != shard_count:
        raise ManifestValidationError("number of shard manifests does not equal shard_count")
    checked_by_id: dict[int, dict[str, Any]] = {}
    for shard in shards:
        checked = _validate_shard_manifest_against_validated_base(
            _require_mapping(shard, "shard manifest"),
            base,
            max_inputs_per_shard=max_inputs_per_shard,
        )
        if checked["shard_count"] != shard_count:
            raise ManifestValidationError("shard manifests disagree on shard_count")
        shard_id = checked["shard_id"]
        if shard_id in checked_by_id:
            raise ManifestValidationError("duplicate shard_id in shard set")
        checked_by_id[shard_id] = checked
    if set(checked_by_id) != set(range(shard_count)):
        raise ManifestValidationError("shard set must contain each zero-based shard_id exactly once")
    ordered = [checked_by_id[shard_id] for shard_id in range(shard_count)]
    union = [path for shard in ordered for path in shard["inputs"]]
    if len(union) != len(set(union)):
        raise ManifestValidationError("shard manifests overlap on one or more input paths")
    if union != base["inputs"]:
        raise ManifestValidationError("union of ordered shard inputs does not exactly equal base-manifest inputs")
    if inputs_sha256(union) != base["inputs_sha256"]:
        raise ManifestValidationError("union input SHA-256 does not match the base manifest")
    return ordered


def shard_artifact_stem(shard_id: int, shard_count: int) -> str:
    """Return the stable local filename stem for one shard's JSON and .paths artifacts."""

    _require_int(shard_id, "shard_id", minimum=0)
    shard_count = _require_int(shard_count, "shard_count", minimum=1)
    if shard_id >= shard_count:
        raise ManifestValidationError("shard_id must be less than shard_count")
    width = max(5, len(str(shard_count - 1)))
    return f"shard-{shard_id:0{width}d}-of-{shard_count:0{width}d}"


def write_immutable_text(path: Path, text: str) -> bool:
    """Create an immutable local artifact; identical reruns are harmless, mismatches fail."""

    encoded = text.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        return True
    except FileExistsError:
        if path.read_bytes() != encoded:
            raise ManifestValidationError(f"refusing to overwrite immutable artifact: {path}")
        return False


def write_immutable_json(path: Path, document: Mapping[str, Any]) -> bool:
    """Write a deterministic JSON artifact without ever replacing a different file."""

    return write_immutable_text(
        path,
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def write_paths(path: Path, paths: Sequence[str]) -> bool:
    """Write the exact newline-delimited list used by the ingester's --input-list."""

    if not paths:
        raise ManifestValidationError("cannot write an empty shard path list")
    return write_immutable_text(path, "\n".join(paths) + "\n")


def write_shard_artifacts(
    output_dir: Path,
    shards: Sequence[Mapping[str, Any]],
    *,
    plan: Mapping[str, Any] | None = None,
) -> list[tuple[Path, Path]]:
    """Write immutable shard JSON/.paths pairs and the optional global shard plan."""

    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[tuple[Path, Path]] = []
    for shard in shards:
        shard = _require_mapping(shard, "shard manifest")
        stem = shard_artifact_stem(shard["shard_id"], shard["shard_count"])
        json_path = output_dir / f"{stem}.json"
        paths_path = output_dir / f"{stem}.paths"
        write_immutable_json(json_path, shard)
        write_paths(paths_path, shard["inputs"])
        written.append((json_path, paths_path))
    if plan is not None:
        write_immutable_json(output_dir / "shard-plan.json", plan)
    return written


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ManifestValidationError(f"could not read {label} {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ManifestValidationError(f"could not parse {label} {path}: {error.msg}") from error
    return dict(_require_mapping(value, label))


def read_paths(path: Path) -> list[str]:
    """Read an explicit local source list without trimming or silently dropping entries."""

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ManifestValidationError(f"could not read input list {path}: {error}") from error
    paths = raw.splitlines()
    if not paths:
        raise ManifestValidationError("input list is empty")
    if any(not value for value in paths):
        raise ManifestValidationError("input list contains an empty path")
    return paths


def _print_summary(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_base = subparsers.add_parser("create-base", help="create an immutable exact-100,000 base manifest")
    create_base.add_argument("--run-id", required=True)
    create_base.add_argument("--crawl", required=True)
    create_base.add_argument("--input-list", required=True, type=Path)
    create_base.add_argument("--output", required=True, type=Path)
    create_base.add_argument("--expected-input-count", required=True, type=int)

    split = subparsers.add_parser("split", help="split a validated base manifest into fixed contiguous shards")
    split.add_argument("--base-manifest", required=True, type=Path)
    split.add_argument("--shard-count", required=True, type=int)
    split.add_argument("--output-dir", required=True, type=Path)
    split.add_argument("--expected-input-count", required=True, type=int)

    materialize = subparsers.add_parser("materialize-shard", help="validate a shard and emit its canonical .paths list")
    materialize.add_argument("--base-manifest", required=True, type=Path)
    materialize.add_argument("--shard-manifest", required=True, type=Path)
    materialize.add_argument("--output", required=True, type=Path)
    materialize.add_argument("--expected-input-count", required=True, type=int)

    verify = subparsers.add_parser("verify", help="prove full base-manifest coverage by a shard set")
    verify.add_argument("--base-manifest", required=True, type=Path)
    verify.add_argument("--shard-manifests", required=True, nargs="+", type=Path)
    verify.add_argument("--shard-plan", type=Path)
    verify.add_argument("--expected-input-count", required=True, type=int)
    args = parser.parse_args(argv)
    if args.expected_input_count < 1 or args.expected_input_count > MAX_SAFE_INPUTS:
        parser.error(f"--expected-input-count must be between 1 and {MAX_SAFE_INPUTS:,}")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        if args.command == "create-base":
            base = build_base_manifest(
                run_id=args.run_id,
                crawl=args.crawl,
                inputs=read_paths(args.input_list),
                expected_input_count=args.expected_input_count,
            )
            write_immutable_json(args.output, base)
            _print_summary(
                {
                    "base_manifest_sha256": base["manifest_sha256"],
                    "crawl": base["crawl"],
                    "first_input": base["inputs"][0],
                    "input_count": base["input_count"],
                    "inputs_sha256": base["inputs_sha256"],
                    "last_input": base["inputs"][-1],
                    "run_id": base["run_id"],
                }
            )
            return 0
        if args.command == "split":
            base = load_base_manifest(args.base_manifest, expected_input_count=args.expected_input_count)
            shards = split_shards(base, args.shard_count, expected_input_count=args.expected_input_count)
            plan = build_shard_plan(base, shards, expected_input_count=args.expected_input_count)
            write_shard_artifacts(args.output_dir, shards, plan=plan)
            _print_summary(
                {
                    "base_manifest_sha256": base["manifest_sha256"],
                    "input_count": base["input_count"],
                    "plan_sha256": plan["plan_sha256"],
                    "run_id": base["run_id"],
                    "shard_count": len(shards),
                }
            )
            return 0
        if args.command == "materialize-shard":
            base = load_base_manifest(args.base_manifest, expected_input_count=args.expected_input_count)
            shard = load_shard_manifest(args.shard_manifest, base, expected_input_count=args.expected_input_count)
            write_paths(args.output, shard["inputs"])
            _print_summary(
                {
                    "input_count": shard["input_count"],
                    "inputs_sha256": shard["inputs_sha256"],
                    "output": str(args.output),
                    "shard_id": shard["shard_id"],
                    "shard_manifest_sha256": shard["manifest_sha256"],
                }
            )
            return 0
        if args.command == "verify":
            base = load_base_manifest(args.base_manifest, expected_input_count=args.expected_input_count)
            shards = [load_shard_manifest(path, base, expected_input_count=args.expected_input_count) for path in args.shard_manifests]
            ordered = verify_shard_set(base, shards, expected_input_count=args.expected_input_count)
            if args.shard_plan is not None:
                load_shard_plan(args.shard_plan, base, ordered, expected_input_count=args.expected_input_count)
            _print_summary(
                {
                    "base_manifest_sha256": base["manifest_sha256"],
                    "input_count": base["input_count"],
                    "inputs_sha256": base["inputs_sha256"],
                    "run_id": base["run_id"],
                    "shard_count": len(ordered),
                    "verified": True,
                }
            )
            return 0
        raise AssertionError(f"unsupported command {args.command!r}")
    except ManifestValidationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
