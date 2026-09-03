import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path


TOOLS = Path(__file__).parents[1] / "tools"
REGIONAL_WORKER_SOURCE = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "src" / "index.ts"
REGIONAL_VERIFIER_SOURCE = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "verify-regional-ramp-wsl.mjs"
REGIONAL_BUILDER = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "build_bundles.py"
REGIONAL_RUNNER_SERVER = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "regional_ramp_server.py"
AGGREGATE_RECOVERY_PREPARER = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "prepare-aggregate-256-recovery-wsl.mjs"
AGGREGATE_RECOVERY_LAUNCHER = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "recover-256-aggregate-wsl.sh"
ENAM_RECOVERY_CONTRACT = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "enam-recovery-source-v1.json"
INCOMPLETE_RECOVERY_CONTRACT = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "incomplete-1000-recovery-source-v1.json"
REMAINING_RECOVERY_CONTRACT = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "remaining-1000-recovery-source-v1.json"
SOURCE_MANIFEST = Path(__file__).parents[1] / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-100000-shards" / "shard-00000-of-00100.json"
TEN_THOUSAND_SOURCE_MANIFEST = Path(__file__).parents[1] / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-10000" / "base-manifest.json"
HIGH_CAPACITY_SOURCE_MANIFEST = Path(__file__).parents[1] / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-100000-shards" / "shard-00010-of-00100.json"
HUNDRED_THOUSAND_SOURCE_MANIFEST = Path(__file__).parents[1] / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-100000.json"
HUNDRED_THOUSAND_CAMPAIGN_PREPARER = Path(__file__).parents[1] / "deployment" / "common-crawl-cloudflare-r2-standard1-regional-ramp" / "prepare_hundred_thousand_campaign.py"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_cloudflare_r2_standard1_regional_ramp as ramp
import common_crawl_gcp_r2_25k_contract as contract


SOURCE_KEY = "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/CC-MAIN-20260710070534-20260710100534-00000.warc.wat.gz"


