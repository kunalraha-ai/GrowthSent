import io
import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
MODULE_PATH = TOOLS / "common_crawl_wat_ingest_v2.py"
SPEC = importlib.util.spec_from_file_location("wat_ingest_v2", MODULE_PATH)
ingest = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = ingest
SPEC.loader.exec_module(ingest)


def source(index: int = 0) -> str:
    return (
        "crawl-data/CC-MAIN-2026-30/segments/1783663951123.52/wat/"
        f"CC-MAIN-20260710070534-20260710100534-{index:05d}.warc.wat.gz"
    )


def context() -> ingest.ShardContext:
    inputs = (source(),)
    return ingest.ShardContext(
        run_id="cc-main-2026-30-first-100000",
        crawl="CC-MAIN-2026-30",
        shard_id=0,
        shard_count=100,
        base_inputs_sha256="a" * 64,
        base_manifest_sha256="b" * 64,
        shard_inputs_sha256="c" * 64,
        shard_manifest_sha256="d" * 64,
        inputs=inputs,
        first_input=inputs[0],
        last_input=inputs[-1],
        control_prefix="control/shards/shard-000-of-100",
        base_manifest={"base": "immutable"},
        shard_manifest={"shard": "immutable"},
        shard_plan={"plan": "immutable"},
    )


