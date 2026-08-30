#!/usr/bin/env node
/**
 * Provision and start exactly one standard-1 one-WAT benchmark Container.
 * The parent Cloudflare token is accepted only from stdin. A two-hour child
 * credential is scoped to one fresh benchmark prefix and never printed.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const BENCHMARK_ROOT = "production/common-crawl/cloudflare-r2-standard1-benchmarks/v1";
const SEMANTIC_CONTRACT_ID = "growthsent-semantic-records-v2";
const CHILD_TTL_SECONDS = 7200;
const WRANGLER = ["--offline", "--yes", "wrangler@4.126.0"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASELINE_KEY_RE = /^production\/common-crawl\/audit\/public-source-baseline\/v2\/[a-z0-9][a-z0-9-]{0,63}\/PUBLIC-SOURCE-BASELINE-MANIFEST\.json$/;

function fail(message) {
  throw new Error(message);
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeCloudflareError(body) {
  return (Array.isArray(body?.errors) ? body.errors : []).slice(0, 3).map((item) => ({
    code: item?.code ?? null,
    message: typeof item?.message === "string" ? item.message.slice(0, 240) : null,
  }));
}

function safeStartError(body) {
  if (!body || typeof body !== "object") return "response was not valid JSON";
  if (typeof body.error === "string") return body.error.slice(0, 240);
  if (body.accepted === false) return "start request was rejected";
  return "unexpected start response";
}

function encodedKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function endpoint() {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function xmlTag(body, name) {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  return match ? match[1] : null;
}

async function readStdin() {
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  return Buffer.concat(parts).toString("utf8").trim();
}

function run(command, args, { cwd, input, env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (value) => output.push(value));
    child.stderr.on("data", (value) => errors.push(value));
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") }));
    child.stdin.end(input ?? "");
  });
}

async function runRequired(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) fail(`${command} failed; no Container start was requested.`);
  return result;
}

async function cloudflareFetch(path, parentApiToken, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${parentApiToken}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try { body = await response.json(); } catch { /* safe diagnostics below */ }
  return { response, body };
}

