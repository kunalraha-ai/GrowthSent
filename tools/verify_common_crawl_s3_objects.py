#!/usr/bin/env python3
"""Verify a published deterministic WAT Pages/Links/metrics triplet in S3."""

from __future__ import annotations

import argparse
import hashlib
import json

import boto3


def input_key(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def object_key(prefix: str, crawl: str, dataset: str, filename: str) -> str:
    return "/".join(filter(None, [prefix.strip("/"), f"crawl={crawl}", f"dataset={dataset}", filename]))


def expected_keys(prefix: str, crawl: str, source: str) -> dict[str, str]:
    """Return the deterministic remote triplet produced by the ingester."""
    part = input_key(source)
    return {
        "pages": object_key(prefix, crawl, "pages", f"part-{part}.parquet"),
        "links": object_key(prefix, crawl, "links", f"part-{part}.parquet"),
        "metrics": object_key(prefix, crawl, "metrics", f"part-{part}.json"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--crawl", required=True)
    parser.add_argument("--source", required=True)
    args = parser.parse_args(argv)
    keys = expected_keys(args.prefix, args.crawl, args.source)
    client = boto3.client("s3")
    objects = {}
    for name, key in keys.items():
        response = client.head_object(Bucket=args.bucket, Key=key)
        objects[name] = {"key": key, "bytes": response["ContentLength"], "etag": response.get("ETag")}
    response = client.get_object(Bucket=args.bucket, Key=keys["metrics"])
    with response["Body"] as body:
        metrics = json.loads(body.read().decode("utf-8"))
    if metrics.get("input") != args.source:
        raise RuntimeError("metrics sidecar input does not match the expected deterministic source")
    print(json.dumps({"bucket": args.bucket, "objects": objects, "metrics": metrics}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
