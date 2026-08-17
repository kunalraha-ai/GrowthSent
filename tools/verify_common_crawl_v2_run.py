#!/usr/bin/env python3
"""Verify a locked Common Crawl production-v2 base manifest and shard set locally.

This tool intentionally reads only local JSON files.  It performs no S3, EC2,
or Common Crawl requests.  Production mode requires the exact, bounded
100,000-input run size before a shard fleet can be launched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


FORMAT_VERSION = 2
BASE_MANIFEST_KIND = "common-crawl-v2-base-manifest"
SHARD_MANIFEST_KIND = "common-crawl-v2-shard-manifest"
SHARD_PLAN_KIND = "common-crawl-v2-shard-plan"
PRODUCTION_INPUT_COUNT = 100_000
MAX_SAFE_INPUTS_PER_SHARD = 1_000
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ManifestVerificationError(ValueError):
    """Raised when a base manifest or shard set cannot prove its safe scope."""


def inputs_sha256(inputs: list[str]) -> str:
    """Return the same ordered-input digest used by the ingestion manifest lock."""
    return hashlib.sha256("\n".join(inputs).encode("utf-8")).hexdigest()


def manifest_sha256(manifest: Mapping[str, Any]) -> str:
    """Hash the canonical manifest document, excluding its self-referential hash."""
    payload = dict(manifest)
    payload.pop("manifest_sha256", None)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def shard_plan_sha256(plan: Mapping[str, Any]) -> str:
    """Hash the canonical shard-plan document, excluding its self hash."""
    payload = dict(plan)
    payload.pop("plan_sha256", None)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def input_hash_suffix(source: str) -> str:
    """Return the deterministic 16-hex part suffix used by the WAT ingester."""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def shard_bounds(total_inputs: int, shard_count: int, shard_id: int) -> tuple[int, int]:
    """Return the deterministic contiguous slice owned by one shard.

    Earlier shards receive one additional input when the total is not evenly
    divisible.  This makes every assignment reproducible from the locked base
    manifest and avoids hash-partition changes when path order is audited.
    """
    if total_inputs < 1:
        raise ManifestVerificationError("base manifest must contain at least one input")
    if shard_count < 1:
        raise ManifestVerificationError("shard_count must be at least one")
    if shard_count > total_inputs:
        raise ManifestVerificationError("shard_count cannot exceed base input_count")
    if not 0 <= shard_id < shard_count:
        raise ManifestVerificationError("shard_id must be in the range [0, shard_count)")

    base_size, remainder = divmod(total_inputs, shard_count)
    start = shard_id * base_size + min(shard_id, remainder)
    end = start + base_size + (1 if shard_id < remainder else 0)
    return start, end


def load_manifest(path: Path) -> dict[str, Any]:
    """Read one local JSON manifest without accessing any external service."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestVerificationError(f"unable to read manifest {path}: {error}") from error
    if not isinstance(document, dict):
        raise ManifestVerificationError(f"manifest {path} must contain a JSON object")
    return document


def _require_string(document: Mapping[str, Any], field: str, label: str) -> str:
    value = document.get(field)
    if not isinstance(value, str) or not value:
        raise ManifestVerificationError(f"{label}.{field} must be a non-empty string")
    return value


def _require_int(document: Mapping[str, Any], field: str, label: str) -> int:
    value = document.get(field)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ManifestVerificationError(f"{label}.{field} must be an integer")
    return value


def _require_inputs(document: Mapping[str, Any], label: str) -> list[str]:
    value = document.get("inputs")
    if not isinstance(value, list) or not value:
        raise ManifestVerificationError(f"{label}.inputs must be a non-empty list of strings")
    if not all(isinstance(source, str) and source for source in value):
        raise ManifestVerificationError(f"{label}.inputs must contain only non-empty strings")
    return value


def _require_sha256(document: Mapping[str, Any], field: str, label: str) -> str:
    value = _require_string(document, field, label)
    if not _SHA256.fullmatch(value):
        raise ManifestVerificationError(f"{label}.{field} must be a lower-case SHA-256 hex digest")
    return value


