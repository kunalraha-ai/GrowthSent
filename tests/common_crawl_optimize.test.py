import importlib.util
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

MODULE_PATH = Path(__file__).parents[1] / "tools" / "common_crawl_optimize.py"
SPEC = importlib.util.spec_from_file_location("wat_optimize", MODULE_PATH)
optimizer = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = optimizer
SPEC.loader.exec_module(optimizer)


PAGES = pa.schema([
    pa.field("crawl", pa.string()), pa.field("source_url", pa.string()), pa.field("source_host", pa.string()),
    pa.field("crawled_at", pa.timestamp("ms")), pa.field("status", pa.string()), pa.field("content_type", pa.string()),
    pa.field("title", pa.string()), pa.field("description", pa.string()), pa.field("canonical", pa.string()),
])
LINKS = pa.schema([
    pa.field("crawl", pa.string()), pa.field("source_url", pa.string()), pa.field("source_host", pa.string()),
    pa.field("target_url", pa.string()), pa.field("target_host", pa.string()), pa.field("anchor", pa.string()),
    pa.field("crawled_at", pa.timestamp("ms")),
])


class OptimizeTests(unittest.TestCase):
    def write_raw(self, root: Path, page_rows, link_rows):
        base = root / "crawl=CC-TEST"
        (base / "dataset=pages").mkdir(parents=True)
        (base / "dataset=links").mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist(page_rows, schema=PAGES), base / "dataset=pages" / "part-a.parquet", compression="snappy")
        pq.write_table(pa.Table.from_pylist(link_rows, schema=LINKS), base / "dataset=links" / "part-b.parquet", compression="snappy")

    def test_reversible_deterministic_dictionaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pages = [{"crawl": "CC-TEST", "source_url": "https://b.example/", "source_host": "b.example", "crawled_at": None,
                      "status": "200", "content_type": "text/html", "title": "B", "description": None,
                      "canonical": "https://a.example/"}] * 5_000
            links = [
                {"crawl": "CC-TEST", "source_url": "https://b.example/", "source_host": "b.example", "target_url": "https://a.example/", "target_host": "a.example", "anchor": "first", "crawled_at": None},
                {"crawl": "CC-TEST", "source_url": "https://a.example/", "source_host": "a.example", "target_url": "https://b.example/", "target_host": "b.example", "anchor": None, "crawled_at": None},
            ]
            self.write_raw(root / "raw", pages, links)
            first = optimizer.optimize(root / "raw", "CC-TEST", root / "out-a", root / "tmp-a", 1, "512MB", 256)
            second = optimizer.optimize(root / "raw", "CC-TEST", root / "out-b", root / "tmp-b", 1, "512MB", 256)
            self.assertTrue(first["lossless_edge_reconstruction"])
            self.assertEqual(first["datasets"]["urls"]["sha256"], second["datasets"]["urls"]["sha256"])
            self.assertEqual(first["datasets"]["hosts"]["sha256"], second["datasets"]["hosts"]["sha256"])
            self.assertEqual(first["datasets"]["anchors"]["sha256"], second["datasets"]["anchors"]["sha256"])
            urls = pq.ParquetDataset(root / "out-a" / "dataset=urls").read().to_pylist()
            hosts = pq.ParquetDataset(root / "out-a" / "dataset=hosts").read().to_pylist()
            anchors = pq.ParquetDataset(root / "out-a" / "dataset=anchors").read().to_pylist()
            url_by_id = {row["url_id"]: row["url"] for row in urls}
            host_by_id = {row["host_id"]: row["host"] for row in hosts}
            host_by_url_id = {row["url_id"]: host_by_id.get(row["host_id"]) for row in urls}
            anchor_by_id = {row["anchor_id"]: row["anchor"] for row in anchors}
            self.assertEqual(set(url_by_id.values()), {"https://a.example/", "https://b.example/"})
            edges = pq.ParquetDataset(root / "out-a" / "dataset=edges").read().to_pylist()
            self.assertEqual(len(edges), len(links))
            decoded_edges = Counter(
                (url_by_id[row["source_url_id"]], url_by_id[row["target_url_id"]], anchor_by_id.get(row["anchor_id"]))
                for row in edges
            )
            self.assertEqual(decoded_edges, Counter((row["source_url"], row["target_url"], row["anchor"]) for row in links))
            self.assertEqual(
                Counter((host_by_url_id[row["source_url_id"]], host_by_url_id[row["target_url_id"]]) for row in edges),
                Counter((row["source_host"], row["target_host"]) for row in links),
            )
            pages_out = pq.ParquetDataset(root / "out-a" / "dataset=pages_optimized").read().to_pylist()
            self.assertEqual(url_by_id[pages_out[0]["canonical_url_id"]], pages[0]["canonical"])
            self.assertEqual(first["datasets"]["edges"]["compression"], ["SNAPPY"])
            content_type_encodings = first["datasets"]["pages"]["encodings_first_file"]["content_type"]
            self.assertTrue({"PLAIN_DICTIONARY", "RLE_DICTIONARY"}.intersection(content_type_encodings))
            self.assertGreater(first["datasets"]["pages"]["row_groups"], 1)


if __name__ == "__main__":
    unittest.main()
