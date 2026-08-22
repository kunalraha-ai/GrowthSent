import gzip
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import pyarrow.parquet as pq

MODULE_PATH = Path(__file__).parents[1] / "tools" / "common_crawl_wat_ingest.py"
SPEC = importlib.util.spec_from_file_location("wat_ingest", MODULE_PATH)
wat = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = wat
SPEC.loader.exec_module(wat)


def wat_record(payload: bytes, content_length: int | None = None) -> bytes:
    size = len(payload) if content_length is None else content_length
    return b"WARC/1.0\r\nContent-Type: application/json\r\nContent-Length: " + str(size).encode() + b"\r\n\r\n" + payload + b"\r\n"


def payload(url="https://example.com/path/page.html"):
    return {
        "Envelope": {
            "WARC-Header-Metadata": {"WARC-Target-URI": url, "WARC-Date": "2026-07-10T08:36:32Z"},
            "Payload-Metadata": {"HTTP-Response-Metadata": {
                "Response-Message": {"Status": 200}, "Headers": {"Content-Type": ["text/html", "charset=utf-8"]},
                "HTML-Metadata": {"Head": {"Title": "FranÃ§ais", "Metas": [{"name": "DESCRIPTION", "content": "Desc"}], "Link": [{"rel": "canonical", "url": "/canonical"}]},
                "Links": [{"path": "A@/href", "url": "../next", "text": "cafÃ©"}, {"path": "A@/href", "url": None}]},
            }},
        }
    }


class FakeSourceS3Error(Exception):
    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        metadata = {} if status is None else {"HTTPStatusCode": status}
        self.response = {"Error": {"Code": code}, "ResponseMetadata": metadata}


