#!/usr/bin/env python3
"""Derive one GCP/R2 25K backlink shard from immutable raw Links objects.

DuckDB stays local to the Batch VM. Only final, verified, deterministic output
is published to R2; an interrupted Spot VM can therefore waste work but cannot
publish a partial completed shard.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import shutil
import time
from typing import Any, Iterable, Mapping

try:  # Windows local validation has no POSIX resource module.
    import resource
except ImportError:  # pragma: no cover - exercised by Windows import smoke
    resource = None

import common_crawl_backlink_derive as derive
import common_crawl_gcp_r2_25k_contract as contract_tools
import common_crawl_r2_store as r2


DEFAULT_MEMORY_LIMIT = "24GB"
DEFAULT_THREADS = 4
DEFAULT_TEMP_CAP = "1.25TiB"
MIN_LEASE_SECONDS = 300
MAX_LEASE_SECONDS = 14_400


class GcpDeriveError(RuntimeError):
    """A GCP/R2 derive shard cannot safely continue."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_timestamp(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise GcpDeriveError("derive lease timestamp is invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise GcpDeriveError("derive lease timestamp lacks a timezone")
    return parsed.astimezone(timezone.utc)


def raw_metric_key(source: str) -> str:
    return contract_tools.raw_part_key("metrics", source)


def _load_raw_link_entry(store: r2.R2Store, source: str) -> Mapping[str, Any]:
    loaded = store.read_json(raw_metric_key(source))
    if loaded is None:
        raise GcpDeriveError(f"raw metrics are missing for required source: {source}")
    report, _etag = loaded
    if report.get("run_id") != contract_tools.RUN_ID or report.get("input") != source:
        raise GcpDeriveError("raw metric belongs to another immutable run/input")
    entries = report.get("artifacts")
    if not isinstance(entries, list):
        raise GcpDeriveError("raw metric lacks immutable artifact metadata")
    entry = next((item for item in entries if isinstance(item, Mapping) and item.get("dataset") == "links"), None)
    if not isinstance(entry, Mapping):
        raise GcpDeriveError("raw metric lacks its Links artifact entry")
    expected_key = contract_tools.raw_part_key("links", source)
    if entry.get("key") != expected_key:
        raise GcpDeriveError("raw Links key does not match the deterministic contract")
    try:
        bytes_count = int(entry["bytes"])
        digest = str(entry["sha256"])
    except (KeyError, TypeError, ValueError) as error:
        raise GcpDeriveError("raw Links artifact metadata is invalid") from error
    if not store.verify(expected_key, bytes_count=bytes_count, sha256=digest):
        raise GcpDeriveError("raw Links artifact is missing")
    return entry


def stage_raw_links(store: r2.R2Store, contract: contract_tools.ShardContract, destination: Path) -> list[Path]:
    """Download exactly one verified Links part for each immutable raw input."""

    staged: list[Path] = []
    for source in contract.inputs:
        entry = _load_raw_link_entry(store, source)
        path = destination / f"part-{contract_tools.part_suffix(source)}.parquet"
        if path.is_file() and path.stat().st_size == int(entry["bytes"]) and r2.sha256_file(path) == str(entry["sha256"]):
            staged.append(path)
            continue
        store.download_verified_file(
            str(entry["key"]),
            path,
            bytes_count=int(entry["bytes"]),
            sha256=str(entry["sha256"]),
        )
        staged.append(path)
    if len(staged) != contract_tools.INPUTS_PER_SHARD or len({path.name for path in staged}) != len(staged):
        raise GcpDeriveError("derive stage did not obtain exactly the locked 1,000 raw Links files")
    return staged


def _read_rollup_hosts(path: Path | None) -> list[str]:
    if path is None:
        return []
    if not path.is_file():
        raise GcpDeriveError("configured bounded rollup hosts file does not exist")
    result: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.strip().lower()
        if value and not value.startswith("#"):
            result.append(value)
    if len(result) != len(set(result)) or len(result) > 100:
        raise GcpDeriveError("bounded rollup host list contains duplicates or exceeds 100 hosts")
    return result


