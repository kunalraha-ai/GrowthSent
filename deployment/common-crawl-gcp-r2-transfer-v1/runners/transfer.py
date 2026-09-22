#!/usr/bin/env python3
"""Copy the verified link-index serving layer from GCS to Cloudflare R2.

Reads a Cloudflare R2 API token from Google Secret Manager, derives the
S3-compatible Access Key ID / Secret Access Key, and runs rclone copy.
No raw credentials are written to disk or logged.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import urllib.request

from google.cloud import secretmanager


PROJECT_ID = "growthsent-link-index"
SECRET_ID = "r2-link-index-output-write"
ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146"
R2_BUCKET = "growthsent-data-lake"
GCS_BUCKET = "growthsent-link-index-498930285709"
GCS_PREFIX = "link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416"
R2_PREFIX = "production/link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def main() -> int:
    client = secretmanager.SecretManagerServiceClient()
    try:
        response = client.access_secret_version(
            request={
                "name": f"projects/{PROJECT_ID}/secrets/{SECRET_ID}/versions/latest"
            }
        )
    except Exception as exc:
        fail(f"could not read R2 API token from Secret Manager: {exc}")

    token = response.payload.data.decode("utf-8").strip()
    if not token:
        fail("R2 API token is empty")

    verify_request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(verify_request, timeout=30) as handle:
            verify_payload = json.loads(handle.read().decode("utf-8"))
    except Exception as exc:
        fail(f"token verification failed: {exc}")

    if not verify_payload.get("success"):
        fail(f"token verification rejected: {verify_payload}")

    access_key_id = verify_payload["result"]["id"]
    secret_access_key = hashlib.sha256(token.encode("utf-8")).hexdigest()

    # rclone remote configuration via environment.  GCS uses the VM's
    # default service account metadata.  S3 points at Cloudflare R2.
    environment = dict(os.environ)
    environment.update(
        {
            "RCLONE_S3_TYPE": "s3",
            "RCLONE_S3_PROVIDER": "Cloudflare",
            "RCLONE_S3_ACCESS_KEY_ID": access_key_id,
            "RCLONE_S3_SECRET_ACCESS_KEY": secret_access_key,
            "RCLONE_S3_ENDPOINT": f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com",
            "RCLONE_S3_REGION": "auto",
            "RCLONE_S3_NO_CHECK_BUCKET": "true",
            "RCLONE_GCS_TYPE": "google cloud storage",
            "RCLONE_GCS_PROJECT_NUMBER": "498930285709",
            "RCLONE_GCS_ENV_AUTH": "true",
        }
    )

    source = f":gcs:{GCS_BUCKET}/{GCS_PREFIX}"
    destination = f":s3:{R2_BUCKET}/{R2_PREFIX}"

    command = [
        "rclone",
        "copy",
        source,
        destination,
        "--transfers", "32",
        "--checkers", "64",
        "--metadata",
        "--stats", "30s",
        "--progress",
        "--verbose",
    ]

    print(f"Starting rclone {source} -> {destination}", flush=True)
    result = subprocess.run(command, env=environment)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