class SequencedSourceS3:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def get_object(self, *, Bucket, Key):
        self.calls.append((Bucket, Key))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class WatIngestTests(unittest.TestCase):
    def test_schema_url_resolution_and_encoding(self):
        metrics = wat.Metrics(input="x")
        rows = wat.rows_from_record(payload(), "CC-MAIN-2026-30", metrics)
        self.assertIsNotNone(rows)
        page, links = rows
        self.assertEqual(page["status"], "200")
        self.assertEqual(page["content_type"], "text/html; charset=utf-8")
        self.assertEqual(page["title"], "Français")
        link = next(links)
        self.assertEqual(link["target_url"], "https://example.com/next")
        self.assertEqual(link["target_host"], "example.com")
        self.assertEqual(link["anchor"], "café")
        self.assertGreater(metrics.encoding_repairs, 0)

    def test_malformed_absolute_url_is_retained_without_host(self):
        data = payload()
        data["Envelope"]["Payload-Metadata"]["HTTP-Response-Metadata"]["HTML-Metadata"]["Links"] = [
            {"path": "A@/href", "url": "http://＃", "text": "bad host"}
        ]
        result = wat.rows_from_record(data, "CC-MAIN-2026-30", wat.Metrics(input="x"))
        self.assertEqual(next(result[1])["target_host"], None)

    def test_malformed_template_url_is_discarded(self):
        data = payload()
        data["Envelope"]["Payload-Metadata"]["HTTP-Response-Metadata"]["HTML-Metadata"]["Links"] = [
            {"path": "A@/href", "url": "http://[template]", "text": "bad template"}
        ]
        metrics = wat.Metrics(input="x")
        result = wat.rows_from_record(data, "CC-MAIN-2026-30", metrics)
        self.assertEqual(list(result[1]), [])
        self.assertEqual(metrics.malformed_records, 1)

    def test_malformed_json_and_warc_are_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.wat.gz"
            with gzip.open(path, "wb") as handle:
                handle.write(wat_record(b"{not json}"))
                handle.write(wat_record(b"{}", content_length=100))
            metrics = wat.Metrics(input=str(path))
            with gzip.open(path, "rb") as handle:
                self.assertEqual(list(wat.iter_wat_json(handle, metrics)), [])
            self.assertEqual(metrics.malformed_json, 1)
            self.assertEqual(metrics.malformed_warc, 1)

    def test_empty_file_writes_empty_parquet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "empty.wat.gz"
            with gzip.open(source, "wb"):
                pass
            metrics = wat.ingest_one("CC-MAIN-2026-30", str(source), root / "out", 2, False)
            self.assertEqual((metrics.pages_emitted, metrics.links_emitted), (0, 0))
            part = wat.input_key(str(source))
            output = root / "out" / "crawl=CC-MAIN-2026-30" / "dataset=pages" / f"part-{part}.parquet"
            self.assertEqual(pq.ParquetFile(output).metadata.num_rows, 0)

    def test_ingest_normalizes_inconsistent_types(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "one.wat.gz"
            with gzip.open(source, "wb") as handle:
                handle.write(wat_record(json.dumps(payload()).encode()))
            metrics = wat.ingest_one("CC-MAIN-2026-30", str(source), root / "out", 1, False)
            self.assertEqual((metrics.pages_emitted, metrics.links_emitted), (1, 1))
            part = wat.input_key(str(source))
            output = root / "out" / "crawl=CC-MAIN-2026-30" / "dataset=pages" / f"part-{part}.parquet"
            row = pq.ParquetFile(output).read().to_pylist()[0]
            self.assertEqual(row["status"], "200")
            self.assertEqual(row["content_type"], "text/html; charset=utf-8")

    def test_resume_reuses_completed_part(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "one.wat.gz"
            with gzip.open(source, "wb") as handle:
                handle.write(wat_record(json.dumps(payload()).encode()))
            first = wat.ingest_one("CC-MAIN-2026-30", str(source), root / "out", 1, False)
            resumed = wat.ingest_one("CC-MAIN-2026-30", str(source), root / "out", 1, True)
            self.assertEqual(resumed.report(), first.report())

    def test_authenticated_s3_streams_a_plain_manifest_key_without_changing_the_key(self):
        source = "crawl-data/CC-MAIN-2026-30/wat/example.warc.wat.gz"
        raw = b"streamed WAT bytes"
        compressed = gzip.compress(raw)
        client = SequencedSourceS3([{"Body": io.BytesIO(compressed), "ContentLength": len(compressed)}])
        metrics = wat.Metrics(input=source)
        with patch.object(wat, "s3_client", return_value=client) as s3_factory:
            with wat.open_input(source, metrics, "commoncrawl", source_s3_bucket="commoncrawl") as stream:
                self.assertEqual(stream.read(), raw)
        s3_factory.assert_called_once_with(
            unsigned=False,
            retries={"mode": "standard", "total_max_attempts": 1},
            connect_timeout=wat.SOURCE_S3_CONNECT_TIMEOUT_SECONDS,
            read_timeout=wat.SOURCE_S3_READ_TIMEOUT_SECONDS,
        )
        self.assertEqual(client.calls, [("commoncrawl", source)])
        self.assertEqual(metrics.input, source)
        self.assertEqual(metrics.input_bytes, len(compressed))

    def test_authenticated_s3_retries_slowdown_then_succeeds_with_bounded_backoff(self):
        source = "crawl-data/CC-MAIN-2026-30/wat/example.warc.wat.gz"
        raw = gzip.compress(b"retry success")
        client = SequencedSourceS3([
            FakeSourceS3Error("SlowDown"),
            {"Body": io.BytesIO(raw), "ContentLength": len(raw)},
        ])
        metrics = wat.Metrics(input=source)
        with (
            patch.object(wat, "s3_client", return_value=client),
            patch.object(wat.random, "uniform", return_value=0.0),
            patch.object(wat.time, "sleep") as sleep,
        ):
            with wat.open_input(source, metrics, "commoncrawl", source_s3_bucket="commoncrawl") as stream:
                self.assertEqual(stream.read(), b"retry success")
        self.assertEqual(len(client.calls), 2)
        sleep.assert_called_once_with(2.0)

    def test_authenticated_s3_stops_after_the_bounded_slowdown_retry_budget(self):
        source = "crawl-data/CC-MAIN-2026-30/wat/example.warc.wat.gz"
        client = SequencedSourceS3([FakeSourceS3Error("SlowDown")] * wat.SOURCE_GET_MAX_ATTEMPTS)
        metrics = wat.Metrics(input=source)
        with (
            patch.object(wat, "s3_client", return_value=client),
            patch.object(wat.random, "uniform", return_value=0.0),
            patch.object(wat.time, "sleep") as sleep,
            self.assertRaisesRegex(FakeSourceS3Error, "SlowDown"),
        ):
            with wat.open_input(source, metrics, "commoncrawl", source_s3_bucket="commoncrawl"):
                pass
        self.assertEqual(len(client.calls), wat.SOURCE_GET_MAX_ATTEMPTS)
        self.assertEqual(
            [call.args[0] for call in sleep.call_args_list],
            [2.0, 4.0, 8.0, 16.0, 32.0, 45.0, 45.0],
        )

    def test_authenticated_s3_does_not_retry_non_retryable_errors(self):
        source = "crawl-data/CC-MAIN-2026-30/wat/example.warc.wat.gz"
        client = SequencedSourceS3([FakeSourceS3Error("AccessDenied", 403)])
        metrics = wat.Metrics(input=source)
        with (
            patch.object(wat, "s3_client", return_value=client),
            patch.object(wat.time, "sleep") as sleep,
            self.assertRaisesRegex(FakeSourceS3Error, "AccessDenied"),
        ):
            with wat.open_input(source, metrics, "commoncrawl", source_s3_bucket="commoncrawl"):
                pass
        self.assertEqual(len(client.calls), 1)
        sleep.assert_not_called()

    def test_authenticated_s3_keeps_metrics_input_and_deterministic_output_suffix(self):
        source = "crawl-data/CC-MAIN-2026-30/wat/example.warc.wat.gz"
        compressed = gzip.compress(wat_record(json.dumps(payload()).encode()))
        client = SequencedSourceS3([{"Body": io.BytesIO(compressed), "ContentLength": len(compressed)}])
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "out"
            with patch.object(wat, "s3_client", return_value=client):
                metrics = wat.ingest_one(
                    "CC-MAIN-2026-30", source, output_root, 1, False,
                    source_s3_bucket="commoncrawl",
                )
            part = wat.input_key(source)
            self.assertEqual(metrics.input, source)
            self.assertTrue((output_root / "crawl=CC-MAIN-2026-30" / "dataset=pages" / f"part-{part}.parquet").is_file())
            self.assertTrue((output_root / "crawl=CC-MAIN-2026-30" / "dataset=links" / f"part-{part}.parquet").is_file())

    def test_batch_aggregates_and_rejects_duplicate_inputs(self):
        first = wat.Metrics(input="one", input_bytes=10, pages_emitted=1, links_emitted=2, output_bytes=4).report()
        second = wat.Metrics(input="two", input_bytes=20, pages_emitted=3, links_emitted=4, output_bytes=6,
                             malformed_records=1, encoding_repairs=2).report()
        aggregate = wat.aggregate_metrics([first, second], 1.25)
        self.assertEqual(aggregate["files"], 2)
        self.assertEqual(aggregate["pages_emitted"], 4)
        self.assertEqual(aggregate["links_emitted"], 6)
        self.assertEqual(aggregate["reduction_ratio"], 0.666667)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            wat.ingest_many("CC", ["same", "same"], Path("out"), 1, False, "commoncrawl", 2)

    def test_worker_count_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "workers"):
            wat.ingest_many("CC", ["one"], Path("out"), 1, False, "commoncrawl", 3)

    def test_input_sources_and_exact_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            listing = Path(tmp) / "paths.txt"
            listing.write_text("one\n\ntwo\nthree\n", encoding="utf-8")
            self.assertEqual(wat.input_sources(["zero"], str(listing), 3), ["zero", "one", "two"])
            self.assertEqual(list(wat.chunks(["a", "b", "c"], 2)), [["a", "b"], ["c"]])
        with self.assertRaisesRegex(ValueError, "at least one"):
            wat.input_sources([], None, None)

    def test_input_scope_is_hard_bounded_and_lockable(self):
        sources = ["crawl-data/CC-MAIN-2026-30/wat/00000.warc.wat.gz",
                   "crawl-data/CC-MAIN-2026-30/wat/00001.warc.wat.gz"]
        self.assertEqual(wat.inputs_sha256(sources),
                         "6d2275416fcad337c4c486b51f134553ea1e6d6080436fede6ea0c988a4e4de6")
        wat.validate_input_scope(sources, 2, "crawl-data/CC-MAIN-2026-30/")
        with self.assertRaisesRegex(ValueError, "ceiling"):
            wat.validate_input_scope(["x"] * 1001, 1001)
        with self.assertRaisesRegex(ValueError, "does not match"):
            wat.validate_input_scope(["different-crawl/file.wat.gz"], 1,
                                     "crawl-data/CC-MAIN-2026-30/")

    def test_progress_snapshot_reports_operational_counts_and_eta(self):
        first = wat.Metrics(input="one", input_bytes=100, pages_emitted=3,
                            links_emitted=5, output_bytes=20).report()
        second = wat.Metrics(input="two", input_bytes=200, failures=["network"]).report()
        progress = wat.progress_snapshot("CC", 10, 2, [first, second], 4.0, "input_finished")
        self.assertEqual(progress["files_remote_recovered"], 2)
        self.assertEqual(progress["files_attempted"], 4)
        self.assertEqual(progress["files_completed"], 3)
        self.assertEqual(progress["files_failed"], 1)
        self.assertEqual(progress["files_remaining_to_attempt"], 6)
        self.assertEqual(progress["pages_emitted_this_invocation"], 3)
        self.assertEqual(progress["links_emitted_this_invocation"], 5)
        self.assertEqual(progress["estimated_remaining_seconds"], 12.0)

    def test_smoke_manifest_can_only_promote_to_its_ordered_scope(self):
        first = "crawl-data/CC-MAIN-2026-30/wat/00000.warc.wat.gz"
        second = "crawl-data/CC-MAIN-2026-30/wat/00001.warc.wat.gz"

        def manifest(inputs):
            return {
                "crawl": "CC-MAIN-2026-30", "input_count": len(inputs),
                "inputs_sha256": wat.inputs_sha256(inputs), "inputs": inputs,
            }

        smoke = manifest([first])
        production = manifest([first, second])
        self.assertTrue(wat.manifest_can_be_promoted(smoke, production))
        self.assertTrue(wat.manifest_can_be_promoted(production, production))
        self.assertFalse(wat.manifest_can_be_promoted(production, smoke))
        self.assertFalse(wat.manifest_can_be_promoted(smoke, manifest([second])))

    def test_path_lists_require_an_explicit_maximum(self):
        with tempfile.TemporaryDirectory() as tmp:
            listing = Path(tmp) / "paths.txt"
            listing.write_text("one\n", encoding="utf-8")
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                wat.main(["--crawl", "CC", "--input-list", str(listing)])

    def test_main_writes_bounded_control_manifest_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "one.wat.gz"
            with gzip.open(source, "wb") as handle:
                handle.write(wat_record(json.dumps(payload()).encode()))
            listing = root / "paths.txt"
            listing.write_text(f"{source}\n", encoding="utf-8")
            digest = wat.inputs_sha256([str(source)])
            stdout = io.StringIO()
            with self.assertLogs(level="INFO"), redirect_stdout(stdout):
                exit_code = wat.main([
                    "--crawl", "CC-MAIN-2026-30", "--input-list", str(listing),
                    "--max-inputs", "1", "--expected-inputs-sha256", digest,
                    "--workers", "1", "--output-dir", str(root / "out"),
                ])
            self.assertEqual(exit_code, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["progress"]["files_completed"], 1)
            manifest = json.loads((root / "out" / "control" / "input-manifest.json").read_text())
            self.assertEqual(manifest["inputs_sha256"], digest)
            summary = json.loads((root / "out" / "control" / "run-summary.json").read_text())
            self.assertEqual(summary["aggregate"]["pages_emitted"], 1)


if __name__ == "__main__":
    unittest.main()
