#!/usr/bin/env python3
"""Build per-domain JSON serving files from the compacted R2 serving tables.

One Batch task handles one target-domain bucket (0-1023). It reads the six
Parquet files in that bucket from R2, keeps the top N rows per table for each
domain, and writes one small JSON file per domain to the immutable R2 output
prefix so the Cloudflare Worker can serve lookups without scanning Parquet.

No raw credentials are logged or written to disk beyond the temporary R2 child
credential injected by the GCP Secret Manager wrapper.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import queue
import shutil
import sys
import threading
from pathlib import Path
from typing import Any, Mapping

try:
    import duckdb
except ImportError as _duckdb_import_error:
    duckdb = None  # type: ignore[assignment]


BUCKET_COUNT = 1024
FORMAT_VERSION = 1
TASK_KIND = "growthsent-cc-main-2026-30-domain-json-v1"
DEFAULT_TOP_N = 100
DEFAULT_UPLOAD_THREADS = 64
DEFAULT_UPLOAD_QUEUE = 200

TABLES: dict[str, dict[str, Any]] = {
    "domain_summary": {
        "columns": ["target_domain", "inbound_link_count", "referring_domain_count"],
        "score": None,
    },
    "referring_domains": {
        "columns": ["target_domain", "source_domain", "inbound_link_count"],
        "score": "inbound_link_count",
    },
    "anchors": {
        "columns": ["target_domain", "anchor", "inbound_link_count"],
        "score": "inbound_link_count",
    },
    "top_pages": {
        "columns": [
            "target_domain",
            "target_url",
            "inbound_link_count",
            "referring_domain_count",
        ],
        "score": "inbound_link_count",
    },
    "broken_backlink_candidates": {
        "columns": [
            "target_domain",
            "target_url",
            "source_domain",
            "source_url",
            "observed_link_count",
        ],
        "score": "observed_link_count",
    },
}


class DomainJsonError(RuntimeError):
    """A recoverable task-level failure."""


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def domain_key(domain: str) -> str:
    """Deterministic, URL-safe key for a normalized domain.

    Matches the encoding the Cloudflare Worker will use to look up the file.
    """
    return base64.urlsafe_b64encode(domain.encode("utf-8")).decode("ascii").rstrip("=")


def _duckdb_struct_expr(columns: list[str], score: str) -> str:
    """Return a struct_pack(...) expression with score first for readability."""
    ordered = [score] + [c for c in columns if c not in ("target_domain", score)]
    return ", ".join(f"{c} := {c}" for c in ordered)


def _duckdb_struct_type(columns: list[str], score: str) -> str:
    """Return a STRUCT(...) type declaration for a table's item list."""
    ordered = [score] + [c for c in columns if c not in ("target_domain", score)]
    fields = []
    for c in ordered:
        if "_count" in c or "link_count" in c:
            fields.append(f"{c} BIGINT")
        else:
            fields.append(f"{c} VARCHAR")
    return f"STRUCT({', '.join(fields)})"


def _head_or_none(s3_client: Any, bucket: str, key: str) -> Mapping[str, Any] | None:
    try:
        return s3_client.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise DomainJsonError(f"R2 head failed for {key}: {error}") from error


