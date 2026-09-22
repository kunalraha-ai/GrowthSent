#!/usr/bin/env python3
"""Verify the Cloudflare domain-JSON cache against the R2 serving tables.

This is a local, read-only verifier. It does not touch Google Cloud or incur
GCP costs. It prompts for a Cloudflare parent R2 token and mints its own
temporary, narrowly scoped R2 object-read-only child credential.

It checks:
  - all 1,024 bucket manifests exist and have a valid schema;
  - sampled bucket domain_summary Parquet row counts match manifest domain_count;
  - sampled domain JSON files exist and match the API response contract;
  - summary counts in JSON payloads match the source Parquet rows.

Usage:
    python tools/verify_domain_json_v1.py \
        --sample-buckets 64 \
        --sample-domains-per-bucket 5 \
        --work-dir /tmp/gs-verify-domain-json
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence

# ---------------------------------------------------------------------------
# Frozen constants matching the current build / API contract.
# ---------------------------------------------------------------------------

BUCKET_COUNT = 1024
FORMAT_VERSION = 1
TASK_KIND = "growthsent-cc-main-2026-30-domain-json-v1"
DEFAULT_TOP_N = 100

ACCOUNT_ID = os.environ.get("GROWTHSENT_ACCOUNT_ID", "4a30e8ac877d9f65ee9a0ecc5df16146")
BUCKET_NAME = os.environ.get("GROWTHSENT_BUCKET", "growthsent-data-lake")

OUTPUT_PREFIX = "production/link-index/v1/domain-json/v1"
SERVING_PREFIX = "production/link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416/serving"
MANIFEST_PREFIX = f"{OUTPUT_PREFIX}/domain-json-manifests"

API_TABLES = {
    "referring_domains": {
        "columns": ["source_domain", "inbound_link_count"],
        "score": "inbound_link_count",
    },
    "anchors": {
        "columns": ["anchor", "inbound_link_count"],
        "score": "inbound_link_count",
    },
    "top_pages": {
        "columns": ["target_url", "inbound_link_count", "referring_domain_count"],
        "score": "inbound_link_count",
    },
    "broken_backlinks": {
        "columns": ["target_url", "source_domain", "source_url", "observed_link_count"],
        "score": "observed_link_count",
    },
}

SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
BUCKET_FILE_RE = re.compile(r"target_bucket=(\d{4})\.json\Z")


class VerificationError(RuntimeError):
    """A verification invariant was violated."""


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _utc_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def domain_key(domain: str) -> str:
    """Deterministic URL-safe key matching the API Worker."""
    return base64.urlsafe_b64encode(domain.encode("utf-8")).decode("ascii").rstrip("=")


def domain_bucket(domain: str) -> int:
    """Bucket assignment matching the API Worker."""
    return (int(hashlib.sha256(domain.encode("utf-8")).hexdigest()[:3], 16) >> 2) % BUCKET_COUNT


def _verify_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise VerificationError(f"{field} must be a 64-char lowercase hex SHA-256 digest")
    return value


# ---------------------------------------------------------------------------
# Temporary R2 credential minting (Cloudflare-only)
# ---------------------------------------------------------------------------


def _call_cloudflare_api(
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as handle:
            payload = json.loads(handle.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body_text = error.read().decode("utf-8", errors="replace")
        raise VerificationError(f"Cloudflare API {method} {path} returned HTTP {error.code}: {body_text}") from error
    except Exception as error:
        raise VerificationError(f"Cloudflare API {method} {path} failed: {error}") from error
    if not isinstance(payload, dict):
        raise VerificationError(f"unexpected Cloudflare API response type for {path}")
    return payload


def _mint_r2_read_credentials(parent_token: str, prefixes: Sequence[str], ttl_seconds: int = 3600) -> dict[str, str]:
    """Mint a temporary object-read-only R2 credential scoped to prefixes."""
    verify = _call_cloudflare_api("/user/tokens/verify", token=parent_token)
    if not verify.get("success") or verify.get("result", {}).get("status") != "active":
        raise VerificationError("parent Cloudflare API token is not active")
    parent_access_key_id = verify["result"]["id"]

    mint_body = {
        "bucket": BUCKET_NAME,
        "parentAccessKeyId": parent_access_key_id,
        "permission": "object-read-only",
        "ttlSeconds": ttl_seconds,
        "prefixes": [p.rstrip("/") + "/" for p in prefixes],
    }
    mint = _call_cloudflare_api(f"/accounts/{ACCOUNT_ID}/r2/temp-access-credentials", token=parent_token, method="POST", body=mint_body)
    if not mint.get("success"):
        errors = mint.get("errors", [])
        raise VerificationError(f"could not mint R2 credential: {errors}")
    result = mint["result"]
    return {
        "access_key_id": result["accessKeyId"],
        "secret_access_key": result["secretAccessKey"],
        "session_token": result["sessionToken"],
    }


# ---------------------------------------------------------------------------
# R2 interactions via existing R2Store
# ---------------------------------------------------------------------------


def _r2_store_from_credentials(credentials: Mapping[str, str], allowed_prefixes: Sequence[str]) -> Any:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from common_crawl_r2_store import R2Store

    os.environ["GROWTHSENT_R2_ACCOUNT_ID"] = ACCOUNT_ID
    os.environ["GROWTHSENT_R2_BUCKET"] = BUCKET_NAME
    os.environ["GROWTHSENT_R2_OUTPUT_ACCESS_KEY_ID"] = credentials["access_key_id"]
    os.environ["GROWTHSENT_R2_OUTPUT_SECRET_ACCESS_KEY"] = credentials["secret_access_key"]
    if credentials.get("session_token"):
        os.environ["GROWTHSENT_R2_OUTPUT_SESSION_TOKEN"] = credentials["session_token"]
    else:
        os.environ.pop("GROWTHSENT_R2_OUTPUT_SESSION_TOKEN", None)
    return R2Store.from_environment(
        credential_prefix="GROWTHSENT_R2_OUTPUT_",
        allowed_prefixes=[p.rstrip("/") for p in allowed_prefixes],
    )


def _manifest_bucket_number(key: str) -> int | None:
    match = BUCKET_FILE_RE.search(key)
    return int(match.group(1)) if match else None


def _list_manifests(r2_store: Any) -> dict[int, dict[str, Any]]:
    keys = r2_store.list_keys(MANIFEST_PREFIX)
    manifests: dict[int, dict[str, Any]] = {}
    for key in keys:
        bucket = _manifest_bucket_number(key)
        if bucket is None:
            continue
        json_body, _etag = r2_store.read_json(key)
        if json_body is None:
            raise VerificationError(f"manifest exists but could not be read: {key}")
        manifests[bucket] = {
            "key": key,
            "body": json_body,
        }
    return manifests


def _validate_manifest(bucket: int, body: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return a dict of errors, or None if valid."""
    errors: list[str] = []
    required_str = ["kind", "output_prefix", "generated_at"]
    for field in required_str:
        if not isinstance(body.get(field), str):
            errors.append(f"missing or non-string field {field}")
    if body.get("kind") != TASK_KIND:
        errors.append(f"kind mismatch: {body.get('kind')}")
    if body.get("format_version") != FORMAT_VERSION:
        errors.append(f"format_version != {FORMAT_VERSION}")
    if body.get("bucket") != bucket:
        errors.append(f"bucket mismatch: file={bucket}, body={body.get('bucket')}")
    if body.get("top_n") != DEFAULT_TOP_N:
        errors.append(f"top_n != {DEFAULT_TOP_N}")
    for field in ("empty", "domain_count", "total_bytes"):
        if field not in body:
            errors.append(f"missing field {field}")
    if isinstance(body.get("empty"), bool):
        empty = body["empty"]
        domain_count = body.get("domain_count")
        total_bytes = body.get("total_bytes")
        if not isinstance(domain_count, int) or domain_count < 0:
            errors.append("domain_count must be a non-negative integer")
        if not isinstance(total_bytes, int) or total_bytes < 0:
            errors.append("total_bytes must be a non-negative integer")
        if empty and (domain_count != 0 or total_bytes != 0):
            errors.append("empty=True but domain_count or total_bytes is non-zero")
    if errors:
        return {"bucket": bucket, "errors": errors}
    return None


