#!/usr/bin/env python3
"""Read-only R2 compatibility probe using the exact boto3 configuration in the Container."""

from __future__ import annotations

import json
import sys
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def error_details(error: ClientError) -> tuple[int | None, str | None]:
    response = error.response.get("ResponseMetadata", {})
    payload = error.response.get("Error", {})
    status = response.get("HTTPStatusCode")
    code = payload.get("Code")
    return (int(status) if isinstance(status, int) else None, str(code) if code else None)


def main() -> int:
    request: dict[str, Any] = json.load(sys.stdin)
    required = ("account_id", "bucket", "key", "prefix", "access_key_id", "secret_access_key", "session_token")
    if any(not request.get(name) for name in required):
        raise SystemExit("missing required boto3 R2 preflight input")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{request['account_id']}.r2.cloudflarestorage.com",
        region_name="auto",
        aws_access_key_id=request["access_key_id"],
        aws_secret_access_key=request["secret_access_key"],
        aws_session_token=request["session_token"],
        config=Config(connect_timeout=10, read_timeout=30, retries={"mode": "standard", "total_max_attempts": 2}, signature_version="s3v4"),
    )
    get_status: int | None = None
    get_code: str | None = None
    try:
        response = client.get_object(Bucket=request["bucket"], Key=request["key"], Range="bytes=0-0")
        get_status = int(response["ResponseMetadata"]["HTTPStatusCode"])
        body = response.get("Body")
        if body is not None:
            body.close()
    except ClientError as error:
        get_status, get_code = error_details(error)

    list_status: int | None = None
    list_code: str | None = None
    key_count: int | None = None
    truncated: bool | None = None
    try:
        response = client.list_objects_v2(Bucket=request["bucket"], Prefix=request["prefix"], MaxKeys=1000)
        list_status = int(response["ResponseMetadata"]["HTTPStatusCode"])
        key_count = len(response.get("Contents") or [])
        truncated = bool(response.get("IsTruncated"))
    except ClientError as error:
        list_status, list_code = error_details(error)

    print(json.dumps({
        "operation": "boto3 R2 GetObject/ListObjectsV2 preflight",
        "get_http_status": get_status,
        "get_error_code": get_code,
        "list_http_status": list_status,
        "list_error_code": list_code,
        "key_count": key_count,
        "truncated": truncated,
    }, sort_keys=True))
    return 0 if get_status == 404 and get_code == "NoSuchKey" and list_status == 200 and key_count == 0 and truncated is False else 1


if __name__ == "__main__":
    raise SystemExit(main())
