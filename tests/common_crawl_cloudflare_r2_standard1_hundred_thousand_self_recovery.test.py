#!/usr/bin/env python3
"""Local contracts for the launch-disabled remaining-89K self-recovery topology."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
SELF_RECOVERY = ROOT / "deployment" / "common-crawl-cloudflare-r2-standard1-hundred-thousand-self-recovery"
REGIONAL_SOURCE = ROOT / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "src" / "index.ts"
SOURCE_MANIFEST = ROOT / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-100000.json"
FIRST_TEN_THOUSAND_MANIFEST = ROOT / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-10000" / "base-manifest.json"
SHARD_TEN_MANIFEST = ROOT / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-100000-shards" / "shard-00010-of-00100.json"
FINAL_PROVISIONER = SELF_RECOVERY / "provision-final-89k-wsl.mjs"
FINAL_PROVISIONER_WRAPPER = SELF_RECOVERY / "provision-final-89k-wsl.sh"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_cloudflare_r2_standard1_regional_ramp as ramp


def load_builder():
    spec = importlib.util.spec_from_file_location("hundred_thousand_self_recovery_builder", SELF_RECOVERY / "build_self_recovery_bundles.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_reuse_preparer():
    spec = importlib.util.spec_from_file_location("verified_reuse_preparer", SELF_RECOVERY / "prepare_verified_reuse_proof.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HundredThousandSelfRecoveryTests(unittest.TestCase):
    def test_topology_is_partitioned_and_avoids_limited_exclusive_regions(self):
        builder = load_builder()
        lanes = builder.reviewed_lanes()
        self.assertEqual(len(lanes), 45)
        self.assertEqual(sum(1 for _lane, group, _delay in lanes if group == "APAC"), 8)
        self.assertEqual(sum(1 for _lane, group, _delay in lanes if group == "ENAM"), 8)
        self.assertEqual(sum(1 for _lane, group, _delay in lanes if group == "WNAM"), 8)
        self.assertEqual(sum(1 for _lane, group, _delay in lanes if group in {"EEUR", "WEUR", "SAM"}), 21)
        self.assertFalse(any(group in {"ME", "OC", "AFR"} for _lane, group, _delay in lanes))
        self.assertEqual(sum(builder.lane_task_count(builder.PROCESSING_TASK_COUNT, index, len(lanes)) for index in range(len(lanes))), 89_000)
        self.assertEqual(len(lanes) * builder.SLOTS_PER_LANE, 1_440)

    def test_sparse_manifest_preserves_global_task_identity(self):
        builder = load_builder()
        source = {
            "kind": "common-crawl-v2-base-manifest",
            "manifest_sha256": "a" * 64,
            "inputs": [
                "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz",
                "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00001.warc.wat.gz",
                "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00002.warc.wat.gz",
                "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00003.warc.wat.gz",
            ],
        }
        sparse = builder.sparse_lane_manifest(
            source_document=source,
            source_file_sha256="b" * 64,
            source_index_start=2,
            processing_task_count=2,
            lane_index=1,
            lane_count=2,
        )
        self.assertEqual(sparse["input_count"], builder.SOURCE_TASK_COUNT)
        self.assertEqual(sparse["source_indexes"], [3])
        self.assertTrue(ramp.selected_input(sparse, task_index=3)["source_key"].endswith("00003.warc.wat.gz"))
        with self.assertRaises(ramp.RegionalRampError):
            ramp.selected_input(sparse, task_index=2)

    def test_verified_reuse_proof_fails_closed_and_excludes_the_completed_prefix(self):
        builder = load_builder()
        source = {
            "manifest_sha256": "a" * 64,
            "inputs_sha256": "b" * 64,
        }
        proof = {
            "kind": "growthsent-cloudflare-r2-standard1-verified-reuse-proof-v1",
            "source_manifest": {
                "file_sha256": "c" * 64,
                "claim_sha256": source["manifest_sha256"],
                "inputs_sha256": source["inputs_sha256"],
                "input_count": builder.SOURCE_TASK_COUNT,
            },
            "completed_source_index_ranges": [{"start": 0, "end_exclusive": builder.REUSED_SOURCE_PREFIX_COUNT}],
            "completed_source_count": builder.REUSED_SOURCE_PREFIX_COUNT,
            "remaining_source_index_ranges": [{"start": builder.REUSED_SOURCE_PREFIX_COUNT, "end_exclusive": builder.SOURCE_TASK_COUNT}],
            "remaining_source_count": builder.PROCESSING_TASK_COUNT,
        }
        proof["proof_sha256"] = __import__("hashlib").sha256(builder.canonical_json(proof).rstrip(b"\n")).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "REUSE-PROOF.json"
            path.write_bytes(builder.canonical_json(proof))
            loaded = builder.load_reuse_proof(path, source_document=source, source_file_sha256="c" * 64)
            self.assertEqual(loaded["remaining_source_count"], 89_000)
            proof["completed_source_count"] = 10_000
            path.write_bytes(builder.canonical_json(proof))
            with self.assertRaises(SystemExit):
                builder.load_reuse_proof(path, source_document=source, source_file_sha256="c" * 64)

    def test_reuse_preparer_binds_the_exact_10k_and_shard10_evidence(self):
        preparer = load_reuse_preparer()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            aggregate = root / "AGGREGATE-RECOVERY-CONTRACT.json"
            aggregate.write_text(json.dumps({"kind": "aggregate", "completed_task_count": 10_000, "incomplete_task_count": 0}), encoding="utf-8")
            indexes = list(range(123))
            recovery = root / "RECOVERY-CONTRACT.json"
            recovery.write_text(json.dumps({
                "kind": "partial-recovery",
                "inventory": {"completed_source_count": 877},
                "recovery_task_count": 123,
                "recovery_source_indexes": indexes,
                "recovery_source_indexes_sha256": __import__("hashlib").sha256(preparer.canonical_json(indexes)).hexdigest(),
            }), encoding="utf-8")
            context = root / "HIGH-CAPACITY-PARTIAL-RECOVERY-CONTEXT.json"
            context.write_text(json.dumps({"run_id": "shard-ten-recovery", "task_count": 123}), encoding="utf-8")
            report = root / "VERIFICATION-REPORT.json"
            report.write_text(json.dumps({"run_id": "shard-ten-recovery", "task_count": 123, "passed": True, "errors": []}), encoding="utf-8")
            proof = preparer.build_proof(
                source_manifest=SOURCE_MANIFEST,
                first_ten_thousand_manifest=FIRST_TEN_THOUSAND_MANIFEST,
                first_ten_thousand_aggregate_contract=aggregate,
                shard_ten_manifest=SHARD_TEN_MANIFEST,
                shard_ten_recovery_contract=recovery,
                shard_ten_recovery_context=context,
                shard_ten_recovery_report=report,
            )
        self.assertEqual(proof["completed_source_index_ranges"], [{"start": 0, "end_exclusive": 11_000}])
        self.assertEqual(proof["remaining_source_index_ranges"], [{"start": 11_000, "end_exclusive": 100_000}])
        self.assertEqual(proof["remaining_source_count"], 89_000)

    def test_runtime_requires_shared_admission_and_does_not_spend_attempts_when_paced(self):
        worker = REGIONAL_SOURCE.read_text(encoding="utf-8")
        admission = (SELF_RECOVERY / "src" / "admission.ts").read_text(encoding="utf-8")
        self.assertIn("REGIONAL_ADMISSION?: DurableObjectNamespace<RegionalStartAdmissionContract>", worker)
        self.assertIn("GROWTHSENT_SOURCE_INDEX_START", worker)
        self.assertIn("values.sourceIndexStart + values.regionIndex", worker)
        self.assertIn("requestRegionalStartPermit", worker)
        self.assertIn("RegionalStartPaced", worker)
        self.assertIn("attempts: priorMatches ? prior!.attempts : 0", worker)
        self.assertIn("outcome.retry_after_seconds ?? retryDelaySeconds", worker)
        self.assertIn("reportCapacityFailure", admission)
        self.assertIn("capacity_backoff_until_ms", admission)
        self.assertIn("claimStart", admission)

    def test_builder_and_policy_are_explicitly_launch_disabled(self):
        builder = (SELF_RECOVERY / "build_self_recovery_bundles.py").read_text(encoding="utf-8")
        policy = (SELF_RECOVERY / "README.md").read_text(encoding="utf-8")
        self.assertIn("remote_start", builder)
        self.assertIn("--reuse-proof", builder)
        self.assertIn("remaining-eighty-nine-thousand", builder)
        self.assertIn("published_limit_basis", builder)
        self.assertNotIn("capacity_review_required", builder)
        self.assertIn("LANE_HEADROOM = 0", builder)
        self.assertNotIn("subprocess", builder)
        self.assertIn("cannot mint credentials", builder)
        self.assertIn("requires a separately reviewed provisioner", policy)

    def test_future_provisioner_requires_explicit_launch_approval_and_preserves_preflight_order(self):
        provisioner = FINAL_PROVISIONER.read_text(encoding="utf-8")
        wrapper = FINAL_PROVISIONER_WRAPPER.read_text(encoding="utf-8")
        self.assertIn("--approved-final-89k-run", provisioner)
        self.assertNotIn("GROWTHSENT_CAPACITY_APPROVAL_REFERENCE", provisioner)
        self.assertIn("all_final_89k_lanes_preflighted", provisioner)
        self.assertIn("final_89k_admission_worker_ready", provisioner)
        self.assertIn("300000", provisioner)
        self.assertIn("Last safe status", provisioner)
        self.assertIn("waitForSafeWorker(lane.worker_url, { run_id: plan.run_id, lane: lane.lane })", provisioner)
        self.assertIn("max_instances_per_lane !== 32", provisioner)
        self.assertIn("FINAL-89K-SAFE-LOGS", provisioner)
        self.assertIn("Safe diagnostic:", provisioner)
        self.assertLess(provisioner.index("all_final_89k_lanes_preflighted"), provisioner.index("final_89k_admission_worker_ready"))
        self.assertIn("GROWTHSENT_FINAL_89K_PLAN", wrapper)
        self.assertIn("boto3.__version__ == \"1.43.67\"", wrapper)
        self.assertIn("mkdir -p \"$CONTROLLER_DIRECTORY\"", wrapper)
        self.assertIn("rerun only if it explicitly confirms", wrapper)


if __name__ == "__main__":
    unittest.main()