# ---------------------------------------------------------------------------
# Sampling against source Parquet
# ---------------------------------------------------------------------------


def _download_parquet(r2_store: Any, key: str, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    try:
        response = r2_store.client.get_object(Bucket=r2_store.bucket, Key=r2_store.assert_allowed(key))
        with temporary.open("wb") as handle:
            for block in iter(lambda: response["Body"].read(8 * 1024 * 1024), b""):
                handle.write(block)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    size = temporary.stat().st_size
    temporary.replace(destination)
    return size


def _read_domain_summary_row_count(path: Path) -> int:
    con = duckdb.connect(":memory:")
    try:
        result = con.execute(f"SELECT COUNT(*) FROM read_parquet('{path.as_posix()}')").fetchone()
        return int(result[0]) if result else 0
    finally:
        con.close()


def _sample_domains_from_summary(path: Path, limit: int) -> list[tuple[str, int, int]]:
    con = duckdb.connect(":memory:")
    try:
        rows = con.execute(
            f"""
            SELECT target_domain, inbound_link_count, referring_domain_count
            FROM read_parquet('{path.as_posix()}')
            USING SAMPLE {limit}
            """
        ).fetchall()
        return [(str(r[0]), int(r[1]), int(r[2])) for r in rows]
    finally:
        con.close()


def _load_domain_json(r2_store: Any, domain: str) -> dict[str, Any] | None:
    key = f"{OUTPUT_PREFIX}/{domain_key(domain)}.json"
    try:
        body, _etag = r2_store.read_json(key)
    except Exception:
        return None
    return dict(body) if body else None


def _validate_domain_json(
    domain: str,
    bucket: int,
    expected_summary: tuple[int, int],
    payload: Mapping[str, Any],
) -> list[str]:
    errors: list[str] = []
    if payload.get("format_version") != FORMAT_VERSION:
        errors.append("format_version != 1")
    if payload.get("domain") != domain:
        errors.append(f"domain mismatch: payload={payload.get('domain')}")
    if payload.get("bucket") != bucket:
        errors.append(f"bucket mismatch: expected={bucket}, payload={payload.get('bucket')}")

    summary = payload.get("summary", {})
    if not isinstance(summary, dict):
        errors.append("summary is not an object")
    else:
        if summary.get("inbound_link_count") != expected_summary[0]:
            errors.append(
                f"inbound_link_count mismatch: parquet={expected_summary[0]}, json={summary.get('inbound_link_count')}"
            )
        if summary.get("referring_domain_count") != expected_summary[1]:
            errors.append(
                f"referring_domain_count mismatch: parquet={expected_summary[1]}, json={summary.get('referring_domain_count')}"
            )

    for table_name, spec in API_TABLES.items():
        table = payload.get(table_name)
        if not isinstance(table, dict):
            errors.append(f"table {table_name} is not an object")
            continue
        total = table.get("total")
        items = table.get("items")
        if not isinstance(total, int) or total < 0:
            errors.append(f"{table_name}.total is not a non-negative integer")
        if not isinstance(items, list):
            errors.append(f"{table_name}.items is not a list")
            continue
        if len(items) > DEFAULT_TOP_N:
            errors.append(f"{table_name}.items length {len(items)} exceeds top_n {DEFAULT_TOP_N}")
        if total < len(items):
            errors.append(f"{table_name}.total {total} is less than len(items) {len(items)}")
        # Items should be descending by score.
        score_column = spec["score"]
        scores = [item.get(score_column) for item in items]
        if scores != sorted(scores, reverse=True):
            errors.append(f"{table_name}.items are not sorted descending by {score_column}")
        # Verify item field names.
        allowed = set(spec["columns"])
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"{table_name}.items[{idx}] is not an object")
                continue
            for field in allowed:
                if field not in item:
                    errors.append(f"{table_name}.items[{idx}] missing field {field}")
            for field in item:
                if field not in allowed:
                    errors.append(f"{table_name}.items[{idx}] unexpected field {field}")
                    break
    return errors