class RegionalRampContractTests(unittest.TestCase):
    def test_aggregate_256_recovery_uses_immutable_source_identity_not_counters(self):
        preparer = AGGREGATE_RECOVERY_PREPARER.read_text(encoding="utf-8")
        launcher = AGGREGATE_RECOVERY_LAUNCHER.read_text(encoding="utf-8")
        self.assertIn("TASK-COMPLETED source-identity checks across original and terminal recovery roots", preparer)
        self.assertIn("aggregate_unique_completed_source_count", preparer)
        self.assertIn("duplicate_valid_completion_marker_count", preparer)
        self.assertIn("Every original and supplemental Worker must be terminal", preparer)
        self.assertIn("GROWTHSENT_AGGREGATE_COMPLETION_CONTEXTS", launcher)
        self.assertIn("--approved-256-aggregate-recovery", launcher)
        self.assertIn("No Worker, Container, or R2 object was changed", launcher)

    def write_inputs(self, root: Path) -> Path:
        inputs = [{"source_key": SOURCE_KEY, "deterministic_suffix": contract.part_suffix(SOURCE_KEY)}]
        document = {
            "format_version": 1,
            "kind": ramp.INPUT_KIND,
            "crawl": contract.CRAWL,
            "source_manifest_sha256": "a" * 64,
            "input_count": 1,
            "inputs": inputs,
            "selected_inputs_sha256": hashlib.sha256(ramp.canonical_json(inputs)).hexdigest(),
        }
        path = root / "selected-inputs.json"
        path.write_bytes(ramp.canonical_json(document))
        return path

    def test_selected_inputs_and_task_prefix_are_locked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_inputs(Path(temporary))
            document = ramp.load_inputs(path, expected_sha256=ramp.sha256_file(path))
        self.assertEqual(ramp.selected_input(document, task_index=0)["source_key"], SOURCE_KEY)
        self.assertEqual(
            ramp.task_prefix("cc-main-2026-30-regional-test", "APAC", 0, 1),
            "production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-regional-test/region=apac/tasks/task-0001",
        )

    def test_selected_inputs_fail_closed_on_digest_or_index_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_inputs(Path(temporary))
            with self.assertRaises(ramp.RegionalRampError):
                ramp.load_inputs(path, expected_sha256="b" * 64)
            document = json.loads(path.read_text(encoding="utf-8"))
            document["inputs"][0]["deterministic_suffix"] = "0" * 16
            path.write_bytes(ramp.canonical_json(document))
            with self.assertRaises(ramp.RegionalRampError):
                ramp.load_inputs(path, expected_sha256=ramp.sha256_file(path))
        with self.assertRaises(ramp.RegionalRampError):
            ramp.task_number(1, 1)

    def test_task_input_only_prefix_is_resumed_but_later_partial_output_is_quarantined(self):
        class Store:
            def __init__(self, keys, input_document):
                self.keys = keys
                self.input_document = input_document

            def list_keys(self, _prefix):
                return list(self.keys)

            def read_json(self, _key):
                return None if self.input_document is None else (self.input_document, "etag")

            def upload_immutable_json(self, key, value):
                self.asserted_value = value
                return {"key": key, "bytes": len(ramp.canonical_json(value)), "sha256": hashlib.sha256(ramp.canonical_json(value)).hexdigest(), "reused": True}

        prefix = ramp.task_prefix("cc-main-2026-30-test-standard1-regional-a1b2c3d4", "APAC", 0, 1)
        input_key = f"{prefix}/TASK-INPUT-MANIFEST.json"
        task_input = {"kind": ramp.TASK_INPUT_KIND, "run_id": "cc-main-2026-30-test-standard1-regional-a1b2c3d4"}
        resumable = Store([input_key], task_input)
        result = ramp._prepare_task_input(resumable, prefix=prefix, task_input=task_input)
        self.assertTrue(result["reused"])
        self.assertEqual(resumable.asserted_value, task_input)

        partial = Store([input_key, f"{prefix}/crawl=CC-MAIN-2026-30/dataset=pages/part-test.parquet"], task_input)
        with self.assertRaisesRegex(ramp.RecoverablePartialTaskPrefixError, "requires isolated recovery"):
            ramp._prepare_task_input(partial, prefix=prefix, task_input=task_input)

    def test_container_label_names_fit_cloudflare_limit(self):
        source = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        match = re.search(r"function containerLabels[\s\S]*?const labels = \{([\s\S]*?)\n  \};", source)
        self.assertIsNotNone(match, "regional Worker must define its Container labels in one guarded helper")
        names = re.findall(r"^    ([a-z0-9_]+):", match.group(1), flags=re.MULTILINE) if match else []
        self.assertEqual(names, ["gs_ramp", "gs_region", "slot"])
        self.assertIn("const MAX_CONTAINER_LABEL_NAME_BYTES = 16;", source)
        self.assertTrue(all(len(name.encode("utf-8")) <= 16 for name in names))

    def test_fixed_slot_pool_replaces_one_container_per_wat(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('import { Container } from "@cloudflare/containers";', worker)
        self.assertIn("function slotName", worker)
        self.assertNotIn("function taskName", worker)
        self.assertIn("const occupiedSlots", worker)
        self.assertIn("container_slot", worker)
        self.assertIn("startAndWaitForPorts", worker)
        self.assertIn('containerFetch("http://localhost/run-task"', worker)
        self.assertIn("isCapacityFailure", worker)
        self.assertIn("this.envVars = runnerEnvironment(env);", worker)
        self.assertIn('kind: "task"', worker)
        self.assertIn("standard1_regional_task_retry_scheduled", worker)

    def test_verifier_handles_signed_head_and_summary_schema(self):
        source = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('content_length_source: contentLength === null ? null : "head_object"', source)
        self.assertIn('head.content_length_source = "list_objects_v2"', source)
        self.assertIn("const taskIdentity =", source)
        self.assertIn("must(taskIdentity(summary)", source)
        self.assertIn("must(suffixIdentity(wat)", source)
        self.assertIn("must(suffixIdentity(complete)", source)

    def test_enam_recovery_build_is_exactly_eighteen_fresh_local_tasks(self):
        recovery = json.loads(ENAM_RECOVERY_CONTRACT.read_text(encoding="utf-8"))
        source_context = {
            "run_id": recovery["source_run_id"],
            "task_count": recovery["source_task_count"],
            "selected_inputs_sha256": recovery["source_selected_inputs_sha256"],
            "regions": [{"region": "ENAM", "regional_task_count": 25}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            context_path = root / "REGIONAL-RAMP-CONTEXT.json"
            context_path.write_text(json.dumps(source_context), encoding="utf-8")
            output = root / "recovery"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-standard1-enam-recover-a1b2c3d4",
                    "--source-manifest",
                    str(SOURCE_MANIFEST),
                    "--task-count",
                    "18",
                    "--recovery-contract",
                    str(ENAM_RECOVERY_CONTRACT),
                    "--source-run-context",
                    str(context_path),
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            selected = json.loads((output / "bundles" / "enam" / "selected-inputs.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "enam" / "wrangler.jsonc").read_text(encoding="utf-8"))
            bundle_files = {path.name for path in (output / "bundles" / "enam").iterdir() if path.is_file()}
        self.assertEqual(plan["kind"], "growthsent-cloudflare-r2-standard1-enam-recovery-plan")
        self.assertEqual(plan["task_count"], 18)
        self.assertEqual(plan["recovery"]["recovery_source_indexes"], recovery["recovery_source_indexes"])
        self.assertEqual([item["region"] for item in plan["regions"]], ["ENAM"])
        self.assertEqual(len(selected["inputs"]), 18)
        self.assertEqual(config["vars"]["GROWTHSENT_REGION_INDEX"], "0")
        self.assertEqual(config["vars"]["GROWTHSENT_REGION_COUNT"], "1")
        self.assertEqual(config["vars"]["GROWTHSENT_REGIONAL_TASK_COUNT"], "18")
        self.assertTrue({"requirements.txt", "package.json", "r2-boto3-preflight.py"}.issubset(bundle_files))

    def test_worker_and_launcher_support_the_isolated_one_lane_recovery(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        provisioner = (REGIONAL_WORKER_SOURCE.parents[1] / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        self.assertIn('setting(env, "GROWTHSENT_REGION_COUNT", 1, 45)', worker)
        self.assertIn("--approved-enam-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-enam-recovery-plan", provisioner)

    def test_incomplete_thousand_wat_recovery_contract_is_exact_and_disjoint(self):
        recovery = json.loads(INCOMPLETE_RECOVERY_CONTRACT.read_text(encoding="utf-8"))
        ranges = recovery["recovery_source_index_ranges"]
        indexes = []
        for item in ranges:
            self.assertIn(item["source_region"], {"APAC", "WNAM", "WEUR"})
            self.assertEqual(item["step"], 4)
            indexes.extend(range(item["start"], item["end"] + 1, item["step"]))
        self.assertEqual(recovery["kind"], "growthsent-cloudflare-r2-standard1-incomplete-recovery-contract-v1")
        self.assertEqual(recovery["source_task_count"], 1000)
        self.assertEqual(recovery["recovery_task_count"], 408)
        self.assertEqual(len(indexes), 408)
        self.assertEqual(len(indexes), len(set(indexes)))
        self.assertEqual(sorted(indexes), sorted(set(indexes)))
        self.assertEqual(recovery["inventory"]["object_count"], 4144)
        self.assertEqual(recovery["inventory"]["completion_marker_count"], 592)
        self.assertEqual(recovery["inventory"]["incomplete_task_count"], 408)

    def test_launcher_and_verifier_bind_the_exact_incomplete_recovery(self):
        provisioner = (REGIONAL_WORKER_SOURCE.parents[1] / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (REGIONAL_WORKER_SOURCE.parents[1] / "recover-incomplete-wsl.sh").read_text(encoding="utf-8")
        self.assertIn("--approved-incomplete-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-incomplete-recovery-plan", provisioner)
        self.assertIn("live_incomplete_recovery_accepted", provisioner)
        self.assertIn("INCOMPLETE-RECOVERY-CONTEXT.json", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-incomplete-recovery-plan", verifier)
        self.assertIn("growthsent-cloudflare-r2-standard1-incomplete-recovery-verification-report", verifier)
        self.assertIn('RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-incomplete-${NONCE}"', launcher)

    def test_remaining_recovery_contract_is_exact_merged_inventory(self):
        recovery = json.loads(REMAINING_RECOVERY_CONTRACT.read_text(encoding="utf-8"))
        indexes = recovery["recovery_source_indexes"]
        self.assertEqual(recovery["kind"], "growthsent-cloudflare-r2-standard1-remaining-recovery-contract-v1")
        self.assertEqual(recovery["source_task_count"], 1000)
        self.assertEqual(recovery["recovery_task_count"], 234)
        self.assertEqual(len(indexes), 234)
        self.assertEqual(indexes, sorted(set(indexes)))
        self.assertTrue(all(isinstance(index, int) and 0 <= index < 1000 for index in indexes))
        self.assertEqual(
            recovery["recovery_source_indexes_sha256"],
            hashlib.sha256(ramp.canonical_json(indexes)).hexdigest(),
        )
        self.assertEqual(
            recovery["inventory"],
            {
                "listed_at": "2026-09-01T07:49:34.355Z",
                "method": "Cloudflare R2 List Objects API; immutable TASK-COMPLETED marker written last",
                "original_object_count": 4144,
                "original_completion_marker_count": 592,
                "prior_recovery_object_count": 1218,
                "prior_recovery_completion_marker_count": 174,
                "original_and_prior_recovery_overlap_count": 0,
                "unique_completed_source_count": 766,
                "remaining_task_count": 234,
            },
        )
        self.assertEqual(recovery["prior_recovery"]["completion_marker_count"], 174)
        self.assertTrue(recovery["prior_recovery"]["container_instances_verified_inactive"])

    def test_remaining_recovery_has_a_separate_fixed_pipeline_launcher_and_verifier_contract(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "recover-remaining-wsl.sh").read_text(encoding="utf-8")
        compile_gate = (root / "compile-remaining-recovery-gate-wsl.sh").read_text(encoding="utf-8")
        self.assertIn("--approved-remaining-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-remaining-recovery-plan", provisioner)
        self.assertIn("live_remaining_recovery_accepted", provisioner)
        self.assertIn("REMAINING-RECOVERY-CONTEXT.json", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-remaining-recovery-plan", verifier)
        self.assertIn("growthsent-cloudflare-r2-standard1-remaining-recovery-verification-report", verifier)
        self.assertIn('RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-remaining-${NONCE}"', launcher)
        self.assertIn("--task-count 234", compile_gate)
        self.assertIn("remaining 1,000-WAT recovery local plan gate passed", compile_gate)

    def test_thousand_wat_plan_is_exactly_four_bounded_lanes_with_expiry_guard(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "thousand"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-standard1-regional-a1b2c3d4",
                    "--source-manifest",
                    str(SOURCE_MANIFEST),
                    "--task-count",
                    "1000",
                    "--execution-profile",
                    "regional-thousand-wat",
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "apac" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["execution_profile"], "regional-thousand-wat")
        self.assertEqual(plan["task_count"], 1000)
        self.assertEqual(plan["max_concurrent_total"], 16)
        self.assertEqual(
            plan["credential_policy"],
            {"id": "regional-six-day-v1", "child_ttl_seconds": 518_400, "start_guard_seconds": 10_800},
        )
        self.assertEqual([item["regional_task_count"] for item in plan["regions"]], [250, 250, 250, 250])
        self.assertTrue(all(item["max_concurrent"] == 4 and item["max_instances"] == 6 for item in plan["regions"]))
        self.assertEqual(config["vars"]["GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS"], "10800")

    def test_thousand_wat_guard_and_verifier_pagination_are_present(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        provisioner = (REGIONAL_WORKER_SOURCE.parents[1] / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        self.assertIn("R2CredentialWindowElapsed", worker)
        self.assertIn("GROWTHSENT_R2_CREDENTIAL_NOT_AFTER", worker)
        self.assertIn("--approved-thousand-wat-run", provisioner)
        self.assertIn("regional-six-day-v1", provisioner)
        self.assertIn('query.set("continuation-token", continuationToken)', verifier)
        self.assertIn("NextContinuationToken", verifier)

    def test_ten_thousand_wat_plan_is_exactly_four_fixed_lanes(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "ten-thousand"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-standard1-regional-a1b2c3d4",
                    "--source-manifest",
                    str(TEN_THOUSAND_SOURCE_MANIFEST),
                    "--task-count",
                    "10000",
                    "--execution-profile",
                    "regional-ten-thousand-wat",
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "apac" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["execution_profile"], "regional-ten-thousand-wat")
        self.assertEqual(plan["task_count"], 10_000)
        self.assertEqual(plan["max_concurrent_total"], 16)
        self.assertEqual(
            plan["credential_policy"],
            {"id": "regional-six-day-v1", "child_ttl_seconds": 518_400, "start_guard_seconds": 10_800},
        )
        self.assertEqual([item["regional_task_count"] for item in plan["regions"]], [2500, 2500, 2500, 2500])
        self.assertTrue(all(item["max_concurrent"] == 4 and item["max_instances"] == 6 for item in plan["regions"]))
        self.assertEqual(config["vars"]["GROWTHSENT_TASK_COUNT"], "10000")
        self.assertEqual(config["vars"]["GROWTHSENT_REGIONAL_TASK_COUNT"], "2500")

    def test_ten_thousand_launcher_and_scalable_verifier_are_explicit(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "provision-and-start-ten-thousand-wat-wsl.sh").read_text(encoding="utf-8")
        compile_gate = (root / "compile-ten-thousand-wat-gate-wsl.sh").read_text(encoding="utf-8")
        self.assertIn("--approved-ten-thousand-wat-run", provisioner)
        self.assertIn("live_ten_thousand_wat_accepted", provisioner)
        self.assertIn("TEN-THOUSAND-RAMP-CONTEXT.json", provisioner)
        self.assertIn("regional-ten-thousand-wat", launcher)
        self.assertIn("--task-count 10000", compile_gate)
        self.assertIn("regional standard-1 10,000-WAT local plan gate passed", compile_gate)
        self.assertIn("MAX_LIST_PAGES = 64", verifier)
        self.assertIn("OBJECT_HEAD_CONCURRENCY = 16", verifier)
        self.assertIn("JSON_VERIFY_CONCURRENCY = 12", verifier)
        self.assertIn("concurrentMap", verifier)
        self.assertIn("TEN_THOUSAND_READ_CHILD_TTL_SECONDS = 21600", verifier)

    def test_256_slot_ten_thousand_plan_uses_two_isolated_lanes_per_region(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "ten-thousand-256"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-s1-256-a1b2c3d4",
                    "--source-manifest",
                    str(TEN_THOUSAND_SOURCE_MANIFEST),
                    "--task-count",
                    "10000",
                    "--max-concurrent",
                    "32",
                    "--start-spacing-seconds",
                    "30",
                    "--execution-profile",
                    "regional-256-ten-thousand-wat",
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "apac-a" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["kind"], "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan")
        self.assertEqual(plan["execution_profile"], "regional-256-ten-thousand-wat")
        self.assertEqual(plan["task_count"], 10_000)
        self.assertEqual(plan["max_concurrent_total"], 256)
        self.assertEqual(plan["start_spacing_seconds_per_lane"], 30)
        self.assertEqual(
            [item["region"] for item in plan["regions"]],
            ["APAC-A", "APAC-B", "ENAM-A", "ENAM-B", "WNAM-A", "WNAM-B", "WEUR-A", "WEUR-B"],
        )
        self.assertEqual([item["placement_constraint"] for item in plan["regions"]], ["APAC", "APAC", "ENAM", "ENAM", "WNAM", "WNAM", "WEUR", "WEUR"])
        self.assertEqual([item["initial_start_delay_seconds"] for item in plan["regions"]], [0, 10, 0, 10, 0, 10, 0, 10])
        self.assertTrue(all(item["regional_task_count"] == 1250 and item["max_concurrent"] == 32 and item["max_instances"] == 34 for item in plan["regions"]))
        self.assertEqual(config["vars"]["GROWTHSENT_REGION"], "APAC-A")
        self.assertEqual(config["vars"]["GROWTHSENT_REGION_COUNT"], "8")
        self.assertEqual(config["vars"]["GROWTHSENT_START_SPACING_SECONDS"], "30")
        self.assertEqual(config["containers"][0]["constraints"]["regions"], ["APAC"])

    def test_hundred_thousand_campaign_is_ten_exact_non_overlapping_waves(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "campaign"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HUNDRED_THOUSAND_CAMPAIGN_PREPARER),
                    "--source-manifest",
                    str(HUNDRED_THOUSAND_SOURCE_MANIFEST),
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            campaign = json.loads((output / "CAMPAIGN-PLAN.json").read_text(encoding="utf-8"))
            source = json.loads(HUNDRED_THOUSAND_SOURCE_MANIFEST.read_text(encoding="utf-8"))
            wave_inputs = []
            for wave in campaign["waves"]:
                wave_document = json.loads((output / wave["manifest_path"]).read_text(encoding="utf-8"))
                self.assertEqual(wave_document["input_count"], 10_000)
                self.assertEqual(wave_document["manifest_sha256"], wave["manifest_claim_sha256"])
                self.assertEqual(wave_document["inputs_sha256"], wave["inputs_sha256"])
                wave_inputs.extend(wave_document["inputs"])
        self.assertEqual(campaign["kind"], "growthsent-cloudflare-r2-standard1-hundred-thousand-campaign-v1")
        self.assertEqual(campaign["source"]["manifest_claim_sha256"], source["manifest_sha256"])
        self.assertEqual(campaign["wave_count"], 10)
        self.assertEqual(campaign["wave_task_count"], 10_000)
        self.assertEqual(campaign["topology"]["max_concurrent_total"], 256)
        self.assertEqual([wave["wave_index"] for wave in campaign["waves"]], list(range(10)))
        self.assertEqual(wave_inputs, source["inputs"])

    def test_256_slot_ten_thousand_launcher_and_verifier_are_separately_guarded(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "provision-and-start-256-ten-thousand-wat-wsl.sh").read_text(encoding="utf-8")
        compile_gate = (root / "compile-256-ten-thousand-wat-gate-wsl.sh").read_text(encoding="utf-8")
        self.assertIn("REVIEWED_REGION_LANE", worker)
        self.assertIn('"APAC"', worker)
        self.assertIn("--approved-256-ten-thousand-wat-run", provisioner)
        self.assertIn("live_256_ten_thousand_wat_accepted", provisioner)
        self.assertIn("HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json", provisioner)
        self.assertIn("regional-256-ten-thousand-wat", verifier)
        self.assertIn("growthsent-cloudflare-r2-standard1-256-ten-thousand-verification-report", verifier)
        self.assertIn("--approved-256-ten-thousand-wat-run", launcher)
        self.assertIn("--max-concurrent 32", launcher)
        self.assertIn("--start-spacing-seconds 30", launcher)
        self.assertIn("regional standard-1 256-slot 10,000-WAT local plan gate passed", compile_gate)
        self.assertIn("APAC-A", compile_gate)

    def test_128_container_checkpoint_is_exact_and_uses_a_fresh_shard(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "capacity-128"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-standard1-regional-a1b2c3d4",
                    "--source-manifest",
                    str(HIGH_CAPACITY_SOURCE_MANIFEST),
                    "--task-count",
                    "1000",
                    "--max-concurrent",
                    "32",
                    "--execution-profile",
                    "regional-128-capacity-checkpoint",
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "apac" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["execution_profile"], "regional-128-capacity-checkpoint")
        self.assertEqual(plan["source_manifest"]["path"], str(HIGH_CAPACITY_SOURCE_MANIFEST))
        self.assertEqual(plan["task_count"], 1000)
        self.assertEqual(plan["max_concurrent_total"], 128)
        self.assertEqual([item["regional_task_count"] for item in plan["regions"]], [250, 250, 250, 250])
        self.assertTrue(all(item["max_concurrent"] == 32 and item["max_instances"] == 34 for item in plan["regions"]))
        self.assertEqual(config["vars"]["GROWTHSENT_MAX_CONCURRENT"], "32")
        self.assertEqual(config["containers"][0]["max_instances"], 34)

    def test_128_container_checkpoint_has_a_separate_guarded_launcher(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "provision-and-start-128-capacity-checkpoint-wsl.sh").read_text(encoding="utf-8")
        compile_gate = (root / "compile-128-capacity-checkpoint-gate-wsl.sh").read_text(encoding="utf-8")
        self.assertIn("--approved-128-capacity-checkpoint", provisioner)
        self.assertIn("live_128_capacity_checkpoint_accepted", provisioner)
        self.assertIn("HIGH-CAPACITY-CHECKPOINT-CONTEXT.json", provisioner)
        self.assertIn("regional-128-capacity-checkpoint", launcher)
        self.assertIn("--max-concurrent 32", launcher)
        self.assertIn("--task-count 1000", compile_gate)
        self.assertIn("regional standard-1 128-container checkpoint local plan gate passed", compile_gate)
        self.assertIn("regional-128-capacity-checkpoint", verifier)
        self.assertIn("128-capacity-checkpoint-verification-report", verifier)

    def test_128_partial_recovery_rebuilds_only_a_hashed_incomplete_subset(self):
        source_document = json.loads(HIGH_CAPACITY_SOURCE_MANIFEST.read_text(encoding="utf-8"))
        source_manifest_sha256 = hashlib.sha256(HIGH_CAPACITY_SOURCE_MANIFEST.read_bytes()).hexdigest()
        source_run_id = "cc-main-2026-30-test-standard1-regional-a1b2c3d4"
        source_selected_inputs_sha256 = "b" * 64
        source_regions = [
            {"region": region, "region_index": index, "region_count": 4, "regional_task_count": 250, "max_concurrent": 32, "max_instances": 34}
            for index, region in enumerate(("APAC", "ENAM", "WNAM", "WEUR"))
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_context = {
                "kind": "growthsent-cloudflare-r2-standard1-regional-ramp-plan",
                "execution_profile": "regional-128-capacity-checkpoint",
                "run_id": source_run_id,
                "r2_root": f"production/common-crawl/cloudflare-r2-regional-ramps/v1/{source_run_id}/",
                "task_count": 1000,
                "max_concurrent_total": 128,
                "selected_inputs_sha256": source_selected_inputs_sha256,
                "regions": source_regions,
            }
            context_path = root / "HIGH-CAPACITY-CHECKPOINT-CONTEXT.json"
            context_path.write_text(json.dumps(source_context), encoding="utf-8")
            source_plan = dict(source_context)
            source_plan["source_manifest"] = {
                "path": str(HIGH_CAPACITY_SOURCE_MANIFEST),
                "claim_sha256": source_document["manifest_sha256"],
                "file_sha256": source_manifest_sha256,
                "source_shard_id": source_document["shard_id"],
            }
            plan_path = root / "RUN-PLAN.json"
            plan_path.write_text(json.dumps(source_plan), encoding="utf-8")
            recovery_indexes = [1]
            contract_document = {
                "format_version": 1,
                "kind": "growthsent-cloudflare-r2-standard1-128-partial-recovery-contract-v1",
                "crawl": "CC-MAIN-2026-30",
                "source_run_id": source_run_id,
                "source_execution_profile": "regional-128-capacity-checkpoint",
                "source_task_count": 1000,
                "source_max_concurrent_total": 128,
                "source_selected_inputs_sha256": source_selected_inputs_sha256,
                "source_manifest_sha256": source_manifest_sha256,
                "source_manifest_claim_sha256": source_document["manifest_sha256"],
                "source_shard_id": source_document["shard_id"],
                "source_context_sha256": hashlib.sha256(context_path.read_bytes()).hexdigest(),
                "source_plan_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
                "source_workers": {"all_inactive": True, "regions": [{"region": region} for region in ("APAC", "ENAM", "WNAM", "WEUR")]},
                "inventory": {
                    "object_count": 7,
                    "completion_marker_count": 999,
                    "completed_source_count": 999,
                    "incomplete_task_count": 1,
                    "partial_task_prefix_count": 1,
                    "region_incomplete_counts": {"APAC": 0, "ENAM": 1, "WNAM": 0, "WEUR": 0},
                },
                "recovery_task_count": 1,
                "recovery_regions": ["ENAM"],
                "recovery_source_indexes": recovery_indexes,
                "recovery_source_indexes_sha256": hashlib.sha256(ramp.canonical_json(recovery_indexes)).hexdigest(),
            }
            contract_path = root / "RECOVERY-CONTRACT.json"
            contract_path.write_bytes(ramp.canonical_json(contract_document))
            output = root / "partial-recovery"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REGIONAL_BUILDER),
                    "--run-id",
                    "cc-main-2026-30-test-standard1-128rcvr-a1b2c3d4",
                    "--source-manifest",
                    str(HIGH_CAPACITY_SOURCE_MANIFEST),
                    "--task-count",
                    "1",
                    "--max-concurrent",
                    "32",
                    "--recovery-contract",
                    str(contract_path),
                    "--source-run-context",
                    str(context_path),
                    "--output-dir",
                    str(output),
                ],
                cwd=Path(__file__).parents[1],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "enam" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["kind"], "growthsent-cloudflare-r2-standard1-128-partial-recovery-plan")
        self.assertEqual(plan["execution_profile"], "regional-128-partial-recovery")
        self.assertEqual(plan["task_count"], 1)
        self.assertEqual(plan["recovery"]["recovery_source_indexes"], recovery_indexes)
        self.assertEqual(plan["recovery"]["recovery_regions"], ["ENAM"])
        self.assertEqual([item["region"] for item in plan["regions"]], ["ENAM"])
        self.assertEqual(config["vars"]["GROWTHSENT_MAX_CONCURRENT"], "1")
        self.assertEqual(config["containers"][0]["max_instances"], 3)

    def test_128_partial_recovery_launcher_inventory_and_verifier_are_bound(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "recover-128-partial-wsl.sh").read_text(encoding="utf-8")
        inventory = (root / "prepare-128-partial-recovery-wsl.mjs").read_text(encoding="utf-8")
        self.assertIn("--approved-128-partial-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-128-partial-recovery-plan", provisioner)
        self.assertIn("HIGH-CAPACITY-PARTIAL-RECOVERY-CONTEXT.json", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-128-partial-recovery-verification-report", verifier)
        self.assertIn("GROWTHSENT_HIGH_CAPACITY_RECOVERY_SOURCE_CONTEXT", launcher)
        self.assertIn("--approved-128-partial-recovery", launcher)
        self.assertIn("read-only inventory", launcher)
        self.assertIn("object-read-only", inventory)
        self.assertIn("sourceWorkersAreInactive", inventory)
        self.assertIn('task?.status?.state === "stopped"', inventory)
        self.assertIn('task?.status?.runner?.state === "succeeded"', inventory)
        self.assertIn('task?.status?.runner?.exit_code === 0', inventory)
        self.assertIn("TASK-COMPLETED.json", inventory)
        self.assertIn("recovery_source_indexes_sha256", inventory)

    def test_256_partial_recovery_rebuilds_only_an_audited_missing_source(self):
        source_document = json.loads(TEN_THOUSAND_SOURCE_MANIFEST.read_text(encoding="utf-8"))
        source_manifest_sha256 = hashlib.sha256(TEN_THOUSAND_SOURCE_MANIFEST.read_bytes()).hexdigest()
        source_run_id = "cc-main-2026-30-test-s1-256-a1b2c3d4"
        source_selected_inputs_sha256 = "c" * 64
        lanes = [
            ("APAC-A", "APAC", 0), ("APAC-B", "APAC", 10),
            ("ENAM-A", "ENAM", 0), ("ENAM-B", "ENAM", 10),
            ("WNAM-A", "WNAM", 0), ("WNAM-B", "WNAM", 10),
            ("WEUR-A", "WEUR", 0), ("WEUR-B", "WEUR", 10),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_context = {
                "kind": "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan",
                "execution_profile": "regional-256-ten-thousand-wat",
                "run_id": source_run_id,
                "r2_root": f"production/common-crawl/cloudflare-r2-regional-ramps/v1/{source_run_id}/",
                "task_count": 10_000,
                "max_concurrent_total": 256,
                "selected_inputs_sha256": source_selected_inputs_sha256,
                "regions": [
                    {"region": region, "region_index": index, "region_count": 8, "placement_constraint": placement, "initial_start_delay_seconds": delay, "regional_task_count": 1250, "max_concurrent": 32, "max_instances": 34}
                    for index, (region, placement, delay) in enumerate(lanes)
                ],
            }
            context_path = root / "HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json"
            context_path.write_text(json.dumps(source_context), encoding="utf-8")
            source_plan = dict(source_context)
            source_plan["source_manifest"] = {"path": str(TEN_THOUSAND_SOURCE_MANIFEST), "claim_sha256": source_document["manifest_sha256"], "file_sha256": source_manifest_sha256, "source_shard_id": source_document.get("shard_id")}
            plan_path = root / "RUN-PLAN.json"
            plan_path.write_text(json.dumps(source_plan), encoding="utf-8")
            recovery_indexes = [4]
            contract_document = {
                "format_version": 1,
                "kind": "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-contract-v1",
                "crawl": "CC-MAIN-2026-30",
                "source_run_id": source_run_id,
                "source_execution_profile": "regional-256-ten-thousand-wat",
                "source_task_count": 10_000,
                "source_max_concurrent_total": 256,
                "source_selected_inputs_sha256": source_selected_inputs_sha256,
                "source_manifest_sha256": source_manifest_sha256,
                "source_manifest_claim_sha256": source_document["manifest_sha256"],
                "source_shard_id": source_document.get("shard_id"),
                "source_context_sha256": hashlib.sha256(context_path.read_bytes()).hexdigest(),
                "source_plan_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
                "source_workers": {"all_inactive": True, "regions": [{"region": region} for region, _, _ in lanes]},
                "inventory": {
                    "object_count": 7,
                    "completion_marker_count": 9999,
                    "completed_source_count": 9999,
                    "incomplete_task_count": 1,
                    "partial_task_prefix_count": 1,
                    "region_incomplete_counts": {region: int(region == "WNAM-A") for region, _, _ in lanes},
                },
                "recovery_task_count": 1,
                "recovery_regions": ["WNAM-A"],
                "recovery_source_indexes": recovery_indexes,
                "recovery_source_indexes_sha256": hashlib.sha256(ramp.canonical_json(recovery_indexes)).hexdigest(),
            }
            contract_path = root / "RECOVERY-CONTRACT.json"
            contract_path.write_bytes(ramp.canonical_json(contract_document))
            output = root / "partial-recovery"
            result = subprocess.run(
                [
                    sys.executable, str(REGIONAL_BUILDER), "--run-id", "cc-main-2026-30-test-s1-256rcvr-a1b2c3d4",
                    "--source-manifest", str(TEN_THOUSAND_SOURCE_MANIFEST), "--task-count", "1", "--max-concurrent", "32", "--start-spacing-seconds", "30",
                    "--execution-profile", "regional-256-ten-thousand-wat", "--recovery-contract", str(contract_path), "--source-run-context", str(context_path), "--output-dir", str(output),
                ],
                cwd=Path(__file__).parents[1], capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
            config = json.loads((output / "bundles" / "wnam-a" / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(plan["kind"], "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-plan")
        self.assertEqual(plan["execution_profile"], "regional-256-ten-thousand-partial-recovery")
        self.assertEqual(plan["recovery"]["recovery_source_indexes"], recovery_indexes)
        self.assertEqual(plan["recovery"]["recovery_regions"], ["WNAM-A"])
        self.assertEqual(config["vars"]["GROWTHSENT_REGION"], "WNAM-A")
        self.assertEqual(config["vars"]["GROWTHSENT_MAX_CONCURRENT"], "1")

    def test_256_partial_recovery_launcher_inventory_and_verifier_are_bound(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "recover-256-partial-wsl.sh").read_text(encoding="utf-8")
        inventory = (root / "prepare-128-partial-recovery-wsl.mjs").read_text(encoding="utf-8")
        self.assertIn("--approved-256-partial-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-plan", provisioner)
        self.assertIn("HIGH-CAPACITY-TEN-THOUSAND-PARTIAL-RECOVERY-CONTEXT.json", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-verification-report", verifier)
        self.assertIn("GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_RECOVERY_SOURCE_CONTEXT", launcher)
        self.assertIn("--approved-256-partial-recovery", launcher)
        self.assertIn("object-read-only", inventory)
        self.assertIn("HIGH_CAPACITY_TEN_THOUSAND_PROFILE", inventory)
        self.assertIn("recovery_source_indexes_sha256", inventory)

    def test_256_failed_lane_recovery_rebuilds_only_terminal_lane_partitions(self):
        source_document = json.loads(TEN_THOUSAND_SOURCE_MANIFEST.read_text(encoding="utf-8"))
        source_manifest_sha256 = hashlib.sha256(TEN_THOUSAND_SOURCE_MANIFEST.read_bytes()).hexdigest()
        source_run_id = "cc-main-2026-30-test-s1-256-e5f6a7b8"
        source_selected_inputs_sha256 = "d" * 64
        lanes = [
            ("APAC-A", "APAC", 0), ("APAC-B", "APAC", 10),
            ("ENAM-A", "ENAM", 0), ("ENAM-B", "ENAM", 10),
            ("WNAM-A", "WNAM", 0), ("WNAM-B", "WNAM", 10),
            ("WEUR-A", "WEUR", 0), ("WEUR-B", "WEUR", 10),
        ]
        recovery_regions = ["ENAM-B", "WNAM-A"]
        recovery_indexes = [3, 4]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_context = {
                "kind": "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan",
                "execution_profile": "regional-256-ten-thousand-wat",
                "run_id": source_run_id,
                "r2_root": f"production/common-crawl/cloudflare-r2-regional-ramps/v1/{source_run_id}/",
                "task_count": 10_000,
                "max_concurrent_total": 256,
                "selected_inputs_sha256": source_selected_inputs_sha256,
                "regions": [
                    {"region": region, "region_index": index, "region_count": 8, "placement_constraint": placement, "initial_start_delay_seconds": delay, "regional_task_count": 1250, "max_concurrent": 32, "max_instances": 34}
                    for index, (region, placement, delay) in enumerate(lanes)
                ],
            }
            context_path = root / "HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json"
            context_path.write_text(json.dumps(source_context), encoding="utf-8")
            source_plan = dict(source_context)
            source_plan["source_manifest"] = {"path": str(TEN_THOUSAND_SOURCE_MANIFEST), "claim_sha256": source_document["manifest_sha256"], "file_sha256": source_manifest_sha256, "source_shard_id": source_document.get("shard_id")}
            plan_path = root / "RUN-PLAN.json"
            plan_path.write_text(json.dumps(source_plan), encoding="utf-8")
            source_states = [
                {"region": region, "safely_inactive": region in recovery_regions, "launch_state": "task_failed" if region in recovery_regions else "launching"}
                for region, _, _ in lanes
            ]
            contract_document = {
                "format_version": 1,
                "kind": "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-contract-v1",
                "crawl": "CC-MAIN-2026-30",
                "source_run_id": source_run_id,
                "source_execution_profile": "regional-256-ten-thousand-wat",
                "source_task_count": 10_000,
                "source_max_concurrent_total": 256,
                "source_selected_inputs_sha256": source_selected_inputs_sha256,
                "source_manifest_sha256": source_manifest_sha256,
                "source_manifest_claim_sha256": source_document["manifest_sha256"],
                "source_shard_id": source_document.get("shard_id"),
                "source_context_sha256": hashlib.sha256(context_path.read_bytes()).hexdigest(),
                "source_plan_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
                "source_workers": {"all_inactive": False, "recovery_lanes_inactive": True, "recovery_regions": recovery_regions, "regions": source_states},
                "inventory": {
                    "scope": "terminal_source_lanes_only",
                    "object_count": 14,
                    "completion_marker_count": 2498,
                    "completed_source_count": 2498,
                    "incomplete_task_count": 2,
                    "partial_task_prefix_count": 2,
                    "scoped_task_count": 2500,
                    "unscoped_task_count": 7500,
                    "region_incomplete_counts": {region: int(region in recovery_regions) for region, _, _ in lanes},
                },
                "recovery_task_count": 2,
                "recovery_regions": recovery_regions,
                "recovery_source_indexes": recovery_indexes,
                "recovery_source_indexes_sha256": hashlib.sha256(ramp.canonical_json(recovery_indexes)).hexdigest(),
            }
            contract_path = root / "FAILED-LANE-RECOVERY-CONTRACT.json"
            contract_path.write_bytes(ramp.canonical_json(contract_document))
            output = root / "failed-lane-recovery"
            result = subprocess.run(
                [
                    sys.executable, str(REGIONAL_BUILDER), "--run-id", "cc-main-2026-30-test-s1-256lane-e5f6a7b8",
                    "--source-manifest", str(TEN_THOUSAND_SOURCE_MANIFEST), "--task-count", "2", "--max-concurrent", "32", "--start-spacing-seconds", "30",
                    "--execution-profile", "regional-256-ten-thousand-wat", "--recovery-contract", str(contract_path), "--source-run-context", str(context_path), "--output-dir", str(output),
                ],
                cwd=Path(__file__).parents[1], capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads((output / "RUN-PLAN.json").read_text(encoding="utf-8"))
        self.assertEqual(plan["kind"], "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-plan")
        self.assertEqual(plan["execution_profile"], "regional-256-ten-thousand-failed-lane-recovery")
        self.assertEqual(plan["recovery"]["recovery_source_indexes"], recovery_indexes)
        self.assertEqual(plan["recovery"]["recovery_regions"], recovery_regions)
        self.assertEqual([item["region"] for item in plan["regions"]], recovery_regions)

    def test_256_failed_lane_recovery_launcher_inventory_and_verifier_are_bound(self):
        root = REGIONAL_WORKER_SOURCE.parents[1]
        provisioner = (root / "provision-and-start-wsl.mjs").read_text(encoding="utf-8")
        verifier = REGIONAL_VERIFIER_SOURCE.read_text(encoding="utf-8")
        launcher = (root / "recover-256-failed-lanes-wsl.sh").read_text(encoding="utf-8")
        inventory = (root / "prepare-128-partial-recovery-wsl.mjs").read_text(encoding="utf-8")
        self.assertIn("--approved-256-failed-lane-recovery", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-plan", provisioner)
        self.assertIn("FAILED-LANE-RECOVERY-CONTEXT.json", provisioner)
        self.assertIn("growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-verification-report", verifier)
        self.assertIn("--approved-256-failed-lane-recovery", launcher)
        self.assertIn("--failed-lanes-only", launcher)
        self.assertIn("GROWTHSENT_FAILED_LANE_RECOVERY_LANES", launcher)
        self.assertIn("RECOVERABLE_TERMINAL_STATES", inventory)
        self.assertIn("terminal_source_lanes_only", inventory)
        self.assertIn("--failed-lanes-only=", inventory)
        self.assertIn("requested_recovery_regions", inventory)

    def test_coordinator_reconciles_ambiguous_starts_and_retries_status_reads(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        # A lost RPC response must not turn an already accepted fixed-slot
        # request into a permanent lane failure. The slot returns an
        # idempotent accepted response after observing its runner state.
        self.assertIn("UNCERTAIN_START_RECONCILIATION_SECONDS = 60", worker)
        self.assertIn('runnerMatches(current, taskIndex, ["running", "succeeded"])', worker)
        self.assertIn('reconciled: true', worker)
        self.assertIn("StartOutcomeUncertain", worker)
        self.assertIn("standard1_regional_task_start_reconciled", worker)
        self.assertNotIn('message: "task was already accepted for start"', worker)
        # A transient status RPC failure must preserve every unresolved task
        # and schedule a reconciliation alarm instead of terminating a lane.
        self.assertIn('kind: "reconcile"', worker)
        self.assertIn("currentInFlight.entries()", worker)
        self.assertIn("standard1_regional_task_status_retry_scheduled", worker)
        self.assertIn("const unresolved = [...remaining, ...currentInFlight.slice(position)]", worker)
        self.assertIn("standard1_regional_task_start_rpc_retry_scheduled", worker)
        self.assertIn("const activeRetry = record.retry", worker)

    def test_partial_prefix_failure_is_quarantined_without_halting_its_lane(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        runner = (REGIONAL_WORKER_SOURCE.parents[1] / "regional_ramp_entry.py").read_text(encoding="utf-8")
        task_module = (TOOLS / "common_crawl_cloudflare_r2_standard1_regional_ramp.py").read_text(encoding="utf-8")
        self.assertIn("RecoverablePartialTaskPrefixError", task_module)
        self.assertIn("partial immutable task prefix requires isolated recovery", task_module)
        self.assertIn("isRecoverablePartialPrefixFailure", worker)
        self.assertIn("recordRecoverableTaskFailure", worker)
        self.assertIn("completed_with_recoverable_failures", worker)
        self.assertIn("standard1_regional_task_quarantined_for_recovery", worker)
        self.assertIn("recoverable_failed_count", worker)
        self.assertIn('"error_type": type(error).__name__', runner)

    def test_transient_task_failures_retry_then_quarantine_without_halting_a_lane(self):
        worker = REGIONAL_WORKER_SOURCE.read_text(encoding="utf-8")
        # A task-level Container, network, or source fault is distinct from a
        # programming/configuration failure: retry it within a tight bounded
        # budget, then preserve forward progress and leave an exact immutable
        # completion-marker inventory for a later recovery.
        self.assertIn("MAX_RUNTIME_TASK_ATTEMPTS = 3", worker)
        self.assertIn("isRetryableTaskFailure", worker)
        self.assertIn('message.includes("network connection lost")', worker)
        self.assertIn('message.includes("container connectivity was lost")', worker)
        self.assertIn('message.includes("common crawl https read failed")', worker)
        self.assertIn("MAX_RUNTIME_TASK_ATTEMPTS", worker)
        self.assertIn("task was quarantined after", worker)
        self.assertIn("recordRecoverableTaskFailure(record, completedCount, unresolved, task", worker)

    def test_runner_server_executes_one_task_and_reuses_its_slot(self):
        spec = importlib.util.spec_from_file_location("regional_ramp_server_test", REGIONAL_RUNNER_SERVER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            os.environ,
            {
                "GROWTHSENT_RAMP_ID": "cc-main-2026-30-test-standard1-regional-a1b2c3d4",
                "GROWTHSENT_REGION": "APAC",
                "GROWTHSENT_REGION_INDEX": "0",
                "GROWTHSENT_REGION_COUNT": "4",
                "GROWTHSENT_TASK_COUNT": "8",
                "GROWTHSENT_HARD_TIMEOUT_SECONDS": "6600",
                "GROWTHSENT_R2_ACCOUNT_ID": "account",
                "GROWTHSENT_R2_BUCKET": "bucket",
                "GROWTHSENT_R2_ACCESS_KEY_ID": "key",
                "GROWTHSENT_R2_SECRET_ACCESS_KEY": "secret",
                "GROWTHSENT_R2_SESSION_TOKEN": "session",
                "GROWTHSENT_RELEASE_SHA256": "a" * 64,
                "GROWTHSENT_SELECTED_INPUTS_SHA256": "b" * 64,
                "GROWTHSENT_CONTAINER_INSTANCE_TYPE": "standard-1",
            },
            clear=False,
        ):
            root = Path(temporary)
            entrypoint = root / "entry.py"
            entrypoint.write_text("raise SystemExit(0)\n", encoding="utf-8")
            module.ENTRYPOINT = entrypoint
            module.WORK_DIRECTORY = root / "work"
            runner = module.TaskRunner()
            class SuccessfulProcess:
                def wait(self):
                    return 0

                def poll(self):
                    return 0

                def terminate(self):
                    return None

            with mock.patch.object(module.subprocess, "Popen", return_value=SuccessfulProcess()):
                status, result = runner.start(0)
                self.assertEqual(status, 202)
                self.assertTrue(result["accepted"])
                for _ in range(100):
                    if runner.status()["state"] != "running":
                        break
                    time.sleep(0.02)
                self.assertEqual(runner.status()["state"], "succeeded")
                self.assertEqual(runner.start(0)[0], 200)
                self.assertEqual(runner.start(1)[0], 400)

    def test_regional_builder_has_no_dependency_on_retired_experiment_directories(self):
        source = REGIONAL_BUILDER.read_text(encoding="utf-8")
        self.assertNotIn("TEN_WAY", source)
        self.assertNotIn("BENCHMARK =", source)


if __name__ == "__main__":
    unittest.main()
