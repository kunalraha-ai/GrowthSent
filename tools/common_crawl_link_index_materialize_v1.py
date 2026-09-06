#!/usr/bin/env python3
"""Materialize verified R2 Links artifacts into immutable GCS index partitions.

Each task receives an exact, disjoint range from the catalog created by
``common_crawl_link_index_catalog_v1``. Every Parquet input is re-verified
against its immutable R2 bytes/SHA-256 contract before DuckDB reads it.

The task emits intermediate, target-domain-bucketed Parquet tables. A later
compaction stage can merge each bucket without re-reading R2 or WAT input.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import shutil
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import common_crawl_r2_store as r2


CATALOG_KIND = "growthsent-cc-main-2026-30-links-catalog-v1"
TASK_KIND = "growthsent-cc-main-2026-30-link-index-materialization-v1"
BUCKET_COUNT = 1024
TABLES = (
    "domain_edges",
    "referring_domains",
    "anchors",
    "top_pages",
    "page_referrers",
    "broken_backlink_candidates",
)


class MaterializeError(RuntimeError):
    """The immutable catalog, source artifact, or serving output is invalid."""


class ScratchUsageSampler:
    """Record scratch-filesystem high-water usage without retaining task data.

    A Batch task has one scratch filesystem. Sampling its used capacity lets a
    representative production-sized probe establish the necessary disk size
    before the full materialization job provisions hundreds of worker disks.
    """

    def __init__(self, directory: Path, interval_seconds: float = 1.0) -> None:
        self._directory = directory
        self._interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._total_bytes: int | None = None
        self._baseline_used_bytes: int | None = None
        self._peak_used_bytes: int | None = None
        self._final_used_bytes: int | None = None
        self._sample_count = 0

    def _sample(self) -> None:
        try:
            usage = shutil.disk_usage(self._directory)
        except OSError:
            return
        with self._lock:
            self._total_bytes = usage.total
            self._baseline_used_bytes = usage.used if self._baseline_used_bytes is None else self._baseline_used_bytes
            self._peak_used_bytes = max(usage.used, self._peak_used_bytes or usage.used)
            self._final_used_bytes = usage.used
            self._sample_count += 1

    def _run(self) -> None:
        while not self._stop_event.wait(self._interval_seconds):
            self._sample()

    def start(self) -> None:
        self._sample()
        self._thread = threading.Thread(target=self._run, name="growthsent-scratch-sampler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval_seconds * 2)
            self._thread = None
        self._sample()

    def report(self) -> dict[str, int]:
        with self._lock:
            baseline = self._baseline_used_bytes or 0
            peak = self._peak_used_bytes or baseline
            return {
                "filesystem_total_bytes": self._total_bytes or 0,
                "baseline_used_bytes": baseline,
                "peak_used_bytes": peak,
                "peak_incremental_bytes": max(0, peak - baseline),
                "final_used_bytes": self._final_used_bytes or baseline,
                "sample_count": self._sample_count,
            }


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _required_string(value: Mapping[str, Any], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item:
        raise MaterializeError(f"missing required string: {name}")
    return item


def _load_source_manifest(path: Path) -> tuple[str, str, int]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MaterializeError("source manifest cannot be read") from error
    if not isinstance(document, dict) or document.get("kind") != "common-crawl-v2-base-manifest":
        raise MaterializeError("source manifest has the wrong immutable contract")
    crawl = _required_string(document, "crawl")
    digest = _required_string(document, "manifest_sha256")
    check_document = dict(document)
    check_document.pop("manifest_sha256", None)
    inputs = document.get("inputs")
    count = document.get("input_count")
    if (
        len(digest) != 64
        or digest != _sha256_bytes(_canonical_json(check_document))
        or not isinstance(count, int)
        or count <= 0
        or not isinstance(inputs, list)
        or len(inputs) != count
        or not all(isinstance(item, str) and item for item in inputs)
        or len(set(inputs)) != len(inputs)
        or document.get("inputs_sha256") != _sha256_bytes("\n".join(inputs).encode("utf-8"))
    ):
        raise MaterializeError("source manifest contract is invalid")
    return crawl, digest, count


def _load_source_roots(path: Path, *, crawl: str) -> tuple[str, tuple[str, ...]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MaterializeError("source roots contract cannot be read") from error
    if not isinstance(document, dict) or document.get("kind") != "growthsent-cc-main-2026-30-completion-marker-roots-v1":
        raise MaterializeError("source roots contract is invalid")
    if document.get("crawl") != crawl:
        raise MaterializeError("source roots crawl does not match the locked source manifest")
    roots = document.get("roots")
    if not isinstance(roots, list) or not roots:
        raise MaterializeError("source roots must be a non-empty list")
    prefixes: list[str] = []
    for root in roots:
        if not isinstance(root, Mapping):
            raise MaterializeError("source root is invalid")
        prefix = r2.normalize_prefix(_required_string(root, "prefix"))
        if prefix in prefixes:
            raise MaterializeError("source roots contain a duplicate prefix")
        prefixes.append(prefix)
    return _sha256_bytes(_canonical_json(document)), tuple(prefixes)


def _load_catalog(
    *, bucket_name: str, object_name: str, source_manifest_sha256: str, source_count: int,
    source_roots_sha256: str, source_prefixes: tuple[str, ...]
) -> dict[str, Any]:
    try:
        from google.cloud import storage
    except ImportError as error:
        raise MaterializeError("google-cloud-storage is required") from error
    blob = storage.Client().bucket(bucket_name).blob(object_name)
    try:
        document = json.loads(blob.download_as_bytes().decode("utf-8"))
    except Exception as error:
        raise MaterializeError("catalog object cannot be read as JSON") from error
    if not isinstance(document, dict) or document.get("kind") != CATALOG_KIND:
        raise MaterializeError("catalog kind is invalid")
    recorded_digest = document.get("catalog_sha256")
    check_document = dict(document)
    check_document.pop("catalog_sha256", None)
    if not isinstance(recorded_digest, str) or recorded_digest != _sha256_bytes(_canonical_json(check_document)):
        raise MaterializeError("catalog SHA-256 is invalid")
    if (
        document.get("source_manifest_sha256") != source_manifest_sha256
        or document.get("source_roots_sha256") != source_roots_sha256
        or document.get("source_identity_count") != source_count
    ):
        raise MaterializeError("catalog does not match the locked source manifest")
    entries = document.get("entries")
    if not isinstance(entries, list) or len(entries) != source_count:
        raise MaterializeError("catalog entries do not cover the locked source range")
    for expected_index, entry in enumerate(entries):
        if not isinstance(entry, Mapping) or entry.get("source_index") != expected_index:
            raise MaterializeError("catalog entry indexes do not partition the source range")
        links = entry.get("links")
        if not isinstance(links, Mapping):
            raise MaterializeError("catalog links artifact is invalid")
        key = _required_string(links, "key")
        if not any(key.startswith(prefix) for prefix in source_prefixes):
            raise MaterializeError("catalog links artifact lies outside the reviewed source roots")
    return document


def _domain_bucket(domain: str) -> int:
    return int(hashlib.sha256(domain.encode("utf-8")).hexdigest()[:3], 16) >> 2


def _registrable_domain_resolver() -> Any:
    try:
        import tldextract
    except ImportError as error:
        raise MaterializeError("tldextract is required for external-link classification") from error
    extractor = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None, include_psl_private_domains=True)

    def resolve(host: str) -> str:
        normalized = host.strip().lower().rstrip(".")
        if not normalized:
            return ""
        try:
            return str(ipaddress.ip_address(normalized))
        except ValueError:
            pass
        result = extractor(normalized)
        value = result.top_domain_under_public_suffix
        return value.lower() if value else normalized

    return resolve


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _immutable_upload(*, bucket: Any, object_name: str, path: Path) -> dict[str, Any]:
    try:
        from google.api_core.exceptions import PreconditionFailed
    except ImportError as error:
        raise MaterializeError("google-api-core is required") from error
    digest = _sha256_file(path)
    blob = bucket.blob(object_name)
    try:
        blob.metadata = {"growthsent-sha256": digest}
        blob.upload_from_filename(path, content_type="application/vnd.apache.parquet", if_generation_match=0, checksum="crc32c")
        return {"key": object_name, "bytes": path.stat().st_size, "sha256": digest, "reused": False}
    except PreconditionFailed:
        blob.reload()
        metadata = blob.metadata or {}
        if metadata.get("growthsent-sha256") != digest or int(blob.size or -1) != path.stat().st_size:
            raise MaterializeError(f"GCS immutable output conflicts: {object_name}")
        return {"key": object_name, "bytes": path.stat().st_size, "sha256": digest, "reused": True}


def _immutable_json_upload(*, bucket: Any, object_name: str, document: Mapping[str, Any]) -> dict[str, Any]:
    try:
        from google.api_core.exceptions import PreconditionFailed
    except ImportError as error:
        raise MaterializeError("google-api-core is required") from error
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
            raise MaterializeError(f"GCS immutable output conflicts: {object_name}")
        return {"key": object_name, "bytes": len(payload), "sha256": digest, "reused": True}


def _existing_summary(bucket: Any, object_name: str, *, run_id: str, source_start: int, source_count: int) -> bool:
    blob = bucket.blob(object_name)
    if not blob.exists():
        return False
    try:
        document = json.loads(blob.download_as_bytes().decode("utf-8"))
    except Exception as error:
        raise MaterializeError("existing task summary is malformed") from error
    if not isinstance(document, dict) or document.get("kind") != TASK_KIND:
        raise MaterializeError("existing task summary conflicts with index output")
    if document.get("run_id") != run_id or document.get("source_start") != source_start or document.get("source_count") != source_count:
        raise MaterializeError("existing task summary has a different source identity")
    return True


def _download_inputs(*, store: r2.R2Store, entries: list[Mapping[str, Any]], directory: Path) -> list[Path]:
    paths: list[Path] = []
    for entry in entries:
        links = entry.get("links")
        if not isinstance(links, Mapping):
            raise MaterializeError("catalog links artifact is invalid")
        key = _required_string(links, "key")
        bytes_count = links.get("bytes")
        digest = _required_string(links, "sha256")
        if not isinstance(bytes_count, int) or bytes_count <= 0 or len(digest) != 64:
            raise MaterializeError("catalog links immutable contract is invalid")
        path = directory / f"source-{int(entry['source_index']):05d}.parquet"
        store.download_verified_file(key, path, bytes_count=bytes_count, sha256=digest)
        paths.append(path)
    return paths


def _write_host_domain_map(*, connection: Any, links_relation: str, path: Path) -> int:
    import pyarrow as pa
    import pyarrow.parquet as pq

    resolver = _registrable_domain_resolver()
    relation = connection.execute(
        "SELECT DISTINCT host FROM ("
        f"SELECT lower(trim(source_host)) AS host FROM {links_relation} WHERE source_host IS NOT NULL "
        "UNION "
        f"SELECT lower(trim(target_host)) AS host FROM {links_relation} WHERE target_host IS NOT NULL"
        ") WHERE host <> ''"
    )
    reader = relation.fetch_record_batch(rows_per_batch=100_000)
    writer: Any | None = None
    total = 0
    try:
        for batch in reader:
            hosts = [str(item) for item in batch.column(0).to_pylist()]
            table = pa.table({"host": hosts, "registrable_domain": [resolver(host) for host in hosts]})
            if writer is None:
                writer = pq.ParquetWriter(path, table.schema, compression="zstd")
            writer.write_table(table)
            total += len(hosts)
    finally:
        if writer is not None:
            writer.close()
    if writer is None:
        raise MaterializeError("no valid hosts found in selected Links artifacts")
    return total


def _copy_partitioned_tables(*, connection: Any, links_relation: str, host_map: Path, output_directory: Path) -> dict[str, int]:
    output_directory.mkdir(parents=True, exist_ok=True)
    host_map_sql = _sql_literal(str(host_map))
    connection.execute(
        "CREATE TABLE classified AS "
        "SELECT source_map.registrable_domain AS source_domain, target_map.registrable_domain AS target_domain, "
        "raw.source_url, raw.target_url, coalesce(raw.anchor, '') AS anchor "
        f"FROM {links_relation} AS raw "
        f"JOIN read_parquet({host_map_sql}) AS source_map ON lower(trim(raw.source_host)) = source_map.host "
        f"JOIN read_parquet({host_map_sql}) AS target_map ON lower(trim(raw.target_host)) = target_map.host "
        "WHERE source_map.registrable_domain <> '' AND target_map.registrable_domain <> '' "
        "AND source_map.registrable_domain <> target_map.registrable_domain "
        "AND raw.target_url IS NOT NULL AND trim(raw.target_url) <> ''"
    )
    queries = {
        "domain_edges": "SELECT source_domain, target_domain, count(*)::BIGINT AS link_count FROM classified GROUP BY source_domain, target_domain",
        "referring_domains": "SELECT target_domain, source_domain, count(*)::BIGINT AS link_count FROM classified GROUP BY target_domain, source_domain",
        "anchors": "SELECT target_domain, anchor, count(*)::BIGINT AS link_count FROM classified GROUP BY target_domain, anchor",
        "top_pages": "SELECT target_domain, target_url, count(*)::BIGINT AS link_count FROM classified GROUP BY target_domain, target_url",
        "page_referrers": "SELECT target_domain, target_url, source_domain, count(*)::BIGINT AS link_count FROM classified GROUP BY target_domain, target_url, source_domain",
        "broken_backlink_candidates": "SELECT target_domain, target_url, source_domain, source_url, count(*)::BIGINT AS link_count FROM classified GROUP BY target_domain, target_url, source_domain, source_url",
    }
    counts: dict[str, int] = {}
    for name, query in queries.items():
        target = output_directory / name
        target_sql = _sql_literal(str(target))
        aggregate_name = f"aggregate_{name}"
        connection.execute(f"CREATE TEMP TABLE {aggregate_name} AS {query}")
        counts[name] = int(connection.execute(f"SELECT count(*) FROM {aggregate_name}").fetchone()[0])
        connection.execute(
            "COPY (SELECT *, "
            "(CAST('0x' || substr(sha256(target_domain), 1, 3) AS BIGINT) >> 2)::INTEGER AS target_bucket "
            f"FROM {aggregate_name}) "
            f"TO {target_sql} (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (target_bucket), OVERWRITE_OR_IGNORE TRUE)"
        )
        connection.execute(f"DROP TABLE {aggregate_name}")
    return counts


def materialize(
    *, source_manifest: Path, source_roots: Path, gcs_bucket: str, catalog_object: str, run_id: str, output_prefix: str,
    source_start: int, source_count: int, shard_id: int, shard_count: int, work_dir: Path
) -> dict[str, Any]:
    if not run_id or source_start < 0 or source_count <= 0 or shard_id < 0 or shard_count <= 0:
        raise MaterializeError("task parameters are invalid")
    crawl, manifest_sha256, total_sources = _load_source_manifest(source_manifest)
    roots_sha256, allowed_prefixes = _load_source_roots(source_roots, crawl=crawl)
    if source_start + source_count > total_sources:
        raise MaterializeError("source selection exceeds the locked catalog range")
    try:
        from google.cloud import storage
        import duckdb
    except ImportError as error:
        raise MaterializeError("DuckDB and google-cloud-storage are required") from error
    bucket = storage.Client().bucket(gcs_bucket)
    normalized_output = output_prefix.strip("/")
    if not normalized_output:
        raise MaterializeError("output prefix is invalid")
    summary_key = f"{normalized_output}/task-manifests/shard={shard_id:05d}.json"
    if _existing_summary(bucket, summary_key, run_id=run_id, source_start=source_start, source_count=source_count):
        return {"status": "reused", "task_summary": summary_key, "source_count": source_count}
    catalog = _load_catalog(
        bucket_name=gcs_bucket,
        object_name=catalog_object,
        source_manifest_sha256=manifest_sha256,
        source_count=total_sources,
        source_roots_sha256=roots_sha256,
        source_prefixes=allowed_prefixes,
    )
    selected_entries = catalog["entries"][source_start : source_start + source_count]
    if len(selected_entries) != source_count:
        raise MaterializeError("catalog source selection is incomplete")
    store = r2.R2Store.from_environment(allowed_prefixes=allowed_prefixes, credential_prefix="GROWTHSENT_R2_INPUT_READ_")
    temporary_root = work_dir / f"shard-{shard_id:05d}"
    shutil.rmtree(temporary_root, ignore_errors=True)
    links_dir = temporary_root / "links"
    local_output = temporary_root / "output"
    work_dir.mkdir(parents=True, exist_ok=True)
    scratch_sampler = ScratchUsageSampler(work_dir)
    started_at = time.monotonic()
    scratch_sampler.start()
    try:
        source_links_bytes = sum(int(entry["links"]["bytes"]) for entry in selected_entries)
        paths = _download_inputs(store=store, entries=selected_entries, directory=links_dir)
        files_sql = "[" + ",".join(_sql_literal(str(path)) for path in paths) + "]"
        connection = duckdb.connect(str(temporary_root / "index.duckdb"))
        try:
            connection.execute("SET memory_limit='26GB'")
            connection.execute("SET threads=4")
            connection.execute("SET max_temp_directory_size='300GB'")
            links_relation = f"read_parquet({files_sql}, union_by_name=true)"
            host_map = temporary_root / "host-domains.parquet"
            host_count = _write_host_domain_map(connection=connection, links_relation=links_relation, path=host_map)
            table_counts = _copy_partitioned_tables(connection=connection, links_relation=links_relation, host_map=host_map, output_directory=local_output)
        finally:
            connection.close()
        artifacts: dict[str, list[dict[str, Any]]] = {name: [] for name in TABLES}
        for table_name in TABLES:
            table_root = local_output / table_name
            if not table_root.exists():
                continue
            for parquet_file in sorted(table_root.rglob("*.parquet")):
                bucket_directory = parquet_file.parent.name
                if not bucket_directory.startswith("target_bucket="):
                    raise MaterializeError("DuckDB output lacks target bucket partition")
                target_bucket = int(bucket_directory.split("=", 1)[1])
                if target_bucket < 0 or target_bucket >= BUCKET_COUNT:
                    raise MaterializeError("target bucket is out of range")
                destination = f"{normalized_output}/intermediate/table={table_name}/target_bucket={target_bucket:04d}/source_shard={shard_id:05d}/part.parquet"
                artifacts[table_name].append(_immutable_upload(bucket=bucket, object_name=destination, path=parquet_file))
        scratch_sampler.stop()
        artifact_bytes_by_table = {
            table_name: sum(int(artifact["bytes"]) for artifact in table_artifacts)
            for table_name, table_artifacts in artifacts.items()
        }
        summary: dict[str, Any] = {
            "format_version": 1,
            "kind": TASK_KIND,
            "crawl": crawl,
            "run_id": run_id,
            "catalog_object": catalog_object,
            "catalog_sha256": catalog["catalog_sha256"],
            "source_manifest_sha256": manifest_sha256,
            "source_roots_sha256": roots_sha256,
            "source_start": source_start,
            "source_count": source_count,
            "source_end_exclusive": source_start + source_count,
            "shard_id": shard_id,
            "shard_count": shard_count,
            "host_count": host_count,
            "external_classification": {
                "method": "registrable-domain comparison",
                "psl": "tldextract bundled snapshot; private suffixes enabled; no network PSL fetch"
            },
            "resource_observation": {
                "elapsed_seconds": round(time.monotonic() - started_at, 3),
                "source_links_bytes": source_links_bytes,
                "artifact_bytes_by_table": artifact_bytes_by_table,
                "artifact_total_bytes": sum(artifact_bytes_by_table.values()),
                "scratch": scratch_sampler.report(),
            },
            "table_row_counts": table_counts,
            "artifacts": artifacts,
        }
        summary["summary_sha256"] = _sha256_bytes(_canonical_json(summary))
        summary_result = _immutable_json_upload(bucket=bucket, object_name=summary_key, document=summary)
        return {"status": "published", "task_summary": summary_result, "source_count": source_count, "table_row_counts": table_counts}
    finally:
        scratch_sampler.stop()
        shutil.rmtree(temporary_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--source-roots", required=True, type=Path)
    parser.add_argument("--gcs-bucket", required=True)
    parser.add_argument("--catalog-object", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--source-start", required=True, type=int)
    parser.add_argument("--source-count", required=True, type=int)
    parser.add_argument("--shard-id", required=True, type=int)
    parser.add_argument("--shard-count", required=True, type=int)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = materialize(
            source_manifest=args.source_manifest,
            source_roots=args.source_roots,
            gcs_bucket=args.gcs_bucket,
            catalog_object=args.catalog_object,
            run_id=args.run_id,
            output_prefix=args.output_prefix,
            source_start=args.source_start,
            source_count=args.source_count,
            shard_id=args.shard_id,
            shard_count=args.shard_count,
            work_dir=args.work_dir,
        )
    except (MaterializeError, r2.R2StoreError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, sort_keys=True), flush=True)
        return 1
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
