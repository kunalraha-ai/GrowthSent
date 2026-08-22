import sys
import unittest
from pathlib import Path


TOOLS = Path(__file__).parents[1] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import common_crawl_gcp_secret_runtime as runtime


class SecretRuntimeTests(unittest.TestCase):
    def test_validates_and_scopes_credentials_without_logging_them(self):
        document = runtime.parse_r2_temporary_credential(
            b'{"account_id":"account","bucket":"growthsent-data-lake","access_key_id":"id","secret_access_key":"secret","session_token":"token"}'
        )
        environment = runtime.credential_environment(document, prefix="GROWTHSENT_R2_RAW_READ_")
        self.assertEqual(environment["GROWTHSENT_R2_BUCKET"], "growthsent-data-lake")
        self.assertIn("GROWTHSENT_R2_RAW_READ_ACCESS_KEY_ID", environment)
        self.assertNotIn("AWS_ACCESS_KEY_ID", environment)

    def test_rejects_malformed_secret_and_unsafe_environment_replacement(self):
        with self.assertRaises(runtime.GcpSecretRuntimeError):
            runtime.parse_r2_temporary_credential(b"{}")
        values = {"account_id": "account", "bucket": "bucket", "access_key_id": "id", "secret_access_key": "secret"}
        with self.assertRaises(runtime.GcpSecretRuntimeError):
            runtime.child_environment({"GROWTHSENT_R2_BUCKET": "different"}, [("GROWTHSENT_R2_", values)])


if __name__ == "__main__":
    unittest.main()
