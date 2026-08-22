#!/usr/bin/env python3
"""Locked publication protocol for the 10K derived-backlink v1 layout.

This is deliberately separate from raw ingestion.  It accepts only the
reviewed first-10K v2 manifest and one of its ten immutable raw shards.  The
runtime commands use S3 only when explicitly invoked by a worker; importing
or validating this module is local-only.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import common_crawl_backlink_derive as derive
import common_crawl_v2_manifest as manifests


RUN_ID = "cc-main-2026-30-first-10000"
CRAWL = "CC-MAIN-2026-30"
SHARD_COUNT = 10
INPUT_COUNT = 10_000
INPUTS_SHA256 = "85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226"
BASE_MANIFEST_SHA256 = "721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0"
SHARD_PLAN_SHA256 = "6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a"
BUCKET = "growthsent-data-552648196041-us-east-1-an"
RAW_LINKS_PREFIX = "production/common-crawl/wat-pages-links/v2/cc-main-2026-30-first-10000/crawl=CC-MAIN-2026-30/dataset=links"
DERIVED_PREFIX = "production/common-crawl/backlink-derived/v1/cc-main-2026-30-first-10000"
DERIVED_SCHEMA_LAYOUT_VERSION = 1


class ProductionDeriveError(ValueError):
    pass


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def s3_checksum_sha256(hex_digest: str) -> str:
    """Return S3's base64 representation for a hexadecimal SHA-256 digest."""

    normalized = normalize_sha256_hex(hex_digest)
    return base64.b64encode(bytes.fromhex(normalized)).decode("ascii")


def normalize_sha256_hex(value: Any) -> str:
    """Validate and normalize a full SHA-256 hexadecimal digest."""

    if not isinstance(value, str) or len(value) != 64:
        raise ProductionDeriveError("SHA-256 digest must contain exactly 64 hexadecimal characters")
    try:
        raw = bytes.fromhex(value)
    except ValueError as error:
        raise ProductionDeriveError("SHA-256 digest is not hexadecimal") from error
    if len(raw) != 32:
        raise ProductionDeriveError("SHA-256 digest must contain exactly 64 hexadecimal characters")
    return raw.hex()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def shard_label(shard_id: int) -> str:
    if not 0 <= shard_id < SHARD_COUNT:
        raise ProductionDeriveError("derive shard id must be in the approved range 0..9")
    return f"shard-{shard_id:03d}-of-{SHARD_COUNT:03d}"


def normalized_prefix(*parts: str) -> str:
    """Join trusted S3 path components with exactly one slash."""
    cleaned: list[str] = []
    for part in parts:
        if not isinstance(part, str) or not part:
            raise ProductionDeriveError("S3 path component must be a non-empty string")
        value = part.strip("/")
        if not value or "//" in value or value in {".", ".."} or "../" in value:
            raise ProductionDeriveError("unsafe or non-normalized S3 path component")
        cleaned.append(value)
    return "/".join(cleaned)


def remote_control_prefix(shard_id: int) -> str:
    return normalized_prefix(DERIVED_PREFIX, "control", "derive-shards", f"derive-{shard_label(shard_id)}")


@dataclass(frozen=True)
class Contract:
    shard_id: int
    shard: Mapping[str, Any]
    base: Mapping[str, Any]
    plan: Mapping[str, Any]

    @property
    def label(self) -> str:
        return shard_label(self.shard_id)

    @property
    def source_keys(self) -> list[str]:
        return [
            normalized_prefix(RAW_LINKS_PREFIX, f"part-{hashlib.sha256(path.encode('utf-8')).hexdigest()[:16]}.parquet")
            for path in self.shard["inputs"]
        ]


