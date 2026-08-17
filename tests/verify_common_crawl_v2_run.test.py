import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

MODULE_PATH = TOOLS / "verify_common_crawl_v2_run.py"
SPEC = importlib.util.spec_from_file_location("verify_common_crawl_v2_run", MODULE_PATH)
verify = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = verify
SPEC.loader.exec_module(verify)

MANIFEST_MODULE_PATH = TOOLS / "common_crawl_v2_manifest.py"
MANIFEST_SPEC = importlib.util.spec_from_file_location("common_crawl_v2_manifest", MANIFEST_MODULE_PATH)
manifest_tools = importlib.util.module_from_spec(MANIFEST_SPEC)
assert MANIFEST_SPEC and MANIFEST_SPEC.loader
sys.modules[MANIFEST_SPEC.name] = manifest_tools
MANIFEST_SPEC.loader.exec_module(manifest_tools)


def source(index: int) -> str:
    return (
        "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
        f"CC-MAIN-20260710070534-20260710100534-{index:05d}.warc.wat.gz"
    )


def finalize_manifest(document: dict) -> dict:
    document["manifest_sha256"] = verify.manifest_sha256(document)
    return document


def base_manifest(count: int, *, run_id: str = "cc-main-2026-30-first-100000") -> dict:
    inputs = [source(index) for index in range(count)]
    return finalize_manifest({
        "format_version": 2,
        "kind": verify.BASE_MANIFEST_KIND,
        "run_id": run_id,
        "crawl": "CC-MAIN-2026-30",
        "input_count": count,
        "inputs_sha256": verify.inputs_sha256(inputs),
        "inputs": inputs,
    })


def shard_manifests(base: dict, shard_count: int) -> list[dict]:
    manifests = []
    for shard_id in range(shard_count):
        start, end = verify.shard_bounds(base["input_count"], shard_count, shard_id)
        inputs = base["inputs"][start:end]
        manifests.append(finalize_manifest({
            "format_version": 2,
            "kind": verify.SHARD_MANIFEST_KIND,
            "run_id": base["run_id"],
            "crawl": base["crawl"],
            "shard_id": shard_id,
            "shard_count": shard_count,
            "base_manifest_sha256": base["manifest_sha256"],
            "base_inputs_sha256": base["inputs_sha256"],
            "input_count": len(inputs),
            "inputs_sha256": verify.inputs_sha256(inputs),
            "first_input": inputs[0],
            "last_input": inputs[-1],
            "inputs": inputs,
        }))
    return manifests


def shard_plan(base: dict, shards: list[dict]) -> dict:
    plan = {
        "format_version": 2,
        "kind": verify.SHARD_PLAN_KIND,
        "run_id": base["run_id"],
        "crawl": base["crawl"],
        "shard_count": len(shards),
        "base_manifest_sha256": base["manifest_sha256"],
        "base_inputs_sha256": base["inputs_sha256"],
        "shards": [
            {
                key: shard[key]
                for key in ("shard_id", "input_count", "first_input", "last_input", "inputs_sha256")
            }
            | {"shard_manifest_sha256": shard["manifest_sha256"]}
            for shard in shards
        ],
    }
    plan["plan_sha256"] = verify.shard_plan_sha256(plan)
    return plan


