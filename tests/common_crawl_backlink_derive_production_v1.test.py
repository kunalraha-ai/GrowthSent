import base64
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

SPEC = importlib.util.spec_from_file_location(
    "common_crawl_backlink_derive_production_v1",
    TOOLS / "common_crawl_backlink_derive_production_v1.py",
)
production = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = production
SPEC.loader.exec_module(production)


MANIFEST_ROOT = ROOT / "deployment" / "common-crawl-production-v2" / "manifests" / "cc-main-2026-30-first-10000"


class FakeClientError(Exception):
    def __init__(self, code: str):
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


class FakeS3:
    """Small S3 double with S3 SHA-256 (base64) HeadObject semantics."""

    def __init__(self):
        self.objects: dict[str, dict[str, object]] = {}
        self.events: list[tuple[str, str]] = []

    def head_object(self, *, Bucket: str, Key: str, ChecksumMode: str):
        del Bucket, ChecksumMode
        try:
            return self.objects[Key]
        except KeyError as error:
            raise FakeClientError("404") from error

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str, ChecksumAlgorithm: str, IfNoneMatch: str):
        del Bucket, ContentType, ChecksumAlgorithm
        if IfNoneMatch == "*" and Key in self.objects:
            raise FakeClientError("PreconditionFailed")
        payload = bytes(Body)
        self.objects[Key] = {
            "ContentLength": len(payload),
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(payload).digest()).decode("ascii"),
            "ChecksumType": "FULL_OBJECT",
            "Body": payload,
        }
        self.events.append(("put", Key))

    def upload_file(self, Filename: str, Bucket: str, Key: str, ExtraArgs: dict[str, object]):
        del Bucket
        payload = Path(Filename).read_bytes()
        self.objects[Key] = {
            "ContentLength": len(payload),
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(payload).digest()).decode("ascii"),
            "ChecksumType": "FULL_OBJECT",
            "Metadata": dict(ExtraArgs.get("Metadata", {})),
            "Body": payload,
        }
        self.events.append(("upload", Key))

    def get_object(self, *, Bucket: str, Key: str):
        del Bucket
        try:
            return {"Body": io.BytesIO(bytes(self.objects[Key]["Body"]))}
        except KeyError as error:
            raise FakeClientError("404") from error


def contract(shard_id: int = 0):
    return production.load_contract(
        MANIFEST_ROOT / "base-manifest.json",
        MANIFEST_ROOT / "shards" / f"shard-{shard_id:05d}-of-00010.json",
        MANIFEST_ROOT / "shards" / "shard-plan.json",
        shard_id,
        10,
    )


def write_verified_detail(root: Path, checked_contract) -> Path:
    detail = (
        root
        / f"crawl={production.CRAWL}"
        / "dataset=backlink-details"
        / f"input_shard={checked_contract.label}"
    )
    for bucket in range(1024):
        (detail / f"target_host_bucket={bucket:04d}").mkdir(parents=True, exist_ok=True)
    (detail / "target_host_bucket=0000" / "part-000.parquet").write_bytes(b"derived-data")
    detail_manifest = {
        "run_id": production.RUN_ID,
        "crawl": production.CRAWL,
        "shard": {"id": checked_contract.shard_id, "count": 10, "label": checked_contract.label},
        "bucket_count": 1024,
        "bucket_algorithm": "int(sha256(target_host)[:3], 16) >> 2, zero-padded decimal",
        "source_links": {"fingerprint_sha256": "a" * 64},
        "manifest_sha256": "b" * 64,
    }
    (detail / "DERIVED-MANIFEST.json").write_text(json.dumps(detail_manifest), encoding="utf-8")
    return detail


