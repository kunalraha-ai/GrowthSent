#!/usr/bin/env node
/** Publish one immutable public-source v2 baseline and completion marker to R2. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const DEFAULT_PREFIX = "production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/";
const CHILD_TTL_SECONDS = 900;
const SHA256_RE = /^[0-9a-f]{64}$/;

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8");
}

function encodedKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function endpoint() {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function xmlValue(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? match[1] : null;
}

function safeCloudflareErrors(body) {
  return (Array.isArray(body?.errors) ? body.errors : []).slice(0, 3).map((item) => ({
    code: item?.code ?? null,
    message: typeof item?.message === "string" ? item.message.slice(0, 240) : null,
  }));
}

function auditConfig() {
  const prefix = process.env.GROWTHSENT_AUDIT_PREFIX ?? DEFAULT_PREFIX;
  if (typeof prefix !== "string" || !/^production\/common-crawl\/audit\/public-source-baseline\/v2\/[a-z0-9][a-z0-9-]{0,63}\/$/.test(prefix)) {
    fail("The audit prefix must be one isolated public-source-baseline v2 namespace.");
  }
  return {
    prefix,
    manifestKey: `${prefix}PUBLIC-SOURCE-BASELINE-MANIFEST.json`,
    completionKey: `${prefix}PUBLIC-SOURCE-BASELINE-COMPLETED.json`,
  };
}

async function stdinText() {
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  return Buffer.concat(parts).toString("utf8").trim();
}

async function cloudflareFetch(path, token, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try { body = await response.json(); } catch { /* safe error below */ }
  return { response, body };
}

async function verifyParent(token) {
  for (const candidate of [
    { kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` },
    { kind: "user", path: "/user/tokens/verify" },
  ]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") {
      return { kind: candidate.kind, id: body.result.id };
    }
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintChild(token, parent, prefix) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({
      bucket: BUCKET,
      parentAccessKeyId: parent.id,
      permission: "object-read-write",
      ttlSeconds: CHILD_TTL_SECONDS,
      prefixes: [prefix],
    }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") {
    fail(`Cloudflare Temporary Credentials API mint failed (${response.status}; ${JSON.stringify(safeCloudflareErrors(body))}).`);
  }
  return result;
}

async function listObjects(client, prefix) {
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const body = await response.text();
  if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
  if (xmlValue(body, "IsTruncated") === "true") fail("R2 audit prefix listing was unexpectedly truncated.");
  return [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => match[1]);
}

async function verifyExactObject(client, key, expected) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject verification failed for ${key} with HTTP ${response.status}.`);
  const metadataDigest = response.headers.get("x-amz-meta-growthsent-sha256");
  if (body.length !== expected.bytes || sha256(body) !== expected.sha256 || metadataDigest !== expected.sha256) {
    fail(`R2 immutable object verification failed for ${key}.`);
  }
  return { key, bytes: body.length, sha256: expected.sha256 };
}

async function putImmutableJson(client, key, body) {
  const expected = { bytes: body.length, sha256: sha256(body) };
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "if-none-match": "*",
      "x-amz-meta-growthsent-sha256": expected.sha256,
    },
    body,
  });
  if (!response.ok) {
    const diagnostic = (await response.text()).slice(0, 2048);
    fail(`R2 conditional immutable publication failed for ${key} (HTTP ${response.status}; ${xmlValue(diagnostic, "Code") ?? "unknown"}).`);
  }
  return verifyExactObject(client, key, expected);
}

async function main() {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) fail("Usage: publish-public-baseline-v2-wsl.mjs <local-manifest-path>");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length === 0 || manifestBytes.length > 2_000_000) fail("Local baseline manifest has an unsafe size.");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("Local baseline manifest is not valid UTF-8 JSON."); }
  if (manifest?.kind !== "growthsent-public-source-baseline-manifest-v2" || manifest?.entry_count !== 10 || manifest?.semantic_contract?.id !== "growthsent-semantic-records-v2" || manifest?.semantic_contract?.version !== 2) {
    fail("Local baseline manifest is not the reviewed ten-WAT semantic v2 document.");
  }
  const audit = auditConfig();
  const completionBytes = canonicalJson({
    baseline_manifest: { bytes: manifestBytes.length, key: audit.manifestKey, sha256: sha256(manifestBytes) },
    entry_count: 10,
    format_version: 2,
    kind: "growthsent-public-source-baseline-completed-v2",
    semantic_contract: "growthsent-semantic-records-v2",
  });
  let parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  let child = null;
  try {
    const parent = await verifyParent(parentToken);
    child = await mintChild(parentToken, parent, audit.prefix);
    json({ stage: "server_minted_child", accepted: true, parent_token_kind: parent.kind, scope: "object-read-write", ttl_seconds: CHILD_TTL_SECONDS, prefix: audit.prefix });
    const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
    const existing = await listObjects(client, audit.prefix);
    if (existing.length !== 0) fail(`Audit prefix is unexpectedly non-empty (${existing.length} object(s)); refusing to overwrite.`);
    json({ stage: "empty_prefix_preflight", object_count: 0 });
    const manifestResult = await putImmutableJson(client, audit.manifestKey, manifestBytes);
    const completionResult = await putImmutableJson(client, audit.completionKey, completionBytes);
    const publishedKeys = (await listObjects(client, audit.prefix)).sort();
    if (JSON.stringify(publishedKeys) !== JSON.stringify([audit.manifestKey, audit.completionKey].sort())) {
      fail("R2 audit prefix does not exactly match the two-object immutable publication contract.");
    }
    json({ status: "published", manifest: manifestResult, completion_marker: completionResult, completion_marker_written_last: true, audit_prefix: audit.prefix, exact_object_count: publishedKeys.length });
  } finally {
    parentToken = "";
    child = null;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512) : "unknown baseline publisher error";
  json({ status: "failed", error: message });
  process.exitCode = 1;
});
