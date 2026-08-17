#!/usr/bin/env python3
"""Build bounded, target-host-oriented Common Crawl backlink serving artifacts.

This tool is intentionally separate from WAT ingestion and the frozen
dictionary experiment.  It reads already-finalized Links Parquet only.  The
raw Pages, Links, and Metrics output schemas remain unchanged.

The first stage partitions one immutable 1,000-input raw Links shard by a
stable SHA-256 prefix of ``target_host``.  It gives a future serving query a
deterministic, narrow object prefix before applying an exact ``target_host``
predicate.  The second stage materializes exact *one-host* rollups from that
narrow detail set.  It never attempts a global anchor/page aggregation: the
100-file feasibility probe showed those cardinalities approach raw-link scale.

All rollup labels say ``observed_link`` because this Python worker deliberately
does not approximate public-suffix/registrable-domain classification.  The
application's existing ``tldts`` logic remains the authority for whether an
observation is external at serving time.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


FORMAT_VERSION = 1
DETAIL_SCHEMA_VERSION = 1
ROLLUP_SCHEMA_VERSION = 1
MAX_LINK_FILES_PER_SHARD = 1_000
# A 10-bit (1,024-way) deterministic target-host bucket is a deliberate
# compromise: the 4,096-way feasibility build incurred excessive tiny-file
# overhead on a single raw part, while 256 buckets leave too much data for a
# large-domain interactive lookup. Across ten 1,000-input shards this bounds
# a target-host lookup to roughly 1/1,024 of the detail corpus before exact
# host filtering, without creating one object per host.
BUCKET_BITS = 10
BUCKET_COUNT = 2 ** BUCKET_BITS
BUCKET_WIDTH = 4
DEFAULT_ROW_GROUP_SIZE = 50_000
DEFAULT_MEMORY_LIMIT = "4GB"


class DerivedDataError(ValueError):
    """Raised when a derived-data build would exceed its reviewed scope."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def json_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def host_bucket(target_host: str) -> str:
    """Return the deterministic zero-padded decimal bucket used in S3 and queries."""

    if not isinstance(target_host, str) or not target_host:
        raise DerivedDataError("target_host must be a non-empty string")
    first_twelve_bits = int(hashlib.sha256(target_host.encode("utf-8")).hexdigest()[:3], 16)
    return f"{first_twelve_bits >> 2:0{BUCKET_WIDTH}d}"


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalized_parquet_paths(directory: Path) -> list[Path]:
    paths = sorted(path for path in directory.rglob("*.parquet") if path.is_file())
    if not paths:
        raise DerivedDataError(f"no Parquet files found under {directory}")
    if len(paths) > MAX_LINK_FILES_PER_SHARD:
        raise DerivedDataError(
            f"refusing {len(paths):,} raw Links files; one derived shard may contain at most "
            f"{MAX_LINK_FILES_PER_SHARD:,} deterministic raw parts"
        )
    return paths


def links_source_fingerprint(paths: Iterable[Path], root: Path) -> dict[str, Any]:
    """Bind a build to raw deterministic parts without re-reading all bytes."""

    entries: list[dict[str, Any]] = []
    for path in paths:
        metadata = pq.ParquetFile(path).metadata
        entries.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "rows": metadata.num_rows,
                "row_groups": metadata.num_row_groups,
            }
        )
    fingerprint = json_sha256(entries)
    return {"files": entries, "fingerprint_sha256": fingerprint}


def _require_safe_run_id(value: str) -> str:
    if not value or len(value) > 128 or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789._-" for character in value):
        raise DerivedDataError("run_id must use lowercase letters, digits, '.', '_', or '-'")
    return value


def _require_shard_identity(shard_id: int, shard_count: int) -> None:
    if not 0 <= shard_id < shard_count <= 10_000:
        raise DerivedDataError("shard identity is out of the bounded zero-based range")


def shard_label(shard_id: int, shard_count: int) -> str:
    _require_shard_identity(shard_id, shard_count)
    width = max(3, len(str(shard_count - 1)))
    return f"shard-{shard_id:0{width}d}-of-{shard_count:0{width}d}"


def _parquet_glob(path: Path) -> str:
    return (path / "**" / "*.parquet").as_posix()