class ProductionDerivedBacklinkTests(unittest.TestCase):
    def _entry(self, root: Path, payload: bytes = b"published-payload") -> dict[str, object]:
        path = root / "payload.parquet"
        path.write_bytes(payload)
        return {
            "path": str(path),
            "key": "locked/payload.parquet",
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    def test_remote_full_object_checksum_and_metadata_succeeds(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            payload = Path(str(entry["path"])).read_bytes()
            client.objects[str(entry["key"])] = {
                "ContentLength": len(payload),
                "ChecksumSHA256": production.s3_checksum_sha256(str(entry["sha256"])),
                "ChecksumType": "FULL_OBJECT",
                "Metadata": {"growthsent-sha256": entry["sha256"]},
            }
            self.assertTrue(production._verify_remote_file(client, entry))

    def test_remote_full_object_checksum_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            client.objects[str(entry["key"])] = {
                "ContentLength": entry["bytes"],
                "ChecksumSHA256": production.s3_checksum_sha256(hashlib.sha256(b"different").hexdigest()),
                "ChecksumType": "FULL_OBJECT",
                "Metadata": {"growthsent-sha256": entry["sha256"]},
            }
            with self.assertRaisesRegex(production.ProductionDeriveError, "full-object checksum mismatch"):
                production._verify_remote_file(client, entry)

    def test_remote_composite_checksum_uses_matching_metadata_and_size(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            client.objects[str(entry["key"])] = {
                "ContentLength": entry["bytes"],
                "ChecksumSHA256": production.s3_checksum_sha256(hashlib.sha256(b"composite-part").hexdigest()) + "-3",
                "ChecksumType": "COMPOSITE",
                "Metadata": {"growthsent-sha256": entry["sha256"]},
            }
            self.assertTrue(production._verify_remote_file(client, entry))

    def test_remote_composite_checksum_mismatched_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            client.objects[str(entry["key"])] = {
                "ContentLength": entry["bytes"],
                "ChecksumSHA256": "not-compared-for-composite",
                "ChecksumType": "COMPOSITE",
                "Metadata": {"growthsent-sha256": hashlib.sha256(b"different").hexdigest()},
            }
            with self.assertRaisesRegex(production.ProductionDeriveError, "metadata SHA-256 mismatch"):
                production._verify_remote_file(client, entry)

    def test_remote_missing_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            client.objects[str(entry["key"])] = {
                "ContentLength": entry["bytes"],
                "ChecksumSHA256": production.s3_checksum_sha256(str(entry["sha256"])),
                "ChecksumType": "FULL_OBJECT",
            }
            with self.assertRaisesRegex(production.ProductionDeriveError, "missing growthsent-sha256 metadata"):
                production._verify_remote_file(client, entry)

    def test_remote_size_mismatch_fails_closed_before_checksum_or_metadata(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            entry = self._entry(Path(temporary_directory))
            client = FakeS3()
            client.objects[str(entry["key"])] = {
                "ContentLength": int(entry["bytes"]) + 1,
                "ChecksumSHA256": production.s3_checksum_sha256(str(entry["sha256"])),
                "ChecksumType": "FULL_OBJECT",
                "Metadata": {"growthsent-sha256": entry["sha256"]},
            }
            with self.assertRaisesRegex(production.ProductionDeriveError, "size mismatch"):
                production._verify_remote_file(client, entry)

    def test_locked_contract_accepts_only_the_approved_run_and_shards(self):
        for shard_id in range(10):
            with self.subTest(shard_id=shard_id):
                loaded = contract(shard_id)
                self.assertEqual(loaded.shard_id, shard_id)
                self.assertEqual(len(loaded.source_keys), 1000)
        with self.assertRaisesRegex(production.ProductionDeriveError, "exactly 10"):
            production.load_contract(
                MANIFEST_ROOT / "base-manifest.json",
                MANIFEST_ROOT / "shards" / "shard-00000-of-00010.json",
                MANIFEST_ROOT / "shards" / "shard-plan.json",
                0,
                9,
            )
        with self.assertRaisesRegex(production.ProductionDeriveError, "0..9"):
            production.load_contract(
                MANIFEST_ROOT / "base-manifest.json",
                MANIFEST_ROOT / "shards" / "shard-00000-of-00010.json",
                MANIFEST_ROOT / "shards" / "shard-plan.json",
                10,
                10,
            )

    def test_source_plan_is_exactly_the_matching_raw_shard(self):
        checked = contract(4)
        plan = production.source_plan(checked)
        self.assertEqual(len(plan["entries"]), 1000)
        self.assertEqual(len({entry["input"] for entry in plan["entries"]}), 1000)
        self.assertTrue(all(entry["key"].startswith(production.RAW_LINKS_PREFIX + "/part-") for entry in plan["entries"]))
        self.assertFalse(any("backlink-derived" in entry["key"] for entry in plan["entries"]))

    def test_path_normalization_rejects_other_or_unsafe_destinations(self):
        self.assertEqual(
            production.normalized_prefix(production.DERIVED_PREFIX, "metrics", "derive-shard-000-of-010.json"),
            production.DERIVED_PREFIX + "/metrics/derive-shard-000-of-010.json",
        )
        for unsafe in ("/", "../raw", "a//b", "..", ""):
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(production.ProductionDeriveError):
                    production.normalized_prefix(production.DERIVED_PREFIX, unsafe)

    def test_bucket_validation_requires_every_distinct_direct_partition(self):
        checked = contract()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "output"
            detail = write_verified_detail(root, checked)
            self.assertEqual(len(production.derive.validate_detail_bucket_directories(detail)), 1024)
            (detail / "target_host_bucket=1023").rmdir()
            with self.assertRaisesRegex(production.derive.DerivedDataError, "missing"):
                production.derive.validate_detail_bucket_directories(detail)

    def test_publication_is_idempotent_and_completion_is_the_last_write(self):
        checked = contract()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            write_verified_detail(root / "output", checked)
            status = root / "status"
            status.mkdir()
            (status / "DERIVED-SHARD-METRICS.json").write_text('{"ok":true}\n', encoding="utf-8")
            publication = production.publication_manifest(root / "output", status, checked)
            self.assertTrue(all(entry["key"].startswith(production.DERIVED_PREFIX + "/") for entry in publication["files"]))
            client = FakeS3()
            first = production.publish(client, publication, owner="unit-test-worker")
            completion_key = production.normalized_prefix(
                production.remote_control_prefix(0), "DERIVED-SHARD-COMPLETED.json"
            )
            self.assertEqual(first["uploaded"], len(publication["files"]))
            self.assertEqual(client.events[-1], ("put", completion_key))
            event_count = len(client.events)
            resumed = production.publish(client, publication, owner="unit-test-worker")
            self.assertEqual(resumed["uploaded"], 0)
            self.assertEqual(resumed["already_verified"], len(publication["files"]))
            self.assertEqual(len(client.events), event_count)

    def test_preexisting_conflicting_destination_fails_closed(self):
        checked = contract()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            write_verified_detail(root / "output", checked)
            status = root / "status"; status.mkdir()
            (status / "DERIVED-SHARD-METRICS.json").write_text('{"ok":true}\n', encoding="utf-8")
            publication = production.publication_manifest(root / "output", status, checked)
            client = FakeS3()
            entry = publication["files"][0]
            client.objects[entry["key"]] = {"ContentLength": int(entry["bytes"]) + 1, "ChecksumSHA256": "wrong"}
            with self.assertRaisesRegex(production.ProductionDeriveError, "size mismatch"):
                production.publish(client, publication, owner="unit-test-worker")

    def test_interrupted_publication_can_resume_only_on_the_same_worker(self):
        client = FakeS3()
        lease_key = production.normalized_prefix(production.remote_control_prefix(0), "lease.json")
        production._acquire_or_resume_lease(client, lease_key, shard=0, owner="same-worker")
        production._acquire_or_resume_lease(client, lease_key, shard=0, owner="same-worker")
        with self.assertRaisesRegex(production.ProductionDeriveError, "live publication lease"):
            production._acquire_or_resume_lease(client, lease_key, shard=0, owner="other-worker")

    def test_unexpected_local_dataset_cannot_be_published(self):
        checked = contract()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            write_verified_detail(root / "output", checked)
            unexpected = root / "output" / f"crawl={production.CRAWL}" / "dataset=raw-links"
            unexpected.mkdir(parents=True)
            (unexpected / "part.parquet").write_bytes(b"must-not-publish")
            status = root / "status"; status.mkdir()
            (status / "DERIVED-SHARD-METRICS.json").write_text('{"ok":true}\n', encoding="utf-8")
            with self.assertRaisesRegex(production.ProductionDeriveError, "outside the locked derive shard"):
                production.publication_manifest(root / "output", status, checked)


if __name__ == "__main__":
    unittest.main()
