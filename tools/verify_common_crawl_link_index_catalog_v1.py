#!/usr/bin/env python3
"""Verify the immutable GCS links catalog before link materialization.

This is intentionally a local, read-only proof.  It validates the catalog's
self-hash and every one of its 100,000 source-to-links-artifact contracts
against the reviewed input manifest and source-root contract.  It does not
read R2, change GCS, or invoke any cloud worker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any


CATALOG_KIND = "growthsent-cc-main-2026-30-links-catalog-v1"
MANIFEST_KIND = "common-crawl-v2-base-manifest"
ROOTS_KIND = "growthsent-cc-main-2026-30-completion-marker-roots-v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


class CatalogVerificationError(RuntimeError):
    """The catalog does not meet the reviewed immutable contract."""


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _load_json(path: Path, *, label: str) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogVerificationError(f"cannot read {label}") from error
    if not isinstance(document, dict):
        raise CatalogVerificationError(f"{label} must be a JSON object")
    return document


def _required_sha256(document: Mapping[str, Any], field: str) -> str:
    value = document.get(field)
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise CatalogVerificationError(f"{field} must be a lowercase SHA-256 digest")
    return value


def _verify_manifest(document: Mapping[str, Any]) -> tuple[str, list[str]]:
    if document.get("kind") != MANIFEST_KIND or document.get("crawl") != "CC-MAIN-2026-30":
        raise CatalogVerificationError("locked source manifest identity is invalid")
    manifest_sha256 = _required_sha256(document, "manifest_sha256")
    check_manifest = dict(document)
    check_manifest.pop("manifest_sha256", None)
    if manifest_sha256 != _sha256(_canonical_json(check_manifest)):
        raise CatalogVerificationError("locked source manifest digest is invalid")
    inputs = document.get("inputs")
    if not isinstance(inputs, list) or not all(isinstance(item, str) and item for item in inputs):
        raise CatalogVerificationError("locked source manifest inputs are invalid")
    if document.get("input_count") != len(inputs) or len(inputs) != 100_000 or len(set(inputs)) != len(inputs):
        raise CatalogVerificationError("locked source manifest does not define the exact 100K range")
    inputs_sha256 = document.get("inputs_sha256")
    actual_inputs_sha256 = _sha256("\n".join(inputs).encode("utf-8"))
    if inputs_sha256 != actual_inputs_sha256:
        raise CatalogVerificationError("locked source manifest input-list digest is invalid")
    return manifest_sha256, inputs


def _verify_roots(document: Mapping[str, Any]) -> str:
    if document.get("kind") != ROOTS_KIND or document.get("crawl") != "CC-MAIN-2026-30":
        raise CatalogVerificationError("source-roots contract identity is invalid")
    roots = document.get("roots")
    if not isinstance(roots, list) or len(roots) != 7:
        raise CatalogVerificationError("source-roots contract does not define seven R2 roots")
    prefixes: set[str] = set()
    identifiers: set[str] = set()
    for root in roots:
        if not isinstance(root, Mapping):
            raise CatalogVerificationError("source root is not an object")
        identifier = root.get("id")
        prefix = root.get("prefix")
        if not isinstance(identifier, str) or not identifier or not isinstance(prefix, str) or not prefix.endswith("/"):
            raise CatalogVerificationError("source root is invalid")
        if identifier in identifiers or prefix in prefixes:
            raise CatalogVerificationError("source-root identifiers and prefixes must be unique")
        identifiers.add(identifier)
        prefixes.add(prefix)
    return _sha256(_canonical_json(document))


def verify_catalog(*, catalog_path: Path, source_manifest_path: Path, source_roots_path: Path) -> dict[str, Any]:
    catalog = _load_json(catalog_path, label="catalog")
    manifest = _load_json(source_manifest_path, label="locked source manifest")
    roots = _load_json(source_roots_path, label="source-roots contract")
    manifest_sha256, inputs = _verify_manifest(manifest)
    roots_sha256 = _verify_roots(roots)

    if catalog.get("kind") != CATALOG_KIND or catalog.get("crawl") != "CC-MAIN-2026-30":
        raise CatalogVerificationError("catalog identity is invalid")
    catalog_sha256 = _required_sha256(catalog, "catalog_sha256")
    check_catalog = dict(catalog)
    check_catalog.pop("catalog_sha256", None)
    if catalog_sha256 != _sha256(_canonical_json(check_catalog)):
        raise CatalogVerificationError("catalog digest is invalid")
    if catalog.get("source_manifest_sha256") != manifest_sha256:
        raise CatalogVerificationError("catalog does not reference the locked source manifest")
    if catalog.get("source_roots_sha256") != roots_sha256:
        raise CatalogVerificationError("catalog does not reference the reviewed source roots")
    entries = catalog.get("entries")
    if catalog.get("source_identity_count") != len(inputs) or not isinstance(entries, list) or len(entries) != len(inputs):
        raise CatalogVerificationError("catalog does not contain exactly 100K entries")

    link_keys: set[str] = set()
    total_links_bytes = 0
    for source_index, expected_source_key in enumerate(inputs):
        entry = entries[source_index]
        if not isinstance(entry, Mapping) or entry.get("source_index") != source_index:
            raise CatalogVerificationError("catalog source indexes do not partition the locked range")
        if entry.get("source_key") != expected_source_key:
            raise CatalogVerificationError("catalog source identity differs from the locked manifest")
        links = entry.get("links")
        if not isinstance(links, Mapping):
            raise CatalogVerificationError("catalog links artifact is invalid")
        key = links.get("key")
        byte_count = links.get("bytes")
        if not isinstance(key, str) or not key or key in link_keys:
            raise CatalogVerificationError("catalog links artifacts must be unique non-empty keys")
        if isinstance(byte_count, bool) or not isinstance(byte_count, int) or byte_count <= 0:
            raise CatalogVerificationError("catalog links artifact byte count is invalid")
        _required_sha256(links, "sha256")
        link_keys.add(key)
        total_links_bytes += byte_count

    return {
        "status": "verified",
        "kind": CATALOG_KIND,
        "crawl": "CC-MAIN-2026-30",
        "catalog_sha256": catalog_sha256,
        "source_identity_count": len(inputs),
        "distinct_links_artifact_count": len(link_keys),
        "links_artifact_total_bytes": total_links_bytes,
        "source_root_count": 7,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--source-roots", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        proof = verify_catalog(
            catalog_path=args.catalog,
            source_manifest_path=args.source_manifest,
            source_roots_path=args.source_roots,
        )
    except CatalogVerificationError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, sort_keys=True), flush=True)
        return 1
    print(json.dumps(proof, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