def load_contract(base_path: Path, shard_path: Path, plan_path: Path, shard_id: int, shard_count: int) -> Contract:
    if shard_count != SHARD_COUNT:
        raise ProductionDeriveError("derive shard count must be exactly 10")
    shard_label(shard_id)
    base = manifests.load_base_manifest(base_path, expected_input_count=INPUT_COUNT)
    shard = manifests.load_shard_manifest(shard_path, base, expected_input_count=INPUT_COUNT)
    plan = manifests.load_shard_plan(plan_path, base, expected_input_count=INPUT_COUNT)
    if base["run_id"] != RUN_ID or base["crawl"] != CRAWL:
        raise ProductionDeriveError("base manifest is not the approved 10K CC-MAIN-2026-30 run")
    if base["inputs_sha256"] != INPUTS_SHA256 or base["manifest_sha256"] != BASE_MANIFEST_SHA256:
        raise ProductionDeriveError("base manifest hash does not match the approved 10K contract")
    if plan["plan_sha256"] != SHARD_PLAN_SHA256 or plan["shard_count"] != SHARD_COUNT:
        raise ProductionDeriveError("shard plan does not match the approved 10K contract")
    if shard["shard_id"] != shard_id or shard["shard_count"] != SHARD_COUNT or shard["input_count"] != 1_000:
        raise ProductionDeriveError("derive shard manifest does not own exactly its approved 1,000 raw inputs")
    plan_entry = plan["shards"][shard_id]
    if (
        plan_entry.get("shard_manifest_sha256") != shard["manifest_sha256"]
        or plan_entry.get("inputs_sha256") != shard["inputs_sha256"]
        or plan_entry.get("input_count") != shard["input_count"]
    ):
        raise ProductionDeriveError("derive shard manifest does not match its immutable shard-plan entry")
    return Contract(shard_id=shard_id, shard=shard, base=base, plan=plan)


def source_plan(contract: Contract) -> dict[str, Any]:
    entries = [
        {"input": source, "suffix": hashlib.sha256(source.encode("utf-8")).hexdigest()[:16], "key": key}
        for source, key in zip(contract.shard["inputs"], contract.source_keys, strict=True)
    ]
    document = {
        "format_version": 1, "kind": "growthsent-derived-v1-source-plan", "run_id": RUN_ID, "crawl": CRAWL,
        "derived_schema_layout_version": DERIVED_SCHEMA_LAYOUT_VERSION,
        "shard": {"id": contract.shard_id, "count": SHARD_COUNT, "label": contract.label,
                  "inputs_sha256": contract.shard["inputs_sha256"], "manifest_sha256": contract.shard["manifest_sha256"]},
        "base_inputs_sha256": INPUTS_SHA256, "base_manifest_sha256": BASE_MANIFEST_SHA256,
        "raw_links_prefix": RAW_LINKS_PREFIX, "entries": entries,
    }
    document["source_plan_sha256"] = sha256_bytes(canonical_json(document))
    return document


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(canonical_json(value))
    os.replace(temporary, path)