# ---------------------------------------------------------------------------
# Verification orchestration
# ---------------------------------------------------------------------------


def verify(
    *,
    credentials: Mapping[str, str],
    work_dir: Path,
    sample_buckets: int,
    sample_domains_per_bucket: int,
) -> dict[str, Any]:
    allowed_prefixes = [OUTPUT_PREFIX, SERVING_PREFIX, MANIFEST_PREFIX]
    r2_store = _r2_store_from_credentials(credentials, allowed_prefixes)

    failures: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "status": "in_progress",
        "crawl": "CC-MAIN-2026-30",
        "bucket_count": BUCKET_COUNT,
        "sampled_buckets": sample_buckets,
        "sampled_domains_per_bucket": sample_domains_per_bucket,
        "started_at": _utc_timestamp(),
    }

    print("[verify] listing manifests...", flush=True)
    manifests = _list_manifests(r2_store)
    report["manifest_count"] = len(manifests)
    all_buckets = set(range(BUCKET_COUNT))
    found_buckets = set(manifests.keys())
    missing_buckets = sorted(all_buckets - found_buckets)
    report["missing_buckets"] = missing_buckets
    report["missing_bucket_count"] = len(missing_buckets)

    total_domain_count = 0
    total_bytes = 0
    for bucket in range(BUCKET_COUNT):
        manifest = manifests.get(bucket)
        if manifest is None:
            continue
        body = manifest["body"]
        manifest_error = _validate_manifest(bucket, body)
        if manifest_error:
            failures.append(manifest_error)
            continue
        total_domain_count += int(body.get("domain_count", 0))
        total_bytes += int(body.get("total_bytes", 0))
    report["total_domain_count"] = total_domain_count
    report["total_bytes"] = total_bytes
    report["empty_bucket_count"] = sum(
        1 for b in range(BUCKET_COUNT) if manifests.get(b, {}).get("body", {}).get("empty") is True
    )

    if missing_buckets:
        print(
            f"[verify] WARNING: {len(missing_buckets)} bucket manifests are missing; sampling will skip them.",
            flush=True,
        )

    # Sample buckets that have manifests and are not empty.
    sample_candidates = [
        b for b in sorted(found_buckets)
        if not manifests[b]["body"].get("empty", False)
    ]
    step = max(1, len(sample_candidates) // sample_buckets)
    sampled_buckets = sample_candidates[::step][:sample_buckets]

    sampled_domain_count = 0
    parquet_mismatches: list[dict[str, Any]] = []
    domain_check_failures: list[dict[str, Any]] = []

    for bucket in sampled_buckets:
        manifest_body = manifests[bucket]["body"]
        expected_domain_count = int(manifest_body.get("domain_count", 0))

        summary_key = f"{SERVING_PREFIX}/table=domain_summary/target_bucket={bucket:04d}/part.parquet"
        summary_path = work_dir / f"bucket-{bucket:04d}" / "domain_summary.parquet"
        print(f"[verify] sampling bucket {bucket:04d}...", flush=True)
        try:
            _download_parquet(r2_store, summary_key, summary_path)
        except Exception as error:
            failures.append({"bucket": bucket, "stage": "download_domain_summary", "error": str(error)})
            continue

        try:
            parquet_count = _read_domain_summary_row_count(summary_path)
        except Exception as error:
            failures.append({"bucket": bucket, "stage": "read_domain_summary", "error": str(error)})
            continue

        if parquet_count != expected_domain_count:
            parquet_mismatches.append(
                {
                    "bucket": bucket,
                    "manifest_domain_count": expected_domain_count,
                    "parquet_row_count": parquet_count,
                }
            )

        for domain, inbound, referring in _sample_domains_from_summary(summary_path, sample_domains_per_bucket):
            payload = _load_domain_json(r2_store, domain)
            sampled_domain_count += 1
            if payload is None:
                domain_check_failures.append(
                    {"bucket": bucket, "domain": domain, "error": "domain JSON file not found"}
                )
                continue
            expected_summary = (inbound, referring)
            errors = _validate_domain_json(domain, bucket, expected_summary, payload)
            if errors:
                domain_check_failures.append(
                    {"bucket": bucket, "domain": domain, "errors": errors}
                )

    report["sampled_domain_count"] = sampled_domain_count
    report["parquet_count_mismatches"] = parquet_mismatches
    report["domain_check_failures"] = domain_check_failures
    report["other_failures"] = failures
    report["finished_at"] = _utc_timestamp()

    if missing_buckets or failures or parquet_mismatches or domain_check_failures:
        report["status"] = "failed"
    else:
        report["status"] = "verified"
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-buckets", type=int, default=64)
    parser.add_argument("--sample-domains-per-bucket", type=int, default=5)
    parser.add_argument("--work-dir", type=Path, default=Path(tempfile.gettempdir()) / "gs-verify-domain-json")
    parser.add_argument("--ttl-seconds", type=int, default=3600, help="TTL for the temporary R2 credential")
    parser.add_argument("--report", type=Path, help="Optional JSON report output path")
    args = parser.parse_args(argv)

    if args.sample_buckets < 1 or args.sample_buckets > BUCKET_COUNT:
        parser.error("sample-buckets must be between 1 and 1024")
    if args.sample_domains_per_bucket < 1:
        parser.error("sample-domains-per-bucket must be >= 1")

    print("[verify] This verifier runs entirely on Cloudflare R2 (no GCP cost).")
    print(
        "[verify] It will mint a temporary object-read-only R2 credential scoped to the JSON cache and serving prefixes.",
        flush=True,
    )
    parent_token = getpass.getpass("Paste active Cloudflare R2 API token (hidden): ").strip()
    if not parent_token:
        print("An R2 API token is required.", file=sys.stderr, flush=True)
        return 1

    allowed_prefixes = [OUTPUT_PREFIX, SERVING_PREFIX, MANIFEST_PREFIX]
    try:
        credentials = _mint_r2_read_credentials(parent_token, allowed_prefixes, ttl_seconds=args.ttl_seconds)
    except VerificationError as error:
        print(f"[verify] credential minting failed: {error}", file=sys.stderr, flush=True)
        return 1

    args.work_dir.mkdir(parents=True, exist_ok=True)
    try:
        report = verify(
            credentials=credentials,
            work_dir=args.work_dir,
            sample_buckets=args.sample_buckets,
            sample_domains_per_bucket=args.sample_domains_per_bucket,
        )
    except VerificationError as error:
        print(f"[verify] FAILED: {error}", file=sys.stderr, flush=True)
        return 1

    if args.report:
        report_path = args.report
    else:
        report_path = Path(tempfile.gettempdir()) / f"verify-domain-json-{_utc_timestamp().replace(':', '-')}Z.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")

    status = report["status"]
    print(f"[verify] status: {status}", flush=True)
    print(f"[verify] manifests: {report['manifest_count']} / {BUCKET_COUNT}", flush=True)
    print(f"[verify] missing buckets: {report['missing_bucket_count']}", flush=True)
    print(f"[verify] total domains (from manifests): {report['total_domain_count']}", flush=True)
    print(f"[verify] total bytes (from manifests): {report['total_bytes']}", flush=True)
    print(f"[verify] parquet count mismatches: {len(report['parquet_count_mismatches'])}", flush=True)
    print(f"[verify] domain check failures: {len(report['domain_check_failures'])}", flush=True)
    print(f"[verify] other failures: {len(report['other_failures'])}", flush=True)
    if status != "verified":
        print(f"[verify] details written to {report_path}", flush=True)
        return 1
    print(f"[verify] report written to {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
