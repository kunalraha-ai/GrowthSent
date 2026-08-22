import io
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_r2_store as r2


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


class FakeR2:
    def __init__(self):
        self.objects = {}

    def head_object(self, *, Bucket, Key):
        del Bucket
        try:
            entry = self.objects[Key]
        except KeyError as error:
            raise ClientError("404") from error
        return {"ContentLength": len(entry["body"]), "Metadata": dict(entry["metadata"]), "ETag": entry["etag"]}

    def put_object(self, *, Bucket, Key, Body, Metadata, IfNoneMatch=None, IfMatch=None, **kwargs):
        del Bucket, kwargs
        exists = Key in self.objects
        if IfNoneMatch == "*" and exists:
            raise ClientError("PreconditionFailed")
        if IfMatch is not None and (not exists or self.objects[Key]["etag"] != IfMatch):
            raise ClientError("PreconditionFailed")
        body = Body.read() if hasattr(Body, "read") else bytes(Body)
        etag = f'"{len(self.objects) + 1}"'
        self.objects[Key] = {"body": body, "metadata": dict(Metadata), "etag": etag}
        return {"ETag": etag}

    def get_object(self, *, Bucket, Key):
        del Bucket
        try:
            entry = self.objects[Key]
        except KeyError as error:
            raise ClientError("404") from error
        return {
            "Body": io.BytesIO(entry["body"]),
            "ContentLength": len(entry["body"]),
            "Metadata": dict(entry["metadata"]),
            "ETag": entry["etag"],
        }


class R2StoreTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeR2()
        self.store = r2.R2Store(self.client, bucket="growthsent-data-lake", allowed_prefixes=["production/common-crawl/test"])

    def _file(self, root, body=b"immutable payload"):
        path = Path(root) / "payload.parquet"
        path.write_bytes(body)
        return path

    def test_new_payload_requires_length_and_growthsent_sha_and_then_reuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._file(tmp)
            key = "production/common-crawl/test/payload.parquet"
            first = self.store.upload_immutable_file(key, path, content_type="application/vnd.apache.parquet")
            second = self.store.upload_immutable_file(key, path, content_type="application/vnd.apache.parquet")
        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])
        self.assertTrue(self.store.verify(key, bytes_count=first["bytes"], sha256=first["sha256"]))

    def test_conflicting_metadata_or_size_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._file(tmp, b"abc")
            key = "production/common-crawl/test/payload.parquet"
            self.store.upload_immutable_file(key, path, content_type="application/octet-stream")
            self.client.objects[key]["metadata"]["growthsent-sha256"] = "f" * 64
            with self.assertRaises(r2.R2StoreError):
                self.store.upload_immutable_file(key, path, content_type="application/octet-stream")
            self.client.objects[key]["metadata"]["growthsent-sha256"] = r2.sha256_file(path)
            self.client.objects[key]["body"] = b"longer"
            with self.assertRaises(r2.R2StoreError):
                self.store.upload_immutable_file(key, path, content_type="application/octet-stream")

    def test_missing_metadata_is_a_conflict_not_an_etag_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._file(tmp)
            key = "production/common-crawl/test/payload.parquet"
            self.client.objects[key] = {"body": path.read_bytes(), "metadata": {}, "etag": '"old"'}
            with self.assertRaises(r2.R2StoreError):
                self.store.upload_immutable_file(key, path, content_type="application/octet-stream")

    def test_json_read_requires_matching_immutable_metadata(self):
        key = "production/common-crawl/test/control.json"
        self.store.upload_immutable_json(key, {"value": 1})
        self.assertEqual(self.store.read_json(key)[0], {"value": 1})
        self.client.objects[key]["metadata"].clear()
        with self.assertRaises(r2.R2StoreError):
            self.store.read_json(key)

    def test_prefix_escape_and_conditional_fence_are_rejected(self):
        with self.assertRaises(r2.R2StoreError):
            self.store.head("production/common-crawl/other/object")
        key = "production/common-crawl/test/control/lease.json"
        etag = self.store.put_json_conditional(key, {"lease": 1}, if_none_match=True)
        with self.assertRaises(r2.R2StoreError):
            self.store.put_json_conditional(key, {"lease": 2}, if_none_match=True)
        self.assertIsNotNone(self.store.put_json_conditional(key, {"lease": 3}, if_match=etag))


if __name__ == "__main__":
    unittest.main()