def _connection(
    memory_limit: str, threads: int, temp_directory: Path | None = None
) -> duckdb.DuckDBPyConnection:
    if threads < 1 or threads > 8:
        raise DerivedDataError("threads must be between 1 and 8")
    connection = duckdb.connect(":memory:")
    connection.execute(f"PRAGMA threads={threads}")
    connection.execute(f"PRAGMA memory_limit={sql_literal(memory_limit)}")
    if temp_directory is not None:
        # The 1,000-input canary is deliberately allowed to spill its bounded
        # sort into the explicitly provisioned worker volume rather than an
        # implicit, potentially small system temporary directory.
        temp_directory.mkdir(parents=True, exist_ok=True)
        connection.execute(f"SET temp_directory={sql_literal(temp_directory.as_posix())}")
    connection.execute("PRAGMA preserve_insertion_order=false")
    return connection


def _read_links_relation(paths: list[Path]) -> tuple[str, list[Any]]:
    # Binding paths separately lets DuckDB safely open paths containing spaces
    # without interpolating external data into SQL.
    return "read_parquet(?, union_by_name=true)", [[path.as_posix() for path in paths]]


def _atomic_publish_directory(stage: Path, destination: Path) -> None:
    if destination.exists():
        raise DerivedDataError(f"refusing to overwrite existing derived output: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(stage, destination)


def _file_manifest(root: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.parquet")):
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                digest.update(block)
        metadata = pq.ParquetFile(path).metadata
        result.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "rows": metadata.num_rows,
                "sha256": digest.hexdigest(),
            }
        )
    return result


def _verify_details_manifest(root: Path, expected: dict[str, Any]) -> bool:
    manifest_path = root / "DERIVED-MANIFEST.json"
    if not manifest_path.is_file():
        return False
    try:
        actual = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    keys = ("format_version", "kind", "run_id", "crawl", "shard", "source_links")
    if any(actual.get(key) != expected.get(key) for key in keys):
        return False
    files = actual.get("detail_files")
    if not isinstance(files, list) or not files:
        return False
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return False
        path = root / entry["path"]
        if not path.is_file() or path.stat().st_size != entry.get("bytes"):
            return False
    return True


def build_detail_shard(
    *,
    links_directory: Path,
    output_root: Path,
    run_id: str,
    crawl: str,
    shard_id: int,
    shard_count: int,
    expected_links_files: int | None = None,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    threads: int = 4,
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE,
    temp_directory: Path | None = None,
    resume: bool = False,
) -> dict[str, Any]:
    """Partition one bounded raw Links shard into stable target-host buckets.

    DuckDB writes the bucket files in a staging directory.  The final
    directory is promoted only after every file has been finalized and the
    manifest is written.  This method never writes to S3.
    """

    _require_safe_run_id(run_id)
    _require_shard_identity(shard_id, shard_count)
    if row_group_size < 10_000 or row_group_size > 1_000_000:
        raise DerivedDataError("row_group_size must be between 10,000 and 1,000,000")
    paths = normalized_parquet_paths(links_directory)
    if expected_links_files is not None and len(paths) != expected_links_files:
        raise DerivedDataError(
            f"raw Links file count must be exactly {expected_links_files}, got {len(paths)}"
        )
    source = links_source_fingerprint(paths, links_directory)
    identity = {
        "format_version": FORMAT_VERSION,
        "kind": "common-crawl-backlink-detail-shard",
        "run_id": run_id,
        "crawl": crawl,
        "shard": {"id": shard_id, "count": shard_count, "label": shard_label(shard_id, shard_count)},
        "source_links": source,
    }
    destination = output_root / f"crawl={crawl}" / "dataset=backlink-details" / f"input_shard={shard_label(shard_id, shard_count)}"
    if destination.exists():
        if resume and _verify_details_manifest(destination, identity):
            return json.loads((destination / "DERIVED-MANIFEST.json").read_text(encoding="utf-8"))
        raise DerivedDataError(f"derived detail destination already exists and is not an exact resumable build: {destination}")

    # DuckDB adds hive partition segments below the target.  Keep staging near
    # output_root so long Windows workspace paths do not exceed MAX_PATH.
    stage = output_root / ".detail-staging" / uuid.uuid4().hex
    stage.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    try:
        connection = _connection(memory_limit, threads, temp_directory)
        source_sql, source_parameters = _read_links_relation(paths)
        query = f"""
            SELECT
              crawl,
              source_url,
              source_host,
              target_url,
              target_host,
              anchor,
              crawled_at,
              lpad(
                cast(cast('0x' || substr(sha256(target_host), 1, 3) as integer) // 4 as varchar),
                {BUCKET_WIDTH}, '0'
              ) AS target_host_bucket
            FROM {source_sql}
            WHERE target_host IS NOT NULL AND target_host <> ''
            ORDER BY target_host_bucket, target_host, source_host, target_url, anchor
        """
        # A 1,024-way target-host partition gives each 10K serving bucket an
        # average raw-data ceiling near 0.85 GB before exact-host filtering;
        # Sorted rows retain useful target_host min/max statistics within each
        # Parquet row group.  One build covers at most 1,000 raw Links parts.
        copy_target = sql_literal(stage.as_posix())
        connection.execute(
            f"COPY ({query}) TO {copy_target} "
            f"(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {row_group_size}, "
            "PARTITION_BY (target_host_bucket))",
            source_parameters,
        )
        connection.close()
        detail_files = _file_manifest(stage)
        if not detail_files:
            raise DerivedDataError("derived detail build produced no Parquet files")
        report = {
            **identity,
            "detail_schema_version": DETAIL_SCHEMA_VERSION,
            "bucket_algorithm": "int(sha256(target_host)[:3], 16) >> 2, zero-padded decimal",
            "bucket_count": BUCKET_COUNT,
            "row_group_size": row_group_size,
            "compression": "zstd",
            "external_classification": "not_applied; raw observations retain source_host for existing tldts serving logic",
            "built_at": utc_timestamp(),
            "build_seconds": round(time.monotonic() - started, 3),
            "detail_files": detail_files,
            "detail_rows": sum(entry["rows"] for entry in detail_files),
            "detail_bytes": sum(entry["bytes"] for entry in detail_files),
        }
        report["manifest_sha256"] = json_sha256(report)
        (stage / "DERIVED-MANIFEST.json").write_bytes(canonical_json(report))
        _atomic_publish_directory(stage, destination)
        return report
    except Exception:
        # Preserve a failed staging directory for local forensic inspection;
        # it is never promoted or treated as resumable output.
        raise


