#!/usr/bin/env python3
"""Run one immutable 1,000-input GCP/R2 raw shard for the next 25K window.

This sibling preserves the proven WAT parser and output schemas but is isolated
from the completed AWS 10K runner. It reads only Common Crawl's official HTTPS
endpoint and writes GrowthSent payload/control objects only through the R2
store contract.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import shutil
import time
from typing import Any, Mapping

import common_crawl_gcp_r2_25k_contract as contract_tools
import common_crawl_http_source as http_source
import common_crawl_r2_store as r2
import common_crawl_wat_ingest as parser


MAX_WORKERS = 4
MIN_LEASE_SECONDS = 300
MAX_LEASE_SECONDS = 7_200


class GcpRawIngestError(RuntimeError):
    """A GCP/R2 raw shard cannot safely continue."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_timestamp(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise GcpRawIngestError("lease timestamp is invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise GcpRawIngestError("lease timestamp lacks a timezone")
    return parsed.astimezone(timezone.utc)


def artifact_paths(output_root: Path, source: str) -> list[tuple[str, Path, str]]:
    suffix = contract_tools.part_suffix(source)
    root = output_root / f"crawl={contract_tools.CRAWL}"
    return [
        ("pages", root / "dataset=pages" / f"part-{suffix}.parquet", "application/vnd.apache.parquet"),
        ("links", root / "dataset=links" / f"part-{suffix}.parquet", "application/vnd.apache.parquet"),
        ("metrics", root / "dataset=metrics" / f"part-{suffix}.json", "application/json"),
    ]


def _artifact_key(dataset: str, source: str) -> str:
    return contract_tools.raw_part_key(dataset, source)


def _read_completed_metric(store: r2.R2Store, source: str) -> dict[str, Any] | None:
    metric_key = _artifact_key("metrics", source)
    existing = store.read_json(metric_key)
    if existing is None:
        return None
    report, _etag = existing
    if report.get("input") != source or report.get("run_id") != contract_tools.RUN_ID:
        raise GcpRawIngestError("existing metrics object belongs to a different immutable raw input")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 2:
        raise GcpRawIngestError("existing metrics object lacks an immutable Pages/Links artifact contract")
    seen: set[str] = set()
    for entry in artifacts:
        if not isinstance(entry, Mapping):
            raise GcpRawIngestError("existing raw artifact contract is invalid")
        dataset = entry.get("dataset")
        if dataset not in {"pages", "links"} or dataset in seen:
            raise GcpRawIngestError("existing raw artifact contract has duplicate or invalid datasets")
        seen.add(dataset)
        if entry.get("key") != _artifact_key(str(dataset), source):
            raise GcpRawIngestError("existing raw artifact key is outside the deterministic contract")
        if not store.verify(str(entry["key"]), bytes_count=int(entry["bytes"]), sha256=str(entry["sha256"])):
            raise GcpRawIngestError("existing raw metrics refer to a missing immutable artifact")
    return report


