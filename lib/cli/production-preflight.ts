import { runProductionPreflight } from "../release/preflight.js";

try {
  const report = await runProductionPreflight();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch {
  // The report itself is deliberately safe; never print a driver error because
  // it can include a connection string.
  console.error("Production preflight could not complete safely.");
  process.exitCode = 1;
}
