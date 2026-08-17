import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

SPEC = importlib.util.spec_from_file_location("build_common_crawl_v2_10k_run", TOOLS / "build_common_crawl_v2_10k_run.py")
run_builder = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = run_builder
SPEC.loader.exec_module(run_builder)

import common_crawl_v2_manifest as manifests


def source_path(index: int) -> str:
    return f"crawl-data/CC-MAIN-2026-30/segments/1700000000000.00/wat/CC-MAIN-{index:05d}.warc.wat.gz"


class BuildCommonCrawlV2TenThousandRunTests(unittest.TestCase):
    def test_exact_first_ten_thousand_and_ten_fixed_shards_are_locked(self):
        source = manifests.build_base_manifest(
            run_id="reviewed-first-100000",
            crawl=run_builder.CRAWL,
            inputs=[source_path(index) for index in range(run_builder.SOURCE_INPUT_COUNT)],
            expected_input_count=run_builder.SOURCE_INPUT_COUNT,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source_path_file = root / "source.json"
            manifests.write_immutable_json(source_path_file, source)
            report = run_builder.write_run(root / "run", source_path_file)
            base = manifests.load_base_manifest(root / "run/base-manifest.json", expected_input_count=10_000)
            self.assertEqual(base["inputs"], source["inputs"][:10_000])
            self.assertEqual(report["input_count"], 10_000)
            self.assertEqual(report["shard_count"], 10)
            self.assertEqual(report["first_input"], source["inputs"][0])
            self.assertEqual(report["last_input"], source["inputs"][9_999])
            shards = [
                manifests.load_shard_manifest(path, base, expected_input_count=10_000)
                for path in sorted((root / "run/shards").glob("shard-*-of-*.json"))
            ]
            self.assertEqual([shard["input_count"] for shard in shards], [1_000] * 10)
            manifests.verify_shard_set(base, shards, expected_input_count=10_000)

    def test_source_manifest_must_be_the_reviewed_exact_hundred_thousand_scope(self):
        source = manifests.build_base_manifest(
            run_id="too-small",
            crawl=run_builder.CRAWL,
            inputs=[source_path(index) for index in range(10)],
            expected_input_count=10,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "source.json"
            manifests.write_immutable_json(path, source)
            with self.assertRaisesRegex(manifests.ManifestValidationError, "100,000"):
                run_builder.build_run(path)


if __name__ == "__main__":
    unittest.main()