def _write_one(
    source: str,
    output_root: Path,
    *,
    source_reader: http_source.CommonCrawlHttpSource,
    batch_size: int,
    artifact_key: Any = _artifact_key,
    run_id: str = contract_tools.RUN_ID,
    source_max_attempts: int = http_source.DEFAULT_MAX_ATTEMPTS,
) -> dict[str, Any]:
    """Use the proven parser/writers with a streaming HTTP transport only."""

    if source_max_attempts < 1 or source_max_attempts > http_source.DEFAULT_MAX_ATTEMPTS:
        raise GcpRawIngestError("source retry budget is outside the approved 1..8 range")
    started = time.monotonic()
    paths = {dataset: path for dataset, path, _ in artifact_paths(output_root, source)}
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
    pages_tmp = paths["pages"].with_suffix(".parquet.tmp")
    links_tmp = paths["links"].with_suffix(".parquet.tmp")
    for temporary in (pages_tmp, links_tmp):
        temporary.unlink(missing_ok=True)
    telemetry_history: list[dict[str, Any]] = []
    metrics: parser.Metrics | None = None
    for attempt in range(source_max_attempts):
        metrics = parser.Metrics(input=source)
        pages = parser.BufferedParquetWriter(pages_tmp, parser.PAGES_SCHEMA, batch_size)
        links = parser.BufferedParquetWriter(links_tmp, parser.LINKS_SCHEMA, batch_size)
        source_metrics: http_source.SourceTelemetry | None = None
        try:
            # Keep a full-WAT retry budget bounded at eight. Open-level HTTP
            # retries and mid-stream gzip/socket recovery share this budget,
            # avoiding a hidden multiplicative retry storm.
            with source_reader.open_gzip(source, max_attempts=1) as (stream, source_metrics):
                for record in parser.iter_wat_json(stream, metrics):
                    rows = parser.rows_from_record(record, contract_tools.CRAWL, metrics)
                    if rows is None:
                        continue
                    page, page_links = rows
                    pages.add(page)
                    metrics.pages_emitted += 1
                    for link in page_links:
                        links.add(link)
                        metrics.links_emitted += 1
            pages.close()
            links.close()
            pages_tmp.replace(paths["pages"])
            links_tmp.replace(paths["links"])
            telemetry = source_metrics.report() if source_metrics is not None else {}
            telemetry.update({"processing_attempts": attempt + 1, "processing_retries": attempt})
            telemetry["prior_attempts"] = telemetry_history
            metrics.input_bytes = int(telemetry.get("downloaded_bytes", 0))
            break
        except Exception as error:
            pages.writer.close()
            links.writer.close()
            pages_tmp.unlink(missing_ok=True)
            links_tmp.unlink(missing_ok=True)
            captured = source_metrics.report() if source_metrics is not None else getattr(error, "telemetry", None)
            if isinstance(captured, http_source.SourceTelemetry):
                captured = captured.report()
            if isinstance(captured, Mapping):
                telemetry_history.append(dict(captured))
            if not http_source.is_retryable_error(error) or attempt == source_max_attempts - 1:
                metrics.failures.append(f"{type(error).__name__}: {error}")
                raise
            source_reader.sleep_before_retry(attempt)
    else:  # pragma: no cover - loop always returns or raises
        raise AssertionError("bounded source processing loop must finish or fail")
    assert metrics is not None
    metrics.runtime_seconds = round(time.monotonic() - started, 3)
    metrics.output_bytes = paths["pages"].stat().st_size + paths["links"].stat().st_size
    report = metrics.report()
    report.update(
        {
            "format_version": 1,
            "run_id": run_id,
            "crawl": contract_tools.CRAWL,
            "source_transport": telemetry,
            "artifacts": [
                {
                    "dataset": dataset,
                    "key": artifact_key(dataset, source),
                    "bytes": path.stat().st_size,
                    "sha256": r2.sha256_file(path),
                }
                for dataset, path, _content_type in artifact_paths(output_root, source)
                if dataset in {"pages", "links"}
            ],
        }
    )
    paths["metrics"].write_bytes(r2.canonical_json(report))
    return report


def _publish_one(store: r2.R2Store, output_root: Path, source: str) -> dict[str, int]:
    uploaded = reused = 0
    for dataset, path, content_type in artifact_paths(output_root, source):
        if dataset == "metrics":
            continue
        result = store.upload_immutable_file(_artifact_key(dataset, source), path, content_type=content_type)
        if result["reused"]:
            reused += 1
        else:
            uploaded += 1
    metric_path = dict((dataset, path) for dataset, path, _ in artifact_paths(output_root, source))["metrics"]
    document = json.loads(metric_path.read_text(encoding="utf-8"))
    result = store.upload_immutable_json(_artifact_key("metrics", source), document)
    if result["reused"]:
        reused += 1
    else:
        uploaded += 1
    verified = _read_completed_metric(store, source)
    if verified is None:
        raise GcpRawIngestError("published raw triplet could not be recovered after verification")
    return {"uploaded": uploaded, "reused": reused}