async function verifyParent(parentApiToken) {
  for (const candidate of [
    { kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` },
    { kind: "user", path: "/user/tokens/verify" },
  ]) {
    const { response, body } = await cloudflareFetch(candidate.path, parentApiToken, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") {
      return { id: body.result.id, kind: candidate.kind };
    }
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintChild(parentApiToken, parent, prefix, permission) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, parentApiToken, {
    method: "POST",
    body: JSON.stringify({
      bucket: BUCKET,
      parentAccessKeyId: parent.id,
      permission,
      ttlSeconds: CHILD_TTL_SECONDS,
      prefixes: [prefix],
    }),
  });
  const credentials = body?.result;
  if (!response.ok || !body?.success || typeof credentials?.accessKeyId !== "string" || !SHA256_RE.test(credentials?.secretAccessKey ?? "") || typeof credentials?.sessionToken !== "string") {
    fail(`Cloudflare Temporary Credentials API mint failed (${response.status}; ${JSON.stringify(safeCloudflareError(body))}).`);
  }
  return credentials;
}

async function verifyReferenceBaseline(credentials, expectedSha256, key) {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: "s3",
  });
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`Public-source baseline GetObject failed (HTTP ${response.status}).`);
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  let document = null;
  try { document = JSON.parse(body.toString("utf8")); } catch { /* checked below */ }
  if (actualSha256 !== expectedSha256 || response.headers.get("x-amz-meta-growthsent-sha256") !== actualSha256 || document?.kind !== "growthsent-public-source-baseline-manifest-v2" || document?.entry_count !== 10 || document?.semantic_contract?.id !== SEMANTIC_CONTRACT_ID || document?.semantic_contract?.version !== 2) {
    fail("Published public-source baseline does not exactly match the reviewed local semantic-v2 manifest.");
  }
  return { key, bytes: body.length, sha256: actualSha256 };
}

async function r2Preflight(credentials, prefix) {
  const client = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, service: "s3" });
  const completionKey = `${prefix}BENCHMARK-COMPLETED.json`;
  const getResponse = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(completionKey)}`, { method: "GET", headers: { Range: "bytes=0-0" } });
  const getBody = (await getResponse.text()).slice(0, 4096);
  const get = { http_status: getResponse.status, r2_error_code: xmlTag(getBody, "Code"), object_exists: getResponse.ok };
  if (get.http_status !== 404 || get.r2_error_code !== "NoSuchKey" || get.object_exists) {
    fail(`Child GetObject preflight failed (${get.http_status}; ${get.r2_error_code ?? "no R2 error code"}).`);
  }
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const listResponse = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const listBody = (await listResponse.text()).slice(0, 131072);
  const keyCount = (listBody.match(/<Key>/g) ?? []).length;
  const truncated = xmlTag(listBody, "IsTruncated") === "true";
  if (listResponse.status !== 200 || keyCount !== 0 || truncated) {
    fail(`Child ListObjectsV2 preflight failed (${listResponse.status}; key_count=${keyCount}; truncated=${truncated}).`);
  }
  return { get, list: { http_status: listResponse.status, key_count: keyCount, truncated } };
}

async function boto3Preflight(bundleDirectory, credentials, prefix) {
  const request = JSON.stringify({
    account_id: ACCOUNT_ID,
    bucket: BUCKET,
    key: `${prefix}BENCHMARK-COMPLETED.json`,
    prefix,
    access_key_id: credentials.accessKeyId,
    secret_access_key: credentials.secretAccessKey,
    session_token: credentials.sessionToken,
  });
  const packagePath = process.env.GROWTHSENT_BOTO3_SITE_PACKAGES;
  const pythonPath = packagePath ? `${packagePath}:${process.env.PYTHONPATH ?? ""}` : process.env.PYTHONPATH;
  const result = await run("python3", [resolve(bundleDirectory, "r2-boto3-preflight.py")], {
    cwd: bundleDirectory,
    input: request,
    env: { ...process.env, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) },
  });
  let diagnostic;
  try { diagnostic = JSON.parse(result.stdout); } catch { fail("boto3 child preflight returned no safe diagnostic."); }
  if (result.code !== 0 || diagnostic.get_http_status !== 404 || diagnostic.get_error_code !== "NoSuchKey" || diagnostic.list_http_status !== 200 || diagnostic.key_count !== 0 || diagnostic.truncated !== false) {
    fail("Child boto3 preflight failed; no Worker was deployed.");
  }
  return diagnostic;
}

async function workerStatus(workerUrl) {
  const response = await fetch(`${workerUrl}/_growthsent_standard1_benchmark/status`, { method: "GET" });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

function workerUrlFromDeploy(output) {
  return /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i.exec(output)?.[0] ?? null;
}

async function main() {
  const [mode, bundleDirectoryArg] = process.argv.slice(2);
  if (mode !== "--approved-one-wat-standard1-benchmark" || !bundleDirectoryArg) {
    fail("Usage: provision-and-start-wsl.mjs --approved-one-wat-standard1-benchmark <bundle-directory>");
  }
  const bundleDirectory = resolve(bundleDirectoryArg);
  const config = JSON.parse(await readFile(resolve(bundleDirectory, "wrangler.jsonc"), "utf8"));
  const benchmarkId = config?.vars?.GROWTHSENT_BENCHMARK_ID;
  const releaseSha256 = config?.vars?.GROWTHSENT_RELEASE_SHA256;
  const referenceManifestSha256 = config?.vars?.GROWTHSENT_REFERENCE_MANIFEST_SHA256;
  const referenceBaselineKey = config?.vars?.GROWTHSENT_REFERENCE_BASELINE_KEY;
  const hardTimeoutSeconds = Number(config?.vars?.GROWTHSENT_HARD_TIMEOUT_SECONDS);
  const workerName = config?.name;
  const container = config?.containers?.[0];
  if (typeof benchmarkId !== "string" || typeof workerName !== "string" || !SHA256_RE.test(releaseSha256 ?? "") || !SHA256_RE.test(referenceManifestSha256 ?? "") || !BASELINE_KEY_RE.test(referenceBaselineKey ?? "") || hardTimeoutSeconds !== 6600 || container?.instance_type !== "standard-1" || container?.max_instances !== 1 || container?.class_name !== "GrowthSentStandard1BenchmarkContainer") {
    fail("The local bundle is not the reviewed one-WAT standard-1 benchmark configuration.");
  }

  let parentApiToken = await readStdin();
  if (!parentApiToken) fail("A parent Cloudflare API token is required.");
  let childCredentials = null;
  try {
    const prefix = `${BENCHMARK_ROOT}/${benchmarkId}/`;
    const baselinePrefix = referenceBaselineKey.slice(0, referenceBaselineKey.lastIndexOf("/") + 1);
    const parent = await verifyParent(parentApiToken);
    const baselineChild = await mintChild(parentApiToken, parent, baselinePrefix, "object-read-only");
    const baseline = await verifyReferenceBaseline(baselineChild, referenceManifestSha256, referenceBaselineKey);
    json({ stage: "published_reference_baseline", accepted: true, ...baseline, semantic_contract: SEMANTIC_CONTRACT_ID });
    childCredentials = await mintChild(parentApiToken, parent, prefix, "object-read-write");
    json({ stage: "server_minted_child", accepted: true, parent_token_kind: parent.kind, scope: "object-read-write", ttl_seconds: CHILD_TTL_SECONDS, prefix });
    json({ stage: "child_aws4fetch", ...(await r2Preflight(childCredentials, prefix)) });
    json({ stage: "child_boto3", result: await boto3Preflight(bundleDirectory, childCredentials, prefix) });

    await runRequired("npx", [...WRANGLER, "deploy", "--dry-run", "--config", "wrangler.jsonc"], { cwd: bundleDirectory });
    const deploy = await runRequired("npx", [...WRANGLER, "deploy", "--config", "wrangler.jsonc"], { cwd: bundleDirectory });
    const workerUrl = workerUrlFromDeploy(`${deploy.stdout}\n${deploy.stderr}`);
    if (!workerUrl) fail("Worker deployed but Wrangler did not report a workers.dev URL; no secrets were installed.");

    const triggerToken = randomBytes(32).toString("base64url");
    await writeFile(resolve(bundleDirectory, "BENCHMARK-CONTEXT.json"), `${JSON.stringify({
      benchmark_id: benchmarkId,
      worker_name: workerName,
      worker_url: workerUrl,
      r2_prefix: prefix,
      reference_baseline_key: referenceBaselineKey,
      release_sha256: releaseSha256,
      hard_timeout_seconds: hardTimeoutSeconds,
      child_credential_ttl_seconds: CHILD_TTL_SECONDS,
      parent_token_kind: parent.kind,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await runRequired("npx", [...WRANGLER, "secret", "bulk", "--name", workerName], {
      cwd: bundleDirectory,
      input: JSON.stringify({
        GROWTHSENT_R2_ACCESS_KEY_ID: childCredentials.accessKeyId,
        GROWTHSENT_R2_SECRET_ACCESS_KEY: childCredentials.secretAccessKey,
        GROWTHSENT_R2_SESSION_TOKEN: childCredentials.sessionToken,
        BENCHMARK_TRIGGER_TOKEN: triggerToken,
      }),
    });
    let status = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      status = await workerStatus(workerUrl);
      if (status?.control_secret_configured) break;
    }
    if (!status || status.benchmark_id !== benchmarkId || status.control_secret_configured !== true || status.state !== "stopped" || status.terminal !== null) {
      fail("Fresh Worker/Container state was not safe to start; no Container start request was sent.");
    }
    const start = await fetch(`${workerUrl}/_growthsent_standard1_benchmark/start`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: triggerToken });
    let startResult = null;
    try { startResult = await start.json(); } catch { /* checked below */ }
    if (start.status !== 202 || startResult?.accepted !== true || startResult?.benchmark_id !== benchmarkId) {
      fail(`Container start was not accepted (HTTP ${start.status}; ${safeStartError(startResult)}); no retry was attempted.`);
    }
    json({ stage: "start", http_status: 202, accepted: true, benchmark_id: benchmarkId });
    json({ status: "live_start_accepted", benchmark_id: benchmarkId, context: resolve(bundleDirectory, "BENCHMARK-CONTEXT.json") });
  } finally {
    parentApiToken = "";
    childCredentials = null;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512) : "unknown standard-1 provisioner error";
  json({ status: "failed", error: message });
  process.exitCode = 1;
});
