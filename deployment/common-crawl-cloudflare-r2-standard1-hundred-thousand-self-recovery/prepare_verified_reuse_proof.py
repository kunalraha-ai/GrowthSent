#!/usr/bin/env python3
"""Prove the verified 11,000-WAT prefix may be excluded from a future run.

This program is deliberately local-only.  It turns the already-produced,
secret-free verification artifacts into one compact proof that the final
campaign builder can bind to.  It does not contact R2 or Cloudflare.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Mapping, Sequence


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_v2_manifest as manifest  # noqa: E402


CRAWL = "CC-MAIN-2026-30"
SOURCE_TASK_COUNT = 100_000
REUSED_PREFIX_COUNT = 11_000
FIRST_TEN_THOUSAND = 10_000
SHARD_TEN_COUNT = 1_000
SHA256_RE = __import__("re").compile(r"[0-9a-f]{64}\Z")


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def document_sha256(document: Mapping[str, Any], field: str) -> str:
    payload = dict(document)
    payload.pop(field, None)
    return hashlib.sha256(canonical_json(payload).rstrip(b"\n")).hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise SystemExit(f"missing {label}: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{label} must contain a JSON object: {path}")
    return value


def integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise SystemExit(f"{label} must be an integer at least {minimum}")
    return value


def sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise SystemExit(f"{label} must be a lowercase SHA-256 digest")
    return value


def nested_integer(document: Mapping[str, Any], names: Sequence[str], label: str) -> int:
    for name in names:
        value = document.get(name)
        if isinstance(value, int) and not isinstance(value, bool):
            return integer(value, label)
    inventory = document.get("inventory")
    if isinstance(inventory, dict):
        for name in names:
            value = inventory.get(name)
            if isinstance(value, int) and not isinstance(value, bool):
                return integer(value, label)
    raise SystemExit(f"{label} is missing from the supplied immutable artifact")


def artifact_reference(path: Path, document: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "path": str(path),
        "file_sha256": sha256_file(path),
        "kind": document.get("kind"),
        "run_id": document.get("run_id"),
    }


def require_empty_output(path: Path) -> None:
    if path.exists():
        raise SystemExit(f"proof output already exists and will not be overwritten: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)


def build_proof(
    *,
    source_manifest: Path,
    first_ten_thousand_manifest: Path,
    first_ten_thousand_aggregate_contract: Path,
    shard_ten_manifest: Path,
    shard_ten_recovery_contract: Path,
    shard_ten_recovery_context: Path,
    shard_ten_recovery_report: Path,
) -> dict[str, Any]:
    source = manifest.load_base_manifest(source_manifest, expected_input_count=SOURCE_TASK_COUNT)
    base = manifest.load_base_manifest(first_ten_thousand_manifest, expected_input_count=FIRST_TEN_THOUSAND)
    shard = manifest.load_shard_manifest(shard_ten_manifest, source, expected_input_count=SOURCE_TASK_COUNT)
    if source["crawl"] != CRAWL or base["crawl"] != CRAWL or shard["crawl"] != CRAWL:
        raise SystemExit("one supplied manifest is not the locked CC-MAIN-2026-30 input declaration")
    if source["inputs"][:FIRST_TEN_THOUSAND] != base["inputs"]:
        raise SystemExit("the verified 10,000-WAT base manifest is not the prefix of the supplied 100,000-WAT source manifest")
    if shard.get("shard_id") != 10 or shard.get("shard_count") != 100 or source["inputs"][FIRST_TEN_THOUSAND:REUSED_PREFIX_COUNT] != shard["inputs"]:
        raise SystemExit("the verified shard-10 manifest is not global source indexes 10,000 through 10,999")

    aggregate = read_json(first_ten_thousand_aggregate_contract, "10,000-WAT aggregate completion contract")
    aggregate_completed = nested_integer(
        aggregate,
        ("completed_task_count", "aggregate_unique_completed_source_count", "unique_completed_source_count"),
        "10,000-WAT aggregate completed count",
    )
    aggregate_incomplete = nested_integer(
        aggregate,
        ("incomplete_task_count", "remaining_task_count"),
        "10,000-WAT aggregate incomplete count",
    )
    if aggregate_completed != FIRST_TEN_THOUSAND or aggregate_incomplete != 0:
        raise SystemExit("the supplied aggregate contract does not prove all 10,000 base WATs completed")

    shard_contract = read_json(shard_ten_recovery_contract, "shard-10 partial recovery contract")
    original_completed = nested_integer(
        shard_contract,
        ("completed_source_count", "completion_marker_count"),
        "shard-10 original completed count",
    )
    recovered_count = nested_integer(
        shard_contract,
        ("recovery_task_count", "incomplete_task_count"),
        "shard-10 recovery task count",
    )
    if original_completed + recovered_count != SHARD_TEN_COUNT:
        raise SystemExit("the shard-10 recovery contract does not account for exactly 1,000 WATs")
    recovered_indexes = shard_contract.get("recovery_source_indexes")
    if not isinstance(recovered_indexes, list) or len(recovered_indexes) != recovered_count:
        raise SystemExit("the shard-10 recovery contract has an invalid recovery source-index inventory")
    if recovered_indexes != sorted(set(recovered_indexes)) or any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= SHARD_TEN_COUNT for index in recovered_indexes):
        raise SystemExit("the shard-10 recovery source-index inventory is not a unique local shard partition")
    claimed_recovered_digest = shard_contract.get("recovery_source_indexes_sha256")
    if claimed_recovered_digest is not None and claimed_recovered_digest != hashlib.sha256(canonical_json(recovered_indexes)).hexdigest():
        raise SystemExit("the shard-10 recovery source-index inventory digest is invalid")

    recovery_context = read_json(shard_ten_recovery_context, "shard-10 recovery context")
    recovery_report = read_json(shard_ten_recovery_report, "shard-10 recovery verification report")
    if integer(recovery_context.get("task_count"), "shard-10 recovery context task_count") != recovered_count:
        raise SystemExit("the shard-10 recovery context does not bind the expected recovery count")
    if recovery_context.get("run_id") != recovery_report.get("run_id"):
        raise SystemExit("the shard-10 recovery context and verification report refer to different runs")
    if integer(recovery_report.get("task_count"), "shard-10 recovery verification report task_count") != recovered_count:
        raise SystemExit("the shard-10 verification report does not cover the full recovery set")
    if recovery_report.get("passed") is False or recovery_report.get("status") == "failed":
        raise SystemExit("the shard-10 recovery verification report is not a success proof")
    errors = recovery_report.get("errors")
    if isinstance(errors, list) and errors:
        raise SystemExit("the shard-10 recovery verification report contains validation errors")

    proof: dict[str, Any] = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-verified-reuse-proof-v1",
        "crawl": CRAWL,
        "source_manifest": {
            "path": str(source_manifest),
            "file_sha256": sha256_file(source_manifest),
            "claim_sha256": sha256(source["manifest_sha256"], "100,000-WAT source manifest claim_sha256"),
            "inputs_sha256": sha256(source["inputs_sha256"], "100,000-WAT source manifest inputs_sha256"),
            "input_count": SOURCE_TASK_COUNT,
        },
        "completed_source_index_ranges": [{"start": 0, "end_exclusive": REUSED_PREFIX_COUNT}],
        "completed_source_count": REUSED_PREFIX_COUNT,
        "remaining_source_index_ranges": [{"start": REUSED_PREFIX_COUNT, "end_exclusive": SOURCE_TASK_COUNT}],
        "remaining_source_count": SOURCE_TASK_COUNT - REUSED_PREFIX_COUNT,
        "evidence": {
            "first_ten_thousand_manifest": artifact_reference(first_ten_thousand_manifest, base),
            "first_ten_thousand_aggregate_contract": artifact_reference(first_ten_thousand_aggregate_contract, aggregate),
            "shard_ten_manifest": artifact_reference(shard_ten_manifest, shard),
            "shard_ten_recovery_contract": artifact_reference(shard_ten_recovery_contract, shard_contract),
            "shard_ten_recovery_context": artifact_reference(shard_ten_recovery_context, recovery_context),
            "shard_ten_recovery_report": artifact_reference(shard_ten_recovery_report, recovery_report),
        },
        "remote_start": "disabled; this proof only authorizes local construction of a disjoint 89,000-WAT campaign",
    }
    proof["proof_sha256"] = document_sha256(proof, "proof_sha256")
    return proof


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--first-ten-thousand-manifest", required=True, type=Path)
    parser.add_argument("--first-ten-thousand-aggregate-contract", required=True, type=Path)
    parser.add_argument("--shard-ten-manifest", required=True, type=Path)
    parser.add_argument("--shard-ten-recovery-contract", required=True, type=Path)
    parser.add_argument("--shard-ten-recovery-context", required=True, type=Path)
    parser.add_argument("--shard-ten-recovery-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    require_empty_output(args.output)
    proof = build_proof(
        source_manifest=args.source_manifest,
        first_ten_thousand_manifest=args.first_ten_thousand_manifest,
        first_ten_thousand_aggregate_contract=args.first_ten_thousand_aggregate_contract,
        shard_ten_manifest=args.shard_ten_manifest,
        shard_ten_recovery_contract=args.shard_ten_recovery_contract,
        shard_ten_recovery_context=args.shard_ten_recovery_context,
        shard_ten_recovery_report=args.shard_ten_recovery_report,
    )
    args.output.write_bytes(canonical_json(proof))
    print(json.dumps({
        "status": "verified_reuse_proof_prepared",
        "proof": str(args.output),
        "proof_sha256": proof["proof_sha256"],
        "completed_source_count": proof["completed_source_count"],
        "remaining_source_count": proof["remaining_source_count"],
        "remote_start": proof["remote_start"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
