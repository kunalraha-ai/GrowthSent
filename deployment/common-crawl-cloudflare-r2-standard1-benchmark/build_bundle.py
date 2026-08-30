#!/usr/bin/env python3
"""Build a local-only, secret-free standard-1 one-WAT benchmark bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Iterable


ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146"
HARD_TIMEOUT_SECONDS = 6600
REFERENCE_ENTRY_COUNT = 10
SELECTED_REFERENCE_ENTRY_INDEX = 0
BENCHMARK_INPUT_COUNT = 1
BENCHMARK_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
WORKER_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TOOLS = ROOT / "tools"
TOOL_NAMES = (
    "common_crawl_cloudflare_r2_standard1_benchmark.py",
    "common_crawl_cloudflare_r2_ten_wat_canary.py",
    "common_crawl_gcp_r2_25k_contract.py",
    "common_crawl_http_source.py",
    "common_crawl_r2_store.py",
    "common_crawl_semantic_contract_v2.py",
    "common_crawl_v2_manifest.py",
    "common_crawl_wat_ingest.py",
    "common_crawl_wat_ingest_gcp_25k.py",
)
STATIC_FILES = (
    "Dockerfile",
    "requirements.txt",
    "standard1_benchmark_entry.py",
    "run-benchmark.sh",
    "package.json",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def checked_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise ValueError(f"missing {label}: {path}")
    return path


def release_sha256(paths: Iterable[Path], output_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.relative_to(output_dir).as_posix()):
        relative = path.relative_to(output_dir).as_posix().encode("utf-8")
        digest.update(relative + b"\0")
        digest.update(sha256_file(path).encode("ascii") + b"\n")
    return digest.hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark-id", required=True)
    parser.add_argument("--worker-name", required=True)
    parser.add_argument("--container-name", required=True)
    parser.add_argument("--reference-manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def load_reference(path: Path) -> tuple[dict[str, object], dict[str, object]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("reference manifest is not valid UTF-8 JSON") from error
    if not isinstance(document, dict):
        raise SystemExit("reference manifest must be a JSON object")
    entries = document.get("entries")
    if (
        not isinstance(entries, list)
        or len(entries) != REFERENCE_ENTRY_COUNT
        or document.get("entry_count") != REFERENCE_ENTRY_COUNT
    ):
        raise SystemExit("reference manifest must contain exactly the reviewed ten entries")
    contract = document.get("semantic_contract")
    if not isinstance(contract, dict) or contract.get("id") != "growthsent-semantic-records-v2" or contract.get("version") != 2:
        raise SystemExit("reference manifest must declare the reviewed growthsent semantic v2 contract")
    selected = entries[SELECTED_REFERENCE_ENTRY_INDEX]
    if (
        not isinstance(selected, dict)
        or not isinstance(selected.get("source_key"), str)
        or not isinstance(selected.get("deterministic_suffix"), str)
        or not re.fullmatch(r"[0-9a-f]{16}", selected["deterministic_suffix"])
    ):
        raise SystemExit("reference manifest's fixed benchmark entry is malformed")
    return document, selected


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not BENCHMARK_ID_RE.fullmatch(args.benchmark_id):
        raise SystemExit("--benchmark-id must be a lowercase slug of at most 64 characters")
    if not WORKER_NAME_RE.fullmatch(args.worker_name) or not WORKER_NAME_RE.fullmatch(args.container_name):
        raise SystemExit("--worker-name and --container-name must be lowercase slugs")
    reference = checked_file(args.reference_manifest, "reference manifest")
    reference_sha256 = sha256_file(reference)
    _document, selected = load_reference(reference)
    if args.output_dir.exists():
        raise SystemExit(f"refusing to overwrite an existing bundle directory: {args.output_dir}")

    args.output_dir.mkdir(parents=True)
    copied: list[Path] = []
    for name in STATIC_FILES:
        source = checked_file(HERE / name, name)
        destination = args.output_dir / name
        shutil.copyfile(source, destination)
        copied.append(destination)
    source_index = checked_file(HERE / "src" / "index.ts", "Worker source")
    destination_index = args.output_dir / "src" / "index.ts"
    destination_index.parent.mkdir(parents=True)
    shutil.copyfile(source_index, destination_index)
    copied.append(destination_index)
    destination_reference = args.output_dir / "reference-manifest.json"
    shutil.copyfile(reference, destination_reference)
    copied.append(destination_reference)
    destination_tools = args.output_dir / "tools"
    destination_tools.mkdir()
    for name in TOOL_NAMES:
        source = checked_file(TOOLS / name, f"tool {name}")
        destination = destination_tools / name
        shutil.copyfile(source, destination)
        copied.append(destination)

    release = release_sha256(copied, args.output_dir)
    release_document = {
        "format_version": 1,
        "kind": "growthsent-cloudflare-r2-standard1-one-wat-benchmark-release",
        "benchmark_id": args.benchmark_id,
        "worker_name": args.worker_name,
        "container_name": args.container_name,
        "reference_manifest_sha256": reference_sha256,
        "reference_manifest_entry_count": REFERENCE_ENTRY_COUNT,
        "selected_reference_entry_index": SELECTED_REFERENCE_ENTRY_INDEX,
        "selected_source_key": selected["source_key"],
        "selected_deterministic_suffix": selected["deterministic_suffix"],
        "input_count": BENCHMARK_INPUT_COUNT,
        "instance_type": "standard-1",
        "release_sha256": release,
        "files": [
            {"path": path.relative_to(args.output_dir).as_posix(), "sha256": sha256_file(path)}
            for path in sorted(copied, key=lambda item: item.relative_to(args.output_dir).as_posix())
        ],
    }
    (args.output_dir / "BENCHMARK-RELEASE.json").write_bytes(canonical_json(release_document))

    config = {
        "$schema": "node_modules/wrangler/config-schema.json",
        "account_id": ACCOUNT_ID,
        "name": args.worker_name,
        "main": "src/index.ts",
        "compatibility_date": "2026-08-29",
        "compatibility_flags": ["nodejs_compat"],
        "workers_dev": True,
        "observability": {"enabled": True, "logs": {"invocation_logs": True, "head_sampling_rate": 1}},
        "containers": [
            {
                "class_name": "GrowthSentStandard1BenchmarkContainer",
                "name": args.container_name,
                "image": "./Dockerfile",
                "instance_type": "standard-1",
                "max_instances": 1,
            }
        ],
        "durable_objects": {
            "bindings": [{"name": "BENCHMARK_CONTAINER", "class_name": "GrowthSentStandard1BenchmarkContainer"}]
        },
        "migrations": [{"tag": "v1", "new_sqlite_classes": ["GrowthSentStandard1BenchmarkContainer"]}],
        "vars": {
            "GROWTHSENT_R2_ACCOUNT_ID": ACCOUNT_ID,
            "GROWTHSENT_R2_BUCKET": "growthsent-data-lake",
            "GROWTHSENT_BENCHMARK_ID": args.benchmark_id,
            "GROWTHSENT_RELEASE_SHA256": release,
            "GROWTHSENT_REFERENCE_MANIFEST_SHA256": reference_sha256,
            "GROWTHSENT_CONTAINER_INSTANCE_TYPE": "standard-1",
            "GROWTHSENT_HARD_TIMEOUT_SECONDS": str(HARD_TIMEOUT_SECONDS),
        },
    }
    (args.output_dir / "wrangler.jsonc").write_bytes(canonical_json(config))
    print(
        json.dumps(
            {
                "benchmark_id": args.benchmark_id,
                "worker_name": args.worker_name,
                "container_name": args.container_name,
                "selected_reference_entry_index": SELECTED_REFERENCE_ENTRY_INDEX,
                "selected_source_key": selected["source_key"],
                "release_sha256": release,
                "output_dir": str(args.output_dir),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
