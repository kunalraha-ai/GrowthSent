#!/usr/bin/env python3
"""Bounded, streaming HTTPS reader for immutable Common Crawl object keys.

This module deliberately accepts only a bare Common Crawl manifest key.  The
key remains the source identity used by manifests, metrics, and deterministic
output suffixes; transport URLs are never persisted as a replacement identity.
It is safe to use outside AWS and has no AWS credential dependency.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
import gzip
import io
import random
import socket
import time
from typing import Any, BinaryIO, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_BASE_URL = "https://data.commoncrawl.org"
DEFAULT_CONNECT_AND_READ_TIMEOUT_SECONDS = 120
DEFAULT_MAX_ATTEMPTS = 8
DEFAULT_INITIAL_BACKOFF_SECONDS = 2.0
DEFAULT_MAX_BACKOFF_SECONDS = 45.0
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})


class CommonCrawlSourceError(RuntimeError):
    """A bounded Common Crawl HTTPS source read failed."""

    def __init__(self, message: str, *, telemetry: SourceTelemetry | None = None):
        super().__init__(message)
        self.telemetry = telemetry


class _NoRedirect(HTTPRedirectHandler):
    """Fail closed if the official source endpoint unexpectedly redirects."""

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, code, msg, headers, newurl
        return None


@dataclass
class SourceTelemetry:
    source_key: str
    source_url: str
    attempts: int = 0
    retries: int = 0
    retryable_http_statuses: list[int] = field(default_factory=list)
    response_status: int | None = None
    declared_content_length: int | None = None
    downloaded_bytes: int = 0
    elapsed_seconds: float = 0.0

    def report(self) -> dict[str, Any]:
        return asdict(self)


class _CountingReader:
    """Minimal file-like wrapper used by gzip to count compressed bytes."""

    def __init__(self, raw: BinaryIO, telemetry: SourceTelemetry):
        self._raw = raw
        self._telemetry = telemetry

    def read(self, size: int = -1) -> bytes:
        value = self._raw.read(size)
        self._telemetry.downloaded_bytes += len(value)
        return value

    def read1(self, size: int = -1) -> bytes:
        reader = getattr(self._raw, "read1", self._raw.read)
        value = reader(size)
        self._telemetry.downloaded_bytes += len(value)
        return value

    def readline(self, size: int = -1) -> bytes:
        value = self._raw.readline(size)
        self._telemetry.downloaded_bytes += len(value)
        return value

    def readable(self) -> bool:
        return True

    def close(self) -> None:
        self._raw.close()

    @property
    def closed(self) -> bool:
        return bool(getattr(self._raw, "closed", False))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._raw, name)


def validate_common_crawl_key(key: str, *, crawl: str) -> str:
    """Validate a bare WAT key without normalizing or rewriting it."""

    if not isinstance(key, str) or not key:
        raise CommonCrawlSourceError("Common Crawl source key must be non-empty")
    required_prefix = f"crawl-data/{crawl}/"
    if (
        key != key.strip()
        or not key.startswith(required_prefix)
        or not key.endswith(".wat.gz")
        or "\\" in key
        or "/../" in f"/{key}"
        or "\r" in key
        or "\n" in key
    ):
        raise CommonCrawlSourceError("source key is outside the locked Common Crawl WAT namespace")
    return key


def source_url_for_key(key: str, *, base_url: str = DEFAULT_BASE_URL) -> str:
    """Return the official HTTPS URL while retaining ``key`` as identity."""

    if not isinstance(base_url, str) or not base_url.startswith("https://"):
        raise CommonCrawlSourceError("Common Crawl HTTPS base URL must use HTTPS")
    # WAT keys have safe path separators. Quote other bytes without changing
    # slash boundaries or the original manifest key retained elsewhere.
    return base_url.rstrip("/") + "/" + quote(key.lstrip("/"), safe="/-._~")


def _status_from_error(error: Exception) -> int | None:
    if isinstance(error, HTTPError):
        return error.code
    return None


def is_retryable_error(error: Exception) -> bool:
    if isinstance(error, CommonCrawlSourceError) and isinstance(error.__cause__, Exception):
        return is_retryable_error(error.__cause__)
    # ``gzip.GzipFile`` reports a prematurely truncated compressed response as
    # EOFError while the parser is consuming the stream.  Treat that transport
    # integrity failure like a reset so the bounded full-WAT retry loop can
    # restart from byte zero rather than publish any partial artifacts.
    if isinstance(error, EOFError):
        return True
    status = _status_from_error(error)
    if status is not None:
        return status in RETRYABLE_HTTP_STATUSES
    if isinstance(error, (URLError, TimeoutError, socket.timeout, ConnectionError, OSError)):
        return True
    return False


class CommonCrawlHttpSource:
    """Official Common Crawl HTTPS transport with bounded retry/backoff."""

    def __init__(
        self,
        *,
        crawl: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_seconds: int = DEFAULT_CONNECT_AND_READ_TIMEOUT_SECONDS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        initial_backoff_seconds: float = DEFAULT_INITIAL_BACKOFF_SECONDS,
        max_backoff_seconds: float = DEFAULT_MAX_BACKOFF_SECONDS,
        user_agent: str = "GrowthSentCommonCrawl/1.0 (bounded research crawler)",
        opener: Any | None = None,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float, float], float] = random.uniform,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        if not crawl or "/" in crawl:
            raise CommonCrawlSourceError("crawl must be a safe non-empty identifier")
        if timeout_seconds < 1 or max_attempts < 1:
            raise CommonCrawlSourceError("timeout and maximum attempts must be positive")
        if initial_backoff_seconds < 1 or max_backoff_seconds < initial_backoff_seconds:
            raise CommonCrawlSourceError("invalid bounded retry backoff configuration")
        self.crawl = crawl
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts
        self.initial_backoff_seconds = initial_backoff_seconds
        self.max_backoff_seconds = max_backoff_seconds
        self.user_agent = user_agent
        self._opener = opener or build_opener(_NoRedirect())
        self._sleep = sleep
        self._jitter = jitter
        self._monotonic = monotonic

    def retry_delay_seconds(self, retry_index: int) -> float:
        """Return one positive, bounded retry delay without sleeping."""

        if retry_index < 0:
            raise CommonCrawlSourceError("retry index must not be negative")
        base_delay = min(self.max_backoff_seconds, self.initial_backoff_seconds * (2**retry_index))
        return min(
            self.max_backoff_seconds,
            base_delay + self._jitter(0.0, min(5.0, base_delay * 0.25)),
        )

    def sleep_before_retry(self, retry_index: int) -> float:
        delay = self.retry_delay_seconds(retry_index)
        self._sleep(delay)
        return delay

    def _open(self, key: str, telemetry: SourceTelemetry, *, max_attempts: int | None = None) -> BinaryIO:
        request = Request(
            telemetry.source_url,
            headers={"User-Agent": self.user_agent, "Accept-Encoding": "identity"},
            method="GET",
        )
        attempts = self.max_attempts if max_attempts is None else max_attempts
        if attempts < 1 or attempts > self.max_attempts:
            raise CommonCrawlSourceError("open attempt override is outside the configured bounded retry policy")
        for index in range(attempts):
            telemetry.attempts = index + 1
            try:
                response = self._opener.open(request, timeout=self.timeout_seconds)
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                telemetry.response_status = int(status)
                value = response.headers.get("Content-Length")
                telemetry.declared_content_length = int(value) if value and value.isdigit() else None
                return response
            except Exception as error:
                status = _status_from_error(error)
                if status in RETRYABLE_HTTP_STATUSES:
                    telemetry.retryable_http_statuses.append(status)
                if not is_retryable_error(error) or index == attempts - 1:
                    status_text = f" HTTP {status}" if status is not None else ""
                    raise CommonCrawlSourceError(
                        f"Common Crawl HTTPS read failed after {index + 1} attempt(s) for {key}: {type(error).__name__}{status_text}",
                        telemetry=telemetry,
                    ) from error
                telemetry.retries += 1
                self.sleep_before_retry(index)
        raise AssertionError("bounded retry loop must return or raise")

    @contextmanager
    def open_gzip(self, key: str, *, max_attempts: int | None = None) -> Iterator[tuple[BinaryIO, SourceTelemetry]]:
        """Stream a compressed WAT without buffering it in memory or on disk."""

        key = validate_common_crawl_key(key, crawl=self.crawl)
        telemetry = SourceTelemetry(source_key=key, source_url=source_url_for_key(key, base_url=self.base_url))
        started = self._monotonic()
        response = self._open(key, telemetry, max_attempts=max_attempts)
        counting = _CountingReader(response, telemetry)
        try:
            with gzip.GzipFile(fileobj=counting, mode="rb") as stream:
                yield stream, telemetry
        finally:
            counting.close()
            telemetry.elapsed_seconds = round(self._monotonic() - started, 3)