@dataclass
class ShardLease:
    store: r2.R2Store
    key: str
    payload: dict[str, Any]
    etag: str | None
    seconds: int
    last_refresh: datetime

    def refresh(self) -> None:
        now = utc_now()
        value = dict(self.payload)
        value.update({"state": "running", "updated_at": utc_timestamp(now), "expires_at": utc_timestamp(now + timedelta(seconds=self.seconds))})
        if not self.etag:
            raise GcpRawIngestError("cannot refresh a lease without an ETag")
        self.etag = self.store.put_json_conditional(self.key, value, if_match=self.etag)
        self.last_refresh = now

    def maybe_refresh(self) -> None:
        if utc_now() - self.last_refresh >= timedelta(seconds=max(60, self.seconds // 3)):
            self.refresh()

    def finalise(self, state: str) -> None:
        if state not in {"completed", "failed", "stopped"} or not self.etag:
            return
        value = dict(self.payload)
        value.update({"state": state, "updated_at": utc_timestamp(), "expires_at": None})
        self.etag = self.store.put_json_conditional(self.key, value, if_match=self.etag)


def acquire_lease(
    store: r2.R2Store,
    contract: contract_tools.ShardContract,
    *,
    owner: str,
    seconds: int,
    allow_expired_takeover: bool,
) -> ShardLease:
    if not owner or len(owner) > 256:
        raise GcpRawIngestError("lease owner must be a bounded non-empty job attempt identity")
    if not MIN_LEASE_SECONDS <= seconds <= MAX_LEASE_SECONDS:
        raise GcpRawIngestError("lease duration is outside the bounded raw-worker range")
    key = contract_tools.raw_control_key(contract.shard_id, "lease.json")
    base = contract.static_metadata()
    base.update({"owner": owner, "lease_seconds": seconds})
    now = utc_now()
    running = dict(base)
    running.update({"state": "running", "updated_at": utc_timestamp(now), "expires_at": utc_timestamp(now + timedelta(seconds=seconds))})
    existing = store.read_json(key)
    if existing is None:
        etag = store.put_json_conditional(key, running, if_none_match=True)
        return ShardLease(store, key, base, etag, seconds, now)
    document, etag = existing
    identity = contract.static_metadata()
    if any(document.get(name) != value for name, value in identity.items()):
        raise GcpRawIngestError("existing R2 shard lease belongs to a different immutable assignment")
    if document.get("state") == "completed":
        raise GcpRawIngestError("raw shard is already completed; refusing to acquire another lease")
    if document.get("state") == "running" and parse_timestamp(document.get("expires_at")) > now:
        raise GcpRawIngestError("raw shard is owned by an active worker")
    if not allow_expired_takeover:
        raise GcpRawIngestError("expired/stopped raw lease requires explicit recovery approval")
    if not etag:
        raise GcpRawIngestError("existing raw lease lacks an ETag fence")
    new_etag = store.put_json_conditional(key, running, if_match=etag)
    return ShardLease(store, key, base, new_etag, seconds, now)


def validate_setup(
    args: argparse.Namespace,
    store: r2.R2Store,
) -> contract_tools.ShardContract:
    contract = contract_tools.load_contract(args.base_manifest, args.shard_manifest, args.shard_plan, shard_id=args.shard_id)
    contract_tools.validate_job_identity(vars(args), contract, release_sha256=args.release_sha256)
    if args.workers < 1 or args.workers > MAX_WORKERS:
        raise GcpRawIngestError(f"workers must be between 1 and {MAX_WORKERS}")
    if args.batch_size < 1:
        raise GcpRawIngestError("batch size must be positive")
    # Put immutable global control objects first; they are all under the raw
    # prefix and must exactly match on every worker/retry.
    store.upload_immutable_json(contract_tools.normalized_key(contract_tools.RAW_PREFIX, "control", "base-manifest.json"), contract.base)
    store.upload_immutable_json(contract_tools.normalized_key(contract_tools.RAW_PREFIX, "control", "shard-plan.json"), contract.plan)
    return contract


def run_shard(args: argparse.Namespace, store: r2.R2Store, *, source_reader: http_source.CommonCrawlHttpSource | None = None) -> dict[str, Any]:
    contract = validate_setup(args, store)
    reader = source_reader or http_source.CommonCrawlHttpSource(
        crawl=contract_tools.CRAWL,
        timeout_seconds=args.source_timeout_seconds,
        max_attempts=args.source_max_attempts,
    )
    lease = acquire_lease(
        store,
        contract,
        owner=args.shard_lease_owner,
        seconds=args.shard_lease_seconds,
        allow_expired_takeover=args.allow_expired_lease_takeover,
    )
    control_prefix = contract_tools.raw_control_key(contract.shard_id, "input-manifest.json")
    store.upload_immutable_json(control_prefix, {**contract.static_metadata(), "inputs": list(contract.inputs), "release_sha256": args.release_sha256})
    started = time.monotonic()
    recovered: dict[str, dict[str, Any]] = {}
    pending: list[str] = []
    for source in contract.inputs:
        result = _read_completed_metric(store, source)
        if result is None:
            pending.append(source)
        else:
            recovered[source] = result
    reports: dict[str, dict[str, Any]] = dict(recovered)
    uploads = {"uploaded": 0, "reused": 0}
    lifecycle_key = contract_tools.raw_control_key(contract.shard_id, "lifecycle.json")
    try:
        store.put_json_conditional(lifecycle_key, {**contract.static_metadata(), "event": "running", "owner": args.shard_lease_owner, "updated_at": utc_timestamp()}, if_none_match=False)
        if args.workers == 1:
            iterator = ((source, _write_one(source, args.output_dir, source_reader=reader, batch_size=args.batch_size, source_max_attempts=args.source_max_attempts)) for source in pending)
            for source, report in iterator:
                lease.maybe_refresh()
                result = _publish_one(store, args.output_dir, source)
                uploads["uploaded"] += result["uploaded"]
                uploads["reused"] += result["reused"]
                reports[source] = report
        else:
            # Low bounded fan-out is intentional for Common Crawl HTTPS. Each
            # task still owns a unique deterministic Pages/Links/Metrics triplet.
            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = {
                    executor.submit(_write_one, source, args.output_dir, source_reader=reader, batch_size=args.batch_size, source_max_attempts=args.source_max_attempts): source
                    for source in pending
                }
                for future in as_completed(futures):
                    source = futures[future]
                    report = future.result()
                    lease.maybe_refresh()
                    result = _publish_one(store, args.output_dir, source)
                    uploads["uploaded"] += result["uploaded"]
                    uploads["reused"] += result["reused"]
                    reports[source] = report
        ordered = [reports[source] for source in contract.inputs]
        failures = [report for report in ordered if report.get("failures")]
        if failures:
            raise GcpRawIngestError("one or more raw inputs failed; completion marker will not be written")
        aggregate = parser.aggregate_metrics(ordered, time.monotonic() - started)
        summary = {
            **contract.static_metadata(),
            "release_sha256": args.release_sha256,
            "source_mode": "https://data.commoncrawl.org/",
            "workers": args.workers,
            "files_remote_recovered": len(recovered),
            "files_processed_this_attempt": len(pending),
            "uploads": uploads,
            "aggregate": aggregate,
            "inputs": ordered,
        }
        store.upload_immutable_json(contract_tools.raw_control_key(contract.shard_id, "run-summary.json"), summary)
        completion = {
            **contract.static_metadata(),
            "kind": "growthsent-gcp-r2-raw-shard-completed",
            "run_summary_sha256": r2.sha256_bytes(r2.canonical_json(summary)),
            "completed_at": utc_timestamp(),
        }
        # Completion-marker-last: no reader may treat the raw shard as usable
        # before every metrics/artifact/control verification above has passed.
        store.upload_immutable_json(contract_tools.raw_control_key(contract.shard_id, "RAW-SHARD-COMPLETED.json"), completion)
        # Do not mutate lifecycle/lease state after this point. The immutable
        # completion marker is intentionally the final R2 write for a
        # successful shard and has priority over an expired prior lease during
        # future resume checks.
        return summary
    except BaseException:
        try:
            lease.finalise("failed")
        finally:
            raise
    finally:
        # Scratch removal is optional and only safe after the completion
        # marker was published. Preserve failed-attempt evidence for a bounded
        # recovery diagnosis rather than deleting it in a finally block.
        if args.remove_uploaded_local and 'completion' in locals():
            shutil.rmtree(args.output_dir, ignore_errors=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser_args = argparse.ArgumentParser(description=__doc__)
    parser_args.add_argument("--base-manifest", type=Path, required=True)
    parser_args.add_argument("--shard-manifest", type=Path, required=True)
    parser_args.add_argument("--shard-plan", type=Path, required=True)
    parser_args.add_argument("--run-id", required=True)
    parser_args.add_argument("--crawl", required=True)
    parser_args.add_argument("--shard-id", type=int, required=True)
    parser_args.add_argument("--shard-count", type=int, required=True)
    parser_args.add_argument("--expected-input-count", type=int, required=True)
    parser_args.add_argument("--base-inputs-sha256", required=True)
    parser_args.add_argument("--base-manifest-sha256", required=True)
    parser_args.add_argument("--shard-inputs-sha256", required=True)
    parser_args.add_argument("--shard-manifest-sha256", required=True)
    parser_args.add_argument("--raw-prefix", required=True)
    parser_args.add_argument("--derived-prefix", required=True)
    parser_args.add_argument("--release-sha256", required=True)
    parser_args.add_argument("--shard-lease-owner", required=True)
    parser_args.add_argument("--shard-lease-seconds", type=int, default=3600)
    parser_args.add_argument("--allow-expired-lease-takeover", action="store_true")
    parser_args.add_argument("--workers", type=int, default=1, choices=range(1, MAX_WORKERS + 1))
    parser_args.add_argument("--batch-size", type=int, default=50_000)
    parser_args.add_argument("--source-timeout-seconds", type=int, default=120)
    parser_args.add_argument("--source-max-attempts", type=int, default=8)
    parser_args.add_argument("--output-dir", type=Path, required=True)
    parser_args.add_argument("--remove-uploaded-local", action="store_true")
    args = parser_args.parse_args(argv)
    if len(args.release_sha256) != 64 or any(character not in "0123456789abcdef" for character in args.release_sha256):
        parser_args.error("--release-sha256 must be lowercase SHA-256 hex")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = r2.R2Store.from_environment(allowed_prefixes=[contract_tools.RAW_PREFIX])
    print(json.dumps(run_shard(args, store), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
