#!/usr/bin/env python3
"""One-WAT, standard-1 Cloudflare Container benchmark runner.

This deliberately remains separate from the production ten-WAT canary.  It
selects exactly the first entry from the reviewed ten-WAT public-source
baseline, applies the identical parser and semantic-v2 checks, and writes only
under a new benchmark-specific R2 prefix.  It is intended to measure whether
the smaller ``standard-1`` Container shape has enough memory, disk, and time
for one representative WAT before any concurrency experiment is approved.
"""

from __future__ import annotations

import shutil
import time as clock
from pathlib import Path
from typing import Any, Callable, Mapping

import common_crawl_cloudflare_r2_ten_wat_canary as ten_wat
import common_crawl_gcp_r2_25k_contract as contract
import common_crawl_http_source as http_source
import common_crawl_r2_store as r2
import common_crawl_semantic_contract_v2 as semantic
import common_crawl_wat_ingest_gcp_25k as raw


BENCHMARK_ROOT = "production/common-crawl/cloudflare-r2-standard1-benchmarks/v1"
REFERENCE_ENTRY_INDEX = 0
INPUT_COUNT = 1


class Standard1BenchmarkError(RuntimeError):
    """The one-WAT standard-1 benchmark cannot safely continue."""


def _prefix(benchmark_id: str) -> str:
    if not ten_wat.CANARY_ID_RE.fullmatch(benchmark_id):
        raise Standard1BenchmarkError("benchmark ID must be a short lowercase slug")
    return r2.normalize_key(BENCHMARK_ROOT, benchmark_id)


def selected_reference_entry(
    reference_manifest: Path, *, expected_sha256: str
) -> ten_wat.ReferenceEntry:
    """Load the full reviewed baseline before selecting its fixed first WAT."""

    try:
        _document, entries = ten_wat.load_reference_manifest(
            reference_manifest, expected_sha256=expected_sha256
        )
    except ten_wat.TenWatCanaryError as error:
        raise Standard1BenchmarkError(str(error)) from error
    if len(entries) != ten_wat.REFERENCE_ENTRY_COUNT:
        raise Standard1BenchmarkError("reviewed reference baseline must contain exactly ten entries")
    try:
        return entries[REFERENCE_ENTRY_INDEX]
    except IndexError as error:  # Defensive: the length check above should make this unreachable.
        raise Standard1BenchmarkError("reviewed reference baseline has no benchmark entry") from error


def _input_manifest(
    *, benchmark_id: str, reference_manifest_sha256: str, entry: ten_wat.ReferenceEntry, release_sha256: str
) -> dict[str, Any]:
    return {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-one-wat-benchmark-input-manifest",
        "benchmark_id": benchmark_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_manifest_sha256,
        "reference_manifest_entry_count": ten_wat.REFERENCE_ENTRY_COUNT,
        "selected_reference_entry_index": REFERENCE_ENTRY_INDEX,
        "semantic_contract": semantic.manifest_contract(),
        "input_count": INPUT_COUNT,
        "inputs": [
            {
                "source_key": entry.source_key,
                "deterministic_suffix": entry.deterministic_suffix,
                "canonical_record_digest": entry.canonical_record_digest,
                "target_host_bucket_digest": entry.target_host_bucket_digest,
            }
        ],
        "release_sha256": release_sha256,
    }


def _aggregate(outcome: Mapping[str, Any]) -> dict[str, int]:
    return {
        "source_bytes": int(outcome.get("source_transport", {}).get("downloaded_bytes") or 0),
        "source_retries": int(outcome.get("source_transport", {}).get("retries") or 0),
        "pages_count": int(outcome.get("semantic_verification", {}).get("pages_count") or 0),
        "links_count": int(outcome.get("semantic_verification", {}).get("links_count") or 0),
        "malformed_count": int(outcome.get("semantic_verification", {}).get("malformed_count") or 0),
        "r2_payload_bytes": sum(int(item.get("bytes") or 0) for item in outcome.get("artifacts", [])),
    }


def _run_benchmark_wat(
    entry: ten_wat.ReferenceEntry,
    *,
    benchmark_id: str,
    prefix: str,
    output_dir: Path,
    store: r2.R2Store,
    release_sha256: str,
) -> dict[str, Any]:
    """Produce the normal per-WAT immutable artifact contract for this benchmark."""

    existing = ten_wat._verify_existing_wat_completion(store, prefix, entry)
    if existing is not None:
        return {"source_key": entry.source_key, "reused": True, **existing}
    report = raw._write_one(
        entry.source_key,
        output_dir,
        source_reader=http_source.CommonCrawlHttpSource(
            crawl=contract.CRAWL, max_attempts=http_source.DEFAULT_MAX_ATTEMPTS
        ),
        batch_size=50_000,
        artifact_key=lambda dataset, source: ten_wat._output_key(prefix, dataset, source),
        run_id=f"cloudflare-r2-standard1-benchmark-{benchmark_id}",
        source_max_attempts=http_source.DEFAULT_MAX_ATTEMPTS,
    )
    semantic_verification = ten_wat._verify_semantics(entry, report, output_dir)
    report["semantic_verification"] = semantic_verification
    report["benchmark_id"] = benchmark_id
    report["release_sha256"] = release_sha256

    local_paths = {
        dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, entry.source_key)
    }
    artifacts: list[dict[str, Any]] = []
    for dataset in ("pages", "links"):
        result = store.upload_immutable_file(
            ten_wat._output_key(prefix, dataset, entry.source_key),
            local_paths[dataset],
            content_type="application/vnd.apache.parquet",
        )
        artifacts.append({"dataset": dataset, **result})
    metrics_result = store.upload_immutable_json(
        ten_wat._output_key(prefix, "metrics", entry.source_key), report
    )
    artifacts.append({"dataset": "metrics", **metrics_result})
    for artifact in artifacts:
        if not store.verify(
            str(artifact["key"]), bytes_count=int(artifact["bytes"]), sha256=str(artifact["sha256"])
        ):
            raise Standard1BenchmarkError("per-WAT immutable artifact failed post-upload verification")

    completion = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-one-wat-benchmark-wat-completed",
        "benchmark_id": benchmark_id,
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
    store.upload_immutable_json(ten_wat._wat_completion_key(prefix, entry.source_key), completion)
    ten_wat._remove_local_artifacts(output_dir, entry.source_key)
    return {"source_key": entry.source_key, "reused": False, **completion}


