#!/usr/bin/env python3
"""Materialize and verify the locked CC-MAIN-2026-30 production-v1 paths."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def inputs_sha256(paths: list[str]) -> str:
    return hashlib.sha256("\n".join(paths).encode("utf-8")).hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "format_version", "crawl", "input_count", "path_prefix", "path_suffix",
        "start_index", "index_width", "inputs_sha256",
    }
    missing = required.difference(manifest)
    if missing:
        raise ValueError(f"manifest is missing required fields: {', '.join(sorted(missing))}")
    if manifest["format_version"] != 1:
        raise ValueError("unsupported manifest format")
    if not isinstance(manifest["input_count"], int) or manifest["input_count"] < 1:
        raise ValueError("manifest input_count must be a positive integer")
    if not isinstance(manifest["start_index"], int) or manifest["start_index"] < 0:
        raise ValueError("manifest start_index must be a non-negative integer")
    if not isinstance(manifest["index_width"], int) or manifest["index_width"] < 1:
        raise ValueError("manifest index_width must be a positive integer")
    if not all(isinstance(manifest[key], str) for key in ("crawl", "path_prefix", "path_suffix", "inputs_sha256")):
        raise ValueError("manifest string fields must be strings")
    return manifest


def paths_from_manifest(manifest: dict[str, Any], count: int | None = None) -> list[str]:
    total = manifest["input_count"]
    selected = total if count is None else count
    if not isinstance(selected, int) or not 1 <= selected <= total:
        raise ValueError(f"count must be between 1 and {total}")
    paths = [
        f"{manifest['path_prefix']}{index:0{manifest['index_width']}d}{manifest['path_suffix']}"
        for index in range(manifest["start_index"], manifest["start_index"] + selected)
    ]
    if selected == total and inputs_sha256(paths) != manifest["inputs_sha256"]:
        raise RuntimeError("materialized full path list does not match locked SHA-256")
    return paths


def write_paths(path: Path, paths: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(paths) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--count", type=int, help="Materialize exactly this ordered prefix")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    manifest = load_manifest(args.manifest)
    paths = paths_from_manifest(manifest, args.count)
    write_paths(args.output, paths)
    print(json.dumps({
        "crawl": manifest["crawl"],
        "count": len(paths),
        "inputs_sha256": inputs_sha256(paths),
        "first": paths[0],
        "last": paths[-1],
        "output": str(args.output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
