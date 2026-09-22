#!/usr/bin/env python3
"""Generate per-domain JSON files for a curated demo list using only R2.

Reads the R2 output-write credential once from Google Secret Manager, then drives
build_domain_json_v1.py per affected bucket. This avoids any long-running GCP
compute; only the secret lookup touches GCP.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def domain_bucket(domain: str) -> int:
    digest = hashlib.sha256(domain.encode("utf-8")).hexdigest()
    return (int(digest[:3], 16) >> 2) % 1024


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domains-file", required=True, type=Path)
    parser.add_argument("--serving-prefix", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--top-n", type=int, default=100)
    args = parser.parse_args()

    sys_path = [str(Path(__file__).resolve().parent)]
    sys_path.extend(os.environ.get("PYTHONPATH", "").split(os.pathsep))
    os.environ["PYTHONPATH"] = os.pathsep.join(sys_path)

    from common_crawl_r2_store import R2Store
    import build_domain_json_v1 as builder

    secret_name = "projects/growthsent-link-index/secrets/r2-link-index-output-write/versions/latest"
    try:
        from google.cloud import secretmanager
    except ImportError as exc:
        raise SystemExit(f"google-cloud-secret-manager is required: {exc}")

    client = secretmanager.SecretManagerServiceClient()
    token = client.access_secret_version(request={"name": secret_name}).payload.data.decode("utf-8").strip()
    if not token:
        raise SystemExit("R2 output-write token is empty")

    import urllib.request
    verify_request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with urllib.request.urlopen(verify_request, timeout=30) as handle:
        verify_payload = json.loads(handle.read().decode("utf-8"))
    access_key_id = verify_payload["result"]["id"]
    secret_access_key = hashlib.sha256(token.encode("utf-8")).hexdigest()

    os.environ["GROWTHSENT_R2_ACCOUNT_ID"] = "4a30e8ac877d9f65ee9a0ecc5df16146"
    os.environ["GROWTHSENT_R2_BUCKET"] = "growthsent-data-lake"
    os.environ["GROWTHSENT_R2_OUTPUT_ACCESS_KEY_ID"] = access_key_id
    os.environ["GROWTHSENT_R2_OUTPUT_SECRET_ACCESS_KEY"] = secret_access_key

    r2_store = R2Store.from_environment(
        credential_prefix="GROWTHSENT_R2_OUTPUT_",
        allowed_prefixes=[args.output_prefix],
    )

    domain_filter = builder._load_domain_filter(args.domains_file, None)
    if not domain_filter:
        raise SystemExit("no domains in file")

    by_bucket: dict[int, set[str]] = {}
    for domain in domain_filter:
        by_bucket.setdefault(domain_bucket(domain), set()).add(domain)

    print(f"domains: {len(domain_filter)} across {len(by_bucket)} buckets")
    args.work_dir.mkdir(parents=True, exist_ok=True)

    for bucket, domains in sorted(by_bucket.items()):
        print(f"bucket {bucket:04d}: {len(domains)} domains", flush=True)
        result = builder.process_bucket(
            bucket=bucket,
            serving_prefix=args.serving_prefix.rstrip("/"),
            output_prefix=args.output_prefix.rstrip("/"),
            work_dir=args.work_dir,
            r2_store=r2_store,
            top_n=args.top_n,
            upload_threads=min(8, max(1, len(domains))),
            batch_size=max(16, len(domains) * 4),
            domain_filter=domains,
        )
        print(json.dumps(result, sort_keys=True), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