def _verify_base_manifest(base: Mapping[str, Any], expected_input_count: int | None) -> dict[str, Any]:
    label = "base manifest"
    if base.get("format_version") != FORMAT_VERSION:
        raise ManifestVerificationError(f"{label}.format_version must be {FORMAT_VERSION}")
    if base.get("kind") != BASE_MANIFEST_KIND:
        raise ManifestVerificationError(f"{label}.kind must be {BASE_MANIFEST_KIND!r}")

    run_id = _require_string(base, "run_id", label)
    crawl = _require_string(base, "crawl", label)
    input_count = _require_int(base, "input_count", label)
    if input_count < 1:
        raise ManifestVerificationError("base manifest.input_count must be at least one")
    if expected_input_count is not None and input_count != expected_input_count:
        raise ManifestVerificationError(
            f"base manifest.input_count must equal {expected_input_count}, got {input_count}"
        )

    inputs = _require_inputs(base, label)
    if len(inputs) != input_count:
        raise ManifestVerificationError(
            f"base manifest.input_count is {input_count}, but inputs contains {len(inputs)} paths"
        )
    if len(set(inputs)) != len(inputs):
        raise ManifestVerificationError("base manifest contains duplicate input paths")

    manifest_hash = _require_sha256(base, "inputs_sha256", label)
    calculated_hash = inputs_sha256(inputs)
    if manifest_hash != calculated_hash:
        raise ManifestVerificationError("base manifest.inputs_sha256 does not match its ordered inputs")
    document_hash = _require_sha256(base, "manifest_sha256", label)
    if document_hash != manifest_sha256(base):
        raise ManifestVerificationError("base manifest.manifest_sha256 does not match its canonical document")

    suffixes = [input_hash_suffix(source) for source in inputs]
    if len(set(suffixes)) != len(suffixes):
        duplicates: dict[str, str] = {}
        seen: dict[str, str] = {}
        for source, suffix in zip(inputs, suffixes, strict=True):
            previous = seen.setdefault(suffix, source)
            if previous != source:
                duplicates[suffix] = previous
        examples = ", ".join(sorted(duplicates)[:3])
        raise ManifestVerificationError(
            f"base manifest has duplicate deterministic part hash suffixes: {examples}"
        )

    return {
        "run_id": run_id,
        "crawl": crawl,
        "input_count": input_count,
        "inputs": inputs,
        "inputs_sha256": manifest_hash,
        "manifest_sha256": document_hash,
        "part_hash_suffix_count": len(suffixes),
    }


def _verify_shard_manifest(
    shard: Mapping[str, Any],
    base: Mapping[str, Any],
    expected_shard_count: int | None,
) -> dict[str, Any]:
    label = "shard manifest"
    if shard.get("format_version") != FORMAT_VERSION:
        raise ManifestVerificationError(f"{label}.format_version must be {FORMAT_VERSION}")
    if shard.get("kind") != SHARD_MANIFEST_KIND:
        raise ManifestVerificationError(f"{label}.kind must be {SHARD_MANIFEST_KIND!r}")

    run_id = _require_string(shard, "run_id", label)
    crawl = _require_string(shard, "crawl", label)
    if run_id != base["run_id"]:
        raise ManifestVerificationError("shard manifest.run_id does not match the base manifest")
    if crawl != base["crawl"]:
        raise ManifestVerificationError("shard manifest.crawl does not match the base manifest")

    shard_id = _require_int(shard, "shard_id", label)
    shard_count = _require_int(shard, "shard_count", label)
    if expected_shard_count is not None and shard_count != expected_shard_count:
        raise ManifestVerificationError("shard manifests do not agree on shard_count")
    start, end = shard_bounds(base["input_count"], shard_count, shard_id)

    base_inputs_hash = _require_sha256(shard, "base_inputs_sha256", label)
    if base_inputs_hash != base["inputs_sha256"]:
        raise ManifestVerificationError("shard manifest.base_inputs_sha256 does not match the base manifest")
    base_manifest_hash = _require_sha256(shard, "base_manifest_sha256", label)
    if base_manifest_hash != base["manifest_sha256"]:
        raise ManifestVerificationError("shard manifest.base_manifest_sha256 does not match the base manifest")

    input_count = _require_int(shard, "input_count", label)
    inputs = _require_inputs(shard, label)
    if input_count != len(inputs):
        raise ManifestVerificationError(
            f"shard manifest.input_count is {input_count}, but inputs contains {len(inputs)} paths"
        )
    if input_count > MAX_SAFE_INPUTS_PER_SHARD:
        raise ManifestVerificationError(
            f"shard manifest.input_count exceeds the {MAX_SAFE_INPUTS_PER_SHARD}-input safety ceiling"
        )
    expected_inputs = base["inputs"][start:end]
    if inputs != expected_inputs:
        raise ManifestVerificationError(
            f"shard {shard_id} inputs are not its deterministic contiguous base-manifest slice"
        )

    manifest_hash = _require_sha256(shard, "inputs_sha256", label)
    if manifest_hash != inputs_sha256(inputs):
        raise ManifestVerificationError("shard manifest.inputs_sha256 does not match its ordered inputs")
    document_hash = _require_sha256(shard, "manifest_sha256", label)
    if document_hash != manifest_sha256(shard):
        raise ManifestVerificationError("shard manifest.manifest_sha256 does not match its canonical document")

    first_input = _require_string(shard, "first_input", label)
    last_input = _require_string(shard, "last_input", label)
    if first_input != inputs[0] or last_input != inputs[-1]:
        raise ManifestVerificationError("shard manifest first_input/last_input do not match its input list")

    return {
        "shard_id": shard_id,
        "shard_count": shard_count,
        "input_count": input_count,
        "inputs": inputs,
        "inputs_sha256": manifest_hash,
        "manifest_sha256": document_hash,
        "first_input": first_input,
        "last_input": last_input,
    }


