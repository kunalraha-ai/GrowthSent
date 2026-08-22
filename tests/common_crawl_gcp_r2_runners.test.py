import argparse
from contextlib import contextmanager
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_backlink_derive as base_derive
import common_crawl_backlink_derive_gcp_25k as derive
import common_crawl_gcp_r2_25k_contract as contract_tools
import common_crawl_gcp_r2_one_wat_canary as canary
import common_crawl_http_source as http_source
import common_crawl_wat_ingest_gcp_25k as raw


MANIFEST_ROOT = ROOT / "deployment" / "common-crawl-gcp-r2-25k" / "manifests" / contract_tools.RUN_ID


def checked_contract(shard_id=0):
    return contract_tools.load_contract(
        MANIFEST_ROOT / "base-manifest.json",
        MANIFEST_ROOT / "shards" / f"shard-{shard_id:05d}-of-00025.json",
        MANIFEST_ROOT / "shards" / "shard-plan.json",
        shard_id=shard_id,
    )


class RecordingStore:
    def __init__(self):
        self.documents = {}
        self.events = []
        self.index = 0

    def read_json(self, key):
        value = self.documents.get(key)
        return None if value is None else (value[0], value[1])

    def put_json_conditional(self, key, value, *, if_none_match=False, if_match=None):
        if if_none_match and key in self.documents:
            raise RuntimeError("conditional collision")
        if if_match is not None and (key not in self.documents or self.documents[key][1] != if_match):
            raise RuntimeError("conditional fence")
        self.index += 1
        etag = f"etag-{self.index}"
        self.documents[key] = (dict(value), etag)
        self.events.append(("conditional", key))
        return etag

    def upload_immutable_json(self, key, value):
        prior = self.documents.get(key)
        if prior is not None and prior[0] != dict(value):
            raise RuntimeError("immutable conflict")
        self.index += 1
        self.documents[key] = (dict(value), f"etag-{self.index}")
        self.events.append(("json", key))
        return {"reused": prior is not None}

    def upload_immutable_file(self, key, path, *, content_type):
        del path, content_type
        self.events.append(("file", key))
        return {"reused": False}

    def verify(self, key, *, bytes_count, sha256):
        del key, bytes_count, sha256
        return True


class RecoveringSource:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0
        self.waits = []

    @contextmanager
    def open_gzip(self, source, *, max_attempts):
        self.calls += 1
        self.asserted_attempt_limit = max_attempts
        if self.calls == 1:
            raise ConnectionResetError("transient reset")
        telemetry = http_source.SourceTelemetry(source_key=source, source_url="https://data.commoncrawl.org/" + source)
        telemetry.attempts = 1
        telemetry.response_status = 200
        telemetry.downloaded_bytes = len(self.payload)
        yield io.BytesIO(self.payload), telemetry

    def sleep_before_retry(self, index):
        self.waits.append(index)
        return 2.0


