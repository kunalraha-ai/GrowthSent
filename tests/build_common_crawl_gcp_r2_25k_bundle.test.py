import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import build_common_crawl_gcp_r2_25k_bundle as bundle


class GcpR2BundleTests(unittest.TestCase):
    def test_bundle_contains_the_isolated_r2_https_runner_and_locked_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "release.tar.gz"
            result = bundle.build(archive)
            self.assertEqual(result["input_count"], 25_000)
            self.assertEqual(result["shard_count"], 25)
            with tarfile.open(archive, "r:gz") as tar:
                names = set(tar.getnames())
        root = bundle.BUNDLE_NAME + "/"
        self.assertIn(root + "tools/common_crawl_http_source.py", names)
        self.assertIn(root + "tools/common_crawl_r2_store.py", names)
        self.assertIn(root + "tools/common_crawl_gcp_r2_one_wat_canary.py", names)
        self.assertIn(root + "manifests/base-manifest.json", names)
        self.assertIn(root + "manifests/shards/shard-00024-of-00025.json", names)
        self.assertIn(root + "Dockerfile", names)
        self.assertIn(root + "batch/raw-shard-job.template.json", names)


if __name__ == "__main__":
    unittest.main()
