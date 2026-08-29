"""Regression checks for the explicit ten-WAT semantic digest contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import pyarrow as pa
import pyarrow.parquet as pq

import common_crawl_cloudflare_r2_ten_wat_canary as canary
import common_crawl_semantic_contract_v2 as semantic


class SemanticContractV2Test(unittest.TestCase):
    def write_pair(self, root: Path, *, reverse: bool = False, changed_link: bool = False) -> tuple[Path, Path]:
        pages = [
            {"url": "https://example.test/a", "fetched_at": "2026-08-28T00:00:00+00:00"},
            {"url": "https://example.test/b", "fetched_at": "2026-08-28T00:00:01+00:00"},
        ]
        links = [
            {"source_url": "https://example.test/a", "target_host": "alpha.example"},
            {"source_url": "https://example.test/b", "target_host": "beta.example" if not changed_link else "gamma.example"},
            {"source_url": "https://example.test/c", "target_host": None},
        ]
        if reverse:
            pages.reverse()
            links.reverse()
        pages_path = root / "pages.parquet"
        links_path = root / "links.parquet"
        pq.write_table(pa.Table.from_pylist(pages), pages_path)
        pq.write_table(pa.Table.from_pylist(links), links_path)
        return pages_path, links_path

    def test_dataset_and_record_digests_are_order_independent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "first").mkdir()
            (root / "second").mkdir()
            first = self.write_pair(root / "first")
            second = self.write_pair(root / "second", reverse=True)
            left = semantic.artifact_semantic_digests(pages_path=first[0], links_path=first[1])
            right = semantic.artifact_semantic_digests(pages_path=second[0], links_path=second[1])
            self.assertEqual(left, right)

    def test_change_to_link_record_changes_semantic_digests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "original").mkdir()
            (root / "changed").mkdir()
            original = self.write_pair(root / "original")
            changed = self.write_pair(root / "changed", changed_link=True)
            left = semantic.artifact_semantic_digests(pages_path=original[0], links_path=original[1])
            right = semantic.artifact_semantic_digests(pages_path=changed[0], links_path=changed[1])
            self.assertNotEqual(left.canonical_links_digest, right.canonical_links_digest)
            self.assertNotEqual(left.canonical_record_digest, right.canonical_record_digest)
            self.assertNotEqual(left.target_host_bucket_digest, right.target_host_bucket_digest)

    def test_missing_target_host_is_still_covered_by_link_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.mkdir(exist_ok=True)
            paths = self.write_pair(root)
            result = semantic.artifact_semantic_digests(pages_path=paths[0], links_path=paths[1])
            self.assertEqual(result.links_count, 3)
            self.assertRegex(result.target_host_bucket_digest, "^[0-9a-f]{64}$")

    def test_runner_rejects_unversioned_legacy_reference_before_processing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.json"
            path.write_text(json.dumps({"entries": []}), encoding="utf-8")
            expected_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(canary.TenWatCanaryError, "semantic v2 contract"):
                canary.load_reference_manifest(path, expected_sha256=expected_sha256)

    def test_runner_accepts_exactly_versioned_reference_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            entries = []
            for index in range(10):
                source_key = f"crawl-data/CC-MAIN-2026-30/segment/wat/part-{index:05d}.wat.gz"
                entries.append(
                    {
                        "source_key": source_key,
                        "deterministic_suffix": canary.contract.part_suffix(source_key),
                        "pages_count": 0,
                        "links_count": 0,
                        "malformed_count": 0,
                        "canonical_pages_digest": "0" * 64,
                        "canonical_links_digest": "1" * 64,
                        "canonical_record_digest": "2" * 64,
                        "target_host_bucket": {"target_host_bucket_digest": "3" * 64},
                    }
                )
            path = Path(directory) / "v2.json"
            path.write_text(json.dumps({"crawl": "CC-MAIN-2026-30", "entry_count": 10, "entries": entries, "semantic_contract": semantic.manifest_contract()}), encoding="utf-8")
            expected_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
            _document, parsed_entries = canary.load_reference_manifest(path, expected_sha256=expected_sha256)
            self.assertEqual(len(parsed_entries), 10)

    def test_zero_malformed_records_is_a_valid_semantic_count(self) -> None:
        report = {"pages_emitted": 1, "links_emitted": 2, "malformed_records": 0}
        self.assertEqual(canary._reported_count(report, "malformed_records"), 0)


if __name__ == "__main__":
    unittest.main()
