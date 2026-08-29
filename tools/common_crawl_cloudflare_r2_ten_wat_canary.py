#!/usr/bin/env python3
"""Bounded sequential ten-WAT HTTPS-to-R2 Cloudflare Container canary.

This runner is deliberately separate from the GCP Batch implementation.  It
accepts only a checked-in copy of the immutable audit manifest, processes its
exact ten Common Crawl WAT keys sequentially over public HTTPS, and publishes
only to a fresh Cloudflare-specific canary prefix.  A failed semantic check
occurs before the affected WAT writes any payload to R2.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import shutil
import time as clock
from typing import Any, Callable, Iterable, Mapping

import common_crawl_gcp_r2_25k_contract as contract
import common_crawl_http_source as http_source
import common_crawl_r2_store as r2
import common_crawl_semantic_contract_v2 as semantic
import common_crawl_wat_ingest_gcp_25k as raw


CANARY_ROOT = "production/common-crawl/cloudflare-r2-canaries/v1"
CANARY_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
REFERENCE_ENTRY_COUNT = 10


class TenWatCanaryError(RuntimeError):
    """The bounded Cloudflare ten-WAT canary cannot safely continue."""


@dataclass(frozen=True)
class ReferenceEntry:
    source_key: str
    pages_count: int
    links_count: int
    malformed_count: int
    deterministic_suffix: str
    canonical_pages_digest: str
    canonical_links_digest: str
    canonical_record_digest: str
    target_host_bucket_digest: str


def _required_entry_value(entry: Mapping[str, Any], label: str, *names: str) -> Any:
    for name in names:
        value = entry.get(name)
        if value is not None:
            return value
    raise TenWatCanaryError(f"audit manifest entry lacks {label}")


def _positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TenWatCanaryError(f"audit manifest {label} must be a non-negative integer")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise TenWatCanaryError(f"audit manifest {label} must be lowercase SHA-256")
    return value


def _reported_count(report: Mapping[str, Any], field: str) -> int:
    """Read a non-negative parser count without treating zero as absent."""

    value = report.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return -1
    return value


def _reference_entries(document: Mapping[str, Any]) -> list[ReferenceEntry]:
    try:
        semantic.require_manifest_contract(document)
    except semantic.SemanticContractError as error:
        raise TenWatCanaryError(str(error)) from error
    raw_entries = document.get("entries")
    if not isinstance(raw_entries, list) or len(raw_entries) != REFERENCE_ENTRY_COUNT:
        raise TenWatCanaryError("audit manifest must contain exactly ten entries")
    if document.get("entry_count") not in {None, REFERENCE_ENTRY_COUNT}:
        raise TenWatCanaryError("audit manifest entry_count does not equal ten")
    if document.get("crawl") not in {None, contract.CRAWL}:
        raise TenWatCanaryError("audit manifest crawl does not match the approved canary crawl")

    entries: list[ReferenceEntry] = []
    seen_sources: set[str] = set()
    seen_suffixes: set[str] = set()
    for value in raw_entries:
        if not isinstance(value, Mapping):
            raise TenWatCanaryError("audit manifest entry is not an object")
        source = _required_entry_value(value, "source key", "source_key", "source", "input")
        if not isinstance(source, str):
            raise TenWatCanaryError("audit manifest source key must be text")
        source = http_source.validate_common_crawl_key(source, crawl=contract.CRAWL)
        suffix = _required_entry_value(value, "deterministic suffix", "deterministic_suffix", "part_suffix", "suffix")
        if not isinstance(suffix, str) or not re.fullmatch(r"[0-9a-f]{16}", suffix):
            raise TenWatCanaryError("audit manifest deterministic suffix must be 16 lowercase hex characters")
        if suffix != contract.part_suffix(source):
            raise TenWatCanaryError("audit manifest deterministic suffix does not match its source key")
        target_host_bucket = value.get("target_host_bucket")
        target_host_bucket_digest = (
            target_host_bucket.get("target_host_bucket_digest")
            if isinstance(target_host_bucket, Mapping)
            else _required_entry_value(value, "target host bucket digest", "target_host_bucket_digest")
        )
        entry = ReferenceEntry(
            source_key=source,
            pages_count=_positive_int(_required_entry_value(value, "pages count", "pages_count", "pages", "pages_emitted"), "pages count"),
            links_count=_positive_int(_required_entry_value(value, "links count", "links_count", "links", "links_emitted"), "links count"),
            malformed_count=_positive_int(_required_entry_value(value, "malformed count", "malformed_count", "malformed_records"), "malformed count"),
            deterministic_suffix=suffix,
            canonical_pages_digest=_digest(_required_entry_value(value, "canonical Pages digest", "canonical_pages_digest"), "canonical Pages digest"),
            canonical_links_digest=_digest(_required_entry_value(value, "canonical Links digest", "canonical_links_digest"), "canonical Links digest"),
            canonical_record_digest=_digest(_required_entry_value(value, "canonical record digest", "canonical_record_digest"), "canonical record digest"),
            target_host_bucket_digest=_digest(target_host_bucket_digest, "target host bucket digest"),
        )
        if entry.source_key in seen_sources or entry.deterministic_suffix in seen_suffixes:
            raise TenWatCanaryError("audit manifest contains duplicate source keys or suffixes")
        seen_sources.add(entry.source_key)
        seen_suffixes.add(entry.deterministic_suffix)
        entries.append(entry)
    return entries


def load_reference_manifest(path: Path, *, expected_sha256: str) -> tuple[dict[str, Any], list[ReferenceEntry]]:
    if not SHA256_RE.fullmatch(expected_sha256):
        raise TenWatCanaryError("configured audit manifest SHA-256 is invalid")
    if not path.is_file():
        raise TenWatCanaryError("embedded audit manifest is missing")
    if r2.sha256_file(path) != expected_sha256:
        raise TenWatCanaryError("embedded audit manifest SHA-256 differs from the approved R2 object")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TenWatCanaryError("embedded audit manifest is not valid UTF-8 JSON") from error
    if not isinstance(document, dict):
        raise TenWatCanaryError("embedded audit manifest must be a JSON object")
    return document, _reference_entries(document)


def _output_key(prefix: str, dataset: str, source: str) -> str:
    if dataset not in {"pages", "links", "metrics"}:
        raise TenWatCanaryError("unsupported canary dataset")
    suffix = contract.part_suffix(source)
    extension = "json" if dataset == "metrics" else "parquet"
    return r2.normalize_key(prefix, f"crawl={contract.CRAWL}", f"dataset={dataset}", f"part-{suffix}.{extension}")


def _wat_completion_key(prefix: str, source: str) -> str:
    return r2.normalize_key(prefix, "control", "wats", f"part-{contract.part_suffix(source)}", "WAT-COMPLETED.json")


def _verify_semantics(entry: ReferenceEntry, report: Mapping[str, Any], output_dir: Path) -> dict[str, Any]:
    checks = {
        "pages_count": _reported_count(report, "pages_emitted") == entry.pages_count,
        "links_count": _reported_count(report, "links_emitted") == entry.links_count,
        "malformed_count": _reported_count(report, "malformed_records") == entry.malformed_count,
        "deterministic_suffix": contract.part_suffix(entry.source_key) == entry.deterministic_suffix,
    }
    if not all(checks.values()):
        failed = ", ".join(name for name, passed in checks.items() if not passed)
        raise TenWatCanaryError(f"semantic count/suffix verification failed: {failed}")
    paths = {dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, entry.source_key)}
    actual = semantic.artifact_semantic_digests(pages_path=paths["pages"], links_path=paths["links"])
    expected = {
        "canonical_pages_digest": entry.canonical_pages_digest,
        "canonical_links_digest": entry.canonical_links_digest,
        "canonical_record_digest": entry.canonical_record_digest,
        "target_host_bucket_digest": entry.target_host_bucket_digest,
    }
    observed = {
        "canonical_pages_digest": actual.canonical_pages_digest,
        "canonical_links_digest": actual.canonical_links_digest,
        "canonical_record_digest": actual.canonical_record_digest,
        "target_host_bucket_digest": actual.target_host_bucket_digest,
    }
    mismatches = [name for name, expected_value in expected.items() if observed[name] != expected_value]
    if actual.pages_count != entry.pages_count or actual.links_count != entry.links_count:
        mismatches.append("artifact_record_counts")
    if mismatches:
        raise TenWatCanaryError(f"semantic v2 verification failed: {', '.join(mismatches)}")
    return {
        "passed": True,
        "semantic_contract": semantic.CONTRACT_ID,
        "pages_count": entry.pages_count,
        "links_count": entry.links_count,
        "malformed_count": entry.malformed_count,
        "deterministic_suffix": entry.deterministic_suffix,
        "canonical_pages_digest": entry.canonical_pages_digest,
        "canonical_pages_digest_algorithm": semantic.manifest_contract()["dataset_digest"],
        "canonical_pages_digest_match": True,
        "canonical_links_digest": entry.canonical_links_digest,
        "canonical_links_digest_algorithm": semantic.manifest_contract()["dataset_digest"],
        "canonical_links_digest_match": True,
        "canonical_record_digest": entry.canonical_record_digest,
        "canonical_record_digest_algorithm": semantic.manifest_contract()["record_digest"],
        "target_host_bucket_digest": entry.target_host_bucket_digest,
        "target_host_bucket_digest_algorithm": semantic.manifest_contract()["target_host_bucket_digest"],
    }


def _verify_existing_wat_completion(store: r2.R2Store, prefix: str, entry: ReferenceEntry) -> dict[str, Any] | None:
    existing = store.read_json(_wat_completion_key(prefix, entry.source_key))
    if existing is None:
        return None
    completion, _etag = existing
    if completion.get("source_key") != entry.source_key or completion.get("deterministic_suffix") != entry.deterministic_suffix:
        raise TenWatCanaryError("existing per-WAT completion marker conflicts with the requested audit input")
    verification = completion.get("semantic_verification")
    if not isinstance(verification, Mapping) or verification.get("passed") is not True or verification.get("semantic_contract") != semantic.CONTRACT_ID:
        raise TenWatCanaryError("existing per-WAT completion lacks a passing semantic verification")
    artifacts = completion.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 3:
        raise TenWatCanaryError("existing per-WAT completion lacks the Pages/Links/Metrics artifact contract")
    for artifact in artifacts:
        if not isinstance(artifact, Mapping):
            raise TenWatCanaryError("existing per-WAT artifact contract is malformed")
        key = artifact.get("key")
        bytes_count = artifact.get("bytes")
        sha256 = artifact.get("sha256")
        if not isinstance(key, str) or not isinstance(bytes_count, int) or not isinstance(sha256, str):
            raise TenWatCanaryError("existing per-WAT artifact contract is incomplete")
        if not store.verify(key, bytes_count=bytes_count, sha256=sha256):
            raise TenWatCanaryError("existing per-WAT completion refers to a missing or conflicting immutable object")
    return completion


def _remove_local_artifacts(output_dir: Path, source: str) -> None:
    for _dataset, path, _content_type in raw.artifact_paths(output_dir, source):
        path.unlink(missing_ok=True)


def _run_one(entry: ReferenceEntry, *, canary_id: str, prefix: str, output_dir: Path, store: r2.R2Store, release_sha256: str) -> dict[str, Any]:
    existing = _verify_existing_wat_completion(store, prefix, entry)
    if existing is not None:
        return {"source_key": entry.source_key, "reused": True, **existing}

    report = raw._write_one(
        entry.source_key,
        output_dir,
        source_reader=http_source.CommonCrawlHttpSource(crawl=contract.CRAWL, max_attempts=http_source.DEFAULT_MAX_ATTEMPTS),
        batch_size=50_000,
        artifact_key=lambda dataset, source: _output_key(prefix, dataset, source),
        run_id=f"cloudflare-r2-ten-wat-canary-{canary_id}",
        source_max_attempts=http_source.DEFAULT_MAX_ATTEMPTS,
    )
    semantic_verification = _verify_semantics(entry, report, output_dir)
    report["semantic_verification"] = semantic_verification
    report["canary_id"] = canary_id
    report["release_sha256"] = release_sha256

    local_paths = {dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, entry.source_key)}
    artifacts: list[dict[str, Any]] = []
    for dataset in ("pages", "links"):
        result = store.upload_immutable_file(
            _output_key(prefix, dataset, entry.source_key),
            local_paths[dataset],
            content_type="application/vnd.apache.parquet",
        )
        artifacts.append({"dataset": dataset, **result})
    metrics_result = store.upload_immutable_json(_output_key(prefix, "metrics", entry.source_key), report)
    artifacts.append({"dataset": "metrics", **metrics_result})
    for artifact in artifacts:
        if not store.verify(str(artifact["key"]), bytes_count=int(artifact["bytes"]), sha256=str(artifact["sha256"])):
            raise TenWatCanaryError("per-WAT immutable artifact failed post-upload verification")

    completion = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-ten-wat-wat-completed",
        "canary_id": canary_id,
        "source_key": entry.source_key,
        "deterministic_suffix": entry.deterministic_suffix,
        "source_url": report["source_transport"]["source_url"],
        "source_transport": report["source_transport"],
        "processing_runtime_seconds": report.get("runtime_seconds"),
        "semantic_verification": semantic_verification,
        "artifacts": artifacts,
        "release_sha256": release_sha256,
    }
    # Per-WAT completion is written only after its three immutable payloads.
    store.upload_immutable_json(_wat_completion_key(prefix, entry.source_key), completion)
    _remove_local_artifacts(output_dir, entry.source_key)
    return {"source_key": entry.source_key, "reused": False, **completion}


def _run_input_manifest(canary_id: str, reference_sha256: str, entries: Iterable[ReferenceEntry], release_sha256: str) -> dict[str, Any]:
    values = list(entries)
    return {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-ten-wat-input-manifest",
        "canary_id": canary_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_sha256,
        "semantic_contract": semantic.manifest_contract(),
        "input_count": len(values),
        "inputs": [
            {
                "source_key": entry.source_key,
                "deterministic_suffix": entry.deterministic_suffix,
                "canonical_record_digest": entry.canonical_record_digest,
                "target_host_bucket_digest": entry.target_host_bucket_digest,
            }
            for entry in values
        ],
        "release_sha256": release_sha256,
    }


def run_ten(
    *,
    canary_id: str,
    output_dir: Path,
    reference_manifest: Path,
    reference_manifest_sha256: str,
    release_sha256: str,
    store: r2.R2Store,
    runtime_metadata: Callable[[], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    if not CANARY_ID_RE.fullmatch(canary_id):
        raise TenWatCanaryError("canary ID must be a short lowercase slug")
    if not SHA256_RE.fullmatch(release_sha256):
        raise TenWatCanaryError("release SHA-256 must be lowercase hex")
    prefix = r2.normalize_key(CANARY_ROOT, canary_id)
    if tuple(store.allowed_prefixes) != (r2.normalize_prefix(prefix),):
        raise TenWatCanaryError("canary R2 credential/store must be restricted to exactly one isolated canary prefix")
    document, entries = load_reference_manifest(reference_manifest, expected_sha256=reference_manifest_sha256)
    del document

    final_key = r2.normalize_key(prefix, "CANARY-COMPLETED.json")
    existing = store.read_json(final_key)
    if existing is not None:
        completion, _etag = existing
        if completion.get("canary_id") == canary_id and completion.get("reference_manifest_sha256") == reference_manifest_sha256:
            return {"completed": True, "reused": True, **completion}
        raise TenWatCanaryError("existing canary completion marker conflicts with this run identity")
    if store.list_keys(prefix):
        raise TenWatCanaryError("fresh canary prefix is unexpectedly non-empty")

    output_dir.mkdir(parents=True, exist_ok=True)
    input_manifest = _run_input_manifest(canary_id, reference_manifest_sha256, entries, release_sha256)
    input_manifest_result = store.upload_immutable_json(r2.normalize_key(prefix, "CANARY-INPUT-MANIFEST.json"), input_manifest)

    started_at = r2.utc_timestamp()
    started = clock.monotonic()
    outcomes: list[dict[str, Any]] = []
    try:
        for entry in entries:
            outcomes.append(_run_one(entry, canary_id=canary_id, prefix=prefix, output_dir=output_dir, store=store, release_sha256=release_sha256))
    finally:
        # Only local, ephemeral files are removed here. No cloud completion is
        # written on a failed/interrupted run.
        shutil.rmtree(output_dir, ignore_errors=True)

    aggregate = {
        "source_bytes": sum(int(outcome.get("source_transport", {}).get("downloaded_bytes") or 0) for outcome in outcomes),
        "source_retries": sum(int(outcome.get("source_transport", {}).get("retries") or 0) for outcome in outcomes),
        "pages_count": sum(int(outcome.get("semantic_verification", {}).get("pages_count") or 0) for outcome in outcomes),
        "links_count": sum(int(outcome.get("semantic_verification", {}).get("links_count") or 0) for outcome in outcomes),
        "malformed_count": sum(int(outcome.get("semantic_verification", {}).get("malformed_count") or 0) for outcome in outcomes),
        "r2_payload_bytes": sum(sum(int(item.get("bytes") or 0) for item in outcome.get("artifacts", [])) for outcome in outcomes),
    }
    summary = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-ten-wat-summary",
        "canary_id": canary_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_manifest_sha256,
        "semantic_contract": semantic.manifest_contract(),
        "release_sha256": release_sha256,
        "started_at": started_at,
        "finished_at": r2.utc_timestamp(),
        "wall_seconds": round(clock.monotonic() - started, 3),
        "input_count": len(entries),
        "outcomes": outcomes,
        "aggregate": aggregate,
        "input_manifest": input_manifest_result,
        "container_runtime": dict(runtime_metadata()) if runtime_metadata is not None else None,
    }
    summary_result = store.upload_immutable_json(r2.normalize_key(prefix, "CANARY-SUMMARY.json"), summary)
    completion = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-ten-wat-completed",
        "canary_id": canary_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_manifest_sha256,
        "semantic_contract": semantic.manifest_contract(),
        "release_sha256": release_sha256,
        "input_count": len(entries),
        "summary": summary_result,
        "aggregate": aggregate,
        "container_runtime": summary["container_runtime"],
    }
    # Completion-marker-last. There are no R2 writes below this line.
    completion_result = store.upload_immutable_json(final_key, completion)
    return {"completed": True, "reused": False, "completion": completion_result, **completion}
