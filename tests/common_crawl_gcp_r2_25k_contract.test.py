import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_gcp_r2_25k_contract as contract
import verify_common_crawl_gcp_r2_25k_run as verifier


MANIFEST_ROOT = ROOT / "deployment" / "common-crawl-gcp-r2-25k" / "manifests" / contract.RUN_ID


class GcpR2ContractTests(unittest.TestCase):
    def test_locked_25k_slice_has_no_golden_overlap_and_all_canonical_shards(self):
        report = verifier.verify(MANIFEST_ROOT / "base-manifest.json", MANIFEST_ROOT / "shards")
        self.assertEqual(report["source_slice"], [10_000, 35_000])
        self.assertEqual(report["input_count"], 25_000)
        self.assertEqual(report["golden_overlap_count"], 0)
        self.assertEqual(report["shard_count"], 25)
        # The verifier above proves all 25 manifests and their exact ordered
        # union. Exercise the per-worker contract path once here without
        # turning the focused test into 25 repeated full-base validations.
        checked = contract.load_contract(
            MANIFEST_ROOT / "base-manifest.json",
            MANIFEST_ROOT / "shards" / "shard-00024-of-00025.json",
            MANIFEST_ROOT / "shards" / "shard-plan.json",
            shard_id=24,
        )
        self.assertEqual(len(checked.inputs), 1_000)

    def test_job_identity_and_prefix_are_hard_locked(self):
        checked = contract.load_contract(
            MANIFEST_ROOT / "base-manifest.json",
            MANIFEST_ROOT / "shards" / "shard-00000-of-00025.json",
            MANIFEST_ROOT / "shards" / "shard-plan.json",
            shard_id=0,
        )
        values = {
            "run_id": contract.RUN_ID,
            "crawl": contract.CRAWL,
            "shard_id": 0,
            "shard_count": 25,
            "base_inputs_sha256": contract.INPUTS_SHA256,
            "base_manifest_sha256": contract.BASE_MANIFEST_SHA256,
            "shard_inputs_sha256": checked.shard["inputs_sha256"],
            "shard_manifest_sha256": checked.shard["manifest_sha256"],
            "release_sha256": "a" * 64,
            "expected_input_count": 1_000,
            "raw_prefix": contract.RAW_PREFIX,
            "derived_prefix": contract.DERIVED_PREFIX,
        }
        contract.validate_job_identity(values, checked, release_sha256="a" * 64)
        values["raw_prefix"] = "production/common-crawl/wat-pages-links/v2/cc-main-2026-30-first-10000"
        with self.assertRaises(contract.GcpR2ContractError):
            contract.validate_job_identity(values, checked, release_sha256="a" * 64)

    def test_invalid_shard_or_path_component_cannot_escape_contract(self):
        for value in (-1, 25, True):
            with self.assertRaises(contract.GcpR2ContractError):
                contract.shard_label(value)
        with self.assertRaises(contract.GcpR2ContractError):
            contract.normalized_key(contract.RAW_PREFIX, "../golden")
        with self.assertRaises(contract.GcpR2ContractError):
            contract.raw_part_key("pages", "not-a-common-crawl-key")


if __name__ == "__main__":
    unittest.main()
