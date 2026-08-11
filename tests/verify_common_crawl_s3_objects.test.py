import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "tools" / "verify_common_crawl_s3_objects.py"
SPEC = importlib.util.spec_from_file_location("verify_common_crawl_s3_objects", MODULE_PATH)
verify = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = verify
SPEC.loader.exec_module(verify)


class VerifyCommonCrawlS3ObjectsTests(unittest.TestCase):
    def test_expected_keys_match_ingestion_remote_layout(self):
        source = (
            "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
            "CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz"
        )
        prefix = "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
        keys = verify.expected_keys(prefix, "CC-MAIN-2026-30", source)

        self.assertEqual(
            keys,
            {
                "pages": (
                    "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
                    "crawl=CC-MAIN-2026-30/dataset=pages/part-a129b99c34135f0d.parquet"
                ),
                "links": (
                    "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
                    "crawl=CC-MAIN-2026-30/dataset=links/part-a129b99c34135f0d.parquet"
                ),
                "metrics": (
                    "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/"
                    "crawl=CC-MAIN-2026-30/dataset=metrics/part-a129b99c34135f0d.json"
                ),
            },
        )

    def test_main_heads_and_reads_the_ingestion_layout(self):
        source = (
            "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
            "CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz"
        )

        class FakeS3Client:
            def __init__(self):
                self.heads = []
                self.gets = []

            def head_object(self, **kwargs):
                self.heads.append(kwargs)
                return {"ContentLength": 123, "ETag": "fake-etag"}

            def get_object(self, **kwargs):
                self.gets.append(kwargs)
                return {"Body": io.BytesIO(json.dumps({"input": source}).encode("utf-8"))}

        client = FakeS3Client()
        output = io.StringIO()
        with patch.object(verify.boto3, "client", return_value=client), redirect_stdout(output):
            exit_code = verify.main([
                "--bucket", "growthsent-data-552648196041-us-east-1-an",
                "--prefix", "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000",
                "--crawl", "CC-MAIN-2026-30",
                "--source", source,
            ])

        self.assertEqual(exit_code, 0)
        expected = verify.expected_keys(
            "production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000",
            "CC-MAIN-2026-30",
            source,
        )
        self.assertEqual([head["Key"] for head in client.heads], list(expected.values()))
        self.assertEqual(client.gets, [{
            "Bucket": "growthsent-data-552648196041-us-east-1-an",
            "Key": expected["metrics"],
        }])
        self.assertEqual(json.loads(output.getvalue())["objects"]["metrics"]["key"], expected["metrics"])


if __name__ == "__main__":
    unittest.main()
