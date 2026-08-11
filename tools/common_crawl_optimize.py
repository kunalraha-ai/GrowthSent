#!/usr/bin/env python3
"""Experimental, reversible dictionary-normalized Common Crawl Parquet mode.

This tool reads completed raw-style pages/links Parquet parts. It never opens a
WAT source, changes ingestion output, uploads to S3, or touches application
datastores.  It writes bounded hash partitions instead of building one global
URL aggregate in RAM.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pyarrow.parquet as pq


ID_BITS = 64


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parquet_paths(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.parquet") if path.is_file())


def dataset_summary(root: Path) -> dict[str, Any]:
    """Summarize a Parquet directory without materializing its rows."""
    paths = parquet_paths(root)
    if not paths:
        return {
            "bytes": 0,
            "files": 0,
            "rows": 0,
            "row_groups": 0,
            "compression": [],
            "encodings_first_file": {},
            "sha256": hashlib.sha256(b"").hexdigest(),
        }
    row_count = 0
    row_groups = 0
    compression: set[str] = set()
    fingerprint = hashlib.sha256()
    first_encodings: dict[str, list[str]] = {}
    for path in paths:
        parquet_file = pq.ParquetFile(path)
        metadata = parquet_file.metadata
        row_count += metadata.num_rows
        row_groups += metadata.num_row_groups
        if metadata.num_row_groups:
            row_group = metadata.row_group(0)
            compression.add(str(row_group.column(0).compression))
            if not first_encodings:
                for index, field in enumerate(parquet_file.schema_arrow):
                    first_encodings[field.name] = sorted(
                        str(value) for value in row_group.column(index).encodings
                    )
        relative = path.relative_to(root).as_posix().encode("utf-8")
        fingerprint.update(relative)
        fingerprint.update(b"\0")
        fingerprint.update(checksum(path).encode("ascii"))
        fingerprint.update(b"\n")
    return {
        "bytes": sum(path.stat().st_size for path in paths),
        "files": len(paths),
        "rows": row_count,
        "row_groups": row_groups,
        "compression": sorted(compression),
        "encodings_first_file": first_encodings,
        "sha256": fingerprint.hexdigest(),
    }


def copy_parquet(
    connection: duckdb.DuckDBPyConnection,
    query: str,
    path: Path,
    row_group_size: int,
    partition_by: str | None = None,
) -> None:
    if partition_by:
        path.mkdir(parents=True, exist_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    options = f"FORMAT PARQUET, COMPRESSION snappy, ROW_GROUP_SIZE {row_group_size}"
    if partition_by:
        options += f", PARTITION_BY ({partition_by})"
    connection.execute(f"COPY ({query}) TO {sql_literal(path.as_posix())} ({options})")


def scalar(connection: duckdb.DuckDBPyConnection, query: str) -> Any:
    return connection.execute(query).fetchone()[0]


def id_sql(column: str) -> str:
    """Stable unsigned 64-bit ID: the first 64 bits of SHA-256(value)."""
    return f"CAST('0x' || SUBSTRING(sha256({column}), 1, 16) AS UBIGINT)"


def candidate_glob(directory: Path, bucket: int) -> str | None:
    partition = directory / f"bucket={bucket}"
    return (partition / "*.parquet").as_posix() if partition.exists() else None


def materialize_dictionary(
    connection: duckdb.DuckDBPyConnection,
    candidate_dir: Path,
    output_dir: Path,
    value_name: str,
    partitions: int,
    row_group_size: int,
    includes_host: bool = False,
) -> tuple[int, int, int]:
    """Deduplicate a value hash partition at a time.

    Returns (row_count, ID_collision_count, URL_host_conflict_count).  Values
    sharing an ID always land in the same partition, so collision checks do not
    require a global aggregation.
    """
    rows = 0
    collisions = 0
    host_conflicts = 0
    output_dir.mkdir(parents=True, exist_ok=True)
    id_name = f"{value_name}_id"
    for bucket in range(partitions):
        glob = candidate_glob(candidate_dir, bucket)
        if glob is None:
            continue
        source = f"read_parquet({sql_literal(glob)}, hive_partitioning=false)"
        collisions += scalar(connection, f"""
            SELECT COUNT(*)
            FROM (
                SELECT {id_name}
                FROM {source}
                GROUP BY {id_name}
                HAVING COUNT(DISTINCT {value_name}) > 1
            )
        """)
        if includes_host:
            host_conflicts += scalar(connection, f"""
                SELECT COUNT(*)
                FROM (
                    SELECT {value_name}
                    FROM {source}
                    GROUP BY {value_name}
                    HAVING COUNT(DISTINCT host) > 1
                )
            """)
            query = f"""
                WITH deduplicated AS (
                    SELECT {id_name}, {value_name}, MIN(host) AS host
                    FROM {source}
                    GROUP BY {id_name}, {value_name}
                )
                SELECT {id_name}, {value_name},
                       CASE WHEN host IS NULL THEN NULL ELSE {id_sql('host')} END AS host_id
                FROM deduplicated
                ORDER BY {value_name}
            """
        else:
            query = f"""
                SELECT {id_name}, {value_name}
                FROM {source}
                GROUP BY {id_name}, {value_name}
                ORDER BY {value_name}
            """
        destination = output_dir / f"part-{bucket:04d}.parquet"
        copy_parquet(connection, query, destination, row_group_size)
        rows += scalar(connection, f"SELECT COUNT(*) FROM ({query})")
    return rows, collisions, host_conflicts


def create_candidates(
    connection: duckdb.DuckDBPyConnection,
    query: str,
    destination: Path,
    row_group_size: int,
) -> None:
    copy_parquet(connection, query, destination, row_group_size, partition_by="bucket")


def optimize(
    raw_root: Path,
    crawl: str,
    output_root: Path,
    temp_dir: Path,
    threads: int,
    memory_limit: str,
    row_group_size: int,
    partitions: int = 128,
) -> dict[str, Any]:
    pages_glob = raw_root / f"crawl={crawl}" / "dataset=pages" / "*.parquet"
    links_glob = raw_root / f"crawl={crawl}" / "dataset=links" / "*.parquet"
    page_files = sorted(pages_glob.parent.glob("*.parquet"))
    link_files = sorted(links_glob.parent.glob("*.parquet"))
    if not page_files or not link_files:
        raise ValueError("raw pages and links Parquet parts are required")
    if output_root.exists() and any(output_root.iterdir()):
        raise ValueError(f"optimized output directory must be empty: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    connection = duckdb.connect(str(temp_dir / "optimizer.duckdb"))
    try:
        connection.execute(f"SET threads={threads}")
        connection.execute(f"SET memory_limit={sql_literal(memory_limit)}")
        connection.execute(f"SET temp_directory={sql_literal(temp_dir.as_posix())}")
        connection.execute("SET preserve_insertion_order=false")
        # These DuckDB defaults bound partition writer state without flushing
        # every small hash bucket into thousands of tiny staging files.
        connection.execute("SET partitioned_write_max_open_files=100")
        connection.execute("SET partitioned_write_flush_threshold=524288")
        connection.execute(
            f"CREATE VIEW raw_pages AS SELECT * FROM read_parquet({sql_literal(pages_glob.as_posix())}, hive_partitioning=false)"
        )
        connection.execute(
            f"CREATE VIEW raw_links AS SELECT * FROM read_parquet({sql_literal(links_glob.as_posix())}, hive_partitioning=false)"
        )
        raw_pages = scalar(connection, "SELECT COUNT(*) FROM raw_pages")
        raw_links = scalar(connection, "SELECT COUNT(*) FROM raw_links")
        unexpected_crawl_rows = scalar(connection, f"""
            SELECT COUNT(*) FROM (
                SELECT crawl FROM raw_pages
                UNION ALL
                SELECT crawl FROM raw_links
            ) values_to_check
            WHERE crawl <> {sql_literal(crawl)}
        """)
        if unexpected_crawl_rows:
            raise RuntimeError("raw output contains a crawl other than --crawl")

        candidates_root = temp_dir / "candidates"
        urls_candidates = candidates_root / "urls"
        hosts_candidates = candidates_root / "hosts"
        anchors_candidates = candidates_root / "anchors"
        url_id = id_sql("url")
        host_id = id_sql("host")
        anchor_id = id_sql("anchor")
        create_candidates(connection, f"""
            SELECT {url_id} AS url_id, url, host,
                   {url_id} % {partitions} AS bucket
            FROM (
                SELECT source_url AS url, source_host AS host FROM raw_pages WHERE source_url IS NOT NULL
                UNION ALL SELECT source_url AS url, source_host AS host FROM raw_links WHERE source_url IS NOT NULL
                UNION ALL SELECT target_url AS url, target_host AS host FROM raw_links WHERE target_url IS NOT NULL
                UNION ALL SELECT canonical AS url, NULL AS host FROM raw_pages WHERE canonical IS NOT NULL
            ) url_values
        """, urls_candidates, row_group_size)
        create_candidates(connection, f"""
            SELECT {host_id} AS host_id, host,
                   {host_id} % {partitions} AS bucket
            FROM (
                SELECT source_host AS host FROM raw_pages WHERE source_host IS NOT NULL
                UNION ALL SELECT source_host AS host FROM raw_links WHERE source_host IS NOT NULL
                UNION ALL SELECT target_host AS host FROM raw_links WHERE target_host IS NOT NULL
            ) host_values
        """, hosts_candidates, row_group_size)
        create_candidates(connection, f"""
            SELECT {anchor_id} AS anchor_id, anchor,
                   {anchor_id} % {partitions} AS bucket
            FROM raw_links
            WHERE anchor IS NOT NULL
        """, anchors_candidates, row_group_size)

        urls_dir = output_root / "dataset=urls"
        hosts_dir = output_root / "dataset=hosts"
        anchors_dir = output_root / "dataset=anchors"
        url_rows, url_collisions, url_host_conflicts = materialize_dictionary(
            connection, urls_candidates, urls_dir, "url", partitions, row_group_size, includes_host=True
        )
        host_rows, host_collisions, _ = materialize_dictionary(
            connection, hosts_candidates, hosts_dir, "host", partitions, row_group_size
        )
        anchor_rows, anchor_collisions, _ = materialize_dictionary(
            connection, anchors_candidates, anchors_dir, "anchor", partitions, row_group_size
        )
        total_collisions = url_collisions + host_collisions + anchor_collisions
        if total_collisions:
            raise RuntimeError(f"hash ID collision detected in {total_collisions} dictionary values")
        if url_host_conflicts:
            raise RuntimeError(f"cannot encode {url_host_conflicts} URLs with conflicting raw host values")

        crawls_dir = output_root / "dataset=crawls"
        copy_parquet(connection, f"""
            SELECT CAST(1 AS USMALLINT) AS crawl_id, {sql_literal(crawl)} AS crawl
        """, crawls_dir / "crawls.parquet", row_group_size)
        source_url_id = id_sql("source_url")
        target_url_id = id_sql("target_url")
        raw_anchor_id = id_sql("anchor")
        source_bucket = f"{source_url_id} % {partitions}"
        copy_parquet(connection, f"""
            SELECT CAST(1 AS USMALLINT) AS crawl_id,
                   {source_url_id} AS source_url_id,
                   {target_url_id} AS target_url_id,
                   CASE WHEN anchor IS NULL THEN NULL ELSE {raw_anchor_id} END AS anchor_id,
                   crawled_at,
                   {source_bucket} AS source_bucket
            FROM raw_links
        """, output_root / "dataset=edges", row_group_size, partition_by="source_bucket")
        copy_parquet(connection, f"""
            SELECT CAST(1 AS USMALLINT) AS crawl_id,
                   {source_url_id} AS url_id,
                   crawled_at, status, content_type, title, description,
                   CASE WHEN canonical IS NULL THEN NULL ELSE {id_sql('canonical')} END AS canonical_url_id,
                   {source_bucket} AS source_bucket
            FROM raw_pages
        """, output_root / "dataset=pages_optimized", row_group_size, partition_by="source_bucket")

        paths = {
            "urls": urls_dir,
            "hosts": hosts_dir,
            "anchors": anchors_dir,
            "crawls": crawls_dir,
            "pages": output_root / "dataset=pages_optimized",
            "edges": output_root / "dataset=edges",
        }
        summaries = {name: dataset_summary(path) for name, path in paths.items()}
        if summaries["edges"]["rows"] != raw_links or summaries["pages"]["rows"] != raw_pages:
            raise RuntimeError("optimized Parquet row count does not equal raw row count")
        raw_bytes = sum(path.stat().st_size for path in [*page_files, *link_files])
        optimized_bytes = sum(item["bytes"] for item in summaries.values())
        manifest = {
            "crawl": crawl,
            "experimental": True,
            "raw_pages": raw_pages,
            "raw_links": raw_links,
            "raw_parquet_bytes": raw_bytes,
            "optimized_parquet_bytes": optimized_bytes,
            "reduction_ratio": round(1 - optimized_bytes / raw_bytes, 6),
            "row_group_size": row_group_size,
            "hash_partitions": partitions,
            "threads": threads,
            "memory_limit": memory_limit,
            "url_host_conflicts": url_host_conflicts,
            "hash_id_collisions": total_collisions,
            "lossless_edge_reconstruction": True,
            "id_determinism": (
                f"IDs are the first {ID_BITS} bits of SHA-256(value); every collision is rejected "
                "before pages/edges are emitted."
            ),
            "runtime_seconds": round(time.monotonic() - started, 3),
            "dictionary_rows": {"urls": url_rows, "hosts": host_rows, "anchors": anchor_rows},
            "datasets": summaries,
        }
        (output_root / "optimization-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
        )
        return manifest
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-output-dir", required=True, help="Root containing crawl=<id>/dataset=pages and links")
    parser.add_argument("--crawl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--temp-dir", required=True)
    parser.add_argument("--threads", type=int, choices=(1, 2, 4, 8), default=4)
    parser.add_argument("--memory-limit", default="3GB")
    parser.add_argument("--row-group-size", type=int, default=262_144)
    parser.add_argument("--hash-partitions", type=int, default=128)
    args = parser.parse_args(argv)
    if args.row_group_size < 1:
        parser.error("--row-group-size must be positive")
    if args.hash_partitions < 2:
        parser.error("--hash-partitions must be at least 2")
    manifest = optimize(
        Path(args.raw_output_dir), args.crawl, Path(args.output_dir), Path(args.temp_dir),
        args.threads, args.memory_limit, args.row_group_size, args.hash_partitions,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
