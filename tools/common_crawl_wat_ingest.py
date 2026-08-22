#!/usr/bin/env python3
"""Streaming Common Crawl WAT ingestion into GrowthSent parquet datasets.

This command intentionally has no database dependency.  It writes deterministic
per-input parquet parts locally and, only when --upload is explicitly supplied,
copies those finalized parts to S3.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import gzip
import hashlib
import json
import logging
import random
import time
import re
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.parquet as pq


PAGES_SCHEMA = pa.schema([
    pa.field("crawl", pa.string()), pa.field("source_url", pa.string()),
    pa.field("source_host", pa.string()), pa.field("crawled_at", pa.timestamp("ms")),
    pa.field("status", pa.string()), pa.field("content_type", pa.string()),
    pa.field("title", pa.string()), pa.field("description", pa.string()),
    pa.field("canonical", pa.string()),
])
LINKS_SCHEMA = pa.schema([
    pa.field("crawl", pa.string()), pa.field("source_url", pa.string()),
    pa.field("source_host", pa.string()), pa.field("target_url", pa.string()),
    pa.field("target_host", pa.string()), pa.field("anchor", pa.string()),
    pa.field("crawled_at", pa.timestamp("ms")),
])
MOJIBAKE_MARKERS = ("Ã", "Â", "â", "ð", "ï¿½")
SCHEMED_URL = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
MAX_SAFE_INPUTS = 1_000
SOURCE_GET_MAX_ATTEMPTS = 8
SOURCE_RETRY_INITIAL_DELAY_SECONDS = 2.0
SOURCE_RETRY_MAX_DELAY_SECONDS = 45.0
SOURCE_S3_CONNECT_TIMEOUT_SECONDS = 10
SOURCE_S3_READ_TIMEOUT_SECONDS = 120
SOURCE_RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
SOURCE_RETRYABLE_S3_CODES = frozenset({
    "SlowDown", "RequestTimeout", "RequestTimeoutException", "ServiceUnavailable",
    "InternalError", "Throttling", "ThrottlingException",
})


@dataclass
class Metrics:
    input: str
    input_bytes: int = 0
    pages_emitted: int = 0
    links_emitted: int = 0
    output_bytes: int = 0
    records_seen: int = 0
    malformed_records: int = 0
    malformed_json: int = 0
    malformed_warc: int = 0
    encoding_repairs: int = 0
    failures: list[str] = field(default_factory=list)
    runtime_seconds: float = 0.0

    def report(self) -> dict[str, Any]:
        data = asdict(self)
        data["reduction_ratio"] = (
            round(1 - self.output_bytes / self.input_bytes, 6) if self.input_bytes else None
        )
        return data


def text(value: Any, metrics: Metrics | None = None, repair: bool = True) -> str | None:
    """Return a stable, UTF-8-safe scalar and safely repair likely double decoding."""
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple)):
        value = "; ".join(str(item) for item in value) if not isinstance(value, dict) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    value = str(value).replace("\x00", "")
    if not repair or not any(marker in value for marker in MOJIBAKE_MARKERS):
        return value
    # A latin-1 -> utf-8 round trip is only accepted if it removes symptoms;
    # this avoids corrupting valid non-Latin text that merely contains a marker.
    try:
        fixed = value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    before = sum(value.count(marker) for marker in MOJIBAKE_MARKERS)
    after = sum(fixed.count(marker) for marker in MOJIBAKE_MARKERS)
    if after < before:
        if metrics:
            metrics.encoding_repairs += 1
        return fixed
    return value


def parse_timestamp(value: Any) -> datetime | None:
    value = text(value)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None)
    except ValueError:
        return None


def host(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return urlparse(value).hostname
    except (TypeError, ValueError):
        return None


def dict_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def iter_wat_json(stream: BinaryIO, metrics: Metrics) -> Iterator[dict[str, Any]]:
    """Yield JSON WARC payloads without ever retaining an entire WAT file.

    WAT records are identified by their `Content-Type: application/json` and
    read by byte Content-Length, rather than decoding the compressed stream as
    text (which makes Content-Length unsafe for non-ASCII payloads).
    """
    while True:
        line = stream.readline()
        if not line:
            return
        if line.strip().lower() != b"content-type: application/json":
            continue
        content_length: int | None = None
        header_ok = False
        while True:
            header = stream.readline()
            if not header:
                metrics.malformed_warc += 1
                return
            if header in (b"\n", b"\r\n"):
                header_ok = True
                break
            if header.lower().startswith(b"content-length:"):
                try:
                    content_length = int(header.split(b":", 1)[1].strip())
                except (ValueError, IndexError):
                    metrics.malformed_warc += 1
        if not header_ok or content_length is None or content_length < 0:
            metrics.malformed_warc += 1
            continue
        payload = stream.read(content_length)
        if len(payload) != content_length:
            metrics.malformed_warc += 1
            return
        metrics.records_seen += 1
        try:
            decoded = payload.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            metrics.malformed_json += 1
            continue
        if isinstance(value, dict):
            yield value
        else:
            metrics.malformed_records += 1


def rows_from_record(record: dict[str, Any], crawl: str, metrics: Metrics) -> tuple[dict[str, Any], Iterator[dict[str, Any]]] | None:
    envelope = record.get("Envelope")
    if not isinstance(envelope, dict):
        metrics.malformed_records += 1
        return None
    payload = envelope.get("Payload-Metadata")
    warc = envelope.get("WARC-Header-Metadata")
    if not isinstance(payload, dict) or not isinstance(warc, dict):
        metrics.malformed_records += 1
        return None
    http = payload.get("HTTP-Response-Metadata")
    # URLs are protocol data, not display text.  Reinterpreting their bytes can
    # turn a (possibly odd but valid) URL into a syntactically invalid one.
    source_url = text(warc.get("WARC-Target-URI"), metrics, repair=False)
    if not isinstance(http, dict) or not source_url:
        return None
    source_host = host(source_url)
    crawled_at = parse_timestamp(warc.get("WARC-Date"))
    html = http.get("HTML-Metadata") if isinstance(http.get("HTML-Metadata"), dict) else {}
    head = html.get("Head") if isinstance(html.get("Head"), dict) else {}
    description = None
    for meta in dict_list(head.get("Metas")):
        if (text(meta.get("name")) or "").lower() == "description":
            description = text(meta.get("content"), metrics)
            break
    canonical = None
    for head_link in dict_list(head.get("Link")):
        if (text(head_link.get("rel")) or "").lower() == "canonical":
            canonical = text(head_link.get("url"), metrics, repair=False)
            break
    response = http.get("Response-Message") if isinstance(http.get("Response-Message"), dict) else {}
    headers = http.get("Headers") if isinstance(http.get("Headers"), dict) else {}
    page = {
        "crawl": crawl, "source_url": source_url, "source_host": source_host,
        "crawled_at": crawled_at, "status": text(response.get("Status"), metrics),
        "content_type": text(headers.get("Content-Type"), metrics),
        "title": text(head.get("Title"), metrics), "description": description,
        "canonical": canonical,
    }

    def links() -> Iterator[dict[str, Any]]:
        for link in dict_list(html.get("Links")):
            if text(link.get("path"), repair=False) != "A@/href":
                continue
            target = text(link.get("url"), metrics, repair=False)
            if not target:
                continue
            try:
                target_url = urljoin(source_url, target)
                target_host = host(target_url)
            except (TypeError, ValueError):
                # Python's current URL parser rejects some historical absolute
                # Common Crawl targets (for example `http://＃`).  Keep an
                # already-schemed target verbatim with no host rather than
                # dropping a real archive link; unsafe relative URLs are still
                # discarded because they cannot be resolved correctly.
                if SCHEMED_URL.match(target) and "[" not in target and "]" not in target:
                    target_url, target_host = target, None
                else:
                    metrics.malformed_records += 1
                    continue
            yield {
                "crawl": crawl, "source_url": source_url, "source_host": source_host,
                "target_url": target_url, "target_host": target_host,
                "anchor": text(link.get("text"), metrics), "crawled_at": crawled_at,
            }
    return page, links()


class BufferedParquetWriter:
    def __init__(self, path: Path, schema: pa.Schema, batch_size: int):
        self.path, self.schema, self.batch_size = path, schema, batch_size
        self.rows: list[dict[str, Any]] = []
        self.writer = pq.ParquetWriter(path, schema, compression="snappy")

    def add(self, row: dict[str, Any]) -> None:
        self.rows.append(row)
        if len(self.rows) >= self.batch_size:
            self.flush()

    def flush(self) -> None:
        if self.rows:
            self.writer.write_table(pa.Table.from_pylist(self.rows, schema=self.schema))
            self.rows.clear()

    def close(self) -> None:
        self.flush()
        self.writer.close()


def input_key(path: str) -> str:
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:16]


def inputs_sha256(sources: list[str]) -> str:
    """Return a stable digest for the ordered bounded input scope."""
    return hashlib.sha256("\n".join(sources).encode("utf-8")).hexdigest()


def validate_input_scope(sources: list[str], max_inputs: int | None,
                         required_source_prefix: str | None = None) -> None:
    """Reject unbounded or unexpectedly sourced work before any WAT reads."""
    if max_inputs is not None and max_inputs > MAX_SAFE_INPUTS:
        raise ValueError(f"--max-inputs may not exceed the safety ceiling of {MAX_SAFE_INPUTS}")
    if len(sources) > MAX_SAFE_INPUTS:
        raise ValueError(f"input scope may not exceed the safety ceiling of {MAX_SAFE_INPUTS}")
    if required_source_prefix:
        unexpected = next((source for source in sources if not source.startswith(required_source_prefix)), None)
        if unexpected:
            raise ValueError(
                f"input does not match --require-source-prefix {required_source_prefix!r}: {unexpected}"
            )


def retry(operation, label: str, attempts: int = 5):
    for attempt in range(attempts):
        try:
            return operation()
        except Exception:
            if attempt == attempts - 1:
                raise
            delay = min(20.0, (2 ** attempt) + random.random())
            logging.warning("%s failed (attempt %s/%s); retrying in %.1fs", label, attempt + 1, attempts, delay)
            time.sleep(delay)


def is_retryable_source_error(error: Exception) -> bool:
    """Return whether a source-read failure can be retried without a tight loop."""
    if isinstance(error, HTTPError):
        return error.code in SOURCE_RETRYABLE_HTTP_STATUSES
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return False
    error_code = str(response.get("Error", {}).get("Code") or "")
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return error_code in SOURCE_RETRYABLE_S3_CODES or status in SOURCE_RETRYABLE_HTTP_STATUSES


def retry_source_read(operation, label: str, attempts: int = SOURCE_GET_MAX_ATTEMPTS):
    """Bound retries for transient Common Crawl source failures.

    Eight outer GetObject attempts are allowed.  Delays begin at two seconds,
    grow exponentially with positive jitter, and are capped at 45 seconds.
    This bounds wait time between attempts while avoiding a synchronized retry
    storm when Common Crawl responds with SlowDown or 503.
    """
    if attempts < 1:
        raise ValueError("source retry attempts must be positive")
    for attempt in range(attempts):
        try:
            return operation()
        except Exception as error:
            if not is_retryable_source_error(error) or attempt == attempts - 1:
                raise
            base_delay = min(SOURCE_RETRY_MAX_DELAY_SECONDS, SOURCE_RETRY_INITIAL_DELAY_SECONDS * (2 ** attempt))
            jitter = random.uniform(0.0, min(5.0, base_delay * 0.25))
            delay = min(SOURCE_RETRY_MAX_DELAY_SECONDS, base_delay + jitter)
            logging.warning(
                "%s retryable source error %s (attempt %s/%s); retrying in %.1fs",
                label, type(error).__name__, attempt + 1, attempts, delay,
            )
            time.sleep(delay)


def s3_client(
    unsigned: bool = False,
    *,
    retries: dict[str, Any] | None = None,
    connect_timeout: int | None = None,
    read_timeout: int | None = None,
):
    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError("boto3 is required for S3 inputs or uploads; install requirements-common-crawl.txt") from error
    config_values: dict[str, Any] = {}
    if unsigned:
        config_values["signature_version"] = UNSIGNED
    if retries is not None:
        config_values["retries"] = retries
    if connect_timeout is not None:
        config_values["connect_timeout"] = connect_timeout
    if read_timeout is not None:
        config_values["read_timeout"] = read_timeout
    return boto3.client("s3", config=Config(**config_values) if config_values else None)


@contextmanager
def open_input(path: str, metrics: Metrics, source_bucket: str, source_unsigned: bool = True,
               source_url_base: str = "https://data.commoncrawl.org/",
               source_s3_bucket: str | None = None) -> Iterator[BinaryIO]:
    local = Path(path)
    if path.startswith("s3://"):
        if path.startswith("s3://"):
            bucket, key = path[5:].split("/", 1)
        client = s3_client(unsigned=source_unsigned and bucket == source_bucket)
        response = retry(lambda: client.get_object(Bucket=bucket, Key=key), f"download {path}")
        metrics.input_bytes = int(response.get("ContentLength") or 0)
        body = response["Body"]
        try:
            with gzip.GzipFile(fileobj=body, mode="rb") as stream:
                yield stream
        finally:
            body.close()
    elif local.exists():
        metrics.input_bytes = local.stat().st_size
        with gzip.open(local, "rb") as stream:
            yield stream
    elif source_s3_bucket:
        # Keep the locked bare manifest key as metrics.input and as the
        # deterministic output suffix source.  Only its transport changes.
        client = s3_client(
            unsigned=False,
            retries={"mode": "standard", "total_max_attempts": 1},
            connect_timeout=SOURCE_S3_CONNECT_TIMEOUT_SECONDS,
            read_timeout=SOURCE_S3_READ_TIMEOUT_SECONDS,
        )
        response = retry_source_read(
            lambda: client.get_object(Bucket=source_s3_bucket, Key=path),
            f"download s3://{source_s3_bucket}/{path}",
        )
        metrics.input_bytes = int(response.get("ContentLength") or 0)
        body = response["Body"]
        try:
            with gzip.GzipFile(fileobj=body, mode="rb") as stream:
                yield stream
        finally:
            body.close()
    else:
        # Common Crawl's public data endpoint permits HTTPS streaming while its
        # S3 API may deny anonymous requests. Path-list object keys use this
        # route by default; no WAT object is staged in memory or on disk.
        url = source_url_base.rstrip("/") + "/" + path.lstrip("/")
        response = retry(lambda: urlopen(Request(url), timeout=120), f"download {path}")
        metrics.input_bytes = int(response.headers.get("Content-Length") or 0)
        try:
            with gzip.GzipFile(fileobj=response, mode="rb") as stream:
                yield stream
        finally:
            response.close()


def upload(local: Path, bucket: str, key: str, content_type: str) -> None:
    client = s3_client()
    retry(lambda: client.upload_file(str(local), bucket, key, ExtraArgs={"ContentType": content_type}), f"upload {key}")


def ingest_one(crawl: str, source: str, output_root: Path, batch_size: int, resume: bool,
               source_bucket: str = "commoncrawl", source_unsigned: bool = True,
               source_url_base: str = "https://data.commoncrawl.org/",
               source_s3_bucket: str | None = None) -> Metrics:
    started = time.monotonic()
    metrics = Metrics(input=source)
    part = input_key(source)
    directory = output_root / f"crawl={crawl}"
    pages_path = directory / "dataset=pages" / f"part-{part}.parquet"
    links_path = directory / "dataset=links" / f"part-{part}.parquet"
    report_path = directory / "metrics" / f"part-{part}.json"
    if resume and pages_path.exists() and links_path.exists() and report_path.exists():
        saved = json.loads(report_path.read_text(encoding="utf-8"))
        logging.info("resuming: local completed part exists for %s", source)
        return Metrics(**{key: saved[key] for key in Metrics.__dataclass_fields__ if key in saved})
    for parent in (pages_path.parent, links_path.parent, report_path.parent):
        parent.mkdir(parents=True, exist_ok=True)
    pages_tmp, links_tmp = pages_path.with_suffix(".parquet.tmp"), links_path.with_suffix(".parquet.tmp")
    for temp in (pages_tmp, links_tmp):
        temp.unlink(missing_ok=True)
    pages_writer = BufferedParquetWriter(pages_tmp, PAGES_SCHEMA, batch_size)
    links_writer = BufferedParquetWriter(links_tmp, LINKS_SCHEMA, batch_size)
    try:
        with open_input(source, metrics, source_bucket, source_unsigned, source_url_base, source_s3_bucket) as stream:
            for record in iter_wat_json(stream, metrics):
                rows = rows_from_record(record, crawl, metrics)
                if rows is None:
                    continue
                page, links = rows
                pages_writer.add(page)
                metrics.pages_emitted += 1
                for link in links:
                    links_writer.add(link)
                    metrics.links_emitted += 1
        pages_writer.close()
        links_writer.close()
        pages_tmp.replace(pages_path)
        links_tmp.replace(links_path)
    except Exception as error:
        metrics.failures.append(f"{type(error).__name__}: {error}")
        pages_writer.writer.close()
        links_writer.writer.close()
        raise
    finally:
        metrics.runtime_seconds = round(time.monotonic() - started, 3)
    metrics.output_bytes = pages_path.stat().st_size + links_path.stat().st_size
    report_path.write_text(json.dumps(metrics.report(), indent=2, sort_keys=True), encoding="utf-8")
    return metrics


def _ingest_task(task: tuple[str, str, str, int, bool, str, bool, str, str | None]) -> dict[str, Any]:
    """Process-pool entry point; each task owns distinct deterministic parts."""
    crawl, source, output_dir, batch_size, resume, source_bucket, source_unsigned, source_url_base, source_s3_bucket = task
    try:
        return ingest_one(
            crawl, source, Path(output_dir), batch_size, resume, source_bucket, source_unsigned,
            source_url_base, source_s3_bucket,
        ).report()
    except Exception as error:
        return Metrics(input=source, failures=[f"{type(error).__name__}: {error}"]).report()


def ingest_many(crawl: str, sources: list[str], output_root: Path, batch_size: int, resume: bool,
                source_bucket: str, workers: int, source_unsigned: bool = True,
                source_url_base: str = "https://data.commoncrawl.org/",
                on_complete: Callable[[str, dict[str, Any]], None] | None = None,
                source_s3_bucket: str | None = None) -> list[dict[str, Any]]:
    """Ingest independent WAT inputs concurrently while preserving input order.

    A source hashes to one pages part and one links part, so no two workers
    write the same files.  ProcessPoolExecutor.map preserves source ordering in
    the returned reports, keeping aggregate output deterministic.
    """
    if workers not in (1, 2, 4, 8):
        raise ValueError("workers must be one of: 1, 2, 4, 8")
    if len(set(sources)) != len(sources):
        raise ValueError("duplicate --input values are not allowed because they map to the same deterministic part")
    tasks = [
        (crawl, source, str(output_root), batch_size, resume, source_bucket, source_unsigned,
         source_url_base, source_s3_bucket)
        for source in sources
    ]
    if workers == 1:
        reports = []
        for source, task in zip(sources, tasks):
            report = _ingest_task(task)
            reports.append(report)
            if on_complete:
                on_complete(source, report)
        return reports
    with ProcessPoolExecutor(max_workers=min(workers, len(tasks))) as executor:
        futures = {executor.submit(_ingest_task, task): (index, source)
                   for index, (source, task) in enumerate(zip(sources, tasks))}
        reports: list[dict[str, Any] | None] = [None] * len(tasks)
        for future in as_completed(futures):
            index, source = futures[future]
            report = future.result()
            reports[index] = report
            if on_complete:
                on_complete(source, report)
    return [report for report in reports if report is not None]


def aggregate_metrics(reports: list[dict[str, Any]], wall_runtime_seconds: float) -> dict[str, Any]:
    return {
        "files": len(reports),
        "input_bytes": sum(int(report.get("input_bytes") or 0) for report in reports),
        "pages_emitted": sum(int(report.get("pages_emitted") or 0) for report in reports),
        "links_emitted": sum(int(report.get("links_emitted") or 0) for report in reports),
        "output_bytes": sum(int(report.get("output_bytes") or 0) for report in reports),
        "records_seen": sum(int(report.get("records_seen") or 0) for report in reports),
        "malformed_records": sum(int(report.get("malformed_records") or 0) for report in reports),
        "malformed_json": sum(int(report.get("malformed_json") or 0) for report in reports),
        "malformed_warc": sum(int(report.get("malformed_warc") or 0) for report in reports),
        "encoding_repairs": sum(int(report.get("encoding_repairs") or 0) for report in reports),
        "failed_inputs": sum(1 for report in reports if report.get("failures")),
        "worker_runtime_seconds": round(sum(float(report.get("runtime_seconds") or 0) for report in reports), 3),
        "wall_runtime_seconds": round(wall_runtime_seconds, 3),
        "reduction_ratio": (
            round(1 - sum(int(report.get("output_bytes") or 0) for report in reports) /
                  sum(int(report.get("input_bytes") or 0) for report in reports), 6)
            if sum(int(report.get("input_bytes") or 0) for report in reports) else None
        ),
    }


def parse_s3_destination(value: str) -> tuple[str, str]:
    if not value.startswith("s3://") or "/" not in value[5:]:
        raise ValueError("destination must be an s3://bucket/prefix URI")
    bucket, prefix = value[5:].split("/", 1)
    return bucket, prefix.strip("/")


def output_key(prefix: str, crawl: str, dataset: str, filename: str) -> str:
    return "/".join(filter(None, [prefix, f"crawl={crawl}", f"dataset={dataset}", filename]))


def control_key(prefix: str, filename: str) -> str:
    return "/".join(filter(None, [prefix, "control", filename]))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def local_artifacts(output_root: Path, crawl: str, source: str) -> list[tuple[str, Path, str]]:
    part = input_key(source)
    root = output_root / f"crawl={crawl}"
    return [
        ("pages", root / "dataset=pages" / f"part-{part}.parquet", "application/vnd.apache.parquet"),
        ("links", root / "dataset=links" / f"part-{part}.parquet", "application/vnd.apache.parquet"),
        ("metrics", root / "metrics" / f"part-{part}.json", "application/json"),
    ]


def upload_artifacts(output_root: Path, crawl: str, source: str, bucket: str, prefix: str) -> None:
    for dataset, local, content_type in local_artifacts(output_root, crawl, source):
        if not local.exists():
            raise RuntimeError(f"cannot upload missing finalized artifact: {local}")
        upload(local, bucket, output_key(prefix, crawl, dataset, local.name), content_type)


def remove_local_artifacts(output_root: Path, crawl: str, source: str) -> None:
    """Release only deterministic artifacts that were already finalized and published."""
    for _, local, _ in local_artifacts(output_root, crawl, source):
        if not local.exists():
            raise RuntimeError(f"cannot remove missing finalized artifact: {local}")
        local.unlink()


def upload_control_json(path: Path, bucket: str, prefix: str) -> None:
    upload(path, bucket, control_key(prefix, path.name), "application/json")


def manifest_can_be_promoted(existing: dict[str, Any], requested: dict[str, Any]) -> bool:
    """Allow only an exact manifest or a verified ordered-prefix promotion.

    A one-file production smoke test may publish the first deterministic part
    before the approved bounded run.  The full run may then promote that
    manifest only when the smoke input is a strict ordered prefix of its locked
    input list.  A different or shorter scope can never reuse the prefix.
    """
    existing_inputs = existing.get("inputs")
    requested_inputs = requested.get("inputs")
    if not isinstance(existing_inputs, list) or not isinstance(requested_inputs, list):
        return False
    if any(not isinstance(value, str) for value in existing_inputs + requested_inputs):
        return False
    if existing.get("crawl") != requested.get("crawl"):
        return False
    if existing.get("input_count") != len(existing_inputs):
        return False
    if existing.get("inputs_sha256") != inputs_sha256(existing_inputs):
        return False
    return existing_inputs == requested_inputs[:len(existing_inputs)]


def remote_control_json(bucket: str, prefix: str, filename: str) -> dict[str, Any] | None:
    client = s3_client()
    try:
        response = client.get_object(Bucket=bucket, Key=control_key(prefix, filename))
        with response["Body"] as body:
            value = json.loads(body.read().decode("utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError(f"remote control object is not a JSON object: {filename}")
        return value
    except Exception as error:
        response = getattr(error, "response", None)
        code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
        if str(code) in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise


def remote_report(crawl: str, source: str, bucket: str, prefix: str) -> dict[str, Any] | None:
    """Return an already-published metric only when every deterministic part exists."""
    client = s3_client()
    artifacts = [(dataset, local, output_key(prefix, crawl, dataset, local.name))
                 for dataset, local, _ in local_artifacts(Path("."), crawl, source)]
    try:
        for _, _, key in artifacts:
            client.head_object(Bucket=bucket, Key=key)
        metric_key = artifacts[-1][2]
        response = client.get_object(Bucket=bucket, Key=metric_key)
        with response["Body"] as body:
            report = json.loads(body.read().decode("utf-8"))
        if report.get("input") != source:
            raise RuntimeError(f"remote metric source mismatch for {source}")
        return report
    except Exception as error:
        response = getattr(error, "response", None)
        code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
        if str(code) in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise


def input_sources(inputs: list[str], input_list: str | None, max_inputs: int | None) -> list[str]:
    sources = list(inputs)
    if input_list:
        opener = gzip.open if input_list.endswith(".gz") else open
        with opener(input_list, "rt", encoding="utf-8") as handle:
            sources.extend(line.strip() for line in handle if line.strip())
    if max_inputs is not None:
        sources = sources[:max_inputs]
    if not sources:
        raise ValueError("provide --input or --input-list with at least one path")
    return sources


def progress_snapshot(crawl: str, total_inputs: int, remote_recovered: int,
                      attempt_reports: list[dict[str, Any]], elapsed_seconds: float,
                      event: str) -> dict[str, Any]:
    """Return a small, machine-readable view of the active bounded run."""
    attempted_now = len(attempt_reports)
    failures_now = sum(1 for report in attempt_reports if report.get("failures"))
    succeeded_now = attempted_now - failures_now
    attempted_total = remote_recovered + attempted_now
    successful_total = remote_recovered + succeeded_now
    aggregate = aggregate_metrics(attempt_reports, elapsed_seconds)
    files_per_second = attempted_now / elapsed_seconds if elapsed_seconds else 0.0
    remaining_to_attempt = total_inputs - attempted_total
    eta_seconds = remaining_to_attempt / files_per_second if files_per_second else None
    return {
        "event": event,
        "crawl": crawl,
        "total_inputs": total_inputs,
        "files_remote_recovered": remote_recovered,
        "files_attempted_this_invocation": attempted_now,
        "files_attempted": attempted_total,
        "files_completed": successful_total,
        "files_failed": failures_now,
        "files_remaining_to_attempt": remaining_to_attempt,
        "files_not_successfully_completed": total_inputs - successful_total,
        "input_bytes_this_invocation": aggregate["input_bytes"],
        "pages_emitted_this_invocation": aggregate["pages_emitted"],
        "links_emitted_this_invocation": aggregate["links_emitted"],
        "output_bytes_this_invocation": aggregate["output_bytes"],
        "elapsed_seconds": round(elapsed_seconds, 3),
        "files_per_hour": round(files_per_second * 3600, 3),
        "input_mib_per_second": round(
            aggregate["input_bytes"] / elapsed_seconds / (2 ** 20), 3
        ) if elapsed_seconds else 0.0,
        "estimated_remaining_seconds": round(eta_seconds, 3) if eta_seconds is not None else None,
    }


def chunks(values: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crawl", required=True)
    parser.add_argument("--input", action="append", default=[], help="Local .wat.gz path or s3://bucket/key; repeatable")
    parser.add_argument("--input-list", help="Text or .gz path list; preserves file order")
    parser.add_argument("--max-inputs", type=int,
                        help=f"Process exactly the first N supplied/listed paths (maximum {MAX_SAFE_INPUTS})")
    parser.add_argument("--expected-inputs-sha256",
                        help="Require this SHA-256 for the selected ordered inputs before reading any WAT")
    parser.add_argument("--require-source-prefix",
                        help="Reject any selected input outside this exact source-path prefix")
    parser.add_argument("--output-dir", default="artifacts/common-crawl")
    parser.add_argument("--source-bucket", default="commoncrawl", help="Bucket used when --input is a Common Crawl object key")
    parser.add_argument("--source-url-base", default="https://data.commoncrawl.org/",
                        help="HTTPS base used for plain Common Crawl object keys")
    parser.add_argument(
        "--source-s3-bucket",
        help="Read plain manifest object keys from this bucket using authenticated S3 instead of HTTPS",
    )
    parser.add_argument("--batch-size", type=int, default=50_000)
    parser.add_argument("--workers", type=int, choices=(1, 2, 4, 8), default=1,
                        help="Bounded number of independent WAT workers (default: 1)")
    parser.add_argument("--files-per-batch", type=int, default=16,
                        help="Maximum inputs retained locally before each publication checkpoint")
    parser.add_argument("--signed-source", action="store_true",
                        help="Sign source S3 requests (the public Common Crawl bucket is unsigned by default)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--upload", action="store_true", help="Upload finalized local parts to --destination")
    parser.add_argument("--remove-uploaded-local", action="store_true",
                        help="After a successful upload, remove only that invocation's local finalized parts")
    parser.add_argument("--destination", default="s3://growthsent-data-552648196041-us-east-1-an/")
    args = parser.parse_args(argv)
    if args.batch_size < 1 or args.files_per_batch < 1:
        parser.error("--batch-size must be positive")
    if args.max_inputs is not None and args.max_inputs < 1:
        parser.error("--max-inputs must be positive")
    if args.input_list and args.max_inputs is None:
        parser.error("--input-list requires --max-inputs so a path list can never run unbounded")
    if args.remove_uploaded_local and not args.upload:
        parser.error("--remove-uploaded-local requires --upload")
    try:
        sources = input_sources(args.input, args.input_list, args.max_inputs)
        validate_input_scope(sources, args.max_inputs, args.require_source_prefix)
    except ValueError as error:
        parser.error(str(error))
    if args.max_inputs is not None and len(sources) != args.max_inputs:
        parser.error(f"requested exactly {args.max_inputs} inputs, but only {len(sources)} were supplied")
    if len(set(sources)) != len(sources):
        parser.error("duplicate inputs are not allowed because they map to the same deterministic part")
    source_digest = inputs_sha256(sources)
    if args.expected_inputs_sha256 and source_digest != args.expected_inputs_sha256.lower():
        parser.error(
            "selected inputs do not match --expected-inputs-sha256 "
            f"(actual {source_digest})"
        )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    started = time.monotonic()
    output_root = Path(args.output_dir)
    bucket, prefix = parse_s3_destination(args.destination) if args.upload else (None, None)
    manifest = {
        "format_version": 1,
        "crawl": args.crawl,
        "input_count": len(sources),
        "inputs_sha256": source_digest,
        "inputs": sources,
    }
    manifest_path = output_root / "control" / "input-manifest.json"
    progress_path = output_root / "control" / "run-progress.json"
    summary_path = output_root / "control" / "run-summary.json"
    write_json(manifest_path, manifest)
    if args.upload:
        existing_manifest = remote_control_json(bucket, prefix, manifest_path.name)
        if existing_manifest and not manifest_can_be_promoted(existing_manifest, manifest):
            parser.error("destination already has a different input manifest; choose a new production prefix")
        if existing_manifest and existing_manifest.get("inputs_sha256") != source_digest:
            logging.info("promoting remote input manifest from %s to %s inputs",
                         existing_manifest.get("input_count"), len(sources))
        upload_control_json(manifest_path, bucket, prefix)
    summaries_by_source: dict[str, dict[str, Any]] = {}
    pending = list(sources)
    if args.upload and args.resume:
        pending = []
        for source in sources:
            saved = remote_report(args.crawl, source, bucket, prefix)
            if saved is None:
                pending.append(source)
            else:
                summaries_by_source[source] = saved
                logging.info("resuming: remote completed parts exist for %s", source)
    remote_recovered = len(summaries_by_source)
    attempt_started = time.monotonic()
    attempt_reports: list[dict[str, Any]] = []

    def checkpoint(event: str, publish: bool) -> dict[str, Any]:
        snapshot = progress_snapshot(args.crawl, len(sources), remote_recovered,
                                     attempt_reports, time.monotonic() - attempt_started, event)
        logging.info("progress %s", json.dumps(snapshot, sort_keys=True))
        if publish:
            write_json(progress_path, snapshot)
            if args.upload:
                upload_control_json(progress_path, bucket, prefix)
        return snapshot

    checkpoint("started", publish=True)

    def report_completed(_: str, report: dict[str, Any]) -> None:
        attempt_reports.append(report)
        checkpoint("input_finished", publish=False)

    for batch in chunks(pending, args.files_per_batch):
        try:
            reports = ingest_many(args.crawl, batch, output_root, args.batch_size, args.resume,
                                  args.source_bucket, args.workers, not args.signed_source, args.source_url_base,
                                  report_completed, args.source_s3_bucket)
        except ValueError as error:
            parser.error(str(error))
        for source, report in zip(batch, reports):
            summaries_by_source[source] = report
            if args.upload and not report["failures"]:
                upload_artifacts(output_root, args.crawl, source, bucket, prefix)
                if args.remove_uploaded_local:
                    remove_local_artifacts(output_root, args.crawl, source)
        checkpoint("batch_published" if args.upload else "batch_finished", publish=True)
    summaries = [summaries_by_source[source] for source in sources]
    for metric in summaries:
        if metric["failures"]:
            logging.error("failed input %s: %s", metric["input"], "; ".join(metric["failures"]))
    wall_runtime_seconds = time.monotonic() - started
    aggregate = aggregate_metrics(summaries, wall_runtime_seconds)
    final_progress = checkpoint("finished", publish=True)
    run_summary = {
        "format_version": 1,
        "crawl": args.crawl,
        "workers": args.workers,
        "effective_workers": min(args.workers, len(sources)),
        "manifest": {key: manifest[key] for key in ("input_count", "inputs_sha256")},
        "progress": final_progress,
        "aggregate": aggregate,
        "inputs": summaries,
    }
    write_json(summary_path, run_summary)
    if args.upload:
        upload_control_json(summary_path, bucket, prefix)
    print(json.dumps(run_summary, indent=2, sort_keys=True))
    return 1 if aggregate["failed_inputs"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
