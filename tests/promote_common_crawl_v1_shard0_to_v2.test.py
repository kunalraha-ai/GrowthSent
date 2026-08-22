import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

MODULE_PATH = TOOLS / "promote_common_crawl_v1_shard0_to_v2.py"
SPEC = importlib.util.spec_from_file_location("promote_common_crawl_v1_shard0_to_v2", MODULE_PATH)
promote = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = promote
SPEC.loader.exec_module(promote)


class FakeS3Error(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakePaginator:
    def __init__(self, client):
        self.client = client

    def paginate(self, *, Bucket, Prefix):
        del Bucket
        entries = [
            {"Key": key, "Size": value["size"]}
            for key, value in sorted(self.client.objects.items())
            if key.startswith(Prefix)
        ]
        entries.extend(self.client.extra_list_entries.get(Prefix, []))
        return [{"Contents": entries}]


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.extra_list_entries = {}
        self.copy_calls = []
        self.copy_sequence = 0

    def get_paginator(self, operation_name):
        if operation_name != "list_objects_v2":
            raise AssertionError(operation_name)
        return FakePaginator(self)

    def put_fixture(self, key, *, body=b"data", etag='"fixture-etag"', checksum=None, metadata=None, content_type=None):
        self.objects[key] = {
            "body": body,
            "size": len(body),
            "etag": etag,
            "checksum": checksum,
            "metadata": dict(metadata or {}),
            "content_type": content_type,
        }

    def get_object(self, *, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise FakeS3Error("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key]["body"])}

    def head_object(self, *, Bucket, Key, ChecksumMode):
        del Bucket
        if ChecksumMode != "ENABLED":
            raise AssertionError(ChecksumMode)
        if Key not in self.objects:
            raise FakeS3Error("404")
        value = self.objects[Key]
        response = {
            "ContentLength": value["size"],
            "ETag": value["etag"],
            "Metadata": value["metadata"],
            "ContentType": value["content_type"],
        }
        if value["checksum"] is not None:
            response["ChecksumSHA256"] = value["checksum"]
        return response

    def copy_object(self, *, Bucket, Key, CopySource, CopySourceIfMatch, MetadataDirective, Metadata,
                    ChecksumAlgorithm, **headers):
        del Bucket
        if MetadataDirective != "REPLACE" or ChecksumAlgorithm != "SHA256":
            raise AssertionError("copy must replace verified promotion metadata and request SHA-256")
        source = self.objects[CopySource["Key"]]
        if CopySourceIfMatch != source["etag"]:
            raise FakeS3Error("PreconditionFailed")
        self.copy_sequence += 1
        etag = f'"copied-{self.copy_sequence}"'
        self.objects[Key] = {
            "body": source["body"],
            "size": source["size"],
            "etag": etag,
            "checksum": "copied-sha256",
            "metadata": dict(Metadata),
            "content_type": headers.get("ContentType"),
        }
        self.copy_calls.append((CopySource["Key"], Key))
        return {"CopyObjectResult": {"ETag": etag}}


class V1ToV2ShardZeroPromotionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base, shard, plan = promote.default_manifest_paths()
        cls.context = promote.load_locked_context(base, shard, plan)
        cls.artifacts = promote.expected_artifacts(cls.context)

    def fake_complete_source(self):
        client = FakeS3()
        client.put_fixture(
            promote.V1_MANIFEST_KEY,
            body=json.dumps({
                "crawl": promote.CRAWL,
                "format_version": 1,
                "input_count": promote.EXPECTED_SHARD_INPUT_COUNT,
                "inputs_sha256": promote.EXPECTED_SHARD_INPUTS_SHA256,
                "inputs": list(self.context.inputs),
            }).encode("utf-8"),
            content_type="application/json",
        )
        for artifact in self.artifacts:
            if artifact.dataset == "metrics":
                body = json.dumps({"input": artifact.input_path, "failures": []}).encode("utf-8")
                content_type = "application/json"
            else:
                body = f"{artifact.dataset}:{artifact.suffix}".encode("ascii")
                content_type = "application/vnd.apache.parquet"
            client.put_fixture(
                artifact.source_key,
                body=body,
                etag=f'"{artifact.suffix}"',
                content_type=content_type,
            )
        return client

    def test_successful_plan_has_exactly_three_thousand_copy_actions(self):
        plan = promote.build_promotion_plan(self.fake_complete_source(), self.context)
        self.assertEqual(len(plan.actions), 3_000)
        self.assertEqual(plan.copy_count, 3_000)
        self.assertEqual(plan.already_verified_count, 0)

    def test_missing_source_object_is_rejected(self):
        client = self.fake_complete_source()
        client.objects.pop(self.artifacts[0].source_key)
        with self.assertRaisesRegex(promote.PromotionError, "missing=1"):
            promote.build_promotion_plan(client, self.context)

    def test_duplicate_suffix_in_source_listing_is_rejected(self):
        client = self.fake_complete_source()
        artifact = self.artifacts[0]
        prefix = f"{promote.V1_SOURCE_PREFIX}crawl={promote.CRAWL}/dataset={artifact.dataset}/"
        client.extra_list_entries[prefix] = [{"Key": artifact.source_key, "Size": 1}]
        with self.assertRaisesRegex(promote.PromotionError, "duplicate deterministic suffix"):
            promote.build_promotion_plan(client, self.context)

    def test_mismatched_metric_input_is_rejected(self):
        client = self.fake_complete_source()
        metric = next(artifact for artifact in self.artifacts if artifact.dataset == "metrics")
        client.objects[metric.source_key]["body"] = json.dumps({
            "input": "crawl-data/CC-MAIN-2026-30/not-the-locked-input.warc.wat.gz",
            "failures": [],
        }).encode("utf-8")
        client.objects[metric.source_key]["size"] = len(client.objects[metric.source_key]["body"])
        with self.assertRaisesRegex(promote.PromotionError, "metric input does not match"):
            promote.build_promotion_plan(client, self.context)

    def test_incomplete_triplet_is_rejected(self):
        client = self.fake_complete_source()
        metric = next(artifact for artifact in self.artifacts if artifact.dataset == "metrics")
        client.objects.pop(metric.source_key)
        with self.assertRaisesRegex(promote.PromotionError, "v1 metrics artifacts differ"):
            promote.build_promotion_plan(client, self.context)

    def test_identical_preexisting_destination_is_reused_without_copy(self):
        client = self.fake_complete_source()
        artifact = self.artifacts[0]
        source = client.objects[artifact.source_key]
        client.put_fixture(
            artifact.destination_key,
            body=source["body"],
            etag=source["etag"],
            content_type=source["content_type"],
        )
        plan = promote.build_promotion_plan(client, self.context)
        matching = next(action for action in plan.actions if action.artifact.destination_key == artifact.destination_key)
        self.assertEqual(matching.action, "already-verified")
        self.assertEqual(plan.copy_count, 2_999)

    def test_conflicting_preexisting_destination_is_rejected(self):
        client = self.fake_complete_source()
        artifact = self.artifacts[0]
        client.put_fixture(artifact.destination_key, body=b"conflict", etag='"conflict"', content_type="application/octet-stream")
        with self.assertRaisesRegex(promote.PromotionError, "conflicting pre-existing"):
            promote.build_promotion_plan(client, self.context)

    def test_unexpected_destination_object_is_rejected(self):
        client = self.fake_complete_source()
        client.put_fixture(f"{promote.V2_DESTINATION_PREFIX}unrelated-object", body=b"unexpected")
        with self.assertRaisesRegex(promote.PromotionError, "destination contains unexpected"):
            promote.build_promotion_plan(client, self.context)

    def test_apply_uses_only_server_side_copies_and_verifies_all_destinations(self):
        client = self.fake_complete_source()
        plan = promote.build_promotion_plan(client, self.context)
        applied = promote.apply_promotion(client, plan)
        self.assertEqual(len(client.copy_calls), 3_000)
        self.assertEqual(sum(action.action == "copied" for action in applied.actions), 3_000)
        self.assertEqual(len([key for key in client.objects if key.startswith(promote.V2_DESTINATION_PREFIX)]), 3_000)
        resumed_plan = promote.build_promotion_plan(client, self.context)
        self.assertEqual(resumed_plan.copy_count, 0)
        self.assertEqual(resumed_plan.already_verified_count, 3_000)


if __name__ == "__main__":
    unittest.main()