def verify_shard_plan(
    shard_plan: Mapping[str, Any],
    base: Mapping[str, Any],
    verified_shards: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Bind a signed shard plan to an already-verified base and shard set."""
    label = "shard plan"
    if shard_plan.get("format_version") != FORMAT_VERSION:
        raise ManifestVerificationError(f"{label}.format_version must be {FORMAT_VERSION}")
    if shard_plan.get("kind") != SHARD_PLAN_KIND:
        raise ManifestVerificationError(f"{label}.kind must be {SHARD_PLAN_KIND!r}")
    if _require_string(shard_plan, "run_id", label) != base["run_id"]:
        raise ManifestVerificationError("shard plan.run_id does not match the base manifest")
    if _require_string(shard_plan, "crawl", label) != base["crawl"]:
        raise ManifestVerificationError("shard plan.crawl does not match the base manifest")
    if _require_sha256(shard_plan, "base_manifest_sha256", label) != base["manifest_sha256"]:
        raise ManifestVerificationError("shard plan.base_manifest_sha256 does not match the base manifest")
    if _require_sha256(shard_plan, "base_inputs_sha256", label) != base["inputs_sha256"]:
        raise ManifestVerificationError("shard plan.base_inputs_sha256 does not match the base manifest")

    plan_shard_count = _require_int(shard_plan, "shard_count", label)
    entries = shard_plan.get("shards")
    if not isinstance(entries, list) or not entries:
        raise ManifestVerificationError("shard plan.shards must be a non-empty list")
    if len(entries) != plan_shard_count:
        raise ManifestVerificationError("shard plan.shards length does not match shard_count")
    if _require_sha256(shard_plan, "plan_sha256", label) != shard_plan_sha256(shard_plan):
        raise ManifestVerificationError("shard plan.plan_sha256 does not match its canonical document")

    verified_by_id = {shard["shard_id"]: shard for shard in verified_shards}
    if len(verified_by_id) != plan_shard_count:
        raise ManifestVerificationError("shard plan.shard_count does not match the supplied shard set")
    entry_ids: list[int] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ManifestVerificationError("shard plan.shards entries must be objects")
        shard_id = _require_int(entry, "shard_id", "shard plan.shards entry")
        entry_ids.append(shard_id)
        actual = verified_by_id.get(shard_id)
        if actual is None:
            raise ManifestVerificationError(f"shard plan references unavailable shard_id {shard_id}")
        expected_metadata = {
            "input_count": actual["input_count"],
            "inputs_sha256": actual["inputs_sha256"],
            "shard_manifest_sha256": actual["manifest_sha256"],
            "first_input": actual["first_input"],
            "last_input": actual["last_input"],
        }
        for field, expected in expected_metadata.items():
            if entry.get(field) != expected:
                raise ManifestVerificationError(
                    f"shard plan metadata for shard_id {shard_id} does not match its shard manifest ({field})"
                )
    if entry_ids != list(range(plan_shard_count)):
        raise ManifestVerificationError("shard plan.shards must be ordered with each shard_id exactly once")

    return {
        "plan_sha256": shard_plan["plan_sha256"],
        "shard_count": plan_shard_count,
    }


def verify_run_manifests(
    base_manifest: Mapping[str, Any],
    shard_manifests: Iterable[Mapping[str, Any]],
    *,
    expected_input_count: int | None = None,
    shard_plan: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Prove a shard set is an exact, disjoint partition of a locked base list.

    The verification does not trust the manifests' own overlap claims.  It
    reconstructs each expected contiguous slice from the base manifest and
    compares every shard's full ordered list and digest.
    """
    base = _verify_base_manifest(base_manifest, expected_input_count)
    supplied_shards = list(shard_manifests)
    if not supplied_shards:
        raise ManifestVerificationError("at least one shard manifest is required")

    verified: list[dict[str, Any]] = []
    shard_count: int | None = None
    shard_ids: set[int] = set()
    for shard_manifest in supplied_shards:
        shard = _verify_shard_manifest(shard_manifest, base, shard_count)
        if shard_count is None:
            shard_count = shard["shard_count"]
        if shard["shard_id"] in shard_ids:
            raise ManifestVerificationError(f"duplicate shard_id {shard['shard_id']}")
        shard_ids.add(shard["shard_id"])
        verified.append(shard)

    assert shard_count is not None
    if len(verified) != shard_count:
        raise ManifestVerificationError(
            f"received {len(verified)} shard manifests, but shard_count is {shard_count}"
        )
    expected_ids = set(range(shard_count))
    if shard_ids != expected_ids:
        missing = sorted(expected_ids.difference(shard_ids))
        unexpected = sorted(shard_ids.difference(expected_ids))
        raise ManifestVerificationError(
            f"shard IDs must be exactly 0..{shard_count - 1}; missing={missing}, unexpected={unexpected}"
        )

    ordered_shards = sorted(verified, key=lambda shard: shard["shard_id"])
    combined_inputs = [source for shard in ordered_shards for source in shard["inputs"]]
    if len(combined_inputs) != len(set(combined_inputs)):
        raise ManifestVerificationError("shard manifests overlap on one or more input paths")
    if combined_inputs != base["inputs"]:
        raise ManifestVerificationError("the ordered union of shard inputs does not exactly equal the base manifest")

    report = {
        "valid": True,
        "run_id": base["run_id"],
        "crawl": base["crawl"],
        "base_input_count": base["input_count"],
        "base_inputs_sha256": base["inputs_sha256"],
        "base_manifest_sha256": base["manifest_sha256"],
        "part_hash_suffix_count": base["part_hash_suffix_count"],
        "shard_count": shard_count,
        "shards": [
            {
                key: shard[key]
                for key in ("shard_id", "input_count", "inputs_sha256", "manifest_sha256", "first_input", "last_input")
            }
            for shard in ordered_shards
        ],
    }
    if shard_plan is not None:
        report["shard_plan"] = verify_shard_plan(shard_plan, base, ordered_shards)
    return report


def _shard_paths(args: argparse.Namespace) -> list[Path]:
    paths = list(args.shard_manifest or [])
    if args.shard_dir is not None:
        # ``common_crawl_v2_manifest.write_shard_artifacts`` writes
        # shard-plan.json beside the shard documents.  Select only the stable
        # per-shard filename form so that plan is never mistaken for a shard.
        paths.extend(sorted(args.shard_dir.glob("shard-*-of-*.json")))
    if not paths:
        raise ManifestVerificationError("provide at least one --shard-manifest or a non-empty --shard-dir")
    if len(set(paths)) != len(paths):
        raise ManifestVerificationError("the same shard manifest was provided more than once")
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-manifest", required=True, type=Path)
    parser.add_argument("--shard-manifest", action="append", type=Path)
    parser.add_argument("--shard-dir", type=Path, help="Read all *.json shard manifests from this directory")
    parser.add_argument("--shard-plan", type=Path, help="Optional signed plan to bind to the shard manifests")
    parser.add_argument(
        "--production",
        action="store_true",
        help=f"Require the bounded production-v2 scope of exactly {PRODUCTION_INPUT_COUNT} inputs",
    )
    parser.add_argument(
        "--expected-input-count",
        type=int,
        help="Optional exact input count for a local synthetic/canary verification",
    )
    args = parser.parse_args(argv)
    if args.production and args.expected_input_count not in (None, PRODUCTION_INPUT_COUNT):
        parser.error(f"--production requires --expected-input-count {PRODUCTION_INPUT_COUNT} when specified")
    if args.expected_input_count is not None and args.expected_input_count < 1:
        parser.error("--expected-input-count must be at least one")

    expected_input_count = PRODUCTION_INPUT_COUNT if args.production else args.expected_input_count
    report = verify_run_manifests(
        load_manifest(args.base_manifest),
        [load_manifest(path) for path in _shard_paths(args)],
        expected_input_count=expected_input_count,
        shard_plan=load_manifest(args.shard_plan) if args.shard_plan is not None else None,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