def _download_source(s3_client: Any, bucket: str, key: str, destination: Path) -> int:
    print(f"[download] start {key} -> {destination}", flush=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    try:
        with temporary.open("wb") as handle:
            response = s3_client.get_object(Bucket=bucket, Key=key)
            for block in iter(lambda: response["Body"].read(16 * 1024 * 1024), b""):
                if block:
                    handle.write(block)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    downloaded_bytes = temporary.stat().st_size
    temporary.replace(destination)
    print(f"[download] done {key}: {downloaded_bytes} bytes -> {destination}", flush=True)
    return downloaded_bytes


def _create_top_table(
    connection: Any,
    table_name: str,
    source_path: str,
    score_column: str,
    columns: list[str],
    top_n: int,
    filter_sql: str | None,
) -> None:
    struct_expr = _duckdb_struct_expr(columns, score_column)
    where = f"WHERE target_domain IN {filter_sql}" if filter_sql else ""
    query = f"""
        CREATE OR REPLACE TABLE top_{table_name} AS
        WITH ranked AS (
            SELECT
                target_domain,
                {', '.join(columns)},
                row_number() OVER (
                    PARTITION BY target_domain
                    ORDER BY {score_column} DESC
                ) AS rn
            FROM read_parquet('{source_path}')
            {where}
        ),
        totals AS (
            SELECT target_domain, count(*)::BIGINT AS total
            FROM ranked
            GROUP BY target_domain
        )
        SELECT
            r.target_domain,
            t.total,
            list(struct_pack({struct_expr}) ORDER BY r.rn) AS items
        FROM ranked r
        JOIN totals t USING (target_domain)
        WHERE r.rn <= {top_n}
        GROUP BY r.target_domain, t.total
    """
    connection.execute(query)


def _create_summary_table(connection: Any, source_path: str, filter_sql: str | None) -> None:
    where = f"WHERE target_domain IN {filter_sql}" if filter_sql else ""
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE summary AS
        SELECT
            target_domain,
            inbound_link_count::BIGINT AS inbound_link_count,
            referring_domain_count::BIGINT AS referring_domain_count
        FROM read_parquet('{source_path}')
        {where}
        ORDER BY target_domain
        """
    )


def _compute_domain_rating(inbound_links: int) -> float:
    return min(100.0, round((inbound_links + 1).bit_length() * 10, 1))  # placeholder if needed


def _to_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return list(value)


def _build_payload(
    domain: str,
    bucket: int,
    row: tuple[Any, ...],
) -> bytes:
    (
        _,  # target_domain already extracted
        inbound_link_count,
        referring_domain_count,
        referring_domains_total,
        referring_domains_items,
        anchors_total,
        anchors_items,
        top_pages_total,
        top_pages_items,
        broken_total,
        broken_items,
    ) = row

    document: dict[str, Any] = {
        "format_version": FORMAT_VERSION,
        "domain": domain,
        "bucket": bucket,
        "generated_at": _utc_timestamp(),
        "summary": {
            "inbound_link_count": int(inbound_link_count or 0),
            "referring_domain_count": int(referring_domain_count or 0),
        },
        "referring_domains": {
            "total": int(referring_domains_total or 0),
            "items": [_row_to_dict(item) for item in _to_list(referring_domains_items)],
        },
        "anchors": {
            "total": int(anchors_total or 0),
            "items": [_row_to_dict(item) for item in _to_list(anchors_items)],
        },
        "top_pages": {
            "total": int(top_pages_total or 0),
            "items": [_row_to_dict(item) for item in _to_list(top_pages_items)],
        },
        "broken_backlinks": {
            "total": int(broken_total or 0),
            "items": [_row_to_dict(item) for item in _to_list(broken_items)],
        },
    }
    return _canonical_json(document)


def _row_to_dict(item: Any) -> dict[str, Any]:
    """Convert a DuckDB struct (dict or SimpleNamespace/tuple) to a plain dict."""
    if isinstance(item, dict):
        return {str(k): _to_json_value(v) for k, v in item.items()}
    if hasattr(item, "_asdict"):
        return {str(k): _to_json_value(v) for k, v in item._asdict().items()}
    if hasattr(item, "__dict__"):
        return {str(k): _to_json_value(v) for k, v in item.__dict__.items()}
    raise DomainJsonError(f"unexpected item type in struct list: {type(item)}")


def _to_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    raise DomainJsonError(f"unserializable value in struct: {type(value)}")


def _utc_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_plausible_domain(value: str) -> bool:
    if not value or not isinstance(value, str):
        return False
    value = value.strip()
    if len(value) > 253 or len(value) < 4:
        return False
    if any(c.isspace() or c in "\x00\x01\x02\x03\x04\x05\x06\x07\x08" for c in value):
        return False
    return "." in value


def _normalize_domain(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("http://") or value.startswith("https://"):
        from urllib.parse import urlparse
        try:
            value = urlparse(value).hostname or value
        except Exception:
            pass
    value = value.replace("www.", "", 1)
    value = value.split(":")[0]
    value = value.rstrip("/")
    return value


def _load_domain_filter(domains_file: Path | None, domains_arg: str | None) -> set[str] | None:
    if not domains_file and not domains_arg:
        return None
    raw: list[str] = []
    if domains_arg:
        raw.extend(domains_arg.split(","))
    if domains_file:
        with domains_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.split("#")[0].strip()
                if line:
                    raw.append(line)
    filtered = {_normalize_domain(d) for d in raw}
    return filtered or None


def _sql_in_list(domains: set[str]) -> str:
    if not domains:
        return "('')"
    return "(" + ", ".join("'" + d.replace("'", "''") + "'" for d in sorted(domains)) + ")"


def _write_manifest(
    r2_store: Any,
    output_prefix: str,
    bucket: int,
    *,
    domain_count: int,
    total_bytes: int,
    top_n: int,
    empty: bool = False,
) -> None:
    document = {
        "format_version": FORMAT_VERSION,
        "kind": TASK_KIND,
        "bucket": bucket,
        "output_prefix": output_prefix,
        "empty": empty,
        "domain_count": domain_count,
        "total_bytes": total_bytes,
        "top_n": top_n,
        "generated_at": _utc_timestamp(),
    }
    key = f"{output_prefix}/domain-json-manifests/target_bucket={bucket:04d}.json"
    body = _canonical_json(document)
    r2_store.client.put_object(
        Bucket=r2_store.bucket,
        Key=r2_store.assert_allowed(key),
        Body=body,
        ContentLength=len(body),
        ContentType="application/json",
        ContentMD5=base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
        Metadata={"growthsent-sha256": _sha256_bytes(body)},
    )


def process_bucket(
    *,
    bucket: int,
    serving_prefix: str,
    output_prefix: str,
    work_dir: Path,
    r2_store: Any,
    top_n: int,
    upload_threads: int,
    batch_size: int,
    domain_filter: set[str] | None = None,
) -> dict[str, Any]:
    if bucket < 0 or bucket >= BUCKET_COUNT:
        raise DomainJsonError("bucket must be 0-1023")

    filter_sql = _sql_in_list(domain_filter) if domain_filter else None

    local_root = work_dir / f"bucket-{bucket:04d}"
    shutil.rmtree(local_root, ignore_errors=True)
    local_root.mkdir(parents=True, exist_ok=True)

    s3_client = r2_store.client
    bucket_name = r2_store.bucket

    downloaded: dict[str, str] = {}
    try:
        for table in TABLES:
            key = f"{serving_prefix}/table={table}/target_bucket={bucket:04d}/part.parquet"
            head = _head_or_none(s3_client, bucket_name, key)
            if head is None or head.get("ContentLength", 0) == 0:
                continue
            destination = local_root / f"{table}.parquet"
            _download_source(s3_client, bucket_name, key, destination)
            downloaded[table] = str(destination)

        if "domain_summary" not in downloaded:
            _write_manifest(
                r2_store,
                output_prefix,
                bucket,
                domain_count=0,
                total_bytes=0,
                top_n=top_n,
                empty=True,
            )
            return {"status": "published", "bucket": bucket, "empty": True}

        print(f"[build] local files before DuckDB: {list(local_root.iterdir())}", flush=True)
        connection = duckdb.connect(str(local_root / "work.duckdb"))
        try:
            memory_limit = os.environ.get("GROWTHSENT_DUCKDB_MEMORY_LIMIT", "10GB")
            threads = max(1, int(os.environ.get("GROWTHSENT_DUCKDB_THREADS", "3")))
            connection.execute(f"SET memory_limit='{memory_limit}'")
            connection.execute(f"SET threads={threads}")
            connection.execute("SET max_temp_directory_size='800GB'")
            connection.execute("SET preserve_insertion_order=false")

            _create_summary_table(connection, downloaded["domain_summary"], filter_sql)

            for table, spec in TABLES.items():
                if table == "domain_summary":
                    continue
                if table not in downloaded:
                    item_type = _duckdb_struct_type(spec["columns"], spec["score"])
                    connection.execute(
                        f"""
                        CREATE OR REPLACE TABLE top_{table} AS
                        SELECT
                            CAST(NULL AS VARCHAR) AS target_domain,
                            CAST(0 AS BIGINT) AS total,
                            CAST(NULL AS {item_type}[]) AS items
                        WHERE false
                        """
                    )
                    continue
                _create_top_table(
                    connection,
                    table,
                    downloaded[table],
                    spec["score"],
                    spec["columns"],
                    top_n,
                    filter_sql,
                )

            join_query = """
                SELECT
                    s.target_domain,
                    s.inbound_link_count,
                    s.referring_domain_count,
                    r.total AS referring_domains_total,
                    r.items AS referring_domains,
                    a.total AS anchors_total,
                    a.items AS anchors,
                    t.total AS top_pages_total,
                    t.items AS top_pages,
                    b.total AS broken_backlinks_total,
                    b.items AS broken_backlinks
                FROM summary s
                LEFT JOIN top_referring_domains r ON r.target_domain = s.target_domain
                LEFT JOIN top_anchors a ON a.target_domain = s.target_domain
                LEFT JOIN top_top_pages t ON t.target_domain = s.target_domain
                LEFT JOIN top_broken_backlink_candidates b ON b.target_domain = s.target_domain
                ORDER BY s.target_domain
            """
            cursor = connection.cursor()
            cursor.execute(join_query)

            upload_queue: queue.Queue[tuple[str, bytes] | None] = queue.Queue(maxsize=DEFAULT_UPLOAD_QUEUE)
            errors: list[str] = []
            stop_event = threading.Event()

            def _is_precondition(exc: Exception) -> bool:
                response = getattr(exc, "response", None)
                if not isinstance(response, Mapping):
                    return False
                code = response.get("Error", {}).get("Code", "")
                return code in {"PreconditionFailed", "ConditionalRequestConflict"}

            def upload_worker() -> None:
                while True:
                    try:
                        task = upload_queue.get(timeout=1)
                    except queue.Empty:
                        if stop_event.is_set():
                            break
                        continue
                    if task is None:
                        upload_queue.task_done()
                        break
                    domain, payload = task
                    try:
                        key = f"{output_prefix}/{domain_key(domain)}.json"
                        r2_store.assert_allowed(key)
                        r2_store.client.put_object(
                            Bucket=r2_store.bucket,
                            Key=key,
                            Body=payload,
                            ContentLength=len(payload),
                            ContentType="application/json",
                            ContentMD5=base64.b64encode(hashlib.md5(payload).digest()).decode("ascii"),
                            Metadata={"growthsent-sha256": _sha256_bytes(payload)},
                            IfNoneMatch="*",
                        )
                    except Exception as exc:
                        if _is_precondition(exc):
                            # Object already exists from a previous run; immutable
                            # keys imply the content is identical.
                            continue
                        errors.append(f"{domain}: {exc}")
                    finally:
                        upload_queue.task_done()

            workers = [
                threading.Thread(target=upload_worker, daemon=True)
                for _ in range(upload_threads)
            ]
            for worker in workers:
                worker.start()

            domain_count = 0
            total_bytes = 0
            try:
                while True:
                    rows = cursor.fetchmany(batch_size)
                    if not rows:
                        break
                    for row in rows:
                        domain = row[0]
                        if not _is_plausible_domain(domain):
                            print(f"[build] skipping implausible target_domain: {domain[:80]!r}", flush=True)
                            continue
                        payload = _build_payload(domain, bucket, row)
                        upload_queue.put((domain, payload))
                        domain_count += 1
                        total_bytes += len(payload)
            finally:
                stop_event.set()
                for _ in workers:
                    try:
                        upload_queue.put(None, timeout=5)
                    except queue.Full:
                        pass
                for worker in workers:
                    worker.join(timeout=60)

            if errors:
                raise DomainJsonError(f"upload errors: {'; '.join(errors[:10])}")

            _write_manifest(
                r2_store,
                output_prefix,
                bucket,
                domain_count=domain_count,
                total_bytes=total_bytes,
                top_n=top_n,
                empty=False,
            )
            return {
                "status": "published",
                "bucket": bucket,
                "domain_count": domain_count,
                "total_bytes": total_bytes,
            }
        finally:
            try:
                connection.close()
            except Exception:
                pass
    finally:
        shutil.rmtree(local_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, type=int)
    parser.add_argument("--serving-prefix", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--upload-threads", type=int, default=DEFAULT_UPLOAD_THREADS)
    parser.add_argument("--batch-size", type=int, default=2048)
    parser.add_argument("--domains-file", type=Path)
    parser.add_argument("--domains", type=str)
    args = parser.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from common_crawl_r2_store import R2Store, R2StoreError

    try:
        r2_store = R2Store.from_environment(
            credential_prefix="GROWTHSENT_R2_OUTPUT_",
            allowed_prefixes=[args.output_prefix],
        )
    except R2StoreError as exc:
        print(json.dumps({"status": "failed", "error": f"R2 store init failed: {exc}"}, sort_keys=True), flush=True)
        return 1

    domain_filter = _load_domain_filter(args.domains_file, args.domains)

    try:
        result = process_bucket(
            bucket=args.bucket,
            serving_prefix=args.serving_prefix.rstrip("/"),
            output_prefix=args.output_prefix.rstrip("/"),
            work_dir=args.work_dir,
            r2_store=r2_store,
            top_n=args.top_n,
            upload_threads=args.upload_threads,
            batch_size=args.batch_size,
            domain_filter=domain_filter,
        )
    except DomainJsonError as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, sort_keys=True), flush=True)
        return 1
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": f"unexpected: {exc}"}, sort_keys=True), flush=True)
        return 1

    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
