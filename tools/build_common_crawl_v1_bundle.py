#!/usr/bin/env python3
"""Build a deterministic deployment tarball for Common Crawl production v1."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import tarfile
import tempfile
from pathlib import Path

import common_crawl_v1_manifest as locked_manifest


ROOT = Path(__file__).parents[1]
BUNDLE_NAME = "growthsent-common-crawl-production-v1"
MANIFEST_NAME = "cc-main-2026-30-first-1000"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_source_list(source_path_list: Path, expected_paths: list[str]) -> None:
    import gzip as gzip_module

    opener = gzip_module.open if source_path_list.suffix == ".gz" else open
    with opener(source_path_list, "rt", encoding="utf-8") as handle:
        observed = []
        for line in handle:
            value = line.strip()
            if value:
                observed.append(value)
                if len(observed) == len(expected_paths):
                    break
    if observed != expected_paths:
        raise RuntimeError("the supplied source path list does not match the locked first-1,000 manifest")


def add_deterministic_tar_member(archive: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def build(output: Path, source_path_list: Path | None) -> dict[str, object]:
    source_manifest = ROOT / "deployment" / "common-crawl-production-v1" / "manifests" / f"{MANIFEST_NAME}.json"
    manifest = locked_manifest.load_manifest(source_manifest)
    paths = locked_manifest.paths_from_manifest(manifest)
    if source_path_list:
        verify_source_list(source_path_list, paths)

    with tempfile.TemporaryDirectory(prefix="growthsent-cc-v1-") as temporary:
        stage = Path(temporary) / BUNDLE_NAME
        (stage / "tools").mkdir(parents=True)
        (stage / "manifests").mkdir()
        shutil.copy2(ROOT / "tools" / "common_crawl_wat_ingest.py", stage / "tools")
        shutil.copy2(ROOT / "tools" / "common_crawl_v1_manifest.py", stage / "tools")
        shutil.copy2(ROOT / "tools" / "verify_common_crawl_s3_objects.py", stage / "tools")
        shutil.copy2(source_manifest, stage / "manifests")
        shutil.copy2(ROOT / "deployment" / "common-crawl-production-v1" / "requirements.txt", stage)
        shutil.copy2(ROOT / "deployment" / "common-crawl-production-v1" / "README.md", stage)
        paths_path = stage / "manifests" / f"{MANIFEST_NAME}.paths"
        locked_manifest.write_paths(paths_path, paths)

        bundle_files = sorted(path for path in stage.rglob("*") if path.is_file())
        bundle_manifest = {
            "bundle_format_version": 1,
            "bundle_name": BUNDLE_NAME,
            "crawl": manifest["crawl"],
            "input_count": manifest["input_count"],
            "inputs_sha256": manifest["inputs_sha256"],
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
        "inputs_sha256": manifest["inputs_sha256"],
        "input_count": manifest["input_count"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-path-list", type=Path,
                        help="Verify the generated locked paths against this existing list before packaging")
    args = parser.parse_args(argv)
    print(json.dumps(build(args.output, args.source_path_list), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
