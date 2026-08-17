import importlib.util
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

BUILD_SPEC = importlib.util.spec_from_file_location("build_common_crawl_v2_bundle", TOOLS / "build_common_crawl_v2_bundle.py")
bundle = importlib.util.module_from_spec(BUILD_SPEC)
assert BUILD_SPEC and BUILD_SPEC.loader
sys.modules[BUILD_SPEC.name] = bundle
BUILD_SPEC.loader.exec_module(bundle)

import common_crawl_v2_manifest as manifests


def source(index: int) -> str:
    return (
        "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
        f"CC-MAIN-20260710070534-20260710100534-{index:05d}.warc.wat.gz"
    )


class BuildCommonCrawlV2BundleTests(unittest.TestCase):
    def test_bundle_is_deterministic_and_contains_only_the_verified_v2_release(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            base = manifests.build_base_manifest(
                run_id="cc-main-2026-30-first-100000",
                crawl="CC-MAIN-2026-30",
                inputs=[source(index) for index in range(4)],
                expected_input_count=4,
            )
            shards = manifests.split_shards(base, 2, expected_input_count=4)
            plan = manifests.build_shard_plan(base, shards, expected_input_count=4)
            base_path = root / "base.json"
            shard_dir = root / "shards"
            plan_path = shard_dir / "shard-plan.json"
            manifests.write_immutable_json(base_path, base)
            manifests.write_shard_artifacts(shard_dir, shards)
            manifests.write_immutable_json(plan_path, plan)

            first = bundle.build(
                root / "first.tar.gz", base_path, plan_path, shard_dir, expected_input_count=4
            )
            second = bundle.build(
                root / "second.tar.gz", base_path, plan_path, shard_dir, expected_input_count=4
            )

            self.assertEqual(first["archive_sha256"], second["archive_sha256"])
            self.assertEqual(first["input_count"], 4)
            self.assertEqual(first["shard_count"], 2)
            with tarfile.open(root / "first.tar.gz", "r:gz") as archive:
                names = archive.getnames()
            self.assertIn("growthsent-common-crawl-production-v2/tools/common_crawl_wat_ingest.py", names)
            self.assertIn("growthsent-common-crawl-production-v2/tools/common_crawl_wat_ingest_v2.py", names)
            self.assertIn("growthsent-common-crawl-production-v2/tools/common_crawl_backlink_derive.py", names)
            self.assertIn("growthsent-common-crawl-production-v2/manifests/base-manifest.json", names)
            self.assertIn("growthsent-common-crawl-production-v2/manifests/shards/shard-plan.json", names)
            self.assertIn("growthsent-common-crawl-production-v2/BUNDLE-MANIFEST.json", names)

    def test_production_cli_path_remains_exactly_one_hundred_thousand_inputs(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            base = manifests.build_base_manifest(
                run_id="cc-main-2026-30-first-100000",
                crawl="CC-MAIN-2026-30",
                inputs=[source(index) for index in range(4)],
                expected_input_count=4,
            )
            shards = manifests.split_shards(base, 2, expected_input_count=4)
            plan = manifests.build_shard_plan(base, shards, expected_input_count=4)
            base_path = root / "base.json"
            shard_dir = root / "shards"
            plan_path = shard_dir / "shard-plan.json"
            manifests.write_immutable_json(base_path, base)
            manifests.write_shard_artifacts(shard_dir, shards)
            manifests.write_immutable_json(plan_path, plan)

            with self.assertRaisesRegex(Exception, "100000|100,000"):
                bundle.build(root / "unsafe.tar.gz", base_path, plan_path, shard_dir)


if __name__ == "__main__":
    unittest.main()
