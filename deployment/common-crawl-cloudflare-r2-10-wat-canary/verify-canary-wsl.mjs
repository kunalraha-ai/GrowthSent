#!/usr/bin/env node
/**
 * Read-only integrity and public-source-baseline verifier for one bounded
 * Cloudflare Container ten-WAT canary. Credentials arrive only on stdin,
 * are used locally to mint a fresh read-only child credential, and are never
 * written to disk or emitted in a diagnostic.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const CANARY_ROOT = "production/common-crawl/cloudflare-r2-canaries/v1";
const AUDIT_MANIFEST_KEY = process.env.GROWTHSENT_AUDIT_MANIFEST_KEY ?? "";
const AUDIT_MANIFEST_SHA256 = process.env.GROWTHSENT_AUDIT_MANIFEST_SHA256 ?? "";
const SEMANTIC_CONTRACT_ID = "growthsent-semantic-records-v2";
const SHA256_RE = /^[0-9a-f]{64}$/;
const CANARY_ID_RE = /^cc-main-2026-30-[a-z0-9-]+$/;
const CHILD_TTL_SECONDS = 3600;

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function safeCloudflareErrors(body) {
  return (Array.isArray(body?.errors) ? body.errors : []).slice(0, 3).map((item) => ({
    code: item?.code ?? null,
    message: typeof item?.message === "string" ? item.message.slice(0, 240) : null,
  }));
}

function redacted(message) {
  return String(message).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512);
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
  try { body = await response.json(); } catch { /* safe diagnostic below */ }
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

async function mintReadOnlyChild(token, parent, prefixes, objects) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({
      bucket: BUCKET,
      parentAccessKeyId: parent.id,
      permission: "object-read-only",
      ttlSeconds: CHILD_TTL_SECONDS,
      prefixes,
      objects,
    }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") {
    fail(`Cloudflare read-only child mint failed (${response.status}; ${JSON.stringify(safeCloudflareErrors(body))}).`);
  }
  return result;
}

function endpoint() {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function encodedKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function xmlValue(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? match[1] : null;
}

function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity] ?? entity);
}

async function listObjects(client, prefix) {
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const body = await response.text();
  if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
  if (xmlValue(body, "IsTruncated") === "true") fail("R2 verifier refuses a truncated canary listing.");
  const objects = [];
  for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const content = match[1];
    const key = xmlValue(content, "Key");
    const size = xmlValue(content, "Size");
    const lastModified = xmlValue(content, "LastModified");
    if (key === null || size === null || lastModified === null || !/^\d+$/.test(size)) fail("R2 ListObjectsV2 returned malformed object metadata.");
    objects.push({ key: decodeXml(key), bytes: Number(size), last_modified: lastModified });
  }
  return objects;
}

async function headObject(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "HEAD" });
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
    ? Number(contentLengthHeader)
    : null;
  const digest = response.headers.get("x-amz-meta-growthsent-sha256");
  return {
    key,
    http_status: response.status,
    content_length: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
    content_length_source: contentLength === null ? null : "head_object",
    growthsent_sha256: typeof digest === "string" ? digest : null,
    last_modified: response.headers.get("last-modified"),
  };
}

