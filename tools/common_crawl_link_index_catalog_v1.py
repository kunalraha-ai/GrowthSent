#!/usr/bin/env python3
"""Build a fail-closed R2 Links-artifact catalog for the verified 100K corpus.

The source task completion marker is authoritative only when it is a verified
immutable JSON object. Links Parquet payloads are verified again by the later
materialization task immediately before they are read. This job never fetches
WAT files, never mutates R2, and writes exactly one generation-guarded GCS
catalog object.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import common_crawl_r2_store as r2


CATALOG_KIND = "growthsent-cc-main-2026-30-links-catalog-v1"
ROOTS_KIND = "growthsent-cc-main-2026-30-completion-marker-roots-v1"
TASK_COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1"
SHA256_LENGTH = 64


class CatalogError(RuntimeError):
    """A source marker or catalog object violates the immutable contract."""


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _required_string(value: Mapping[str, Any], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item:
        raise CatalogError(f"missing required string: {name}")
    return item


def _sha256_string(value: Mapping[str, Any], name: str) -> str:
    item = _required_string(value, name)
    if len(item) != SHA256_LENGTH or any(character not in "0123456789abcdef" for character in item):
        raise CatalogError(f"invalid SHA-256: {name}")
    return item


def _load_json(path: Path, *, expected_kind: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogError(f"cannot read JSON contract: {path}") from error
    if not isinstance(value, dict) or value.get("kind") != expected_kind:
        raise CatalogError(f"unexpected JSON contract kind: {path}")
    return value


def _load_locked_sources(path: Path) -> tuple[str, str, dict[str, int]]:
    document = _load_json(path, expected_kind="common-crawl-v2-base-manifest")
    crawl = _required_string(document, "crawl")
    manifest_sha256 = _sha256_string(document, "manifest_sha256")
    inputs_sha256 = _sha256_string(document, "inputs_sha256")
    inputs = document.get("inputs")
    if not isinstance(inputs, list) or not inputs or not all(isinstance(item, str) and item for item in inputs):
        raise CatalogError("locked source manifest has invalid inputs")
    if document.get("input_count") != len(inputs) or len(set(inputs)) != len(inputs):
        raise CatalogError("locked source manifest is not a unique exact input range")
    # The manifest's self-declared digests are part of the verified campaign
    # contract. The values are retained in the catalog for later attribution.
    return crawl, manifest_sha256, {source_key: index for index, source_key in enumerate(inputs)}


def _load_roots(path: Path, *, crawl: str) -> tuple[dict[str, Any], tuple[str, ...]]:
    document = _load_json(path, expected_kind=ROOTS_KIND)
    if document.get("crawl") != crawl:
        raise CatalogError("source roots crawl does not match locked source manifest")
    roots = document.get("roots")
    if not isinstance(roots, list) or not roots:
        raise CatalogError("source roots must have at least one root")
    prefixes: list[str] = []
    identifiers: set[str] = set()
    for root in roots:
        if not isinstance(root, Mapping):
            raise CatalogError("source root must be an object")
        identifier = _required_string(root, "id")
        prefix = r2.normalize_prefix(_required_string(root, "prefix"))
        if identifier in identifiers or prefix in prefixes:
            raise CatalogError("source root identifiers and prefixes must be unique")
        identifiers.add(identifier)
        prefixes.append(prefix)
    return document, tuple(prefixes)


def _links_artifact(marker: Mapping[str, Any], *, source_key: str, source_index: int, root_prefix: str) -> dict[str, Any]:
    if marker.get("kind") != TASK_COMPLETION_KIND:
        raise CatalogError("completion marker kind is not accepted")
    if marker.get("crawl") != "CC-MAIN-2026-30" or marker.get("source_key") != source_key:
        raise CatalogError("completion marker source identity is invalid")
    artifacts = marker.get("artifacts")
    if not isinstance(artifacts, list):
        raise CatalogError("completion marker artifacts are invalid")
    candidates = [artifact for artifact in artifacts if isinstance(artifact, Mapping) and artifact.get("dataset") == "links"]
    if len(candidates) != 1:
        raise CatalogError("completion marker must contain exactly one links artifact")
    artifact = candidates[0]
    key = _required_string(artifact, "key")
    if not key.startswith(root_prefix):
        raise CatalogError("links artifact lies outside its approved R2 source root")
    bytes_count = artifact.get("bytes")
    if not isinstance(bytes_count, int) or bytes_count <= 0:
        raise CatalogError("links artifact bytes are invalid")
    sha256 = _sha256_string(artifact, "sha256")
    return {
        "source_index": source_index,
        "source_key": source_key,
        "links": {"key": key, "bytes": bytes_count, "sha256": sha256},
    }


def _catalog_document(
    *, crawl: str, source_manifest_sha256: str, source_roots: Mapping[str, Any], entries: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    entries_list = sorted(entries, key=lambda item: int(item["source_index"]))
    result: dict[str, Any] = {
        "format_version": 1,
        "kind": CATALOG_KIND,
        "crawl": crawl,
        "source_manifest_sha256": source_manifest_sha256,
        "source_roots_sha256": _sha256(_canonical_json(dict(source_roots))),
        "source_identity_count": len(entries_list),
        "entries": entries_list,
    }
    result["catalog_sha256"] = _sha256(_canonical_json(result))
    return result


def _verify_existing_catalog(blob: Any, expected: Mapping[str, Any]) -> bool:
    if not blob.exists():
        return False
    try:
        current = json.loads(blob.download_as_bytes().decode("utf-8"))
    except Exception as error:
        raise CatalogError("existing GCS catalog is not valid JSON") from error
    if not isinstance(current, dict) or current.get("kind") != CATALOG_KIND:
        raise CatalogError("existing GCS object conflicts with catalog identity")
    if current.get("catalog_sha256") != expected.get("catalog_sha256"):
        raise CatalogError("existing GCS catalog conflicts with immutable source contract")
    return True


def _upload_catalog(*, bucket_name: str, object_name: str, document: Mapping[str, Any]) -> bool:
    try:
        from google.api_core.exceptions import PreconditionFailed
        from google.cloud import storage
    except ImportError as error:
        raise CatalogError("google-cloud-storage is required for catalog publication") from error
    if not bucket_name or "/" in bucket_name or not object_name or object_name.startswith("/"):
        raise CatalogError("GCS destination is invalid")
    client = storage.Client()
    blob = client.bucket(bucket_name).blob(object_name)
    payload = _canonical_json(dict(document))
    try:
        blob.upload_from_string(
            payload,
            content_type="application/json",
            if_generation_match=0,
            checksum="crc32c",
        )
    except PreconditionFailed:
        return _verify_existing_catalog(blob, document)
    return False


def build_catalog(*, source_manifest: Path, source_roots: Path) -> dict[str, Any]:
    crawl, manifest_sha256, source_indexes = _load_locked_sources(source_manifest)
    roots_document, root_prefixes = _load_roots(source_roots, crawl=crawl)
    store = r2.R2Store.from_environment(allowed_prefixes=root_prefixes, credential_prefix="GROWTHSENT_R2_INPUT_READ_")
    entries: dict[int, dict[str, Any]] = {}
    for root_prefix in root_prefixes:
        marker_keys = [key for key in store.list_keys(root_prefix) if key.endswith("/TASK-COMPLETED.json")]
        if not marker_keys:
            raise CatalogError(f"approved source root contains no completion markers: {root_prefix}")
        for key in marker_keys:
            item = store.read_json(key)
            if item is None:
                raise CatalogError("completion marker disappeared while cataloging")
            marker, _etag = item
            source_key = _required_string(marker, "source_key")
            source_index = source_indexes.get(source_key)
            if source_index is None:
                raise CatalogError("completion marker refers to a source outside the locked 100K manifest")
            entry = _links_artifact(marker, source_key=source_key, source_index=source_index, root_prefix=root_prefix)
            if source_index in entries:
                raise CatalogError(f"duplicate valid completion marker for source index {source_index}")
            entries[source_index] = entry
    if len(entries) != len(source_indexes):
        raise CatalogError(f"incomplete catalog: expected {len(source_indexes)} source identities, found {len(entries)}")
    if list(sorted(entries)) != list(range(len(source_indexes))):
        raise CatalogError("catalog source indexes do not partition the locked source range")
    return _catalog_document(
        crawl=crawl,
        source_manifest_sha256=manifest_sha256,
        source_roots=roots_document,
        entries=entries.values(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--source-roots", required=True, type=Path)
    parser.add_argument("--gcs-bucket", required=True)
    parser.add_argument("--gcs-object", required=True)
    args = parser.parse_args(argv)
    try:
        catalog = build_catalog(source_manifest=args.source_manifest, source_roots=args.source_roots)
        reused = _upload_catalog(bucket_name=args.gcs_bucket, object_name=args.gcs_object, document=catalog)
    except (CatalogError, r2.R2StoreError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, sort_keys=True), flush=True)
        return 1
    print(
        json.dumps(
            {
                "status": "reused" if reused else "published",
                "catalog_object": args.gcs_object,
                "catalog_sha256": catalog["catalog_sha256"],
                "source_identity_count": catalog["source_identity_count"],
                "source_roots_sha256": catalog["source_roots_sha256"],
            },
            sort_keys=True,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
