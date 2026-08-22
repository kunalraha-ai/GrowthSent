#!/usr/bin/env python3
"""Materialize one reviewed GCP Batch job JSON locally; never submit it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any

import common_crawl_gcp_r2_25k_contract as contract_tools


ROOT = Path(__file__).parents[1]
DEPLOYMENT = ROOT / "deployment" / "common-crawl-gcp-r2-25k"
MANIFEST_ROOT = DEPLOYMENT / "manifests" / contract_tools.RUN_ID
IMAGE_RE = re.compile(r"[^\s]+@sha256:[0-9a-f]{64}\Z")
EMAIL_RE = re.compile(r"[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com\Z")
SECRET_VERSION_RE = re.compile(r"projects/[^/]+/secrets/[^/]+/versions/(?:[1-9][0-9]*|latest)\Z")


class BatchJobBuildError(ValueError):
    """The operator supplied a job field outside the reviewed contract."""


def _required(value: str, name: str, pattern: re.Pattern[str]) -> str:
    if not pattern.fullmatch(value):
        raise BatchJobBuildError(f"{name} has an unsafe/unreviewed format")
    return value


def _shard_contract(shard_id: int) -> contract_tools.ShardContract:
    return contract_tools.load_contract(
        MANIFEST_ROOT / "base-manifest.json",
        MANIFEST_ROOT / "shards" / f"shard-{shard_id:05d}-of-00025.json",
        MANIFEST_ROOT / "shards" / "shard-plan.json",
        shard_id=shard_id,
    )


def _environment(job: dict[str, Any]) -> dict[str, str]:
    try:
        return job["taskGroups"][0]["taskSpec"]["environment"]["variables"]
    except (KeyError, IndexError, TypeError) as error:
        raise BatchJobBuildError("Batch template has no task environment map") from error


def build(
    *,
    stage: str,
    shard_id: int,
    release_sha256: str,
    image_uri: str,
    service_account: str,
    attempt_id: str,
    primary_r2_secret_version: str,
    additional_r2_secret_version: str | None = None,
    allow_expired_lease_takeover: bool = False,
) -> dict[str, Any]:
    if stage not in {"raw", "derive"}:
        raise BatchJobBuildError("stage must be raw or derive")
    if not re.fullmatch(r"[0-9a-f]{64}", release_sha256):
        raise BatchJobBuildError("release SHA-256 must be lowercase hex")
    _required(image_uri, "image URI", IMAGE_RE)
    _required(service_account, "service account", EMAIL_RE)
    _required(primary_r2_secret_version, "primary Secret Manager version", SECRET_VERSION_RE)
    if additional_r2_secret_version is not None:
        _required(additional_r2_secret_version, "additional Secret Manager version", SECRET_VERSION_RE)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", attempt_id):
        raise BatchJobBuildError("attempt ID must be a bounded lowercase Batch job identifier")
    if stage == "raw" and additional_r2_secret_version is not None:
        raise BatchJobBuildError("raw jobs accept exactly one R2 secret version")
    if stage == "derive" and additional_r2_secret_version is None:
        raise BatchJobBuildError("derive jobs require separate raw-read and derived-write secret versions")
    checked = _shard_contract(shard_id)
    template = DEPLOYMENT / "batch" / f"{stage}-shard-job.template.json"
    job = json.loads(template.read_text(encoding="utf-8"))
    if "first-10000" in json.dumps(job) or "s3://" in json.dumps(job):
        raise BatchJobBuildError("template is not isolated from the reviewed GCP/R2 contract")
    task = job["taskGroups"][0]["taskSpec"]
    task["runnables"][0]["container"]["imageUri"] = image_uri
    job["allocationPolicy"]["serviceAccount"]["email"] = service_account
    environment = _environment(job)
    identity = {
        "GROWTHSENT_RELEASE_SHA256": release_sha256,
        "GROWTHSENT_BASE_INPUTS_SHA256": contract_tools.INPUTS_SHA256,
        "GROWTHSENT_BASE_MANIFEST_SHA256": contract_tools.BASE_MANIFEST_SHA256,
        "GROWTHSENT_SHARD_INPUTS_SHA256": checked.shard["inputs_sha256"],
        "GROWTHSENT_SHARD_MANIFEST_SHA256": checked.shard["manifest_sha256"],
        "GROWTHSENT_BATCH_ATTEMPT": attempt_id,
    }
    if stage == "raw":
        identity.update({"GROWTHSENT_SHARD_ID": str(shard_id), "GROWTHSENT_R2_RAW_PUBLISH_SECRET_VERSION": primary_r2_secret_version})
    else:
        identity.update(
            {
                "GROWTHSENT_DERIVE_SHARD_ID": str(shard_id),
                "GROWTHSENT_R2_RAW_READ_SECRET_VERSION": primary_r2_secret_version,
                "GROWTHSENT_R2_DERIVED_WRITE_SECRET_VERSION": str(additional_r2_secret_version),
            }
        )
    if allow_expired_lease_takeover:
        identity["GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER"] = "true"
    environment.update(identity)
    if any("REPLACE_WITH" in value for value in environment.values()) or "REPLACE_WITH" in json.dumps(job):
        raise BatchJobBuildError("unresolved placeholder remains in materialized Batch job")
    return job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("raw", "derive"), required=True)
    parser.add_argument("--shard-id", type=int, required=True)
    parser.add_argument("--release-sha256", required=True)
    parser.add_argument("--image-uri", required=True)
    parser.add_argument("--service-account", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--primary-r2-secret-version", required=True)
    parser.add_argument("--additional-r2-secret-version")
    parser.add_argument("--allow-expired-lease-takeover", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    document = build(
        stage=args.stage,
        shard_id=args.shard_id,
        release_sha256=args.release_sha256,
        image_uri=args.image_uri,
        service_account=args.service_account,
        attempt_id=args.attempt_id,
        primary_r2_secret_version=args.primary_r2_secret_version,
        additional_r2_secret_version=args.additional_r2_secret_version,
        allow_expired_lease_takeover=args.allow_expired_lease_takeover,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
