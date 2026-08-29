"""One explicit, reproducible semantic digest contract for Common Crawl WAT output.

The contract compares the *multiset* of emitted Page and Link records, rather
than Parquet bytes or incidental writer ordering.  It is intentionally small
enough to run after one WAT has been parsed, and is shared by the reference
baseline builder and the Cloudflare Container canary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

import pyarrow.parquet as pq


CONTRACT_ID = "growthsent-semantic-records-v2"
CONTRACT_VERSION = 2
SHA256_HEX_LENGTH = 64


class SemanticContractError(RuntimeError):
    """A semantic baseline or artifact does not meet the v2 contract."""


@dataclass(frozen=True)
class SemanticDigests:
    pages_count: int
    links_count: int
    canonical_pages_digest: str
    canonical_links_digest: str
    canonical_record_digest: str
    target_host_bucket_digest: str


def _canonical_json_line(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _normalise(value: Any) -> Any:
    """Make Parquet/Python values stable before canonical JSON encoding."""

    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, Mapping):
        return {str(key): _normalise(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalise(item) for item in value]
    return value


def _row_digest(row: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_json_line(_normalise(row))).hexdigest()


def _multiset_digest(row_digests: list[str]) -> str:
    """Hash a sorted multiset of fixed-width row hashes with explicit lines."""

    digest = hashlib.sha256()
    for value in sorted(row_digests):
        digest.update(value.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _host_bucket(target_host: str) -> str:
    first_twelve_bits = int(hashlib.sha256(target_host.encode("utf-8")).hexdigest()[:3], 16)
    return f"{first_twelve_bits >> 2:04d}"


def _dataset_digest(path: Path, *, collect_target_hosts: bool) -> tuple[int, str, dict[tuple[str, str], int]]:
    if not path.is_file():
        raise SemanticContractError(f"missing required Parquet artifact: {path}")
    count = 0
    row_digests: list[str] = []
    target_host_counts: dict[tuple[str, str], int] = {}
    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches():
        for raw_row in batch.to_pylist():
            if not isinstance(raw_row, Mapping):
                raise SemanticContractError("Parquet record is not a mapping")
            count += 1
            row_digests.append(_row_digest(raw_row))
            if collect_target_hosts:
                target_host = raw_row.get("target_host")
                # A syntactically valid parsed link can lack a usable target
                # host. It remains in the Links dataset digest, but cannot
                # participate in a target-host bucket by definition.
                if not isinstance(target_host, str) or not target_host:
                    continue
                bucket = _host_bucket(target_host)
                key = (target_host, bucket)
                target_host_counts[key] = target_host_counts.get(key, 0) + 1
    return count, _multiset_digest(row_digests), target_host_counts


def _target_host_bucket_digest(counts: Mapping[tuple[str, str], int]) -> str:
    digest = hashlib.sha256()
    for (target_host, bucket), record_count in sorted(counts.items()):
        digest.update(
            _canonical_json_line(
                {
                    "record_count": record_count,
                    "target_host": target_host,
                    "target_host_bucket": bucket,
                }
            )
        )
    return digest.hexdigest()


def artifact_semantic_digests(*, pages_path: Path, links_path: Path) -> SemanticDigests:
    """Calculate every v2 digest from one Pages/Links artifact pair."""

    pages_count, pages_digest, _unused = _dataset_digest(pages_path, collect_target_hosts=False)
    links_count, links_digest, target_host_counts = _dataset_digest(links_path, collect_target_hosts=True)
    record_digest = hashlib.sha256(
        _canonical_json_line(
            {
                "contract": CONTRACT_ID,
                "links": links_digest,
                "pages": pages_digest,
            }
        )
    ).hexdigest()
    return SemanticDigests(
        pages_count=pages_count,
        links_count=links_count,
        canonical_pages_digest=pages_digest,
        canonical_links_digest=links_digest,
        canonical_record_digest=record_digest,
        target_host_bucket_digest=_target_host_bucket_digest(target_host_counts),
    )


def manifest_contract() -> dict[str, Any]:
    """The exact contract declaration embedded in each approved baseline."""

    return {
        "id": CONTRACT_ID,
        "version": CONTRACT_VERSION,
        "record_normalisation": "datetime-isoformat;date-time-isoformat;bytes-lowercase-hex;recursive-json-values",
        "canonical_json": "utf-8;ensure-ascii=false;sort-keys=true;separators=comma-colon;trailing-newline=true",
        "dataset_digest": "sha256(sorted-sha256(canonical-json-line(record))-ascii-json-lines)",
        "record_digest": "sha256(canonical-json-line({contract,links,pages}))",
        "target_host_bucket_digest": "sha256(sorted-canonical-json-lines({record_count,target_host,target_host_bucket}) for non-empty link target_host values)",
    }


def require_manifest_contract(document: Mapping[str, Any]) -> None:
    """Fail closed unless this is an exact v2 semantic baseline."""

    if document.get("semantic_contract") != manifest_contract():
        raise SemanticContractError("reference manifest does not declare the exact growthsent semantic v2 contract")


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == SHA256_HEX_LENGTH and all(character in "0123456789abcdef" for character in value)
