import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

MODULE_PATH = TOOLS / "common_crawl_v2_manifest.py"
SPEC = importlib.util.spec_from_file_location("common_crawl_v2_manifest", MODULE_PATH)
v2 = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = v2
SPEC.loader.exec_module(v2)


def synthetic_paths(count: int) -> list[str]:
    """Local fixtures only: these are structurally valid but never fetched."""

    return [
        "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
        f"CC-MAIN-20260710070534-20260710100534-{index:05d}.warc.wat.gz"
        for index in range(count)
    ]


class CommonCrawlV2ManifestTests(unittest.TestCase):
    def base(self, count: int = 12) -> dict:
        return v2.build_base_manifest(
            run_id="cc-main-2026-30-first-100000",
            crawl="CC-MAIN-2026-30",
            inputs=synthetic_paths(count),
            expected_input_count=count,
        )

    def test_base_manifest_records_and_validates_all_immutable_identity_fields(self):
        base = self.base(5)
        self.assertEqual(base["format_version"], 2)
        self.assertEqual(base["kind"], v2.BASE_MANIFEST_KIND)
        self.assertEqual(base["input_count"], 5)
        self.assertEqual(base["inputs_sha256"], v2.inputs_sha256(base["inputs"]))
        self.assertEqual(base["manifest_sha256"], v2.manifest_sha256(base))
        self.assertEqual(
            v2.validate_base_manifest(base, expected_input_count=5)["manifest_sha256"],
            base["manifest_sha256"],
        )

    def test_production_base_manifest_rejects_any_count_other_than_100000(self):
        with self.assertRaisesRegex(v2.ManifestValidationError, "exactly 100,000"):
            v2.build_base_manifest(
                run_id="cc-main-2026-30-first-100000",
                crawl="CC-MAIN-2026-30",
                inputs=synthetic_paths(3),
            )

    def test_split_is_contiguous_deterministic_and_exactly_covers_the_base(self):
        base = self.base(11)
        shards = v2.split_shards(base, 3, expected_input_count=11)
        self.assertEqual([shard["input_count"] for shard in shards], [4, 4, 3])
        self.assertEqual([shard["shard_id"] for shard in shards], [0, 1, 2])
        self.assertEqual(shards[0]["inputs"], base["inputs"][:4])
        self.assertEqual(shards[1]["inputs"], base["inputs"][4:8])
        self.assertEqual(shards[2]["inputs"], base["inputs"][8:])
        verified = v2.verify_shard_set(base, list(reversed(shards)), expected_input_count=11)
        self.assertEqual([shard["shard_id"] for shard in verified], [0, 1, 2])
        self.assertEqual(
            [path for shard in verified for path in shard["inputs"]],
            base["inputs"],
        )

    def test_shard_records_base_and_shard_hashes_and_global_plan_binds_them(self):
        base = self.base(12)
        shards = v2.split_shards(base, 3, expected_input_count=12)
        plan = v2.build_shard_plan(base, shards, expected_input_count=12)
        self.assertEqual(plan["kind"], v2.SHARD_PLAN_KIND)
        self.assertEqual(plan["base_manifest_sha256"], base["manifest_sha256"])
        self.assertEqual(plan["base_inputs_sha256"], base["inputs_sha256"])
        self.assertEqual(plan["plan_sha256"], v2.shard_plan_sha256(plan))
        self.assertEqual(
            plan["shards"][1]["shard_manifest_sha256"],
            shards[1]["manifest_sha256"],
        )
        self.assertEqual(
            v2.validate_shard_plan(
                plan, base, shards, expected_input_count=12
            )["plan_sha256"],
            plan["plan_sha256"],
        )

        tampered_plan = copy.deepcopy(plan)
        tampered_plan["shards"][0]["inputs_sha256"] = "0" * 64
        tampered_plan["plan_sha256"] = v2.shard_plan_sha256(tampered_plan)
        with self.assertRaisesRegex(v2.ManifestValidationError, "deterministic base-manifest slice"):
            v2.validate_shard_plan(
                tampered_plan,
                base,
                expected_input_count=12,
            )

    def test_overlap_or_repartitioned_shard_is_rejected_even_with_recomputed_hashes(self):
        base = self.base(12)
        shards = v2.split_shards(base, 3, expected_input_count=12)
        tampered = copy.deepcopy(shards)
        tampered[1]["inputs"] = list(tampered[0]["inputs"])
        tampered[1]["first_input"] = tampered[1]["inputs"][0]
        tampered[1]["last_input"] = tampered[1]["inputs"][-1]
        tampered[1]["inputs_sha256"] = v2.inputs_sha256(tampered[1]["inputs"])
        tampered[1]["manifest_sha256"] = v2.manifest_sha256(tampered[1])
        with self.assertRaisesRegex(v2.ManifestValidationError, "contiguous base-manifest slice"):
            v2.verify_shard_set(base, tampered, expected_input_count=12)

    def test_duplicate_shard_id_and_missing_shard_are_rejected(self):
        base = self.base(12)
        shards = v2.split_shards(base, 3, expected_input_count=12)
        duplicate_id = copy.deepcopy(shards)
        duplicate_id[2] = copy.deepcopy(duplicate_id[1])
        with self.assertRaisesRegex(v2.ManifestValidationError, "duplicate shard_id|zero-based shard"):
            v2.verify_shard_set(base, duplicate_id, expected_input_count=12)

    def test_hard_per_shard_ceiling_prevents_a_large_single_worker_shard(self):
        base = self.base(1001)
        with self.assertRaisesRegex(v2.ManifestValidationError, "hard per-shard ceiling"):
            v2.split_shards(base, 1, expected_input_count=1001)
        shards = v2.split_shards(base, 2, expected_input_count=1001)
        self.assertEqual([shard["input_count"] for shard in shards], [501, 500])

    def test_production_sized_base_has_one_hundred_disjoint_one_thousand_input_shards(self):
        # This is a local synthetic topology proof.  It never resolves or
        # downloads Common Crawl paths, but exercises the real production
        # 100,000-input and 1,000-input-per-shard safety ceilings together.
        base = v2.build_base_manifest(
            run_id="cc-main-2026-30-first-100000",
            crawl="CC-MAIN-2026-30",
            inputs=synthetic_paths(v2.PRODUCTION_INPUT_COUNT),
        )
        shards = v2.split_shards(base, 100)
        plan = v2.build_shard_plan(base, shards)
        verified = v2.verify_shard_set(base, shards)

        self.assertEqual(base["input_count"], 100_000)
        self.assertEqual(len(shards), 100)
        self.assertTrue(all(shard["input_count"] == 1_000 for shard in shards))
        self.assertEqual(sum(shard["input_count"] for shard in verified), 100_000)
        self.assertEqual(len({path for shard in shards for path in shard["inputs"]}), 100_000)
        self.assertEqual(plan["shard_count"], 100)

    def test_tampered_base_or_shard_hash_is_rejected(self):
        base = self.base(8)
        changed_base = copy.deepcopy(base)
        changed_base["inputs"][0] = synthetic_paths(9)[8]
        with self.assertRaisesRegex(v2.ManifestValidationError, "inputs_sha256"):
            v2.validate_base_manifest(changed_base, expected_input_count=8)

        shard = v2.split_shards(base, 2, expected_input_count=8)[0]
        changed_shard = copy.deepcopy(shard)
        changed_shard["manifest_sha256"] = "0" * 64
        with self.assertRaisesRegex(v2.ManifestValidationError, "manifest_sha256"):
            v2.validate_shard_manifest(changed_shard, base, expected_input_count=8)

    def test_duplicate_inputs_and_deterministic_output_suffix_collisions_are_rejected(self):
        paths = synthetic_paths(4)
        paths[-1] = paths[0]
        with self.assertRaisesRegex(v2.ManifestValidationError, "duplicate input path"):
            v2.build_base_manifest(
                run_id="cc-main-2026-30-first-100000",
                crawl="CC-MAIN-2026-30",
                inputs=paths,
                expected_input_count=4,
            )

        with patch.object(v2, "input_key", return_value="f" * 16):
            with self.assertRaisesRegex(v2.ManifestValidationError, "output suffix collision"):
                v2.build_base_manifest(
                    run_id="cc-main-2026-30-first-100000",
                    crawl="CC-MAIN-2026-30",
                    inputs=synthetic_paths(4),
                    expected_input_count=4,
                )

    def test_artifacts_are_immutable_and_paths_sidecars_are_canonical(self):
        base = self.base(10)
        shards = v2.split_shards(base, 4, expected_input_count=10)
        plan = v2.build_shard_plan(base, shards, expected_input_count=10)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.json"
            self.assertTrue(v2.write_immutable_json(base_path, base))
            self.assertFalse(v2.write_immutable_json(base_path, base))
            written = v2.write_shard_artifacts(root / "shards", shards, plan=plan)
            self.assertEqual(len(written), 4)
            self.assertTrue((root / "shards" / "shard-00000-of-00004.paths").exists())
            recovered = [
                v2.load_shard_manifest(json_path, base, expected_input_count=10)
                for json_path, _ in written
            ]
            v2.load_shard_plan(
                root / "shards" / "shard-plan.json",
                base,
                recovered,
                expected_input_count=10,
            )
            self.assertEqual(
                v2.read_paths(written[0][1]),
                shards[0]["inputs"],
            )
            with self.assertRaisesRegex(v2.ManifestValidationError, "refusing to overwrite"):
                v2.write_immutable_text(written[0][1], "different\n")

    def test_cli_never_promotes_a_small_or_unbounded_list_to_production_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_list = root / "paths.txt"
            input_list.write_text("\n".join(synthetic_paths(2)) + "\n", encoding="utf-8")
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                exit_code = v2.main(
                    [
                        "create-base",
                        "--run-id",
                        "cc-main-2026-30-first-100000",
                        "--crawl",
                        "CC-MAIN-2026-30",
                        "--input-list",
                        str(input_list),
                        "--output",
                        str(root / "base.json"),
                        "--expected-input-count",
                        "100000",
                    ]
                )
            self.assertEqual(exit_code, 2)
            self.assertIn("exactly 100,000", stderr.getvalue())
            self.assertFalse((root / "base.json").exists())


if __name__ == "__main__":
    unittest.main()
