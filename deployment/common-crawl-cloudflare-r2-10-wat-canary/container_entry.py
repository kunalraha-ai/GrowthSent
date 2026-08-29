#!/usr/bin/env python3
"""Entrypoint for the sequential Cloudflare Container ten-WAT canary."""

from __future__ import annotations

import json
import os
from pathlib import Path
import resource
import shutil
import sys
import threading
import time
from typing import Any

import common_crawl_cloudflare_r2_ten_wat_canary as canary
import common_crawl_r2_store as r2


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required runtime setting: {name}")
    return value


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def redacted_error(error: BaseException) -> str:
    message = str(error)
    for name in (
        "GROWTHSENT_R2_ACCESS_KEY_ID",
        "GROWTHSENT_R2_SECRET_ACCESS_KEY",
        "GROWTHSENT_R2_SESSION_TOKEN",
    ):
        value = os.environ.get(name)
        if value:
            message = message.replace(value, "[redacted]")
    return message[:512]


class DiskSampler:
    def __init__(self, path: str) -> None:
        self.path = path
        self.samples = 0
        self.maximum_used = 0
        self.capacity = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def sample(self) -> None:
        usage = shutil.disk_usage(self.path)
        self.capacity = max(self.capacity, int(usage.total))
        self.maximum_used = max(self.maximum_used, int(usage.used))
        self.samples += 1

    def _run(self) -> None:
        while not self._stop.wait(1):
            self.sample()

    def start(self) -> None:
        self.sample()
        self._thread.start()

    def stop(self) -> None:
        self.sample()
        self._stop.set()
        self._thread.join(timeout=2)


def main() -> int:
    started_at = utc_timestamp()
    started = time.monotonic()
    sampler = DiskSampler("/work")
    sampler.start()
    canary_id = required("GROWTHSENT_CANARY_ID")

    def runtime_metadata() -> dict[str, Any]:
        return {
            "provider": "cloudflare-containers",
            "instance_type": required("GROWTHSENT_CONTAINER_INSTANCE_TYPE"),
            "provisioned_vcpu": 4,
            "provisioned_memory_mib": 12_288,
            "provisioned_disk_bytes": sampler.capacity,
            "max_observed_disk_used_bytes": sampler.maximum_used,
            "disk_sample_count": sampler.samples,
            "max_rss_bytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024,
            "container_wall_seconds": round(time.monotonic() - started, 3),
            "hard_timeout_seconds": int(required("GROWTHSENT_HARD_TIMEOUT_SECONDS")),
            "disk_is_ephemeral": True,
        }

    try:
        prefix = r2.normalize_key(canary.CANARY_ROOT, canary_id)
        store = r2.R2Store.from_environment(allowed_prefixes=[prefix])
        result = canary.run_ten(
            canary_id=canary_id,
            output_dir=Path("/work/output"),
            reference_manifest=Path("/opt/growthsent/reference-manifest.json"),
            reference_manifest_sha256=required("GROWTHSENT_REFERENCE_MANIFEST_SHA256"),
            release_sha256=required("GROWTHSENT_RELEASE_SHA256"),
            store=store,
            runtime_metadata=runtime_metadata,
        )
        print(
            json.dumps(
                {
                    "canary_id": canary_id,
                    "completed": bool(result.get("completed")),
                    "reused": bool(result.get("reused")),
                    "started_at": started_at,
                    "finished_at": utc_timestamp(),
                    "container_wall_seconds": round(time.monotonic() - started, 3),
                    "completion_key": f"{prefix}/CANARY-COMPLETED.json",
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return 0
    except BaseException as error:
        print(
            json.dumps(
                {
                    "canary_id": canary_id,
                    "completed": False,
                    "error_type": type(error).__name__,
                    "error": redacted_error(error),
                    "started_at": started_at,
                    "finished_at": utc_timestamp(),
                    "container_wall_seconds": round(time.monotonic() - started, 3),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1
    finally:
        sampler.stop()


if __name__ == "__main__":
    raise SystemExit(main())
