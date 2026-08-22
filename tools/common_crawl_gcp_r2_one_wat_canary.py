#!/usr/bin/env python3
"""Bounded one-WAT HTTPS-to-R2 canary; never targets production run prefixes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any

import common_crawl_gcp_r2_25k_contract as contract
import common_crawl_http_source as http_source
import common_crawl_r2_store as r2
import common_crawl_wat_ingest_gcp_25k as raw


CANARY_ROOT = "production/common-crawl/gcp-r2-canaries/v1"
CANARY_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


class OneWatCanaryError(RuntimeError):
    """A canary request is outside its one-input isolated contract."""


def _key(prefix: str, dataset: str, source: str) -> str:
    if dataset not in {"pages", "links", "metrics"}:
        raise OneWatCanaryError("unsupported canary dataset")
    suffix = contract.part_suffix(source)
    extension = "json" if dataset == "metrics" else "parquet"
    return r2.normalize_key(prefix, f"crawl={contract.CRAWL}", f"dataset={dataset}", f"part-{suffix}.{extension}")


def run_one(args: argparse.Namespace, store: r2.R2Store, reader: http_source.CommonCrawlHttpSource | None = None) -> dict[str, Any]:
    if not CANARY_ID_RE.fullmatch(args.canary_id):
        raise OneWatCanaryError("canary ID must be a short lowercase slug")
    source = http_source.validate_common_crawl_key(args.source_key, crawl=contract.CRAWL)
    prefix = r2.normalize_key(CANARY_ROOT, args.canary_id)
    if not all(value.startswith(prefix + "/") for value in store.allowed_prefixes):
        raise OneWatCanaryError("canary R2 credential/store must be restricted to this one isolated prefix")
    completion_key = r2.normalize_key(prefix, "CANARY-COMPLETED.json")
    existing = store.read_json(completion_key)
    if existing is not None:
        report, _etag = existing
        if report.get("source_key") == source and report.get("canary_id") == args.canary_id:
            return {"completed": True, "reused": True, **report}
        raise OneWatCanaryError("existing canary completion marker conflicts with requested input")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    source_reader = reader or http_source.CommonCrawlHttpSource(crawl=contract.CRAWL)
    report = raw._write_one(
        source,
        args.output_dir,
        source_reader=source_reader,
        batch_size=args.batch_size,
        artifact_key=lambda dataset, value: _key(prefix, dataset, value),
        run_id=f"gcp-r2-one-wat-canary-{args.canary_id}",
    )
    report["artifacts"] = []
    uploads = []
    paths = {dataset: path for dataset, path, _ in raw.artifact_paths(args.output_dir, source)}
    for dataset in ("pages", "links"):
        path = paths[dataset]
        key = _key(prefix, dataset, source)
        result = store.upload_immutable_file(key, path, content_type="application/vnd.apache.parquet")
        report["artifacts"].append({"dataset": dataset, "key": key, "bytes": result["bytes"], "sha256": result["sha256"]})
        uploads.append(result)
    metric_key = _key(prefix, "metrics", source)
    metric_result = store.upload_immutable_json(metric_key, report)
    uploads.append(metric_result)
    for entry in report["artifacts"]:
        if not store.verify(entry["key"], bytes_count=entry["bytes"], sha256=entry["sha256"]):
            raise OneWatCanaryError("canary payload failed post-upload verification")
    completion = {
        "format_version": 1,
        "kind": "growthsent-gcp-r2-one-wat-canary-completed",
        "canary_id": args.canary_id,
        "source_key": source,
        "source_url": report["source_transport"]["source_url"],
        "metrics_key": metric_key,
        "metrics_sha256": metric_result["sha256"],
        "artifacts": report["artifacts"],
        "release_sha256": args.release_sha256,
    }
    # Completion-marker-last. There are no cloud writes below this line.
    store.upload_immutable_json(completion_key, completion)
    return {"completed": True, "reused": False, "uploads": uploads, **completion}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canary-id", required=True)
    parser.add_argument("--source-key", required=True)
    parser.add_argument("--release-sha256", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=50_000)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{64}", args.release_sha256):
        parser.error("--release-sha256 must be lowercase SHA-256 hex")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    prefix = r2.normalize_key(CANARY_ROOT, args.canary_id)
    store = r2.R2Store.from_environment(allowed_prefixes=[prefix])
    print(json.dumps(run_one(args, store), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