def _collect_publication(output_root: Path, contract: contract_tools.ShardContract, metrics_path: Path) -> list[dict[str, Any]]:
    crawl_root = output_root / f"crawl={contract_tools.CRAWL}"
    detail_prefix = f"dataset=backlink-details/input_shard={contract.label}/"
    rollup_prefix = f"dataset=backlink-host-rollups/input_shard={contract.label}/"
    files: list[dict[str, Any]] = []
    for path in sorted(crawl_root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(crawl_root).as_posix()
        if not (relative.startswith(detail_prefix) or relative.startswith(rollup_prefix)):
            raise GcpDeriveError("derive output has an object outside this shard's approved detail/rollup paths")
        files.append(
            {
                "key": contract_tools.normalized_key(contract_tools.DERIVED_PREFIX, f"crawl={contract_tools.CRAWL}", relative),
                "path": path,
                "bytes": path.stat().st_size,
                "sha256": r2.sha256_file(path),
            }
        )
    files.append(
        {
            "key": contract_tools.normalized_key(contract_tools.DERIVED_PREFIX, "metrics", f"derive-{contract.label}.json"),
            "path": metrics_path,
            "bytes": metrics_path.stat().st_size,
            "sha256": r2.sha256_file(metrics_path),
        }
    )
    if not files or len({entry["key"] for entry in files}) != len(files):
        raise GcpDeriveError("derive publication contains no files or duplicate destination keys")
    return files


def _acquire_lease(store: r2.R2Store, contract: contract_tools.ShardContract, *, owner: str, seconds: int, allow_takeover: bool) -> tuple[str, str | None, dict[str, Any]]:
    if not owner or len(owner) > 256 or not MIN_LEASE_SECONDS <= seconds <= MAX_LEASE_SECONDS:
        raise GcpDeriveError("derive lease configuration is invalid")
    key = contract_tools.derived_control_key(contract.shard_id, "lease.json")
    now = utc_now()
    identity = contract.static_metadata()
    value = {
        **identity,
        "owner": owner,
        "lease_seconds": seconds,
        "state": "running",
        "updated_at": utc_timestamp(now),
        "expires_at": utc_timestamp(now + timedelta(seconds=seconds)),
    }
    existing = store.read_json(key)
    if existing is None:
        return key, store.put_json_conditional(key, value, if_none_match=True), identity
    document, etag = existing
    if any(document.get(name) != field for name, field in identity.items()):
        raise GcpDeriveError("existing derive lease belongs to another immutable assignment")
    if document.get("state") == "completed":
        raise GcpDeriveError("derive shard is already completed")
    if document.get("state") == "running" and _parse_time(document.get("expires_at")) > now:
        raise GcpDeriveError("derive shard has an active owner")
    if not allow_takeover or not etag:
        raise GcpDeriveError("derive recovery needs explicit confirmation after an expired lease")
    return key, store.put_json_conditional(key, value, if_match=etag), identity


def _finalise_lease(store: r2.R2Store, key: str, etag: str | None, identity: Mapping[str, Any], *, owner: str, state: str) -> None:
    if not etag:
        return
    store.put_json_conditional(
        key,
        {**identity, "owner": owner, "state": state, "updated_at": utc_timestamp(), "expires_at": None},
        if_match=etag,
    )


def validate_setup(args: argparse.Namespace) -> contract_tools.ShardContract:
    contract = contract_tools.load_contract(args.base_manifest, args.shard_manifest, args.shard_plan, shard_id=args.shard_id)
    contract_tools.validate_job_identity(vars(args), contract, release_sha256=args.release_sha256)
    if args.memory_limit != DEFAULT_MEMORY_LIMIT or args.threads != DEFAULT_THREADS or args.max_temp_directory_size != DEFAULT_TEMP_CAP:
        raise GcpDeriveError("derive resource settings do not match the reviewed compatibility canary envelope")
    return contract


def run_shard(
    args: argparse.Namespace,
    raw_store: r2.R2Store,
    derived_store: r2.R2Store,
) -> dict[str, Any]:
    contract = validate_setup(args)
    for directory in (args.work_dir, args.output_dir, args.temp_directory, args.status_dir):
        directory.mkdir(parents=True, exist_ok=True)
    derived_store.upload_immutable_json(contract_tools.normalized_key(contract_tools.DERIVED_PREFIX, "control", "base-manifest.json"), contract.base)
    derived_store.upload_immutable_json(contract_tools.normalized_key(contract_tools.DERIVED_PREFIX, "control", "shard-plan.json"), contract.plan)
    completed_key = contract_tools.derived_control_key(contract.shard_id, "DERIVED-SHARD-COMPLETED.json")
    prior = derived_store.read_json(completed_key)
    if prior is not None:
        document, _etag = prior
        if all(document.get(key) == value for key, value in contract.static_metadata().items()):
            return {"completed": True, "reused_completed_shard": True, "shard": contract.label}
        raise GcpDeriveError("existing derive completion marker conflicts with this immutable run")
    lease_key, lease_etag, identity = _acquire_lease(
        derived_store,
        contract,
        owner=args.shard_lease_owner,
        seconds=args.shard_lease_seconds,
        allow_takeover=args.allow_expired_lease_takeover,
    )
    started = time.monotonic()
    try:
        source_plan = {
            **contract.static_metadata(),
            "kind": "growthsent-gcp-r2-derived-source-plan",
            "raw_links_prefix": contract_tools.normalized_key(contract_tools.RAW_PREFIX, f"crawl={contract_tools.CRAWL}", "dataset=links"),
            "entries": [
                {"input": source, "key": contract_tools.raw_part_key("links", source), "suffix": contract_tools.part_suffix(source)}
                for source in contract.inputs
            ],
        }
        source_plan["source_plan_sha256"] = r2.sha256_bytes(r2.canonical_json(source_plan))
        derived_store.upload_immutable_json(contract_tools.derived_control_key(contract.shard_id, "source-plan.json"), source_plan)
        links_directory = args.work_dir / "raw-links"
        stage_raw_links(raw_store, contract, links_directory)
        detail = derive.build_detail_shard(
            links_directory=links_directory,
            output_root=args.output_dir,
            run_id=contract_tools.RUN_ID,
            crawl=contract_tools.CRAWL,
            shard_id=contract.shard_id,
            shard_count=contract_tools.SHARD_COUNT,
            expected_links_files=contract_tools.INPUTS_PER_SHARD,
            memory_limit=args.memory_limit,
            threads=args.threads,
            temp_directory=args.temp_directory,
            max_temp_directory_size=args.max_temp_directory_size,
            resume=True,
        )
        detail_root = args.output_dir / f"crawl={contract_tools.CRAWL}" / "dataset=backlink-details" / f"input_shard={contract.label}"
        buckets = derive.validate_detail_bucket_directories(detail_root)
        rollup_hosts = _read_rollup_hosts(args.rollup_hosts_file)
        rollup_results: list[dict[str, Any]] = []
        skipped_hosts: list[str] = []
        for host in rollup_hosts:
            try:
                rollup_results.append(
                    derive.build_host_rollup(
                        detail_root=detail_root,
                        output_root=args.output_dir,
                        crawl=contract_tools.CRAWL,
                        run_id=contract_tools.RUN_ID,
                        target_host=host,
                        input_shard_id=contract.shard_id,
                        input_shard_count=contract_tools.SHARD_COUNT,
                    )
                )
            except derive.DerivedDataError as error:
                if "was not found" not in str(error):
                    raise
                skipped_hosts.append(host)
        usage = shutil.disk_usage(args.work_dir)
        metrics = {
            **contract.static_metadata(),
            "release_sha256": args.release_sha256,
            "detail_manifest_sha256": detail["manifest_sha256"],
            "detail_rows": detail["detail_rows"],
            "detail_bytes": detail["detail_bytes"],
            "bucket_count": len(buckets),
            "bounded_rollups": len(rollup_results),
            "skipped_rollup_hosts": skipped_hosts,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "work_disk_free_bytes": usage.free,
            "work_disk_used_bytes": usage.used,
            "max_rss_kib": (
                int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
                if resource is not None else None
            ),
        }
        metrics_path = args.status_dir / "DERIVED-SHARD-METRICS.json"
        metrics_path.parent.mkdir(parents=True, exist_ok=True)
        metrics_path.write_bytes(r2.canonical_json(metrics))
        files = _collect_publication(args.output_dir, contract, metrics_path)
        publication = {
            **contract.static_metadata(),
            "kind": "growthsent-gcp-r2-derived-publication",
            "source_plan_sha256": source_plan["source_plan_sha256"],
            "detail_manifest_sha256": detail["manifest_sha256"],
            "bounded_rollup_count": len(rollup_results),
            "files": [{key: value for key, value in entry.items() if key != "path"} for entry in files],
        }
        publication["publication_manifest_sha256"] = r2.sha256_bytes(r2.canonical_json(publication))
        uploaded = reused = 0
        for entry in files:
            result = derived_store.upload_immutable_file(str(entry["key"]), Path(entry["path"]), content_type=("application/json" if str(entry["key"]).endswith(".json") else "application/vnd.apache.parquet"))
            if result["reused"]:
                reused += 1
            else:
                uploaded += 1
        derived_store.upload_immutable_json(contract_tools.derived_control_key(contract.shard_id, "DERIVED-PUBLICATION-MANIFEST.json"), publication)
        completion = {
            **contract.static_metadata(),
            "kind": "growthsent-gcp-r2-derived-shard-completed",
            "publication_manifest_sha256": publication["publication_manifest_sha256"],
            "completed_at": utc_timestamp(),
        }
        # Completion-marker-last: this is the only signal future serving/catalog
        # code may use to expose the shard.
        derived_store.upload_immutable_json(completed_key, completion)
        # Completion is the final R2 write. A later worker first checks this
        # immutable marker, so the now-stale lease cannot cause recomputation.
        return {"completed": True, "shard": contract.label, "uploaded": uploaded, "reused": reused, "metrics": metrics}
    except BaseException:
        try:
            _finalise_lease(derived_store, lease_key, lease_etag, identity, owner=args.shard_lease_owner, state="failed")
        finally:
            raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser_args = argparse.ArgumentParser(description=__doc__)
    for name in ("base-manifest", "shard-manifest", "shard-plan"):
        parser_args.add_argument(f"--{name}", type=Path, required=True)
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
    parser_args.add_argument("--shard-lease-seconds", type=int, default=7200)
    parser_args.add_argument("--allow-expired-lease-takeover", action="store_true")
    parser_args.add_argument("--memory-limit", default=DEFAULT_MEMORY_LIMIT)
    parser_args.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser_args.add_argument("--max-temp-directory-size", default=DEFAULT_TEMP_CAP)
    parser_args.add_argument("--work-dir", type=Path, required=True)
    parser_args.add_argument("--output-dir", type=Path, required=True)
    parser_args.add_argument("--temp-directory", type=Path, required=True)
    parser_args.add_argument("--status-dir", type=Path, required=True)
    parser_args.add_argument("--rollup-hosts-file", type=Path)
    args = parser_args.parse_args(argv)
    if len(args.release_sha256) != 64 or any(char not in "0123456789abcdef" for char in args.release_sha256):
        parser_args.error("--release-sha256 must be lowercase SHA-256 hex")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    raw_store = r2.R2Store.from_environment(
        allowed_prefixes=[contract_tools.normalized_key(contract_tools.RAW_PREFIX, f"crawl={contract_tools.CRAWL}", "dataset=links"), contract_tools.normalized_key(contract_tools.RAW_PREFIX, f"crawl={contract_tools.CRAWL}", "dataset=metrics")],
        credential_prefix="GROWTHSENT_R2_RAW_READ_",
    )
    derived_store = r2.R2Store.from_environment(
        allowed_prefixes=[contract_tools.DERIVED_PREFIX],
        credential_prefix="GROWTHSENT_R2_DERIVED_WRITE_",
    )
    print(json.dumps(run_shard(args, raw_store, derived_store), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