def _host_detail_files(detail_root: Path, target_host: str) -> list[Path]:
    bucket = host_bucket(target_host)
    files = sorted(path for path in detail_root.rglob("*.parquet") if f"target_host_bucket={bucket}" in path.as_posix())
    if not files:
        raise DerivedDataError(f"no detail Parquet files exist for target host bucket {bucket}")
    return files


def _record_table(rows: list[dict[str, Any]], schema: pa.Schema) -> pa.Table:
    return pa.Table.from_pylist(rows, schema=schema)


def _write_single_parquet(path: Path, table: pa.Table) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd", row_group_size=DEFAULT_ROW_GROUP_SIZE)


def build_host_rollup(
    *,
    detail_root: Path,
    output_root: Path,
    crawl: str,
    run_id: str,
    target_host: str,
    top_k: int = 100,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    threads: int = 2,
) -> dict[str, Any]:
    """Build exact raw-observation rollups for one target host only.

    This is deliberately a per-host operation.  It reads only the deterministic
    bucket prefix and exact target host, then records whether each result is
    raw-observation scoped.  Global anchor/page aggregation is intentionally
    not attempted because it is not compact at this crawl scale.
    """

    _require_safe_run_id(run_id)
    target_host = target_host.strip().lower()
    if not target_host or any(character.isspace() for character in target_host):
        raise DerivedDataError("target_host must be a non-empty normalized hostname")
    if top_k < 1 or top_k > 1_000:
        raise DerivedDataError("top_k must be between 1 and 1,000")
    files = _host_detail_files(detail_root, target_host)
    bucket = host_bucket(target_host)
    source_sql, parameters = _read_links_relation(files)
    connection = _connection(memory_limit, threads)
    try:
        filtered = f"(SELECT * FROM {source_sql} WHERE target_host = ?)"
        base_parameters = [*parameters, target_host]
        summary = connection.execute(
            f"""
            SELECT
              COUNT(*) AS observed_link_row_count,
              COUNT(DISTINCT source_host) AS unique_referring_host_count,
              COUNT(DISTINCT target_url) AS unique_target_page_count,
              COUNT(*) FILTER (WHERE anchor IS NOT NULL AND length(trim(anchor)) > 0) AS nonempty_anchor_row_count
            FROM {filtered}
            """,
            base_parameters,
        ).fetchone()
        if summary is None or summary[0] == 0:
            raise DerivedDataError(f"target host was not found in its deterministic detail bucket: {target_host}")
        referring_rows = connection.execute(
            f"""
            SELECT source_host, COUNT(*) AS observed_link_row_count
            FROM {filtered}
            WHERE source_host IS NOT NULL AND source_host <> ''
            GROUP BY source_host
            ORDER BY observed_link_row_count DESC, source_host ASC
            """,
            base_parameters,
        ).fetchall()
        anchor_rows = connection.execute(
            f"""
            SELECT anchor, COUNT(*) AS observed_link_row_count
            FROM {filtered}
            WHERE anchor IS NOT NULL AND length(trim(anchor)) > 0
            GROUP BY anchor
            ORDER BY observed_link_row_count DESC, anchor ASC
            LIMIT {top_k}
            """,
            base_parameters,
        ).fetchall()
        page_rows = connection.execute(
            f"""
            SELECT target_url,
                   COUNT(*) AS observed_link_row_count,
                   COUNT(DISTINCT source_host) AS referring_host_count
            FROM {filtered}
            WHERE target_url IS NOT NULL AND target_url <> ''
            GROUP BY target_url
            ORDER BY observed_link_row_count DESC, target_url ASC
            LIMIT {top_k}
            """,
            base_parameters,
        ).fetchall()
    finally:
        connection.close()

    host_key = hashlib.sha256(target_host.encode("utf-8")).hexdigest()
    # Mirror the proven raw-part convention: the path key is a compact,
    # deterministic 64-bit prefix, while the full SHA-256 remains in the
    # manifest.  An existing key is never overwritten, so a theoretical
    # collision fails closed rather than mixing two hosts.
    host_partition_key = host_key[:16]
    destination = output_root / f"crawl={crawl}" / "dataset=backlink-host-rollups" / f"target_host_bucket={bucket}" / f"target_host_key={host_partition_key}"
    if destination.exists():
        raise DerivedDataError(f"refusing to overwrite an existing target-host rollup: {destination}")
    # Keep the staging path short on Windows; repeating the 64-hex host key in
    # the temporary directory can exceed the legacy MAX_PATH boundary.
    stage = output_root / ".host-rollup-staging" / uuid.uuid4().hex
    stage.mkdir(parents=True, exist_ok=False)
    try:
        summary_schema = pa.schema([
            pa.field("crawl", pa.string()), pa.field("run_id", pa.string()), pa.field("target_host", pa.string()),
            pa.field("target_host_bucket", pa.string()), pa.field("observed_link_row_count", pa.int64()),
            pa.field("unique_referring_host_count", pa.int64()), pa.field("unique_target_page_count", pa.int64()),
            pa.field("nonempty_anchor_row_count", pa.int64()), pa.field("rollup_schema_version", pa.int32()),
        ])
        _write_single_parquet(stage / "dataset=domain-summary" / "part.parquet", _record_table([{
            "crawl": crawl, "run_id": run_id, "target_host": target_host, "target_host_bucket": bucket,
            "observed_link_row_count": int(summary[0]), "unique_referring_host_count": int(summary[1]),
            "unique_target_page_count": int(summary[2]), "nonempty_anchor_row_count": int(summary[3]),
            "rollup_schema_version": ROLLUP_SCHEMA_VERSION,
        }], summary_schema))
        _write_single_parquet(stage / "dataset=referring-hosts" / "part.parquet", _record_table([
            {"target_host": target_host, "source_host": str(source_host), "observed_link_row_count": int(count)}
            for source_host, count in referring_rows
        ], pa.schema([pa.field("target_host", pa.string()), pa.field("source_host", pa.string()), pa.field("observed_link_row_count", pa.int64())])))
        _write_single_parquet(stage / "dataset=top-anchors" / "part.parquet", _record_table([
            {"target_host": target_host, "anchor": str(anchor), "observed_link_row_count": int(count)}
            for anchor, count in anchor_rows
        ], pa.schema([pa.field("target_host", pa.string()), pa.field("anchor", pa.string()), pa.field("observed_link_row_count", pa.int64())])))
        _write_single_parquet(stage / "dataset=top-linked-pages" / "part.parquet", _record_table([
            {"target_host": target_host, "target_url": str(url), "observed_link_row_count": int(count), "referring_host_count": int(host_count)}
            for url, count, host_count in page_rows
        ], pa.schema([
            pa.field("target_host", pa.string()), pa.field("target_url", pa.string()),
            pa.field("observed_link_row_count", pa.int64()), pa.field("referring_host_count", pa.int64()),
        ])))
        report = {
            "format_version": FORMAT_VERSION,
            "kind": "common-crawl-backlink-host-rollup",
            "rollup_schema_version": ROLLUP_SCHEMA_VERSION,
            "crawl": crawl,
            "run_id": run_id,
            "target_host": target_host,
            "target_host_bucket": bucket,
            "target_host_sha256": host_key,
            "target_host_key": host_partition_key,
            "detail_file_count": len(files),
            "scope": "raw HTML link observations; external/internal classification is intentionally deferred to the application's tldts logic",
            "top_k": top_k,
            "built_at": utc_timestamp(),
            "summary": {
                "observed_link_row_count": int(summary[0]),
                "unique_referring_host_count": int(summary[1]),
                "unique_target_page_count": int(summary[2]),
                "nonempty_anchor_row_count": int(summary[3]),
            },
            "referring_host_rows": len(referring_rows),
            "top_anchor_rows": len(anchor_rows),
            "top_linked_page_rows": len(page_rows),
        }
        report["manifest_sha256"] = json_sha256(report)
        (stage / "DERIVED-MANIFEST.json").write_bytes(canonical_json(report))
        _atomic_publish_directory(stage, destination)
        return report
    except Exception:
        raise


