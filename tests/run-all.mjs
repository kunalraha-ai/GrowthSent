import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Do not rely on shell glob expansion: `pnpm test` on Windows otherwise passes
// a literal wildcard to tsx and can hang before the test runner reports work.
const testDirectory = join(process.cwd(), "tests");
const files = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => join("tests", file));

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;
