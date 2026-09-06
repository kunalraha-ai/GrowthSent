#!/usr/bin/env python3
"""Compact one immutable target-domain bucket into GCS serving Parquet tables.

This stage consumes only the GCS intermediate partitions emitted by the link
materializer. It does not reach R2, Common Crawl, or the public internet.
Each compacted bucket becomes directly queryable through Atlas Data Federation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any


BUCKET_COUNT = 1024
TASK_KIND = "growthsent-cc-main-2026-30-link-index-compaction-v1"
INPUT_TABLES = (
    "domain_edges",
    "referring_domains",
    "anchors",
    "top_pages",
    "page_referrers",
    "broken_backlink_candidates",
)


class CompactionError(RuntimeError):
    """An intermediate artifact or serving output does not meet its contract."""


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _immutable_upload(*, bucket: Any, object_name: str, path: Path) -> dict[str, Any]:
    from google.api_core.exceptions import PreconditionFailed

    digest = _sha256_file(path)
    blob = bucket.blob(object_name)
    try:
        blob.metadata = {"growthsent-sha256": digest}
        blob.upload_from_filename(path, content_type="application/vnd.apache.parquet", if_generation_match=0, checksum="crc32c")
        return {"key": object_name, "bytes": path.stat().st_size, "sha256": digest, "reused": False}
    except PreconditionFailed:
        blob.reload()
        if (blob.metadata or {}).get("growthsent-sha256") != digest or int(blob.size or -1) != path.stat().st_size:
            raise CompactionError(f"GCS immutable serving output conflicts: {object_name}")
        return {"key": object_name, "bytes": path.stat().st_size, "sha256": digest, "reused": True}


def _immutable_json_upload(*, bucket: Any, object_name: str, document: Mapping[str, Any]) -> dict[str, Any]:
    from google.api_core.exceptions import PreconditionFailed

    payload = _canonical_json(document)
    digest = _sha256_bytes(payload)
    blob = bucket.blob(object_name)
    try:
        blob.metadata = {"growthsent-sha256": digest}
        blob.upload_from_string(payload, content_type="application/json", if_generation_match=0, checksum="crc32c")
        return {"key": object_name, "bytes": len(payload), "sha256": digest, "reused": False}
    except PreconditionFailed:
        blob.reload()
        if (blob.metadata or {}).get("growthsent-sha256") != digest or int(blob.size or -1) != len(payload):
            raise CompactionError(f"GCS immutable task summary conflicts: {object_name}")
        return {"key": object_name, "bytes": len(payload), "sha256": digest, "reused": True}


def _list_and_download(*, bucket: Any, prefix: str, destination: Path) -> list[Path]:
    blobs = sorted(bucket.list_blobs(prefix=prefix), key=lambda blob: blob.name)
    paths: list[Path] = []
    for index, blob in enumerate(blobs):
        if not blob.name.endswith(".parquet"):
            continue
        path = destination / f"part-{index:06d}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(path, checksum="crc32c")
        paths.append(path)
    return paths


def _read_parquet_sql(paths: list[Path]) -> str:
    if not paths:
        raise CompactionError("required intermediate partition is empty")
    return "read_parquet([" + ",".join(_sql_literal(str(path)) for path in paths) + "])"


def _copy_query(*, connection: Any, query: str, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection.execute(f"COPY ({query}) TO {_sql_literal(str(path))} (FORMAT PARQUET, COMPRESSION ZSTD)")
    return int(connection.execute(f"SELECT count(*) FROM ({query})").fetchone()[0])


def _existing_summary(bucket: Any, object_name: str, *, run_id: str, target_bucket: int) -> bool:
    blob = bucket.blob(object_name)
    if not blob.exists():
        return False
    try:
        document = json.loads(blob.download_as_bytes().decode("utf-8"))
    except Exception as error:
        raise CompactionError("existing compaction summary is malformed") from error
    if not isinstance(document, dict) or document.get("kind") != TASK_KIND:
        raise CompactionError("existing compaction summary conflicts with output")
    if document.get("run_id") != run_id or document.get("target_bucket") != target_bucket:
        raise CompactionError("existing compaction summary has a different bucket identity")
    return True


def compact_bucket(*, gcs_bucket: str, run_id: str, input_prefix: str, output_prefix: str, target_bucket: int, work_dir: Path) -> dict[str, Any]:
    if not run_id or target_bucket < 0 or target_bucket >= BUCKET_COUNT:
        raise CompactionError("run ID or target bucket is invalid")
    try:
        from google.cloud import storage
        import duckdb
    except ImportError as error:
        raise CompactionError("DuckDB and google-cloud-storage are required") from error
    bucket = storage.Client().bucket(gcs_bucket)
    input_root = input_prefix.strip("/")
    output_root = output_prefix.strip("/")
    if not input_root or not output_root:
        raise CompactionError("GCS prefixes are invalid")
    summary_key = f"{output_root}/compaction-manifests/target_bucket={target_bucket:04d}.json"
    if _existing_summary(bucket, summary_key, run_id=run_id, target_bucket=target_bucket):
        return {"status": "reused", "task_summary": summary_key, "target_bucket": target_bucket}
    temporary_root = work_dir / f"bucket-{target_bucket:04d}"
    shutil.rmtree(temporary_root, ignore_errors=True)
    downloaded: dict[str, list[Path]] = {}
    try:
        for table in INPUT_TABLES:
            prefix = f"{input_root}/intermediate/table={table}/target_bucket={target_bucket:04d}/"
            downloaded[table] = _list_and_download(bucket=bucket, prefix=prefix, destination=temporary_root / "input" / table)
        if not any(downloaded.values()):
            summary = {
                "format_version": 1,
                "kind": TASK_KIND,
                "run_id": run_id,
                "target_bucket": target_bucket,
                "input_prefix": input_root,
                "output_prefix": output_root,
                "empty": True,
                "artifacts": {},
            }
            summary["summary_sha256"] = _sha256_bytes(_canonical_json(summary))
            result = _immutable_json_upload(bucket=bucket, object_name=summary_key, document=summary)
            return {"status": "published", "task_summary": result, "target_bucket": target_bucket, "empty": True}
        missing = [name for name, paths in downloaded.items() if not paths]
        if missing:
            raise CompactionError(f"partial intermediate bucket: missing tables {','.join(missing)}")
        connection = duckdb.connect(str(temporary_root / "compact.duckdb"))
        try:
            connection.execute("SET memory_limit='26GB'")
            connection.execute("SET threads=4")
            connection.execute("SET max_temp_directory_size='300GB'")
            for table, paths in downloaded.items():
                connection.execute(f"CREATE VIEW source_{table} AS SELECT * FROM {_read_parquet_sql(paths)}")
            queries = {
                "referring_domains": "SELECT target_domain, source_domain, sum(link_count)::BIGINT AS inbound_link_count FROM source_referring_domains GROUP BY target_domain, source_domain",
                "anchors": "SELECT target_domain, anchor, sum(link_count)::BIGINT AS inbound_link_count FROM source_anchors GROUP BY target_domain, anchor",
                "domain_edges": "SELECT source_domain, target_domain, sum(link_count)::BIGINT AS link_count FROM source_domain_edges GROUP BY source_domain, target_domain",
                "broken_backlink_candidates": "SELECT target_domain, target_url, source_domain, source_url, sum(link_count)::BIGINT AS observed_link_count FROM source_broken_backlink_candidates GROUP BY target_domain, target_url, source_domain, source_url",
                "top_pages": "WITH links AS (SELECT target_domain, target_url, sum(link_count)::BIGINT AS inbound_link_count FROM source_top_pages GROUP BY target_domain, target_url), referrers AS (SELECT target_domain, target_url, source_domain FROM source_page_referrers GROUP BY target_domain, target_url, source_domain) SELECT links.target_domain, links.target_url, links.inbound_link_count, count(referrers.source_domain)::BIGINT AS referring_domain_count FROM links LEFT JOIN referrers USING (target_domain, target_url) GROUP BY links.target_domain, links.target_url, links.inbound_link_count",
                "domain_summary": "WITH referrers AS (SELECT target_domain, source_domain, sum(link_count)::BIGINT AS inbound_link_count FROM source_referring_domains GROUP BY target_domain, source_domain) SELECT target_domain, sum(inbound_link_count)::BIGINT AS inbound_link_count, count(*)::BIGINT AS referring_domain_count FROM referrers GROUP BY target_domain",
            }
            local_outputs: dict[str, Path] = {}
            counts: dict[str, int] = {}
            for table, query in queries.items():
                path = temporary_root / "output" / f"{table}.parquet"
                counts[table] = _copy_query(connection=connection, query=query, path=path)
                local_outputs[table] = path
        finally:
            connection.close()
        artifacts: dict[str, dict[str, Any]] = {}
        for table, path in local_outputs.items():
            key = f"{output_root}/serving/table={table}/target_bucket={target_bucket:04d}/part.parquet"
            artifacts[table] = _immutable_upload(bucket=bucket, object_name=key, path=path)
        summary = {
            "format_version": 1,
            "kind": TASK_KIND,
            "run_id": run_id,
            "target_bucket": target_bucket,
            "input_prefix": input_root,
            "output_prefix": output_root,
            "empty": False,
            "input_part_counts": {table: len(paths) for table, paths in downloaded.items()},
            "table_row_counts": counts,
            "artifacts": artifacts,
        }
        summary["summary_sha256"] = _sha256_bytes(_canonical_json(summary))
        result = _immutable_json_upload(bucket=bucket, object_name=summary_key, document=summary)
        return {"status": "published", "task_summary": result, "target_bucket": target_bucket, "table_row_counts": counts}
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gcs-bucket", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--input-prefix", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--target-bucket", required=True, type=int)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = compact_bucket(
            gcs_bucket=args.gcs_bucket,
            run_id=args.run_id,
            input_prefix=args.input_prefix,
            output_prefix=args.output_prefix,
            target_bucket=args.target_bucket,
            work_dir=args.work_dir,
        )
    except CompactionError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, sort_keys=True), flush=True)
        return 1
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
