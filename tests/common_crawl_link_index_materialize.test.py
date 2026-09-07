import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_link_index_materialize_v1 as materialize


class LinkIndexMaterializeTests(unittest.TestCase):
    def test_intermediate_part_keys_are_unique_across_source_shards(self):
        keys = {
            materialize._intermediate_part_key(
                output_prefix="link-index/v1/cost-probes/example",
                table_name="domain_edges",
                target_bucket=0,
                shard_id=shard_id,
            )
            for shard_id in range(2)
        }

        self.assertEqual(len(keys), 2)
        self.assertEqual(
            keys,
            {
                "link-index/v1/cost-probes/example/intermediate/table=domain_edges/target_bucket=0000/source_shard=00000/part.parquet",
                "link-index/v1/cost-probes/example/intermediate/table=domain_edges/target_bucket=0000/source_shard=00001/part.parquet",
            },
        )

    def test_partitioned_output_rejects_duplicate_files_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bucket = root / "target_bucket=0007"
            bucket.mkdir()
            (bucket / "data-0.parquet").touch()
            (bucket / "data-1.parquet").touch()

            with self.assertRaisesRegex(materialize.MaterializeError, "more than one file"):
                materialize._partitioned_output_files(root)

    def test_registrable_domain_resolver_supports_pinned_and_current_tldextract_results(self):
        class LegacyResult:
            registered_domain = "example.co.uk"

        class CurrentResult:
            top_domain_under_public_suffix = "example.com"

        original = sys.modules.get("tldextract")
        try:
            for result, host, expected in (
                (LegacyResult(), "WWW.Example.CO.UK.", "example.co.uk"),
                (CurrentResult(), "WWW.Example.COM", "example.com"),
            ):
                sys.modules["tldextract"] = types.SimpleNamespace(
                    TLDExtract=lambda **_: lambda _: result
                )
                self.assertEqual(materialize._registrable_domain_resolver()(host), expected)
        finally:
            if original is None:
                sys.modules.pop("tldextract", None)
            else:
                sys.modules["tldextract"] = original


if __name__ == "__main__":
    unittest.main()
