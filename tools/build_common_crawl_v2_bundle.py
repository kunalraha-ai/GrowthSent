#!/usr/bin/env python3
"""Build a deterministic, manifest-verified Common Crawl production-v2 bundle.

The builder is intentionally local-only.  It accepts an already reviewed,
explicitly sized v2 base manifest and its complete shard set; it never
downloads a Common Crawl path list or creates AWS resources.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any

import verify_common_crawl_v2_run as verifier


ROOT = Path(__file__).parents[1]
BUNDLE_NAME = "growthsent-common-crawl-production-v2"
PRODUCTION_INPUT_COUNT = verifier.PRODUCTION_INPUT_COUNT
MAX_INPUTS_PER_SHARD = 1_000
DEFAULT_SOURCE_PREFIX = "crawl-data/CC-MAIN-2026-30/"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def add_deterministic_tar_member(archive: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def load_and_verify(
    base_manifest_path: Path,
    shard_plan_path: Path,
    shard_directory: Path,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    required_source_prefix: str = DEFAULT_SOURCE_PREFIX,
) -> tuple[dict[str, Any], dict[str, Any], list[tuple[Path, dict[str, Any]]], dict[str, Any]]:
    shard_paths = sorted(
        path
        for path in shard_directory.glob("shard-*-of-*.json")
        if path.is_file()
    )
    if not shard_paths:
        raise ValueError("shard directory does not contain any JSON shard manifests")
    base = verifier.load_manifest(base_manifest_path)
    shard_plan = verifier.load_manifest(shard_plan_path)
    shards = [(path, verifier.load_manifest(path)) for path in shard_paths]
    report = verifier.verify_run_manifests(
        base,
        [shard for _, shard in shards],
        expected_input_count=expected_input_count,
        shard_plan=shard_plan,
    )
    if any(shard["input_count"] > MAX_INPUTS_PER_SHARD for _, shard in shards):
        raise ValueError(f"every v2 shard must contain at most {MAX_INPUTS_PER_SHARD} inputs")
    if any(not source.startswith(required_source_prefix) for source in base["inputs"]):
        raise ValueError("base manifest contains a source outside the required Common Crawl prefix")
    return base, shard_plan, shards, report


def build(
    output: Path,
    base_manifest_path: Path,
    shard_plan_path: Path,
    shard_directory: Path,
    *,
    expected_input_count: int = PRODUCTION_INPUT_COUNT,
    required_source_prefix: str = DEFAULT_SOURCE_PREFIX,
) -> dict[str, Any]:
    base, shard_plan, shards, report = load_and_verify(
        base_manifest_path,
        shard_plan_path,
        shard_directory,
        expected_input_count=expected_input_count,
        required_source_prefix=required_source_prefix,
    )
    release_files = [
        ROOT / "tools" / "common_crawl_wat_ingest.py",
        ROOT / "tools" / "common_crawl_wat_ingest_v2.py",
        ROOT / "tools" / "common_crawl_v2_manifest.py",
        ROOT / "tools" / "verify_common_crawl_v2_run.py",
        ROOT / "tools" / "common_crawl_backlink_derive.py",
        ROOT / "deployment" / "common-crawl-production-v2" / "requirements.txt",
        ROOT / "deployment" / "common-crawl-production-v2" / "README.md",
    ]
    missing = [str(path) for path in release_files if not path.is_file()]
    if missing:
        raise RuntimeError(f"v2 release is missing required files: {', '.join(missing)}")

    with tempfile.TemporaryDirectory(prefix="growthsent-cc-v2-") as temporary_directory:
        stage = Path(temporary_directory) / BUNDLE_NAME
        tools_directory = stage / "tools"
        manifests_directory = stage / "manifests"
        shards_directory = manifests_directory / "shards"
        tools_directory.mkdir(parents=True)
        shards_directory.mkdir(parents=True)
        for path in release_files[:5]:
            shutil.copy2(path, tools_directory / path.name)
        for path in release_files[5:]:
            shutil.copy2(path, stage / path.name)
        shutil.copy2(base_manifest_path, manifests_directory / "base-manifest.json")
        shutil.copy2(shard_plan_path, shards_directory / "shard-plan.json")
        for path, _ in shards:
            shutil.copy2(path, shards_directory / path.name)

        bundle_files = sorted(path for path in stage.rglob("*") if path.is_file())
        bundle_manifest = {
            "bundle_format_version": verifier.FORMAT_VERSION,
            "bundle_name": BUNDLE_NAME,
            "run_id": base["run_id"],
            "crawl": base["crawl"],
            "base_input_count": base["input_count"],
            "base_inputs_sha256": base["inputs_sha256"],
            "base_manifest_sha256": base["manifest_sha256"],
            "shard_count": shard_plan["shard_count"],
            "shard_plan_sha256": shard_plan["plan_sha256"],
            "files": {
                path.relative_to(stage).as_posix(): {"sha256": sha256(path), "bytes": path.stat().st_size}
                for path in bundle_files
            },
        }
        (stage / "BUNDLE-MANIFEST.json").write_text(
            json.dumps(bundle_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                with tarfile.open(mode="w", fileobj=compressed, format=tarfile.PAX_FORMAT) as archive:
                    for path in sorted(stage.rglob("*")):
                        if path.is_file():
                            add_deterministic_tar_member(
                                archive, path, f"{BUNDLE_NAME}/{path.relative_to(stage).as_posix()}"
                            )
    return {
        "archive": str(output),
        "archive_bytes": output.stat().st_size,
        "archive_sha256": sha256(output),
        "run_id": base["run_id"],
        "input_count": base["input_count"],
        "inputs_sha256": base["inputs_sha256"],
        "manifest_sha256": base["manifest_sha256"],
        "shard_count": shard_plan["shard_count"],
        "shard_plan_sha256": shard_plan["plan_sha256"],
        "verification": report,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base-manifest", required=True, type=Path)
    parser.add_argument("--shard-plan", required=True, type=Path)
    parser.add_argument("--shard-dir", required=True, type=Path)
    parser.add_argument("--expected-input-count", required=True, type=int)
    parser.add_argument("--required-source-prefix", default=DEFAULT_SOURCE_PREFIX)
    args = parser.parse_args(argv)
    print(json.dumps(
        build(
            args.output,
            args.base_manifest,
            args.shard_plan,
            args.shard_dir,
            expected_input_count=args.expected_input_count,
            required_source_prefix=args.required_source_prefix,
        ),
        indent=2,
        sort_keys=True,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
