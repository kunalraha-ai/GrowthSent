#!/usr/bin/env python3
"""R2 S3-compatible immutable publication primitives for Common Crawl runs.

Only a dedicated R2 client is constructed here.  It never reads generic AWS
environment variables, so Common Crawl source access and R2 publication cannot
accidentally share endpoints or credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, BinaryIO, Iterable, Mapping


SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_SINGLE_PUT_BYTES = 5 * 1024**3


class R2StoreError(RuntimeError):
    """An immutable R2 object-store operation failed closed."""


def canonical_json(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def md5_file_base64(path: Path) -> str:
    """Return an upload-body MD5 without reading a large Parquet file at once."""

    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return base64.b64encode(digest.digest()).decode("ascii")


def normalize_key(*parts: str) -> str:
    """Join trusted keys with one slash and reject path traversal/empty parts."""

    cleaned: list[str] = []
    for raw in parts:
        if not isinstance(raw, str) or not raw.strip():
            raise R2StoreError("R2 key component must be a non-empty string")
        value = raw.strip("/")
        if not value or "\\" in value or "\r" in value or "\n" in value or any(segment in {"", ".", ".."} for segment in value.split("/")):
            raise R2StoreError("R2 key component is unsafe or non-normalized")
        cleaned.append(value)
    return "/".join(cleaned)


def normalize_prefix(value: str) -> str:
    return normalize_key(value).rstrip("/") + "/"


def _error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if not isinstance(response, Mapping):
        return None
    detail = response.get("Error")
    if not isinstance(detail, Mapping):
        return None
    value = detail.get("Code")
    return str(value) if value is not None else None


def _is_missing(error: Exception) -> bool:
    return _error_code(error) in {"404", "NoSuchKey", "NotFound", "NoSuchBucket"}


def _is_precondition(error: Exception) -> bool:
    return _error_code(error) in {"412", "PreconditionFailed", "ConditionalRequestConflict"}


def _metadata_sha256(head: Mapping[str, Any]) -> str:
    metadata = head.get("Metadata")
    if not isinstance(metadata, Mapping):
        raise R2StoreError("destination conflict: missing growthsent-sha256 metadata")
    value = {str(key).lower(): item for key, item in metadata.items()}.get("growthsent-sha256")
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise R2StoreError("destination conflict: invalid growthsent-sha256 metadata")
    return value


@dataclass(frozen=True)
class R2ClientConfig:
    account_id: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None
    connect_timeout_seconds: int = 10
    read_timeout_seconds: int = 120

    @property
    def endpoint_url(self) -> str:
        return f"https://{self.account_id}.r2.cloudflarestorage.com"

    @classmethod
    def from_environment(cls, *, credential_prefix: str = "GROWTHSENT_R2_") -> "R2ClientConfig":
        def required(name: str) -> str:
            value = os.environ.get(name)
            if not value:
                raise R2StoreError(f"required R2 runtime setting is missing: {name}")
            return value

        if not credential_prefix.endswith("_"):
            raise R2StoreError("R2 credential environment prefix must end with an underscore")
        return cls(
            account_id=required("GROWTHSENT_R2_ACCOUNT_ID"),
            bucket=required("GROWTHSENT_R2_BUCKET"),
            access_key_id=required(f"{credential_prefix}ACCESS_KEY_ID"),
            secret_access_key=required(f"{credential_prefix}SECRET_ACCESS_KEY"),
            session_token=os.environ.get(f"{credential_prefix}SESSION_TOKEN"),
        )

    def build_client(self) -> Any:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as error:
            raise R2StoreError("boto3 is required for R2 publication") from error
        return boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            region_name="auto",
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            aws_session_token=self.session_token,
            config=Config(
                connect_timeout=self.connect_timeout_seconds,
                read_timeout=self.read_timeout_seconds,
                retries={"mode": "standard", "total_max_attempts": 4},
                signature_version="s3v4",
            ),
        )


class R2Store:
    """Fail-closed immutable object access within explicit allowed prefixes."""

    def __init__(self, client: Any, *, bucket: str, allowed_prefixes: Iterable[str]):
        self.client = client
        if not bucket or "/" in bucket:
            raise R2StoreError("R2 bucket must be a safe bucket name")
        self.bucket = bucket
        prefixes = tuple(normalize_prefix(prefix) for prefix in allowed_prefixes)
        if not prefixes:
            raise R2StoreError("at least one R2 allowed prefix is required")
        self.allowed_prefixes = prefixes

    @classmethod
    def from_environment(cls, *, allowed_prefixes: Iterable[str], credential_prefix: str = "GROWTHSENT_R2_") -> "R2Store":
        config = R2ClientConfig.from_environment(credential_prefix=credential_prefix)
        return cls(config.build_client(), bucket=config.bucket, allowed_prefixes=allowed_prefixes)

    def assert_allowed(self, key: str) -> str:
        key = normalize_key(key)
        if not any(key.startswith(prefix) for prefix in self.allowed_prefixes):
            raise R2StoreError("R2 key is outside this worker's immutable allowed prefix")
        return key

    def head(self, key: str) -> Mapping[str, Any] | None:
        key = self.assert_allowed(key)
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _is_missing(error):
                return None
            raise R2StoreError(f"R2 HeadObject failed for {key}") from error

    def verify(self, key: str, *, bytes_count: int, sha256: str) -> bool:
        if not isinstance(bytes_count, int) or bytes_count < 0 or not SHA256_RE.fullmatch(sha256):
            raise R2StoreError("invalid immutable object verification contract")
        head = self.head(key)
        if head is None:
            return False
        if int(head.get("ContentLength", -1)) != bytes_count:
            raise R2StoreError(f"destination conflict: ContentLength mismatch for {key}")
        if _metadata_sha256(head) != sha256:
            raise R2StoreError(f"destination conflict: growthsent-sha256 mismatch for {key}")
        # R2 multipart ETags and composite checksums are intentionally not
        # treated as full-file digests. Metadata plus exact length is the
        # durable immutable contract, backed by Content-MD5 on initial put.
        return True

    def _put_file_once(self, key: str, path: Path, *, content_type: str, sha256: str) -> None:
        size = path.stat().st_size
        if size > MAX_SINGLE_PUT_BYTES:
            raise R2StoreError("immutable R2 single-part publication exceeds the 5 GiB safety limit")
        content_md5 = md5_file_base64(path)
        with path.open("rb") as body:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentLength=size,
                ContentType=content_type,
                ContentMD5=content_md5,
                Metadata={"growthsent-sha256": sha256},
                IfNoneMatch="*",
            )

    def upload_immutable_file(self, key: str, path: Path, *, content_type: str) -> dict[str, Any]:
        key = self.assert_allowed(key)
        if not path.is_file():
            raise R2StoreError(f"cannot publish missing local file: {path}")
        size = path.stat().st_size
        digest = sha256_file(path)
        if self.verify(key, bytes_count=size, sha256=digest):
            return {"key": key, "bytes": size, "sha256": digest, "reused": True}
        try:
            self._put_file_once(key, path, content_type=content_type, sha256=digest)
        except Exception as error:
            if not _is_precondition(error):
                raise R2StoreError(f"R2 immutable PutObject failed for {key}") from error
        if not self.verify(key, bytes_count=size, sha256=digest):
            raise R2StoreError(f"post-upload immutable verification failed for {key}")
        return {"key": key, "bytes": size, "sha256": digest, "reused": False}

    def upload_immutable_json(self, key: str, value: Mapping[str, Any]) -> dict[str, Any]:
        key = self.assert_allowed(key)
        body = canonical_json(value)
        digest = sha256_bytes(body)
        if self.verify(key, bytes_count=len(body), sha256=digest):
            return {"key": key, "bytes": len(body), "sha256": digest, "reused": True}
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentLength=len(body),
                ContentType="application/json",
                ContentMD5=base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
                Metadata={"growthsent-sha256": digest},
                IfNoneMatch="*",
            )
        except Exception as error:
            if not _is_precondition(error):
                raise R2StoreError(f"R2 immutable JSON PutObject failed for {key}") from error
        if not self.verify(key, bytes_count=len(body), sha256=digest):
            raise R2StoreError(f"post-upload immutable JSON verification failed for {key}")
        return {"key": key, "bytes": len(body), "sha256": digest, "reused": False}

    def put_json_conditional(
        self,
        key: str,
        value: Mapping[str, Any],
        *,
        if_none_match: bool = False,
        if_match: str | None = None,
    ) -> str | None:
        """Write a mutable fenced control object; payloads never use this."""

        key = self.assert_allowed(key)
        if if_none_match and if_match is not None:
            raise R2StoreError("a conditional R2 control write cannot use both If-Match and If-None-Match")
        body = canonical_json(value)
        arguments: dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": key,
            "Body": body,
            "ContentLength": len(body),
            "ContentType": "application/json",
            "ContentMD5": base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
            "Metadata": {"growthsent-sha256": sha256_bytes(body)},
        }
        if if_none_match:
            arguments["IfNoneMatch"] = "*"
        if if_match is not None:
            arguments["IfMatch"] = if_match
        try:
            response = self.client.put_object(**arguments)
        except Exception as error:
            if _is_precondition(error):
                raise R2StoreError("R2 conditional control write lost its fence") from error
            raise R2StoreError(f"R2 conditional control write failed for {key}") from error
        return response.get("ETag")

    def read_json(self, key: str) -> tuple[dict[str, Any], str | None] | None:
        key = self.assert_allowed(key)
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _is_missing(error):
                return None
            raise R2StoreError(f"R2 GetObject failed for {key}") from error
        try:
            body = response["Body"].read()
            digest = sha256_bytes(body)
            if int(response.get("ContentLength", len(body))) != len(body):
                raise R2StoreError(f"R2 JSON ContentLength mismatch for {key}")
            metadata = response.get("Metadata")
            if not isinstance(metadata, Mapping):
                raise R2StoreError(f"R2 JSON lacks immutable metadata: {key}")
            metadata_hash = {str(k).lower(): v for k, v in metadata.items()}.get("growthsent-sha256")
            if metadata_hash != digest:
                raise R2StoreError(f"R2 JSON metadata SHA-256 mismatch for {key}")
            value = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise R2StoreError(f"R2 object is not valid JSON: {key}") from error
        if not isinstance(value, dict):
            raise R2StoreError(f"R2 JSON object is not an object: {key}")
        return value, response.get("ETag")

    def download_verified_file(self, key: str, destination: Path, *, bytes_count: int, sha256: str) -> None:
        key = self.assert_allowed(key)
        if not self.verify(key, bytes_count=bytes_count, sha256=sha256):
            raise R2StoreError(f"required immutable source object is missing: {key}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".download")
        temporary.unlink(missing_ok=True)
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            with temporary.open("wb") as handle:
                for block in iter(lambda: response["Body"].read(8 * 1024 * 1024), b""):
                    handle.write(block)
        except Exception as error:
            temporary.unlink(missing_ok=True)
            raise R2StoreError(f"R2 download failed for {key}") from error
        if temporary.stat().st_size != bytes_count or sha256_file(temporary) != sha256:
            temporary.unlink(missing_ok=True)
            raise R2StoreError(f"downloaded R2 object failed immutable verification: {key}")
        temporary.replace(destination)

    def list_keys(self, prefix: str) -> list[str]:
        prefix = normalize_prefix(prefix)
        self.assert_allowed(prefix + "placeholder")
        paginator = self.client.get_paginator("list_objects_v2")
        keys: list[str] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                key = item.get("Key")
                if isinstance(key, str):
                    keys.append(key)
        return sorted(keys)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
