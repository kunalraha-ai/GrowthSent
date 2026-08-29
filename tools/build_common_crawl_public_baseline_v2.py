#!/usr/bin/env python3
"""Build a deterministic public-source semantic baseline for exactly ten WATs.

This utility never talks to R2.  It downloads the locked Common Crawl inputs
over public HTTPS, writes only ephemeral local Pages/Links files, calculates
the v2 semantic contract, removes those artifacts, and creates one local audit
manifest.  It is deliberately labelled a public-source baseline, not a golden
artifact comparison, because the original golden raw objects are unavailable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
from typing import Any, Mapping

import common_crawl_gcp_r2_25k_contract as contract
import common_crawl_http_source as http_source
import common_crawl_semantic_contract_v2 as semantic
import common_crawl_wat_ingest_gcp_25k as raw


INPUT_SPEC_KIND = "growthsent-public-source-baseline-inputs-v2"
BASELINE_KIND = "growthsent-public-source-baseline-manifest-v2"
ENTRY_COUNT = 10


class BaselineBuildError(RuntimeError):
    """The public-source baseline cannot safely be created."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def read_input_spec(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise BaselineBuildError(f"locked input spec is missing: {path}")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BaselineBuildError("locked input spec is not valid UTF-8 JSON") from error
    if not isinstance(document, Mapping) or document.get("kind") != INPUT_SPEC_KIND:
        raise BaselineBuildError("locked input spec kind is invalid")
    if document.get("crawl") != contract.CRAWL or document.get("entry_count") != ENTRY_COUNT:
        raise BaselineBuildError("locked input spec is not exactly the approved ten-WAT crawl slice")
    inputs = document.get("inputs")
    if not isinstance(inputs, list) or len(inputs) != ENTRY_COUNT:
        raise BaselineBuildError("locked input spec must contain exactly ten inputs")
    result: list[dict[str, str]] = []
    seen_sources: set[str] = set()
    seen_suffixes: set[str] = set()
    for item in inputs:
        if not isinstance(item, Mapping):
            raise BaselineBuildError("locked input spec contains a non-object input")
        source = item.get("source_key")
        suffix = item.get("deterministic_suffix")
        if not isinstance(source, str) or not isinstance(suffix, str):
            raise BaselineBuildError("locked input spec contains invalid source data")
        source = http_source.validate_common_crawl_key(source, crawl=contract.CRAWL)
        if suffix != contract.part_suffix(source):
            raise BaselineBuildError("locked input spec suffix does not match its source key")
        if source in seen_sources or suffix in seen_suffixes:
            raise BaselineBuildError("locked input spec contains duplicate sources or suffixes")
        seen_sources.add(source)
        seen_suffixes.add(suffix)
        result.append({"source_key": source, "deterministic_suffix": suffix})
    return result


def parser_identity() -> dict[str, str]:
    root = Path(__file__).resolve().parent
    files = (
        "common_crawl_wat_ingest.py",
        "common_crawl_wat_ingest_gcp_25k.py",
        "common_crawl_semantic_contract_v2.py",
    )
    return {name: sha256_file(root / name) for name in files}


def artifact_paths(output_dir: Path, source_key: str) -> tuple[Path, Path]:
    values = {dataset: path for dataset, path, _content_type in raw.artifact_paths(output_dir, source_key)}
    return values["pages"], values["links"]


def reported_count(report: Mapping[str, Any], field: str) -> int:
    """Read a parser count without confusing a valid zero with missing data."""

    value = report.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise BaselineBuildError(f"parser report has an invalid {field}")
    return value


def remove_artifacts(output_dir: Path, source_key: str) -> None:
    for _dataset, path, _content_type in raw.artifact_paths(output_dir, source_key):
        path.unlink(missing_ok=True)


def entry_for_source(source: Mapping[str, str], *, output_dir: Path, reader: http_source.CommonCrawlHttpSource) -> dict[str, Any]:
    source_key = source["source_key"]
    report = raw._write_one(
        source_key,
        output_dir,
        source_reader=reader,
        batch_size=50_000,
        run_id="growthsent-public-source-baseline-v2",
        source_max_attempts=http_source.DEFAULT_MAX_ATTEMPTS,
    )
    pages_path, links_path = artifact_paths(output_dir, source_key)
    try:
        digests = semantic.artifact_semantic_digests(pages_path=pages_path, links_path=links_path)
    except semantic.SemanticContractError as error:
        raise BaselineBuildError(f"semantic v2 digest calculation failed: {error}") from error
    finally:
        remove_artifacts(output_dir, source_key)
    pages_count = reported_count(report, "pages_emitted")
    links_count = reported_count(report, "links_emitted")
    malformed_count = reported_count(report, "malformed_records")
    if pages_count != digests.pages_count or links_count != digests.links_count:
        raise BaselineBuildError("parser report and v2 artifact counts disagree")
    return {
        "source_key": source_key,
        "deterministic_suffix": source["deterministic_suffix"],
        "pages_count": pages_count,
        "links_count": links_count,
        "malformed_count": malformed_count,
        "canonical_pages_digest": digests.canonical_pages_digest,
        "canonical_links_digest": digests.canonical_links_digest,
        "canonical_record_digest": digests.canonical_record_digest,
        "target_host_bucket": {"target_host_bucket_digest": digests.target_host_bucket_digest},
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-spec", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    inputs = read_input_spec(args.input_spec)
    if args.output_manifest.exists():
        raise BaselineBuildError(f"refusing to overwrite an existing audit manifest: {args.output_manifest}")
    if args.work_dir.exists():
        raise BaselineBuildError(f"refusing to reuse an existing work directory: {args.work_dir}")
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.work_dir.mkdir(parents=True)
    reader = http_source.CommonCrawlHttpSource(crawl=contract.CRAWL, max_attempts=http_source.DEFAULT_MAX_ATTEMPTS)
    entries: list[dict[str, Any]] = []
    try:
        for index, source in enumerate(inputs, start=1):
            entry = entry_for_source(source, output_dir=args.work_dir, reader=reader)
            entries.append(entry)
            print(
                json.dumps(
                    {
                        "stage": "source_complete",
                        "index": index,
                        "source_key": entry["source_key"],
                        "pages_count": entry["pages_count"],
                        "links_count": entry["links_count"],
                        "malformed_count": entry["malformed_count"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
    finally:
        shutil.rmtree(args.work_dir, ignore_errors=True)

    document = {
        "format_version": 2,
        "kind": BASELINE_KIND,
        "crawl": contract.CRAWL,
        "entry_count": ENTRY_COUNT,
        "semantic_contract": semantic.manifest_contract(),
        "reference_origin": {
            "type": "bounded-public-source-reconstruction-v2",
            "reference_label": "public-source semantic baseline; not an immutable golden-artifact comparison",
            "transport": "Common Crawl public HTTPS",
            "original_golden_raw_artifacts_available": False,
            "published_raw_artifacts": False,
            "processing_scope": "exactly ten locked WAT source keys; sequential local parser execution",
        },
        "locked_input_spec_sha256": sha256_file(args.input_spec),
        "parser_files_sha256": parser_identity(),
        "entries": entries,
    }
    args.output_manifest.write_bytes(canonical_json(document))
    print(
        json.dumps(
            {
                "status": "baseline_built",
                "output_manifest": str(args.output_manifest),
                "manifest_sha256": sha256_file(args.output_manifest),
                "entry_count": len(entries),
                "work_dir_removed": not args.work_dir.exists(),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BaselineBuildError as error:
        print(json.dumps({"status": "baseline_failed", "error": str(error)}))
        raise SystemExit(1)