def verify_local_detail(output_root: Path, contract: Contract) -> dict[str, Any]:
    detail = output_root / f"crawl={CRAWL}" / "dataset=backlink-details" / f"input_shard={contract.label}"
    buckets = derive.validate_detail_bucket_directories(detail)
    manifest_path = detail / "DERIVED-MANIFEST.json"
    if not manifest_path.is_file():
        raise ProductionDeriveError("derived detail manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_shard = {"id": contract.shard_id, "count": SHARD_COUNT, "label": contract.label}
    if manifest.get("run_id") != RUN_ID or manifest.get("crawl") != CRAWL or manifest.get("shard") != expected_shard:
        raise ProductionDeriveError("derived detail manifest does not match the locked derive shard")
    if manifest.get("bucket_count") != derive.BUCKET_COUNT or manifest.get("bucket_algorithm") != "int(sha256(target_host)[:3], 16) >> 2, zero-padded decimal":
        raise ProductionDeriveError("derived detail bucket contract is invalid")
    if manifest.get("source_links", {}).get("fingerprint_sha256") is None:
        raise ProductionDeriveError("derived detail manifest is missing source provenance")
    return {"detail_root": detail, "bucket_count": len(buckets), "manifest": manifest}


def verify_local_rollups(output_root: Path, contract: Contract) -> int:
    """Verify every locally materialized bounded rollup belongs to this shard."""

    rollup_root = (
        output_root
        / f"crawl={CRAWL}"
        / "dataset=backlink-host-rollups"
        / f"input_shard={contract.label}"
    )
    if not rollup_root.exists():
        return 0
    if not rollup_root.is_dir():
        raise ProductionDeriveError("derived rollup root is not a directory")
    verified = 0
    expected_input_shard = {"id": contract.shard_id, "count": SHARD_COUNT, "label": contract.label}
    for manifest_path in sorted(rollup_root.rglob("DERIVED-MANIFEST.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("kind") != "common-crawl-backlink-host-rollup"
            or manifest.get("run_id") != RUN_ID
            or manifest.get("crawl") != CRAWL
            or manifest.get("input_shard") != expected_input_shard
        ):
            raise ProductionDeriveError(f"derived rollup manifest is outside the locked derive shard: {manifest_path}")
        verified += 1
    return verified


def publication_manifest(output_root: Path, status_dir: Path, contract: Contract) -> dict[str, Any]:
    verification = verify_local_detail(output_root, contract)
    rollup_count = verify_local_rollups(output_root, contract)
    metrics = status_dir / "DERIVED-SHARD-METRICS.json"
    if not metrics.is_file():
        raise ProductionDeriveError("derived shard metrics are missing")
    files: list[dict[str, Any]] = []
    shard_metrics_name = f"derive-{contract.label}.json"
    for root, prefix in ((output_root / f"crawl={CRAWL}", f"crawl={CRAWL}"), (metrics.parent, "metrics")):
        paths = [metrics] if root == metrics.parent else sorted(root.rglob("*"))
        for path in paths:
            if not path.is_file():
                continue
            relative = shard_metrics_name if root == metrics.parent else path.relative_to(root).as_posix()
            key = normalized_prefix(DERIVED_PREFIX, prefix, relative)
            files.append({"key": key, "bytes": path.stat().st_size, "sha256": sha256_file(path), "path": str(path)})
    files.sort(key=lambda entry: entry["key"])
    if not files:
        raise ProductionDeriveError("derived publication contains no files")
    if len({entry["key"] for entry in files}) != len(files):
        raise ProductionDeriveError("derived publication contains duplicate destination keys")
    expected_detail_prefix = normalized_prefix(
        DERIVED_PREFIX,
        f"crawl={CRAWL}",
        "dataset=backlink-details",
        f"input_shard={contract.label}",
    ) + "/"
    expected_rollup_prefix = normalized_prefix(
        DERIVED_PREFIX,
        f"crawl={CRAWL}",
        "dataset=backlink-host-rollups",
        f"input_shard={contract.label}",
    ) + "/"
    expected_metrics_key = normalized_prefix(DERIVED_PREFIX, "metrics", shard_metrics_name)
    for entry in files:
        key = entry["key"]
        if key == expected_metrics_key:
            continue
        if not (key.startswith(expected_detail_prefix) or key.startswith(expected_rollup_prefix)):
            raise ProductionDeriveError("derived publication contains output outside the locked derive shard")
    document = {
        "format_version": 1, "kind": "growthsent-derived-v1-publication", "run_id": RUN_ID, "crawl": CRAWL,
        "derived_schema_layout_version": DERIVED_SCHEMA_LAYOUT_VERSION, "destination_prefix": DERIVED_PREFIX,
        "shard": {"id": contract.shard_id, "count": SHARD_COUNT, "label": contract.label},
        "source_plan_sha256": source_plan(contract)["source_plan_sha256"],
        "detail_manifest_sha256": verification["manifest"]["manifest_sha256"],
        "bounded_rollup_count": rollup_count,
        "files": files,
    }
    document["publication_manifest_sha256"] = sha256_bytes(canonical_json(document))
    return document


def _client_error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
    return str(code) if code is not None else None


def _is_missing(error: Exception) -> bool:
    return _client_error_code(error) in {"404", "NoSuchKey", "NotFound"}


def _head(client: Any, key: str) -> Mapping[str, Any] | None:
    try:
        return client.head_object(Bucket=BUCKET, Key=key, ChecksumMode="ENABLED")
    except Exception as error:  # boto exception type is intentionally not needed for local tests
        if _is_missing(error):
            return None
        raise


def _verify_remote_file(client: Any, entry: Mapping[str, Any]) -> bool:
    """Verify a published payload without mistaking multipart checksums for file hashes.

    ``upload_file`` may use multipart upload.  S3 reports multipart SHA-256
    values as ``ChecksumType=COMPOSITE``; those values intentionally do not
    equal a SHA-256 of the complete local file.  Our immutable payload metadata
    records that complete local hash, so every accepted payload must have the
    exact size and ``growthsent-sha256`` metadata.  For S3 full-object
    checksums, we additionally verify the decoded SHA-256 bytes.
    """

    head = _head(client, entry["key"])
    if head is None:
        return False
    if int(head.get("ContentLength", -1)) != int(entry["bytes"]):
        raise ProductionDeriveError(f"destination conflict: size mismatch for {entry['key']}")

    expected_sha256 = normalize_sha256_hex(entry["sha256"])
    raw_metadata = head.get("Metadata")
    if not isinstance(raw_metadata, Mapping):
        raise ProductionDeriveError(f"destination conflict: missing growthsent-sha256 metadata for {entry['key']}")
    metadata = {str(key).lower(): value for key, value in raw_metadata.items()}
    metadata_sha256 = metadata.get("growthsent-sha256")
    if metadata_sha256 is None:
        raise ProductionDeriveError(f"destination conflict: missing growthsent-sha256 metadata for {entry['key']}")
    try:
        actual_metadata_sha256 = normalize_sha256_hex(metadata_sha256)
    except ProductionDeriveError as error:
        raise ProductionDeriveError(f"destination conflict: invalid growthsent-sha256 metadata for {entry['key']}") from error
    if actual_metadata_sha256 != expected_sha256:
        raise ProductionDeriveError(f"destination conflict: metadata SHA-256 mismatch for {entry['key']}")

    checksum_type = head.get("ChecksumType")
    if checksum_type == "COMPOSITE":
        # Multipart composite checksums are not a whole-file digest.  Exact
        # size plus the verified immutable full-file metadata is authoritative.
        return True
    if checksum_type != "FULL_OBJECT":
        raise ProductionDeriveError(f"destination conflict: unsupported S3 checksum type for {entry['key']}")

    checksum = head.get("ChecksumSHA256")
    if not isinstance(checksum, str):
        raise ProductionDeriveError(f"destination conflict: missing full-object checksum for {entry['key']}")
    try:
        checksum_bytes = base64.b64decode(checksum, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProductionDeriveError(f"destination conflict: invalid full-object checksum for {entry['key']}") from error
    if checksum_bytes != bytes.fromhex(expected_sha256):
        raise ProductionDeriveError(f"destination conflict: full-object checksum mismatch for {entry['key']}")
    return True


def _read_remote_json(client: Any, key: str) -> Mapping[str, Any]:
    try:
        response = client.get_object(Bucket=BUCKET, Key=key)
        body = response["Body"].read()
        document = json.loads(body.decode("utf-8"))
    except Exception as error:
        raise ProductionDeriveError(f"unable to read existing derive publication lease: {key}") from error
    if not isinstance(document, dict):
        raise ProductionDeriveError("existing derive publication lease is not a JSON object")
    return document


def _acquire_or_resume_lease(client: Any, key: str, *, shard: int, owner: str) -> None:
    """Create a write-once lease, or resume only the same worker's lease.

    A retry on the same derive worker can continue an interrupted upload without
    exposing a partially uploaded shard as complete. A different worker fails
    closed rather than racing that upload; operators can inspect the explicit
    control object before choosing recovery.
    """

    lease = canonical_json(
        {"run_id": RUN_ID, "crawl": CRAWL, "shard": shard, "owner": owner, "state": "publishing", "created_at": utc_now()}
    )
    existing = _head(client, key)
    if existing is None:
        try:
            client.put_object(
                Bucket=BUCKET,
                Key=key,
                Body=lease,
                ContentType="application/json",
                ChecksumAlgorithm="SHA256",
                IfNoneMatch="*",
            )
            return
        except Exception as error:
            if _client_error_code(error) not in {"PreconditionFailed", "412"}:
                raise
    existing_lease = _read_remote_json(client, key)
    if (
        existing_lease.get("run_id") == RUN_ID
        and existing_lease.get("crawl") == CRAWL
        and existing_lease.get("shard") == shard
        and existing_lease.get("owner") == owner
        and existing_lease.get("state") == "publishing"
    ):
        return
    raise ProductionDeriveError("derive shard already has a live publication lease")


def publish(client: Any, publication: Mapping[str, Any], *, owner: str) -> dict[str, int]:
    """Idempotently publish an already verified local shard; completion is last."""
    shard = int(publication["shard"]["id"])
    control = remote_control_prefix(shard)
    lease_key = normalized_prefix(control, "lease.json")
    completion_key = normalized_prefix(control, "DERIVED-SHARD-COMPLETED.json")
    manifest_key = normalized_prefix(control, "DERIVED-PUBLICATION-MANIFEST.json")
    # The publication's own provenance hash excludes its self-referential
    # field. S3 verifies the bytes actually stored, which include that field.
    publication_object_sha256 = sha256_bytes(canonical_json(publication))
    if _head(client, completion_key) is not None:
        existing = _head(client, manifest_key)
        if existing is None or existing.get("ChecksumSHA256") != s3_checksum_sha256(publication_object_sha256):
            raise ProductionDeriveError("completed derive shard does not match the reviewed publication manifest")
        return {"uploaded": 0, "already_verified": len(publication["files"]), "completed": 1}
    _acquire_or_resume_lease(client, lease_key, shard=shard, owner=owner)
    uploaded = already = 0
    for entry in publication["files"]:
        if _verify_remote_file(client, entry):
            already += 1
            continue
        client.upload_file(entry["path"], BUCKET, entry["key"], ExtraArgs={"ChecksumAlgorithm": "SHA256", "Metadata": {"growthsent-sha256": entry["sha256"]}})
        if not _verify_remote_file(client, entry):
            raise ProductionDeriveError(f"post-upload verification failed for {entry['key']}")
        uploaded += 1
    body = canonical_json(publication)
    client.put_object(Bucket=BUCKET, Key=manifest_key, Body=body, ContentType="application/json", ChecksumAlgorithm="SHA256", IfNoneMatch="*")
    marker = canonical_json({"format_version": 1, "kind": "growthsent-derived-v1-completed", "run_id": RUN_ID,
                             "crawl": CRAWL, "shard": publication["shard"],
                             "publication_manifest_sha256": publication["publication_manifest_sha256"], "completed_at": utc_now()})
    # This is intentionally the final write in the protocol.
    client.put_object(Bucket=BUCKET, Key=completion_key, Body=marker, ContentType="application/json", ChecksumAlgorithm="SHA256", IfNoneMatch="*")
    return {"uploaded": uploaded, "already_verified": already, "completed": 1}


def _paths(args: argparse.Namespace) -> Contract:
    return load_contract(args.base_manifest, args.shard_manifest, args.shard_plan, args.shard_id, args.shard_count)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate-contract", "write-source-plan"):
        command = commands.add_parser(name)
        command.add_argument("--base-manifest", type=Path, required=True)
        command.add_argument("--shard-manifest", type=Path, required=True)
        command.add_argument("--shard-plan", type=Path, required=True)
        command.add_argument("--shard-id", type=int, required=True)
        command.add_argument("--shard-count", type=int, required=True)
        if name == "write-source-plan":
            command.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify-local-detail")
    for command in (verify,):
        command.add_argument("--base-manifest", type=Path, required=True); command.add_argument("--shard-manifest", type=Path, required=True)
        command.add_argument("--shard-plan", type=Path, required=True); command.add_argument("--shard-id", type=int, required=True); command.add_argument("--shard-count", type=int, required=True)
        command.add_argument("--output-root", type=Path, required=True)
    publish_command = commands.add_parser("publish")
    publish_command.add_argument("--base-manifest", type=Path, required=True)
    publish_command.add_argument("--shard-manifest", type=Path, required=True)
    publish_command.add_argument("--shard-plan", type=Path, required=True)
    publish_command.add_argument("--shard-id", type=int, required=True)
    publish_command.add_argument("--shard-count", type=int, required=True)
    publish_command.add_argument("--output-root", type=Path, required=True)
    publish_command.add_argument("--status-dir", type=Path, required=True)
    publish_command.add_argument("--owner", required=True)
    args = parser.parse_args(argv)
    contract = _paths(args)
    if args.command == "validate-contract":
        result = source_plan(contract)
    elif args.command == "write-source-plan":
        result = source_plan(contract); write_json_atomic(args.output, result)
    elif args.command == "verify-local-detail":
        result = verify_local_detail(args.output_root, contract)
        result = {"bucket_count": result["bucket_count"], "detail_manifest_sha256": result["manifest"]["manifest_sha256"]}
    else:
        import boto3

        publication = publication_manifest(args.output_root, args.status_dir, contract)
        write_json_atomic(args.status_dir / "DERIVED-PUBLICATION-MANIFEST.json", publication)
        result = publish(boto3.client("s3"), publication, owner=args.owner)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
