import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

SPEC = importlib.util.spec_from_file_location("common_crawl_backlink_derive", TOOLS / "common_crawl_backlink_derive.py")
derive = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = derive
SPEC.loader.exec_module(derive)


def write_links(path: Path) -> None:
    table = pa.Table.from_pylist([
        {"crawl": "CC-TEST", "source_url": "https://a.example/one", "source_host": "a.example", "target_url": "https://target.example/a", "target_host": "target.example", "anchor": "Alpha", "crawled_at": None},
        {"crawl": "CC-TEST", "source_url": "https://a.example/two", "source_host": "a.example", "target_url": "https://target.example/a", "target_host": "target.example", "anchor": "Alpha", "crawled_at": None},
        {"crawl": "CC-TEST", "source_url": "https://b.example/", "source_host": "b.example", "target_url": "https://target.example/b", "target_host": "target.example", "anchor": "Beta", "crawled_at": None},
        {"crawl": "CC-TEST", "source_url": "https://source.example/", "source_host": "source.example", "target_url": "https://other.example/", "target_host": "other.example", "anchor": None, "crawled_at": None},
    ])
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="snappy", row_group_size=2)


class CommonCrawlBacklinkDeriveTests(unittest.TestCase):
    def test_target_bucket_is_sha256_stable(self):
        self.assertEqual(derive.host_bucket("github.com"), "0235")
        self.assertEqual(derive.host_bucket("github.com"), derive.host_bucket("github.com"))

    def test_detail_shard_and_one_host_rollup_are_bounded_and_truthful(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            links = root / "links"
            write_links(links / "part-a.parquet")
            details = root / "details"
            report = derive.build_detail_shard(
                links_directory=links,
                output_root=details,
                run_id="cc-test-first-1",
                crawl="CC-TEST",
                shard_id=0,
                shard_count=1,
                expected_links_files=1,
                threads=1,
                memory_limit="1GB",
                row_group_size=10_000,
                temp_directory=root / "duckdb-spill",
            )
            self.assertEqual(report["detail_rows"], 4)
            self.assertEqual(
                report["bucket_algorithm"],
                "int(sha256(target_host)[:3], 16) >> 2, zero-padded decimal",
            )
            self.assertIn("not_applied", report["external_classification"])
            self.assertTrue((root / "duckdb-spill").is_dir())
            detail_root = details / "crawl=CC-TEST" / "dataset=backlink-details"
            sample = derive.lookup_detail_rows(detail_root=detail_root, target_host="target.example", limit=10, memory_limit="1GB")
            self.assertEqual(len(sample), 3)
            rollups = root / "rollups"
            host_report = derive.build_host_rollup(
                detail_root=detail_root,
                output_root=rollups,
                crawl="CC-TEST",
                run_id="cc-test-first-1",
                target_host="target.example",
                top_k=10,
                threads=1,
                memory_limit="1GB",
            )
            self.assertEqual(host_report["summary"]["observed_link_row_count"], 3)
            self.assertEqual(host_report["summary"]["unique_referring_host_count"], 2)
            self.assertEqual(host_report["summary"]["unique_target_page_count"], 2)
            self.assertIn("raw HTML link observations", host_report["scope"])
            manifest = next(rollups.rglob("DERIVED-MANIFEST.json"))
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["target_host"], "target.example")

    def test_existing_detail_output_requires_exact_resume_contract(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            links = root / "links"
            write_links(links / "part-a.parquet")
            args = dict(
                links_directory=links, output_root=root / "details", run_id="cc-test-first-1", crawl="CC-TEST",
                shard_id=0, shard_count=1, expected_links_files=1, threads=1, memory_limit="1GB", row_group_size=10_000,
            )
            first = derive.build_detail_shard(**args)
            resumed = derive.build_detail_shard(**args, resume=True)
            self.assertEqual(first["manifest_sha256"], resumed["manifest_sha256"])
            with self.assertRaisesRegex(derive.DerivedDataError, "refusing to overwrite|not an exact resumable"):
                derive.build_detail_shard(**args)


if __name__ == "__main__":
    unittest.main()
