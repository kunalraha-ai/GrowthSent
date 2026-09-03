#!/usr/bin/env python3
"""Entrypoint for one isolated task in a regional standard-1 ramp."""

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

import common_crawl_cloudflare_r2_standard1_regional_ramp as ramp
import common_crawl_r2_store as r2


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required runtime setting: {name}")
    return value


def integer(name: str) -> int:
    try:
        value = int(required(name))
    except ValueError as error:
        raise RuntimeError(f"{name} must be a decimal integer") from error
    if value < 0:
        raise RuntimeError(f"{name} must be non-negative")
    return value


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def redacted_error(error: BaseException) -> str:
    message = str(error)
    for name in ("GROWTHSENT_R2_ACCESS_KEY_ID", "GROWTHSENT_R2_SECRET_ACCESS_KEY", "GROWTHSENT_R2_SESSION_TOKEN"):
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
    run_id = required("GROWTHSENT_RAMP_ID")
    region = required("GROWTHSENT_REGION")
    task_index = integer("GROWTHSENT_TASK_INDEX")

    def runtime_metadata() -> dict[str, Any]:
        return {
            "provider": "cloudflare-containers",
            "instance_type": required("GROWTHSENT_CONTAINER_INSTANCE_TYPE"),
            "provisioned_vcpu": 0.5,
            "provisioned_memory_mib": 4_096,
            "configured_disk_gib": 8,
            "observed_filesystem_capacity_bytes": sampler.capacity,
            "max_observed_disk_used_bytes": sampler.maximum_used,
            "disk_sample_count": sampler.samples,
            "max_rss_bytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024,
            "container_wall_seconds": round(time.monotonic() - started, 3),
            "hard_timeout_seconds": integer("GROWTHSENT_HARD_TIMEOUT_SECONDS"),
            "disk_is_ephemeral": True,
            "region": region,
            "task_index": task_index,
        }

    try:
        configured_output_prefix = os.environ.get("GROWTHSENT_R2_OUTPUT_PREFIX")
        prefix = ramp.region_prefix(run_id, region) if configured_output_prefix is None else r2.normalize_key(configured_output_prefix)
        store = r2.R2Store.from_environment(allowed_prefixes=[prefix])
        result = ramp.run_task(
            run_id=run_id,
            region=region,
            task_index=task_index,
            inputs_path=Path("/opt/growthsent/selected-inputs.json"),
            selected_inputs_sha256=required("GROWTHSENT_SELECTED_INPUTS_SHA256"),
            output_dir=Path("/work/output"),
            release_sha256=required("GROWTHSENT_RELEASE_SHA256"),
            store=store,
            r2_output_prefix=prefix,
            runtime_metadata=runtime_metadata,
        )
        print(json.dumps({
            "run_id": run_id,
            "region": region,
            "task_index": task_index,
            "completed": bool(result.get("completed")),
            "reused": bool(result.get("reused")),
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "container_wall_seconds": round(time.monotonic() - started, 3),
            "completion_key": f"{prefix}/tasks/task-{task_index + 1:04d}/TASK-COMPLETED.json",
        }, sort_keys=True), flush=True)
        return 0
    except BaseException as error:
        print(json.dumps({
            "run_id": run_id,
            "region": region,
            "task_index": task_index,
            "completed": False,
            "error_type": type(error).__name__,
            "error": redacted_error(error),
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "container_wall_seconds": round(time.monotonic() - started, 3),
        }, sort_keys=True), file=sys.stderr, flush=True)
        return 1
    finally:
        sampler.stop()


if __name__ == "__main__":
    raise SystemExit(main())