class VerifyCommonCrawlV2RunTests(unittest.TestCase):
    def test_valid_shards_are_an_exact_disjoint_partition(self):
        base = base_manifest(11)
        shards = shard_manifests(base, 3)

        report = verify.verify_run_manifests(
            base,
            [shards[2], shards[0], shards[1]],
            expected_input_count=11,
            shard_plan=shard_plan(base, shards),
        )

        self.assertTrue(report["valid"])
        self.assertEqual(report["base_input_count"], 11)
        self.assertEqual(report["shard_count"], 3)
        self.assertEqual([shard["input_count"] for shard in report["shards"]], [4, 4, 3])
        self.assertEqual([shard["shard_id"] for shard in report["shards"]], [0, 1, 2])
        self.assertEqual(report["shard_plan"]["shard_count"], 3)

    def test_accepts_the_sibling_manifest_tool_artifacts(self):
        base = manifest_tools.build_base_manifest(
            run_id="cc-main-2026-30-first-100000",
            crawl="CC-MAIN-2026-30",
            inputs=[source(index) for index in range(7)],
            expected_input_count=7,
        )
        shards = manifest_tools.split_shards(base, 3, expected_input_count=7)
        plan = manifest_tools.build_shard_plan(base, shards, expected_input_count=7)

        report = verify.verify_run_manifests(
            base,
            shards,
            expected_input_count=7,
            shard_plan=plan,
        )

        self.assertTrue(report["valid"])
        self.assertEqual(report["shard_plan"]["plan_sha256"], plan["plan_sha256"])

    def test_rejects_duplicate_shard_ownership(self):
        base = base_manifest(6)
        shards = shard_manifests(base, 2)

        with self.assertRaisesRegex(verify.ManifestVerificationError, "duplicate shard_id"):
            verify.verify_run_manifests(base, [shards[0], shards[0]])

    def test_rejects_overlap_or_repartitioned_shard_inputs(self):
        base = base_manifest(8)
        shards = shard_manifests(base, 2)
        # This presents the same input in two shard documents and changes the
        # supposed owner slice.  The verifier must reject before launch.
        shards[1]["inputs"] = list(shards[0]["inputs"])
        shards[1]["first_input"] = shards[1]["inputs"][0]
        shards[1]["last_input"] = shards[1]["inputs"][-1]
        shards[1]["inputs_sha256"] = verify.inputs_sha256(shards[1]["inputs"])
        finalize_manifest(shards[1])

        with self.assertRaisesRegex(verify.ManifestVerificationError, "deterministic contiguous"):
            verify.verify_run_manifests(base, shards)

    def test_rejects_missing_shard_and_wrong_union(self):
        base = base_manifest(8)
        shards = shard_manifests(base, 4)

        with self.assertRaisesRegex(verify.ManifestVerificationError, "received 3 shard manifests"):
            verify.verify_run_manifests(base, shards[:3])

    def test_rejects_base_and_shard_manifest_hash_tampering(self):
        base = base_manifest(4)
        shards = shard_manifests(base, 2)
        base["crawl"] = "CC-MAIN-2026-99"

        with self.assertRaisesRegex(verify.ManifestVerificationError, "base manifest.manifest_sha256"):
            verify.verify_run_manifests(base, shards)

        base = base_manifest(4)
        shards = shard_manifests(base, 2)
        shards[0]["first_input"] = "tampered"

        with self.assertRaisesRegex(verify.ManifestVerificationError, "shard manifest.manifest_sha256"):
            verify.verify_run_manifests(base, shards)

    def test_recovery_cannot_repartition_a_shard_or_change_its_base_reference(self):
        base = base_manifest(11)
        shards = shard_manifests(base, 2)
        # A resumed shard cannot change the fleet width: its same shard ID
        # would own a different deterministic slice under three shards.
        shards[0]["shard_count"] = 3
        finalize_manifest(shards[0])
        with self.assertRaisesRegex(verify.ManifestVerificationError, "deterministic contiguous"):
            verify.verify_run_manifests(base, shards)

        base = base_manifest(6)
        shards = shard_manifests(base, 2)
        shards[0]["base_manifest_sha256"] = "0" * 64
        finalize_manifest(shards[0])
        with self.assertRaisesRegex(verify.ManifestVerificationError, "base_manifest_sha256"):
            verify.verify_run_manifests(base, shards)

    def test_rejects_tampered_or_mismatched_shard_plan(self):
        base = base_manifest(6)
        shards = shard_manifests(base, 2)
        plan = shard_plan(base, shards)
        plan["shards"][0]["input_count"] = 999
        plan["plan_sha256"] = verify.shard_plan_sha256(plan)
        with self.assertRaisesRegex(verify.ManifestVerificationError, "does not match its shard manifest"):
            verify.verify_run_manifests(base, shards, shard_plan=plan)

        plan = shard_plan(base, shards)
        plan["crawl"] = "CC-MAIN-2026-99"
        with self.assertRaisesRegex(verify.ManifestVerificationError, "shard plan.crawl"):
            verify.verify_run_manifests(base, shards, shard_plan=plan)

    def test_rejects_base_path_duplicates_and_part_suffix_collisions(self):
        base = base_manifest(4)
        base["inputs"][3] = base["inputs"][2]
        base["inputs_sha256"] = verify.inputs_sha256(base["inputs"])
        finalize_manifest(base)

        with self.assertRaisesRegex(verify.ManifestVerificationError, "duplicate input paths"):
            verify.verify_run_manifests(base, shard_manifests(base, 2))

        base = base_manifest(4)
        with patch.object(verify, "input_hash_suffix", return_value="same-suffix"):
            with self.assertRaisesRegex(verify.ManifestVerificationError, "duplicate deterministic part hash suffixes"):
                verify.verify_run_manifests(base, shard_manifests(base, 2))

    def test_production_mode_requires_exactly_one_hundred_thousand_inputs(self):
        base = base_manifest(4)
        shards = shard_manifests(base, 2)

        with self.assertRaisesRegex(verify.ManifestVerificationError, "must equal 100000"):
            verify.verify_run_manifests(base, shards, expected_input_count=verify.PRODUCTION_INPUT_COUNT)

    def test_production_sized_manifest_verifies_without_external_access(self):
        base = base_manifest(verify.PRODUCTION_INPUT_COUNT)
        shards = shard_manifests(base, 100)

        report = verify.verify_run_manifests(
            base,
            shards,
            expected_input_count=verify.PRODUCTION_INPUT_COUNT,
        )

        self.assertTrue(report["valid"])
        self.assertEqual(report["base_input_count"], verify.PRODUCTION_INPUT_COUNT)
        self.assertEqual(sum(shard["input_count"] for shard in report["shards"]), verify.PRODUCTION_INPUT_COUNT)
        self.assertTrue(all(shard["input_count"] == 1_000 for shard in report["shards"]))

    def test_rejects_a_shard_above_the_hard_safety_ceiling(self):
        base = base_manifest(1_001)
        shards = shard_manifests(base, 1)

        with self.assertRaisesRegex(verify.ManifestVerificationError, "safety ceiling"):
            verify.verify_run_manifests(base, shards, expected_input_count=1_001)

    def test_cli_reads_only_local_files_and_emits_a_safe_report(self):
        base = base_manifest(5)
        shards = shard_manifests(base, 2)
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            base_path = root / "base.json"
            shard_dir = root / "shards"
            shard_dir.mkdir()
            plan_path = shard_dir / "shard-plan.json"
            base_path.write_text(json.dumps(base), encoding="utf-8")
            plan_path.write_text(json.dumps(shard_plan(base, shards)), encoding="utf-8")
            for shard in shards:
                (shard_dir / f"shard-{shard['shard_id']:05d}-of-{len(shards):05d}.json").write_text(
                    json.dumps(shard), encoding="utf-8"
                )

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = verify.main([
                    "--base-manifest", str(base_path),
                    "--shard-dir", str(shard_dir),
                    "--shard-plan", str(plan_path),
                    "--expected-input-count", "5",
                ])

        self.assertEqual(exit_code, 0)
        report = json.loads(stdout.getvalue())
        self.assertTrue(report["valid"])
        self.assertEqual(report["shard_count"], 2)
        self.assertEqual(report["shard_plan"]["shard_count"], 2)


if __name__ == "__main__":
    unittest.main()
