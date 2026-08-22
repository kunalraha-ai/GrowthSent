import base64
import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
BOOTSTRAP = ROOT / "deployment" / "common-crawl-production-v2" / "derive-launch-template-bootstrap.sh"
LAUNCH_TEMPLATE_DATA = ROOT / "deployment" / "common-crawl-production-v2" / "backlink-derived-production-10k-launch-template-data.json"
GIT_BASH_CANDIDATES = (
    Path("C:/Program Files/Git/bin/bash.exe"),
    Path("C:/Program Files/Git/usr/bin/bash.exe"),
)


def bash_executable() -> str:
    for candidate in GIT_BASH_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("Git Bash is required to validate the production-derived bootstrap on Windows")


def validation_function() -> str:
    source = BOOTSTRAP.read_text(encoding="utf-8")
    start = source.index("validate_derive_identity() {")
    end = source.index("\n}\ntoken=", start) + 3
    return source[start:end]


def validate(run_id: str, shard_id: str, shard_count: str) -> subprocess.CompletedProcess[str]:
    harness = "\n".join([
        "set -Eeuo pipefail",
        validation_function(),
        "RUN_ID=$1",
        "DERIVE_SHARD_ID=$2",
        "DERIVE_SHARD_COUNT=$3",
        "validate_derive_identity",
    ])
    return subprocess.run(
        [bash_executable(), "-c", harness, "derive-bootstrap-test", run_id, shard_id, shard_count],
        check=False,
        capture_output=True,
        text=True,
    )


class DeriveLaunchTemplateBootstrapTests(unittest.TestCase):
    def test_syntax_is_valid(self):
        subprocess.run([bash_executable(), "-n", str(BOOTSTRAP)], check=True)

    def test_only_the_locked_run_and_ten_shards_are_accepted(self):
        for shard_id in range(10):
            with self.subTest(shard_id=shard_id):
                self.assertEqual(validate("cc-main-2026-30-first-10000", str(shard_id), "10").returncode, 0)
        for run_id, shard_id, shard_count in (
            ("cc-main-2026-30-first-1000", "0", "10"),
            ("cc-main-2026-30-first-10000", "0", "9"),
            ("cc-main-2026-30-first-10000", "-1", "10"),
            ("cc-main-2026-30-first-10000", "10", "10"),
        ):
            with self.subTest(run_id=run_id, shard_id=shard_id, shard_count=shard_count):
                self.assertNotEqual(validate(run_id, shard_id, shard_count).returncode, 0)

    def test_launch_spec_is_the_r6i_xlarge_one_point_five_tebibyte_envelope(self):
        spec = json.loads(LAUNCH_TEMPLATE_DATA.read_text(encoding="utf-8"))
        self.assertEqual(spec["InstanceType"], "r6i.xlarge")
        self.assertTrue(spec["NetworkInterfaces"][0]["AssociatePublicIpAddress"])
        self.assertEqual(spec["NetworkInterfaces"][0]["Groups"], ["sg-0595a0df1b7105404"])
        self.assertEqual(spec["BlockDeviceMappings"][0]["Ebs"]["VolumeSize"], 1536)
        self.assertTrue(spec["BlockDeviceMappings"][0]["Ebs"]["Encrypted"])
        self.assertTrue(spec["BlockDeviceMappings"][0]["Ebs"]["DeleteOnTermination"])
        self.assertEqual(spec["MetadataOptions"]["HttpTokens"], "required")
        self.assertEqual(
            base64.b64decode(spec["UserData"]).decode("utf-8"),
            BOOTSTRAP.read_text(encoding="utf-8"),
        )


if __name__ == "__main__":
    unittest.main()