def lookup_detail_rows(
    *, detail_root: Path, target_host: str, limit: int = 10, memory_limit: str = DEFAULT_MEMORY_LIMIT
) -> list[dict[str, Any]]:
    """Read a bounded detail sample from only the deterministic host bucket."""

    if limit < 1 or limit > 100:
        raise DerivedDataError("limit must be between 1 and 100")
    normalized = target_host.strip().lower()
    files = _host_detail_files(detail_root, normalized)
    source_sql, parameters = _read_links_relation(files)
    connection = _connection(memory_limit, 2)
    try:
        rows = connection.execute(
            f"""
            SELECT source_url, source_host, target_url, anchor, crawled_at
            FROM {source_sql}
            WHERE target_host = ?
            LIMIT {limit}
            """,
            [*parameters, normalized],
        ).to_arrow_table().to_pylist()
        return rows
    finally:
        connection.close()


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    detail = commands.add_parser("build-detail-shard", help="partition one bounded raw Links shard by target host")
    detail.add_argument("--links-dir", required=True, type=Path)
    detail.add_argument("--output-root", required=True, type=Path)
    detail.add_argument("--run-id", required=True)
    detail.add_argument("--crawl", required=True)
    detail.add_argument("--shard-id", required=True, type=int)
    detail.add_argument("--shard-count", required=True, type=int)
    detail.add_argument("--expected-links-files", type=int)
    detail.add_argument("--memory-limit", default=DEFAULT_MEMORY_LIMIT)
    detail.add_argument("--threads", type=int, default=4)
    detail.add_argument("--row-group-size", type=int, default=DEFAULT_ROW_GROUP_SIZE)
    detail.add_argument("--temp-directory", type=Path)
    detail.add_argument("--resume", action="store_true")
    host = commands.add_parser("build-host-rollup", help="materialize exact raw-observation rollups for one host")
    host.add_argument("--detail-root", required=True, type=Path)
    host.add_argument("--output-root", required=True, type=Path)
    host.add_argument("--run-id", required=True)
    host.add_argument("--crawl", required=True)
    host.add_argument("--target-host", required=True)
    host.add_argument("--top-k", type=int, default=100)
    host.add_argument("--memory-limit", default=DEFAULT_MEMORY_LIMIT)
    host.add_argument("--threads", type=int, default=2)
    lookup = commands.add_parser("lookup-details", help="read a bounded target-host detail sample")
    lookup.add_argument("--detail-root", required=True, type=Path)
    lookup.add_argument("--target-host", required=True)
    lookup.add_argument("--limit", type=int, default=10)
    lookup.add_argument("--memory-limit", default=DEFAULT_MEMORY_LIMIT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.command == "build-detail-shard":
        result = build_detail_shard(
            links_directory=args.links_dir,
            output_root=args.output_root,
            run_id=args.run_id,
            crawl=args.crawl,
            shard_id=args.shard_id,
            shard_count=args.shard_count,
            expected_links_files=args.expected_links_files,
            memory_limit=args.memory_limit,
            threads=args.threads,
            row_group_size=args.row_group_size,
            temp_directory=args.temp_directory,
            resume=args.resume,
        )
    elif args.command == "build-host-rollup":
        result = build_host_rollup(
            detail_root=args.detail_root,
            output_root=args.output_root,
            run_id=args.run_id,
            crawl=args.crawl,
            target_host=args.target_host,
            top_k=args.top_k,
            memory_limit=args.memory_limit,
            threads=args.threads,
        )
    else:
        result = lookup_detail_rows(
            detail_root=args.detail_root,
            target_host=args.target_host,
            limit=args.limit,
            memory_limit=args.memory_limit,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
