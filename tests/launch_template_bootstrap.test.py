import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
BOOTSTRAP = ROOT / "deployment" / "common-crawl-production-v2" / "launch-template-bootstrap.sh"
GIT_BASH_CANDIDATES = (
    Path("C:/Program Files/Git/bin/bash.exe"),
    Path("C:/Program Files/Git/usr/bin/bash.exe"),
)


def bash_executable() -> str:
    for candidate in GIT_BASH_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("Git Bash is required to validate the production-v2 bootstrap on Windows")


def validation_function() -> str:
    source = BOOTSTRAP.read_text(encoding="utf-8")
    start = source.index("validate_launch_identity() {")
    end = source.index("\n}\n\ntoken=", start) + 3
    return source[start:end]


def validate(run_id: str, shard_id: str, shard_count: str) -> subprocess.CompletedProcess[str]:
    harness = "\n".join(
        [
            "set -Eeuo pipefail",
            validation_function(),
            "RUN_ID=$1",
            "SHARD_ID=$2",
            "SHARD_COUNT=$3",
            "validate_launch_identity",
        ]
    )
    return subprocess.run(
        [bash_executable(), "-c", harness, "bootstrap-test", run_id, shard_id, shard_count],
        check=False,
        capture_output=True,
        text=True,
    )


class LaunchTemplateBootstrapTests(unittest.TestCase):
    def test_bash_syntax_is_valid(self):
        subprocess.run([bash_executable(), "-n", str(BOOTSTRAP)], check=True)

    def test_exact_run_and_all_shard_ids_are_accepted(self):
        for shard_id in range(10):
            with self.subTest(shard_id=shard_id):
                result = validate("cc-main-2026-30-first-10000", str(shard_id), "10")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_run_id_is_rejected(self):
        self.assertNotEqual(validate("cc-main-2026-30-first-100000", "0", "10").returncode, 0)

    def test_non_ten_shard_count_is_rejected(self):
        for shard_count in ("0", "9", "11", "100"):
            with self.subTest(shard_count=shard_count):
                self.assertNotEqual(
                    validate("cc-main-2026-30-first-10000", "0", shard_count).returncode,
                    0,
                )

    def test_out_of_range_shard_ids_are_rejected(self):
        for shard_id in ("-1", "10", "99"):
            with self.subTest(shard_id=shard_id):
                self.assertNotEqual(
                    validate("cc-main-2026-30-first-10000", shard_id, "10").returncode,
                    0,
                )


if __name__ == "__main__":
    unittest.main()