def run_one_wat(
    *,
    benchmark_id: str,
    output_dir: Path,
    reference_manifest: Path,
    reference_manifest_sha256: str,
    release_sha256: str,
    store: r2.R2Store,
    runtime_metadata: Callable[[], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run one selected WAT with the same immutable artifact contract as the canary."""

    if not ten_wat.SHA256_RE.fullmatch(release_sha256):
        raise Standard1BenchmarkError("release SHA-256 must be lowercase hex")
    prefix = _prefix(benchmark_id)
    if tuple(store.allowed_prefixes) != (r2.normalize_prefix(prefix),):
        raise Standard1BenchmarkError(
            "benchmark R2 credential/store must be restricted to exactly one isolated benchmark prefix"
        )
    entry = selected_reference_entry(reference_manifest, expected_sha256=reference_manifest_sha256)

    final_key = r2.normalize_key(prefix, "BENCHMARK-COMPLETED.json")
    existing = store.read_json(final_key)
    if existing is not None:
        completion, _etag = existing
        if (
            completion.get("benchmark_id") == benchmark_id
            and completion.get("reference_manifest_sha256") == reference_manifest_sha256
            and completion.get("input_count") == INPUT_COUNT
        ):
            return {"completed": True, "reused": True, **completion}
        raise Standard1BenchmarkError("existing benchmark completion marker conflicts with this run identity")
    if store.list_keys(prefix):
        raise Standard1BenchmarkError("fresh benchmark prefix is unexpectedly non-empty")

    output_dir.mkdir(parents=True, exist_ok=True)
    input_result = store.upload_immutable_json(
        r2.normalize_key(prefix, "BENCHMARK-INPUT-MANIFEST.json"),
        _input_manifest(
            benchmark_id=benchmark_id,
            reference_manifest_sha256=reference_manifest_sha256,
            entry=entry,
            release_sha256=release_sha256,
        ),
    )
    started_at = r2.utc_timestamp()
    started = clock.monotonic()
    try:
        outcome = _run_benchmark_wat(
            entry,
            benchmark_id=benchmark_id,
            prefix=prefix,
            output_dir=output_dir,
            store=store,
            release_sha256=release_sha256,
        )
    finally:
        # This only removes local ephemeral artifacts.  It never removes R2 objects.
        shutil.rmtree(output_dir, ignore_errors=True)

    aggregate = _aggregate(outcome)
    summary = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-one-wat-benchmark-summary",
        "benchmark_id": benchmark_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_manifest_sha256,
        "reference_manifest_entry_count": ten_wat.REFERENCE_ENTRY_COUNT,
        "selected_reference_entry_index": REFERENCE_ENTRY_INDEX,
        "semantic_contract": semantic.manifest_contract(),
        "release_sha256": release_sha256,
        "started_at": started_at,
        "finished_at": r2.utc_timestamp(),
        "wall_seconds": round(clock.monotonic() - started, 3),
        "input_count": INPUT_COUNT,
        "outcomes": [outcome],
        "aggregate": aggregate,
        "input_manifest": input_result,
        "container_runtime": dict(runtime_metadata()) if runtime_metadata is not None else None,
    }
    summary_result = store.upload_immutable_json(r2.normalize_key(prefix, "BENCHMARK-SUMMARY.json"), summary)
    completion = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-one-wat-benchmark-completed",
        "benchmark_id": benchmark_id,
        "crawl": contract.CRAWL,
        "reference_manifest_sha256": reference_manifest_sha256,
        "reference_manifest_entry_count": ten_wat.REFERENCE_ENTRY_COUNT,
        "selected_reference_entry_index": REFERENCE_ENTRY_INDEX,
        "semantic_contract": semantic.manifest_contract(),
        "release_sha256": release_sha256,
        "input_count": INPUT_COUNT,
        "summary": summary_result,
        "aggregate": aggregate,
        "container_runtime": summary["container_runtime"],
    }
    # Completion-marker-last.  There are no R2 writes below this line.
    completion_result = store.upload_immutable_json(final_key, completion)
    return {"completed": True, "reused": False, "completion": completion_result, **completion}
