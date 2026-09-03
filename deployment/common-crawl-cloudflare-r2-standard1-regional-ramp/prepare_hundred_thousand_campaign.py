#!/usr/bin/env python3
"""Prepare a local-only, auditable 100,000-WAT campaign for 256-slot waves.

The current regional Worker profile processes exactly 10,000 WATs with eight
isolated 32-slot lanes.  A single 100,000-WAT remote run would make one
temporary R2 credential and one set of Workers responsible for several days of
work.  This preparer instead derives ten immutable 10,000-WAT base manifests
from the locked 100,000-WAT source manifest.  Each future wave can therefore
be started, verified, retired, and recovered independently.

This program only reads local manifests and writes local files.  It does not
call Cloudflare, create credentials, deploy a Worker, start a Container, or
write R2 objects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Mapping, Sequence


TOTAL_TASK_COUNT = 100_000
WAVE_TASK_COUNT = 10_000
WAVE_COUNT = TOTAL_TASK_COUNT // WAVE_TASK_COUNT
EXECUTION_PROFILE = "regional-256-ten-thousand-wat"
CAMPAIGN_KIND = "growthsent-cloudflare-r2-standard1-hundred-thousand-campaign-v1"
CAMPAIGN_FORMAT_VERSION = 1

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_v2_manifest as manifest  # noqa: E402


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def campaign_sha256(document: Mapping[str, Any]) -> str:
    payload = dict(document)
    payload.pop("campaign_sha256", None)
    return hashlib.sha256(canonical_json(payload).rstrip(b"\n")).hexdigest()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(argv)


def require_empty_output_dir(path: Path) -> None:
    if path.exists() and not path.is_dir():
        raise SystemExit(f"output path is not a directory: {path}")
    if path.exists() and any(path.iterdir()):
        raise SystemExit(f"output directory must be empty: {path}")
    path.mkdir(parents=True, exist_ok=True)


def build_campaign(source_path: Path, output_dir: Path) -> dict[str, Any]:
    source = manifest.load_base_manifest(
        source_path, expected_input_count=TOTAL_TASK_COUNT
    )
    source_inputs = list(source["inputs"])
    if len(source_inputs) != TOTAL_TASK_COUNT:
        raise SystemExit("source manifest does not contain exactly 100,000 WAT inputs")

    require_empty_output_dir(output_dir)
    waves_dir = output_dir / "waves"
    waves_dir.mkdir()
    waves: list[dict[str, Any]] = []
    reconstructed_inputs: list[str] = []

    for wave_index in range(WAVE_COUNT):
        start = wave_index * WAVE_TASK_COUNT
        end = start + WAVE_TASK_COUNT
        wave_inputs = source_inputs[start:end]
        if len(wave_inputs) != WAVE_TASK_COUNT:
            raise SystemExit("100,000-WAT campaign has an incomplete deterministic wave")
        wave_document = manifest.build_base_manifest(
            # build_base_manifest validates the derived run ID, so a source
            # run ID that would make a future wave name unsafe fails closed.
            run_id=f"{source['run_id']}-wave-{wave_index:02d}-of-{WAVE_COUNT:02d}",
            crawl=source["crawl"],
            inputs=wave_inputs,
            expected_input_count=WAVE_TASK_COUNT,
        )
        relative_path = Path("waves") / f"wave-{wave_index:02d}-of-{WAVE_COUNT:02d}.json"
        wave_path = output_dir / relative_path
        wave_path.write_bytes(canonical_json(wave_document))
        # Read back and validate the exact serialized artifact that later
        # launch preparation will consume.
        loaded_wave = manifest.load_base_manifest(
            wave_path, expected_input_count=WAVE_TASK_COUNT
        )
        if loaded_wave["inputs"] != wave_inputs:
            raise SystemExit("serialized campaign wave differs from its source slice")
        reconstructed_inputs.extend(loaded_wave["inputs"])
        waves.append(
            {
                "wave_index": wave_index,
                "input_start": start,
                "input_end_exclusive": end,
                "input_count": WAVE_TASK_COUNT,
                "manifest_path": relative_path.as_posix(),
                "manifest_file_sha256": sha256_file(wave_path),
                "manifest_claim_sha256": loaded_wave["manifest_sha256"],
                "inputs_sha256": loaded_wave["inputs_sha256"],
                "first_input": loaded_wave["inputs"][0],
                "last_input": loaded_wave["inputs"][-1],
                "remote_start": "disabled; this is a locally prepared future wave",
            }
        )

    if reconstructed_inputs != source_inputs:
        raise SystemExit("campaign wave union does not exactly reproduce the source input order")
    if manifest.inputs_sha256(reconstructed_inputs) != source["inputs_sha256"]:
        raise SystemExit("campaign wave union SHA-256 does not match the source manifest")

    campaign: dict[str, Any] = {
        "format_version": CAMPAIGN_FORMAT_VERSION,
        "kind": CAMPAIGN_KIND,
        "source": {
            "manifest_path": str(source_path),
            "manifest_file_sha256": sha256_file(source_path),
            "manifest_claim_sha256": source["manifest_sha256"],
            "inputs_sha256": source["inputs_sha256"],
            "input_count": TOTAL_TASK_COUNT,
            "run_id": source["run_id"],
            "crawl": source["crawl"],
        },
        "wave_count": WAVE_COUNT,
        "wave_task_count": WAVE_TASK_COUNT,
        "execution_profile": EXECUTION_PROFILE,
        "topology": {
            "lane_count": 8,
            "slots_per_lane": 32,
            "max_concurrent_total": 256,
            "start_spacing_seconds_per_lane": 30,
            "physical_regions": ["APAC", "ENAM", "WNAM", "WEUR"],
        },
        "waves": waves,
        "remote_start": "disabled; campaign preparation creates only local immutable manifests",
    }
    campaign["campaign_sha256"] = campaign_sha256(campaign)
    campaign_path = output_dir / "CAMPAIGN-PLAN.json"
    campaign_path.write_bytes(canonical_json(campaign))
    try:
        serialized_campaign = json.loads(campaign_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("serialized campaign plan is not valid UTF-8 JSON") from error
    if serialized_campaign.get("campaign_sha256") != campaign_sha256(serialized_campaign):
        raise SystemExit("serialized campaign plan SHA-256 is invalid")
    return serialized_campaign


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    campaign = build_campaign(args.source_manifest, args.output_dir)
    print(
        json.dumps(
            {
                "status": "hundred_thousand_campaign_prepared",
                "campaign": str(args.output_dir / "CAMPAIGN-PLAN.json"),
                "campaign_sha256": campaign["campaign_sha256"],
                "wave_count": campaign["wave_count"],
                "wave_task_count": campaign["wave_task_count"],
                "task_count": TOTAL_TASK_COUNT,
                "remote_start": campaign["remote_start"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
