import assert from "node:assert";
import { validateUrlForScan } from "../lib/security/ssrf";

async function testSsrfProtection() {
  console.log("Running SSRF Protection Tests...");

  // Localhost should be blocked
  const res1 = await validateUrlForScan("http://localhost:8443");
  assert.strictEqual(res1.isValid, false, "Localhost should be blocked");

  // Private IP 127.0.0.1 should be blocked
  const res2 = await validateUrlForScan("http://127.0.0.1/admin");
  assert.strictEqual(res2.isValid, false, "127.0.0.1 should be blocked");

  // AWS Metadata IP 169.254.169.254 should be blocked
  const res3 = await validateUrlForScan("http://169.254.169.254/latest/meta-data/");
  assert.strictEqual(res3.isValid, false, "169.254.169.254 should be blocked");

  // Private network 192.168.1.1 should be blocked
  const res4 = await validateUrlForScan("http://192.168.1.1");
  assert.strictEqual(res4.isValid, false, "192.168.1.1 should be blocked");

  // FTP protocol should be blocked
  const res5 = await validateUrlForScan("ftp://example.com/file.txt");
  assert.strictEqual(res5.isValid, false, "FTP protocol should be blocked");

  // A public literal can be validated without a live DNS lookup or HTTP request.
  const res6 = await validateUrlForScan("https://8.8.8.8");
  assert.strictEqual(res6.isValid, true, "Public HTTPS URL should pass validation");

  console.log("✔ SSRF Protection Tests Passed!");
}

testSsrfProtection().catch((err) => {
  console.error("❌ SSRF Test Failed:", err);
  process.exit(1);
});