class FakeS3Error(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.sequence = 0

    def get_object(self, *, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise FakeS3Error("NoSuchKey")
        value = self.objects[Key]
        return {"Body": io.BytesIO(value["body"]), "ETag": value["etag"]}

    def put_object(self, *, Bucket, Key, Body, ContentType, IfNoneMatch=None, IfMatch=None):
        del Bucket, ContentType
        current = self.objects.get(Key)
        if IfNoneMatch == "*" and current is not None:
            raise FakeS3Error("PreconditionFailed")
        if IfMatch is not None and (current is None or current["etag"] != IfMatch):
            raise FakeS3Error("PreconditionFailed")
        self.sequence += 1
        etag = f'"etag-{self.sequence}"'
        self.objects[Key] = {"body": bytes(Body), "etag": etag}
        return {"ETag": etag}


class CommonCrawlWatIngestV2Tests(unittest.TestCase):
    def test_shard_control_keys_are_namespaced_and_immutable(self):
        fake = FakeS3()
        key = ingest.control_key("run", "control/shards/shard-000-of-100", "input-manifest.json")
        self.assertEqual(key, "run/control/shards/shard-000-of-100/input-manifest.json")
        self.assertEqual(ingest.canonical_control_prefix(0, 100), "control/shards/shard-000-of-100")
        self.assertEqual(ingest.canonical_control_prefix(99, 100), "control/shards/shard-099-of-100")
        ingest.ensure_remote_immutable_json(fake, "bucket", key, {"immutable": True})
        ingest.ensure_remote_immutable_json(fake, "bucket", key, {"immutable": True})
        with self.assertRaisesRegex(RuntimeError, "differs"):
            ingest.ensure_remote_immutable_json(fake, "bucket", key, {"immutable": False})

    def test_conditional_lease_blocks_duplicate_owner_and_fences_stale_owner(self):
        fake = FakeS3()
        shard = context()
        key = ingest.control_key("run", shard.control_prefix, "lease.json")
        started = datetime(2026, 8, 15, tzinfo=timezone.utc)
        first = ingest.acquire_shard_lease(fake, "bucket", key, shard, "worker-a", 300, now=started)

        with self.assertRaisesRegex(RuntimeError, "already owned"):
            ingest.acquire_shard_lease(fake, "bucket", key, shard, "worker-b", 300, now=started + timedelta(seconds=1))

        with self.assertRaisesRegex(RuntimeError, "explicitly confirm"):
            ingest.acquire_shard_lease(
                fake, "bucket", key, shard, "worker-b", 300, now=started + timedelta(seconds=301)
            )

        replacement = ingest.acquire_shard_lease(
            fake,
            "bucket",
            key,
            shard,
            "worker-b",
            300,
            now=started + timedelta(seconds=301),
            allow_expired_takeover=True,
        )
        with self.assertRaisesRegex(RuntimeError, "lost ownership"):
            first.refresh(now=started + timedelta(seconds=302))
        replacement.finalize("completed")
        lease_document = json.loads(fake.objects[key]["body"])
        self.assertEqual(lease_document["state"], "completed")
        self.assertEqual(lease_document["owner_id"], "worker-b")

    def test_lease_rejects_another_immutable_assignment_for_the_same_shard_path(self):
        fake = FakeS3()
        shard = context()
        key = ingest.control_key("run", shard.control_prefix, "lease.json")
        ingest.acquire_shard_lease(fake, "bucket", key, shard, "worker-a", 300)
        other = context()
        other = ingest.ShardContext(
            **{**other.__dict__, "shard_manifest_sha256": "e" * 64}
        )
        with self.assertRaisesRegex(RuntimeError, "different immutable shard assignment"):
            ingest.acquire_shard_lease(fake, "bucket", key, other, "worker-b", 300)

    def test_runtime_runner_refuses_any_base_scope_other_than_the_locked_ten_thousand(self):
        shard = context()
        arguments = [
            "--base-manifest", "ignored-base.json", "--shard-manifest", "ignored-shard.json",
            "--shard-plan", "ignored-plan.json", "--run-id", shard.run_id,
            "--shard-id", "0", "--shard-count", "100",
            "--expected-base-input-count", "100000",
            "--base-inputs-sha256", shard.base_inputs_sha256,
            "--base-manifest-sha256", shard.base_manifest_sha256,
            "--shard-inputs-sha256", shard.shard_inputs_sha256,
            "--shard-manifest-sha256", shard.shard_manifest_sha256,
            "--control-prefix", shard.control_prefix, "--shard-lease-owner", "worker-a",
            "--max-inputs", "1", "--expected-inputs-sha256", shard.shard_inputs_sha256,
            "--require-source-prefix", "crawl-data/CC-MAIN-2026-30/", "--output-dir", "work",
            "--upload", "--remove-uploaded-local", "--destination", "s3://bucket/run",
        ]
        with self.assertRaises(SystemExit):
            ingest.parse_args(arguments)

    def test_resume_reuses_only_the_same_locked_shard_and_does_not_reingest_remote_triplet(self):
        fake = FakeS3()
        shard = context()
        completed_metric = ingest.v1.Metrics(input=source(), pages_emitted=1, links_emitted=2, output_bytes=3).report()
        with tempfile.TemporaryDirectory() as temporary_directory:
            arguments = [
                "--base-manifest", "ignored-base.json",
                "--shard-manifest", "ignored-shard.json",
                "--shard-plan", "ignored-plan.json",
                "--run-id", shard.run_id,
                "--shard-id", "0",
                "--shard-count", "100",
                "--expected-base-input-count", "10000",
                "--base-inputs-sha256", shard.base_inputs_sha256,
                "--base-manifest-sha256", shard.base_manifest_sha256,
                "--shard-inputs-sha256", shard.shard_inputs_sha256,
                "--shard-manifest-sha256", shard.shard_manifest_sha256,
                "--control-prefix", shard.control_prefix,
                "--shard-lease-owner", "worker-a",
                "--shard-lease-seconds", "300",
                "--max-inputs", "1",
                "--expected-inputs-sha256", shard.shard_inputs_sha256,
                "--require-source-prefix", "crawl-data/CC-MAIN-2026-30/",
                "--workers", "1",
                "--output-dir", str(Path(temporary_directory) / "work"),
                "--resume",
                "--upload",
                "--remove-uploaded-local",
                "--destination", "s3://bucket/run",
            ]
            stdout = io.StringIO()
            with (
                patch.object(ingest, "context_from_args", return_value=shard),
                patch.object(ingest.v1, "s3_client", return_value=fake),
                patch.object(ingest.v1, "remote_report", return_value=completed_metric),
                patch.object(ingest.v1, "ingest_many", side_effect=AssertionError("resume must not ingest completed input")),
                redirect_stdout(stdout),
            ):
                exit_code = ingest.main(arguments)

        self.assertEqual(exit_code, 0)
        summary = json.loads(stdout.getvalue())
        self.assertEqual(summary["shard_id"], 0)
        self.assertEqual(summary["shard_count"], 100)
        self.assertEqual(summary["aggregate"]["files"], 1)
        self.assertEqual(summary["progress"]["files_remote_recovered"], 1)
        self.assertIn("run/control/shards/shard-000-of-100/run-summary.json", fake.objects)

    def test_interrupted_shard_marks_its_lease_stopped_for_same_shard_resume(self):
        fake = FakeS3()
        shard = context()
        with tempfile.TemporaryDirectory() as temporary_directory:
            arguments = [
                "--base-manifest", "ignored-base.json",
                "--shard-manifest", "ignored-shard.json",
                "--shard-plan", "ignored-plan.json",
                "--run-id", shard.run_id,
                "--shard-id", "0",
                "--shard-count", "100",
                "--expected-base-input-count", "10000",
                "--base-inputs-sha256", shard.base_inputs_sha256,
                "--base-manifest-sha256", shard.base_manifest_sha256,
                "--shard-inputs-sha256", shard.shard_inputs_sha256,
                "--shard-manifest-sha256", shard.shard_manifest_sha256,
                "--control-prefix", shard.control_prefix,
                "--shard-lease-owner", "worker-a",
                "--shard-lease-seconds", "300",
                "--max-inputs", "1",
                "--expected-inputs-sha256", shard.shard_inputs_sha256,
                "--require-source-prefix", "crawl-data/CC-MAIN-2026-30/",
                "--workers", "1",
                "--output-dir", str(Path(temporary_directory) / "work"),
                "--resume",
                "--upload",
                "--remove-uploaded-local",
                "--destination", "s3://bucket/run",
            ]
            with (
                patch.object(ingest, "context_from_args", return_value=shard),
                patch.object(ingest.v1, "s3_client", return_value=fake),
                patch.object(ingest.v1, "remote_report", return_value=None),
                patch.object(ingest.v1, "ingest_many", side_effect=KeyboardInterrupt),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    ingest.main(arguments)

        lease_key = ingest.control_key("run", shard.control_prefix, "lease.json")
        lifecycle_key = ingest.control_key("run", shard.control_prefix, "lifecycle.json")
        self.assertEqual(json.loads(fake.objects[lease_key]["body"])["state"], "stopped")
        self.assertEqual(json.loads(fake.objects[lifecycle_key]["body"])["event"], "stopped")


if __name__ == "__main__":
    unittest.main()
