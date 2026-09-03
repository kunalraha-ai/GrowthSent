import gzip
import io
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_http_source as source


KEY = "crawl-data/CC-MAIN-2026-30/segments/test/wat/example.warc.wat.gz"


class Response(io.BytesIO):
    status = 200

    def __init__(self, value):
        super().__init__(value)
        self.headers = {"Content-Length": str(len(value))}


class SequencedOpener:
    def __init__(self, values):
        self.values = iter(values)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request.full_url, timeout))
        value = next(self.values)
        if isinstance(value, Exception):
            raise value
        return value


class HttpSourceTests(unittest.TestCase):
    def test_streams_gzip_and_preserves_bare_manifest_identity(self):
        compressed = gzip.compress(b"bounded WAT content")
        opener = SequencedOpener([Response(compressed)])
        clock = iter((10.0, 12.5))
        reader = source.CommonCrawlHttpSource(
            crawl="CC-MAIN-2026-30", opener=opener, monotonic=lambda: next(clock), sleep=lambda _: None
        )
        with reader.open_gzip(KEY) as (stream, telemetry):
            self.assertEqual(stream.read(), b"bounded WAT content")
        self.assertEqual(telemetry.source_key, KEY)
        self.assertEqual(telemetry.source_url, "https://data.commoncrawl.org/" + KEY)
        self.assertEqual(telemetry.response_status, 200)
        self.assertEqual(telemetry.downloaded_bytes, len(compressed))
        self.assertEqual(telemetry.elapsed_seconds, 2.5)
        self.assertEqual(opener.requests[0][1], 120)

    def test_503_uses_bounded_positive_backoff_then_recovers(self):
        compressed = gzip.compress(b"recovered")
        error = HTTPError("https://data.commoncrawl.org/x", 503, "busy", {}, None)
        waits = []
        reader = source.CommonCrawlHttpSource(
            crawl="CC-MAIN-2026-30",
            opener=SequencedOpener([error, Response(compressed)]),
            sleep=waits.append,
            jitter=lambda _low, _high: 0.25,
        )
        with reader.open_gzip(KEY) as (stream, telemetry):
            self.assertEqual(stream.read(), b"recovered")
        self.assertEqual(telemetry.attempts, 2)
        self.assertEqual(telemetry.retries, 1)
        self.assertEqual(telemetry.retryable_http_statuses, [503])
        self.assertGreaterEqual(waits[0], 2.0)
        self.assertLessEqual(waits[0], 45.0)

    def test_repeated_slowdown_exhausts_retry_budget_without_tight_loop(self):
        error = HTTPError("https://data.commoncrawl.org/x", 503, "busy", {}, None)
        waits = []
        reader = source.CommonCrawlHttpSource(
            crawl="CC-MAIN-2026-30",
            opener=SequencedOpener([error] * 3),
            max_attempts=3,
            sleep=waits.append,
            jitter=lambda _low, _high: 0.0,
        )
        with self.assertRaises(source.CommonCrawlSourceError):
            with reader.open_gzip(KEY):
                pass
        self.assertEqual(waits, [2.0, 4.0])

    def test_non_retryable_http_failure_fails_immediately(self):
        reader = source.CommonCrawlHttpSource(
            crawl="CC-MAIN-2026-30",
            opener=SequencedOpener([HTTPError("https://data.commoncrawl.org/x", 404, "missing", {}, None)]),
            sleep=lambda _: self.fail("must not retry 404"),
        )
        with self.assertRaisesRegex(source.CommonCrawlSourceError, r"HTTPError HTTP 404"):
            with reader.open_gzip(KEY):
                pass

    def test_truncated_gzip_eof_is_retryable_at_the_full_wat_layer(self):
        self.assertTrue(source.is_retryable_error(EOFError("Compressed file ended before the end-of-stream marker was reached")))

    def test_source_key_validation_rejects_url_rewriting_or_traversal(self):
        with self.assertRaises(source.CommonCrawlSourceError):
            source.validate_common_crawl_key("https://data.commoncrawl.org/" + KEY, crawl="CC-MAIN-2026-30")
        with self.assertRaises(source.CommonCrawlSourceError):
            source.validate_common_crawl_key("crawl-data/CC-MAIN-2026-30/../secret.wat.gz", crawl="CC-MAIN-2026-30")


if __name__ == "__main__":
    unittest.main()
