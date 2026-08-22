import sys
import unittest
from pathlib import Path


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import build_common_crawl_gcp_r2_25k_batch_job as jobs
import common_crawl_gcp_r2_25k_contract as contract


IMAGE = "us-docker.pkg.dev/project/repo/growthsent@sha256:" + "a" * 64
SERVICE_ACCOUNT = "growthsent-cc-raw-worker@project.iam.gserviceaccount.com"
SECRET = "projects/project/secrets/raw-r2/versions/1"


class BatchJobBuildTests(unittest.TestCase):
    def test_raw_job_is_single_shard_digest_pinned_and_has_no_aws_output(self):
        job = jobs.build(
            stage="raw",
            shard_id=0,
            release_sha256="b" * 64,
            image_uri=IMAGE,
            service_account=SERVICE_ACCOUNT,
            attempt_id="raw-000-attempt-1",
            primary_r2_secret_version=SECRET,
        )
        env = job["taskGroups"][0]["taskSpec"]["environment"]["variables"]
        self.assertEqual(env["GROWTHSENT_SHARD_ID"], "0")
        self.assertEqual(env["GROWTHSENT_RAW_PREFIX"], contract.RAW_PREFIX)
        self.assertEqual(job["taskGroups"][0]["taskSpec"]["maxRetryCount"], 0)
        self.assertNotIn("s3://", str(job))
        self.assertNotIn("first-10000", str(job))

    def test_derive_needs_two_distinct_secret_bindings_and_explicit_takeover(self):
        job = jobs.build(
            stage="derive",
            shard_id=24,
            release_sha256="b" * 64,
            image_uri=IMAGE,
            service_account="growthsent-cc-derive-worker@project.iam.gserviceaccount.com",
            attempt_id="derive-024-recovery-1",
            primary_r2_secret_version="projects/project/secrets/raw-read/versions/7",
            additional_r2_secret_version="projects/project/secrets/derive-write/versions/8",
            allow_expired_lease_takeover=True,
        )
        env = job["taskGroups"][0]["taskSpec"]["environment"]["variables"]
        self.assertEqual(env["GROWTHSENT_DERIVE_SHARD_ID"], "24")
        self.assertEqual(env["GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER"], "true")
        self.assertIn("RAW_READ", " ".join(env))
        self.assertIn("DERIVED_WRITE", " ".join(env))

    def test_invalid_image_or_wrong_secret_shape_is_rejected_before_job_materialization(self):
        with self.assertRaises(jobs.BatchJobBuildError):
            jobs.build(
                stage="raw",
                shard_id=0,
                release_sha256="b" * 64,
                image_uri="mutable:tag",
                service_account=SERVICE_ACCOUNT,
                attempt_id="raw-000-attempt-1",
                primary_r2_secret_version=SECRET,
            )
        with self.assertRaises(jobs.BatchJobBuildError):
            jobs.build(
                stage="derive",
                shard_id=0,
                release_sha256="b" * 64,
                image_uri=IMAGE,
                service_account=SERVICE_ACCOUNT,
                attempt_id="derive-000-attempt-1",
                primary_r2_secret_version=SECRET,
            )


if __name__ == "__main__":
    unittest.main()