async function getJson(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject JSON failed for ${key} with HTTP ${response.status}.`);
  let value;
  try { value = JSON.parse(body.toString("utf8")); } catch { fail(`R2 object is not valid UTF-8 JSON: ${key}`); }
  return { key, bytes: body.length, sha256: sha256(body), value };
}

function must(condition, message, errors) {
  if (!condition) errors.push(message);
}

function expectedKeys(canaryPrefix, entries) {
  const keys = [
    `${canaryPrefix}CANARY-INPUT-MANIFEST.json`,
    `${canaryPrefix}CANARY-SUMMARY.json`,
    `${canaryPrefix}CANARY-COMPLETED.json`,
  ];
  for (const entry of entries) {
    const suffix = entry?.deterministic_suffix;
    if (typeof suffix !== "string" || !/^[0-9a-f]{16}$/.test(suffix)) fail("Audit manifest contains an invalid deterministic suffix.");
    keys.push(
      `${canaryPrefix}crawl=CC-MAIN-2026-30/dataset=pages/part-${suffix}.parquet`,
      `${canaryPrefix}crawl=CC-MAIN-2026-30/dataset=links/part-${suffix}.parquet`,
      `${canaryPrefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`,
      `${canaryPrefix}control/wats/part-${suffix}/WAT-COMPLETED.json`,
    );
  }
  return keys.sort();
}

function sourceTelemetry(value) {
  return {
    source_key: value?.source_key ?? null,
    downloaded_bytes: value?.source_transport?.downloaded_bytes ?? null,
    retry_count: value?.source_transport?.retries ?? null,
    http_status_history: value?.source_transport?.http_status_history ?? null,
    source_download_seconds: value?.source_transport?.elapsed_seconds ?? null,
    source_url: value?.source_transport?.source_url ?? null,
  };
}

function isSameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

async function main() {
  const [canaryId, outputDirectoryArg] = process.argv.slice(2);
  if (!CANARY_ID_RE.test(canaryId ?? "") || !outputDirectoryArg) fail("Usage: verify-canary-wsl.mjs <canary-id> <output-directory>");
  const outputDirectory = resolve(outputDirectoryArg);
  const canaryPrefix = `${CANARY_ROOT}/${canaryId}/`;
  if (!AUDIT_MANIFEST_KEY.startsWith("production/common-crawl/audit/public-source-baseline/v2/") || !SHA256_RE.test(AUDIT_MANIFEST_SHA256)) {
    fail("A reviewed public-source baseline v2 key and SHA-256 are required.");
  }
  const parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  let child = null;
  try {
    const parent = await verifyParent(parentToken);
    child = await mintReadOnlyChild(parentToken, parent, [canaryPrefix], [AUDIT_MANIFEST_KEY]);
    json({ stage: "read_only_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: CHILD_TTL_SECONDS, prefixes: [canaryPrefix], objects: [AUDIT_MANIFEST_KEY] });
    const client = new AwsClient({
      accessKeyId: child.accessKeyId,
      secretAccessKey: child.secretAccessKey,
      sessionToken: child.sessionToken,
      service: "s3",
    });

    const audit = await getJson(client, AUDIT_MANIFEST_KEY);
    if (audit.sha256 !== AUDIT_MANIFEST_SHA256) fail("The immutable public-source baseline SHA-256 does not match the reviewed local copy.");
    const auditEntries = audit.value?.entries;
    if (!Array.isArray(auditEntries) || auditEntries.length !== 10 || audit.value?.semantic_contract?.id !== SEMANTIC_CONTRACT_ID || audit.value?.semantic_contract?.version !== 2) {
      fail("The immutable public-source baseline does not declare the reviewed ten-WAT semantic v2 contract.");
    }

    const objects = await listObjects(client, canaryPrefix);
    const actualKeys = objects.map((object) => object.key).sort();
    const expected = expectedKeys(canaryPrefix, auditEntries);
    const verificationErrors = [];
    must(isSameArray(actualKeys, expected), "canary prefix keys do not exactly match the expected 43-object contract", verificationErrors);
    const listedByKey = new Map(objects.map((object) => [object.key, object]));
    const heads = [];
    for (const key of actualKeys) heads.push(await headObject(client, key));
    for (const object of heads) {
      const listed = listedByKey.get(object.key);
      must(object.http_status === 200, `HeadObject did not return HTTP 200 for ${object.key}`, verificationErrors);
      must(Boolean(listed), `ListObjectsV2 has no matching object for ${object.key}`, verificationErrors);
      must(
        object.content_length === null || object.content_length === listed?.bytes,
        `HeadObject ContentLength differs from ListObjectsV2 for ${object.key}`,
        verificationErrors,
      );
      if (object.content_length === null && listed) {
        // R2 may omit Content-Length on a signed HEAD response. ListObjectsV2
        // carries the authoritative object Size, so use it only as that safe
        // fallback and retain its source in the report.
        object.content_length = listed.bytes;
        object.content_length_source = "list_objects_v2";
      }
      must(object.content_length !== null, `R2 did not provide a valid ContentLength for ${object.key}`, verificationErrors);
      must(SHA256_RE.test(object.growthsent_sha256 ?? ""), `missing or malformed growthsent-sha256 metadata for ${object.key}`, verificationErrors);
    }
    const headByKey = new Map(heads.map((object) => [object.key, object]));
    const jsonKeys = actualKeys.filter((key) => key.endsWith(".json"));
    const jsonByKey = new Map();
    for (const key of jsonKeys) {
      const value = await getJson(client, key);
      jsonByKey.set(key, value);
      const head = headByKey.get(key);
      must(head?.content_length === value.bytes, `JSON byte count differs from HeadObject for ${key}`, verificationErrors);
      must(head?.growthsent_sha256 === value.sha256, `JSON SHA-256 metadata differs from its full downloaded digest for ${key}`, verificationErrors);
    }

    const input = jsonByKey.get(`${canaryPrefix}CANARY-INPUT-MANIFEST.json`)?.value;
    const summary = jsonByKey.get(`${canaryPrefix}CANARY-SUMMARY.json`)?.value;
    const completion = jsonByKey.get(`${canaryPrefix}CANARY-COMPLETED.json`)?.value;
    must(input?.canary_id === canaryId && input?.input_count === 10, "input manifest does not identify this exact ten-WAT canary", verificationErrors);
    must(input?.reference_manifest_sha256 === AUDIT_MANIFEST_SHA256 && input?.semantic_contract?.id === SEMANTIC_CONTRACT_ID, "input manifest does not bind to the reviewed semantic v2 baseline", verificationErrors);
    must(summary?.kind === "growthsent-cloudflare-r2-ten-wat-summary" && summary?.canary_id === canaryId, "summary identity is invalid", verificationErrors);
    must(summary?.reference_manifest_sha256 === AUDIT_MANIFEST_SHA256 && summary?.input_count === 10 && summary?.semantic_contract?.id === SEMANTIC_CONTRACT_ID, "summary semantic-baseline binding is invalid", verificationErrors);
    must(completion?.kind === "growthsent-cloudflare-r2-ten-wat-completed" && completion?.canary_id === canaryId, "completion marker identity is invalid", verificationErrors);
    must(completion?.reference_manifest_sha256 === AUDIT_MANIFEST_SHA256 && completion?.input_count === 10 && completion?.semantic_contract?.id === SEMANTIC_CONTRACT_ID, "completion marker semantic-baseline binding is invalid", verificationErrors);
    const summaryHead = headByKey.get(`${canaryPrefix}CANARY-SUMMARY.json`);
    const completionHead = headByKey.get(`${canaryPrefix}CANARY-COMPLETED.json`);
    must(completion?.summary?.key === `${canaryPrefix}CANARY-SUMMARY.json`, "completion marker references an unexpected summary key", verificationErrors);
    must(completion?.summary?.bytes === summaryHead?.content_length && completion?.summary?.sha256 === summaryHead?.growthsent_sha256, "completion marker summary size/hash contract does not match R2", verificationErrors);
    must(completion?.completion?.key === undefined, "completion marker unexpectedly contains a nested completion result", verificationErrors);
    const completionListed = listedByKey.get(`${canaryPrefix}CANARY-COMPLETED.json`);
    const laterObjects = objects.filter((object) => object.last_modified > (completionListed?.last_modified ?? "")).map((object) => object.key);
    must(laterObjects.length === 0, "an object was modified after the completion marker", verificationErrors);

    const expectedBySource = new Map(auditEntries.map((entry) => [entry.source_key, entry]));
    const outcomes = Array.isArray(summary?.outcomes) ? summary.outcomes : [];
    must(outcomes.length === 10, "summary does not contain exactly ten outcomes", verificationErrors);
    const telemetry = [];
    for (const outcome of outcomes) {
      const expectedEntry = expectedBySource.get(outcome?.source_key);
      const verification = outcome?.semantic_verification;
      must(Boolean(expectedEntry), `summary contains an unexpected source key: ${String(outcome?.source_key)}`, verificationErrors);
      if (!expectedEntry) continue;
      must(outcome?.deterministic_suffix === expectedEntry.deterministic_suffix, `deterministic suffix differs for ${expectedEntry.source_key}`, verificationErrors);
      must(verification?.passed === true && verification?.semantic_contract === SEMANTIC_CONTRACT_ID, `semantic v2 verification did not pass for ${expectedEntry.source_key}`, verificationErrors);
      for (const field of ["pages_count", "links_count", "malformed_count", "canonical_pages_digest", "canonical_links_digest", "canonical_record_digest"]) {
        must(verification?.[field] === expectedEntry[field], `${field} differs from the audit manifest for ${expectedEntry.source_key}`, verificationErrors);
      }
      must(verification?.target_host_bucket_digest === expectedEntry?.target_host_bucket?.target_host_bucket_digest, `target_host_bucket_digest differs from the audit manifest for ${expectedEntry.source_key}`, verificationErrors);
      must(verification?.canonical_pages_digest_match === true && verification?.canonical_links_digest_match === true, `canonical Pages/Links digest match is not true for ${expectedEntry.source_key}`, verificationErrors);
      must(typeof verification?.canonical_record_digest_algorithm === "string" && typeof verification?.target_host_bucket_digest_algorithm === "string", `semantic digest algorithm is absent for ${expectedEntry.source_key}`, verificationErrors);
      const artifacts = Array.isArray(outcome?.artifacts) ? outcome.artifacts : [];
      must(artifacts.length === 3, `summary does not contain exactly three artifacts for ${expectedEntry.source_key}`, verificationErrors);
      for (const artifact of artifacts) {
        const head = headByKey.get(artifact?.key);
        must(Boolean(head), `summary artifact is missing from the canary prefix: ${String(artifact?.key)}`, verificationErrors);
        must(head?.content_length === artifact?.bytes && head?.growthsent_sha256 === artifact?.sha256, `summary artifact size/hash contract differs from R2: ${String(artifact?.key)}`, verificationErrors);
      }
      const metricsKey = `${canaryPrefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${expectedEntry.deterministic_suffix}.json`;
      const metrics = jsonByKey.get(metricsKey)?.value;
      must(metrics?.canary_id === canaryId && metrics?.release_sha256 === summary?.release_sha256, `metrics identity is invalid for ${expectedEntry.source_key}`, verificationErrors);
      must(metrics?.semantic_verification?.semantic_contract === SEMANTIC_CONTRACT_ID && metrics?.semantic_verification?.canonical_record_digest === expectedEntry.canonical_record_digest && metrics?.semantic_verification?.target_host_bucket_digest === expectedEntry.target_host_bucket.target_host_bucket_digest, `metrics semantic digest differs from the v2 baseline for ${expectedEntry.source_key}`, verificationErrors);
      const watCompletionKey = `${canaryPrefix}control/wats/part-${expectedEntry.deterministic_suffix}/WAT-COMPLETED.json`;
      const watCompletion = jsonByKey.get(watCompletionKey)?.value;
      must(watCompletion?.source_key === expectedEntry.source_key && watCompletion?.semantic_verification?.passed === true, `per-WAT completion is invalid for ${expectedEntry.source_key}`, verificationErrors);
      telemetry.push(sourceTelemetry(outcome));
    }
    must(new Set(outcomes.map((outcome) => outcome?.source_key)).size === 10, "summary outcomes contain duplicate source keys", verificationErrors);
    const allPayloadBytes = heads.reduce((total, object) => total + (object.content_length ?? 0), 0);
    const report = {
      kind: "growthsent-cloudflare-r2-ten-wat-verification-report",
      canary_id: canaryId,
      canary_prefix: canaryPrefix,
      read_only_child_ttl_seconds: CHILD_TTL_SECONDS,
      reference_baseline: { key: AUDIT_MANIFEST_KEY, sha256: audit.sha256, entries: auditEntries.length, semantic_contract: SEMANTIC_CONTRACT_ID },
      r2: {
        exact_object_count: actualKeys.length,
        expected_object_count: expected.length,
        exact_object_keys: actualKeys,
        total_bytes: allPayloadBytes,
        object_integrity: heads.map((object) => ({
          key: object.key,
          content_length: object.content_length,
          content_length_source: object.content_length_source,
          growthsent_sha256: object.growthsent_sha256,
        })),
        all_growthsent_sha256_metadata_valid: heads.every((object) => SHA256_RE.test(object.growthsent_sha256 ?? "")),
        json_full_hashes_match_metadata: jsonKeys.every((key) => {
          const item = jsonByKey.get(key);
          return item && item.sha256 === headByKey.get(key)?.growthsent_sha256;
        }),
        completion_marker_written_last: laterObjects.length === 0,
        objects_after_completion_marker: laterObjects,
      },
      correctness: {
        reference_equivalence_passed: verificationErrors.length === 0,
        semantic_entries_verified: outcomes.length,
        aggregate: summary?.aggregate ?? null,
        source_telemetry: telemetry,
      },
      container_runtime: summary?.container_runtime ?? completion?.container_runtime ?? null,
      completion: completion ?? null,
      errors: verificationErrors,
    };
    await writeFile(resolve(outputDirectory, "VERIFICATION-REPORT.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    json({ status: verificationErrors.length === 0 ? "verified" : "verification_failed", canary_id: canaryId, object_count: actualKeys.length, total_bytes: allPayloadBytes, reference_equivalence_passed: verificationErrors.length === 0, error_count: verificationErrors.length, report: resolve(outputDirectory, "VERIFICATION-REPORT.json") });
    if (verificationErrors.length > 0) process.exitCode = 1;
  } finally {
    child = null;
  }
}

main().catch((error) => {
  json({ status: "failed", error: redacted(error instanceof Error ? error.message : "unknown verifier error") });
  process.exitCode = 1;
});