class GcpR2RunnerTests(unittest.TestCase):
    def test_raw_paths_are_deterministic_and_never_target_golden_or_canary_prefixes(self):
        source = checked_contract().inputs[0]
        keys = [contract_tools.raw_part_key(dataset, source) for dataset in ("pages", "links", "metrics")]
        self.assertEqual(len(set(keys)), 3)
        for key in keys:
            self.assertTrue(key.startswith(contract_tools.RAW_PREFIX + "/"))
            self.assertNotIn("first-10000", key)
            self.assertNotIn("backlink-derived-canary", key)
        local = raw.artifact_paths(Path("scratch"), source)
        self.assertEqual([item[0] for item in local], ["pages", "links", "metrics"])

    def test_one_wat_canary_has_a_separate_nonproduction_prefix(self):
        key = canary._key(canary.CANARY_ROOT + "/https-proof", "links", checked_contract().inputs[0])
        self.assertTrue(key.startswith("production/common-crawl/gcp-r2-canaries/v1/https-proof/"))
        self.assertNotIn(contract_tools.RAW_PREFIX, key)
        self.assertNotIn(contract_tools.DERIVED_PREFIX, key)

    def test_raw_active_lease_prevents_overlapping_owner(self):
        checked = checked_contract()
        store = RecordingStore()
        first = raw.acquire_lease(store, checked, owner="batch-attempt-a", seconds=600, allow_expired_takeover=False)
        self.assertTrue(first.etag)
        with self.assertRaises(raw.GcpRawIngestError):
            raw.acquire_lease(store, checked, owner="batch-attempt-b", seconds=600, allow_expired_takeover=False)

    def test_raw_midstream_network_error_retries_the_whole_wat_with_one_shared_budget(self):
        source = checked_contract().inputs[0]
        payload = {
            "Envelope": {
                "WARC-Header-Metadata": {"WARC-Target-URI": "https://example.com/", "WARC-Date": "2026-07-10T00:00:00Z"},
                "Payload-Metadata": {"HTTP-Response-Metadata": {"Response-Message": {"Status": 200}, "Headers": {"Content-Type": ["text/html"]}, "HTML-Metadata": {"Links": []}}},
            }
        }
        encoded = json.dumps(payload).encode("utf-8")
        wat = b"WARC/1.0\r\nContent-Type: application/json\r\nContent-Length: " + str(len(encoded)).encode("ascii") + b"\r\n\r\n" + encoded + b"\r\n"
        reader = RecoveringSource(wat)
        with tempfile.TemporaryDirectory() as tmp:
            report = raw._write_one(source, Path(tmp), source_reader=reader, batch_size=1, source_max_attempts=2)
        self.assertEqual(reader.calls, 2)
        self.assertEqual(reader.waits, [0])
        self.assertEqual(report["input"], source)
        self.assertEqual(report["source_transport"]["processing_retries"], 1)
        self.assertEqual(report["artifacts"][0]["key"], contract_tools.raw_part_key("pages", source))

    def test_missing_bucket_directory_is_rejected_by_the_approved_validator(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for bucket in range(1023):
                (root / f"target_host_bucket={bucket:04d}").mkdir()
            with self.assertRaises(base_derive.DerivedDataError):
                base_derive.validate_detail_bucket_directories(root)

    def test_derive_completion_marker_is_the_last_r2_write(self):
        checked = checked_contract()
        store = RecordingStore()
        args = argparse.Namespace(
            base_manifest=MANIFEST_ROOT / "base-manifest.json",
            shard_manifest=MANIFEST_ROOT / "shards" / "shard-00000-of-00025.json",
            shard_plan=MANIFEST_ROOT / "shards" / "shard-plan.json",
            run_id=contract_tools.RUN_ID,
            crawl=contract_tools.CRAWL,
            shard_id=0,
            shard_count=25,
            expected_input_count=1000,
            base_inputs_sha256=contract_tools.INPUTS_SHA256,
            base_manifest_sha256=contract_tools.BASE_MANIFEST_SHA256,
            shard_inputs_sha256=checked.shard["inputs_sha256"],
            shard_manifest_sha256=checked.shard["manifest_sha256"],
            raw_prefix=contract_tools.RAW_PREFIX,
            derived_prefix=contract_tools.DERIVED_PREFIX,
            release_sha256="a" * 64,
            shard_lease_owner="batch-attempt",
            shard_lease_seconds=600,
            allow_expired_lease_takeover=False,
            memory_limit="24GB",
            threads=4,
            max_temp_directory_size="1.25TiB",
            rollup_hosts_file=None,
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args.work_dir = root / "work"
            args.output_dir = root / "output"
            args.temp_directory = root / "spill"
            args.status_dir = root / "status"
            detail_root = args.output_dir / f"crawl={contract_tools.CRAWL}" / "dataset=backlink-details" / f"input_shard={checked.label}"
            for bucket in range(1024):
                (detail_root / f"target_host_bucket={bucket:04d}").mkdir(parents=True, exist_ok=True)
            (detail_root / "target_host_bucket=0000" / "data_0.parquet").write_bytes(b"detail")
            with (
                patch.object(derive, "stage_raw_links", return_value=[]),
                patch.object(
                    derive.derive,
                    "build_detail_shard",
                    return_value={"manifest_sha256": "b" * 64, "detail_rows": 1, "detail_bytes": 6},
                ),
            ):
                result = derive.run_shard(args, RecordingStore(), store)
        self.assertTrue(result["completed"])
        self.assertTrue(store.events[-1][1].endswith("DERIVED-SHARD-COMPLETED.json"))
        self.assertNotIn("first-10000", "\n".join(key for _, key in store.events))


if __name__ == "__main__":
    unittest.main()
