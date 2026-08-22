#!/usr/bin/env python3
"""Build the deterministic local-only GCP/R2 25K release bundle.

The builder validates the immutable 25K source slice before copying anything.
It performs no network or cloud action and never includes runtime credentials.
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

import verify_common_crawl_gcp_r2_25k_run as verifier


ROOT = Path(__file__).parents[1]
DEPLOYMENT = ROOT / "deployment" / "common-crawl-gcp-r2-25k"
BUNDLE_NAME = "growthsent-common-crawl-gcp-r2-25k"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _add_member(archive: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def _required_paths() -> list[Path]:
    return [
        ROOT / "tools" / "common_crawl_wat_ingest.py",
        ROOT / "tools" / "common_crawl_v2_manifest.py",
        ROOT / "tools" / "common_crawl_backlink_derive.py",
        ROOT / "tools" / "common_crawl_http_source.py",
        ROOT / "tools" / "common_crawl_r2_store.py",
        ROOT / "tools" / "common_crawl_gcp_r2_25k_contract.py",
        ROOT / "tools" / "common_crawl_gcp_secret_runtime.py",
        ROOT / "tools" / "common_crawl_gcp_r2_one_wat_canary.py",
        ROOT / "tools" / "build_common_crawl_gcp_r2_25k_batch_job.py",
        ROOT / "tools" / "common_crawl_wat_ingest_gcp_25k.py",
        ROOT / "tools" / "common_crawl_backlink_derive_gcp_25k.py",
        ROOT / "tools" / "verify_common_crawl_gcp_r2_25k_run.py",
        DEPLOYMENT / "requirements.txt",
        DEPLOYMENT / "README.md",
        DEPLOYMENT / "ARCHITECTURE.md",
        DEPLOYMENT / "container" / "Dockerfile",
        DEPLOYMENT / "runners" / "raw-task.sh",
        DEPLOYMENT / "runners" / "derive-task.sh",
        DEPLOYMENT / "config" / "derive-rollup-hosts.txt",
        DEPLOYMENT / "batch" / "raw-shard-job.template.json",
        DEPLOYMENT / "batch" / "derive-shard-job.template.json",
        DEPLOYMENT / "iam" / "gcp-service-account-design.json",
        DEPLOYMENT / "iam" / "r2-temporary-credential-contract.json",
    ]


def build(output: Path) -> dict[str, Any]:
    manifest_root = DEPLOYMENT / "manifests" / "cc-main-2026-30-offset-10000-count-25000"
    report = verifier.verify(manifest_root / "base-manifest.json", manifest_root / "shards")
    required = _required_paths()
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("GCP/R2 release is missing: " + ", ".join(missing))
    with tempfile.TemporaryDirectory(prefix="growthsent-gcp-r2-25k-") as temporary:
        stage = Path(temporary) / BUNDLE_NAME
        tools = stage / "tools"
        runners = stage / "runners"
        config = stage / "config"
        manifests = stage / "manifests"
        for directory in (tools, runners, config, manifests / "shards"):
            directory.mkdir(parents=True, exist_ok=True)
        for path in required:
            if path.parent.name == "tools":
                target = tools / path.name
            elif path.parent.name == "runners":
                target = runners / path.name
            elif path.parent.name == "config":
                target = config / path.name
            elif path.parent.name in {"batch", "iam"}:
                target = stage / path.parent.name / path.name
            else:
                target = stage / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        shutil.copy2(manifest_root / "base-manifest.json", manifests / "base-manifest.json")
        for path in sorted((manifest_root / "shards").glob("*")):
            if path.is_file():
                shutil.copy2(path, manifests / "shards" / path.name)
        included = sorted(path for path in stage.rglob("*") if path.is_file())
        bundle_manifest = {
            "bundle_format_version": 1,
            "bundle_name": BUNDLE_NAME,
            "run": report,
            "files": {
                path.relative_to(stage).as_posix(): {"sha256": sha256(path), "bytes": path.stat().st_size}
                for path in included
            },
        }
        (stage / "BUNDLE-MANIFEST.json").write_text(
            json.dumps(bundle_manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("wb") as handle:
            with gzip.GzipFile(filename="", mode="wb", fileobj=handle, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for path in sorted(stage.rglob("*")):
                        if path.is_file():
                            _add_member(archive, path, f"{BUNDLE_NAME}/{path.relative_to(stage).as_posix()}")
    return {"archive": str(output), "archive_bytes": output.stat().st_size, "archive_sha256": sha256(output), **report}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(build(args.output), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
