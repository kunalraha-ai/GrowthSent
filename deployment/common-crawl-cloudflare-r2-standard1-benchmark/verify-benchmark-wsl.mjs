#!/usr/bin/env node
/** Read-only integrity verifier for one standard-1 one-WAT benchmark. */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const BENCHMARK_ROOT = "production/common-crawl/cloudflare-r2-standard1-benchmarks/v1";
const SEMANTIC_CONTRACT_ID = "growthsent-semantic-records-v2";
const CHILD_TTL_SECONDS = 3600;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BENCHMARK_ID_RE = /^cc-main-2026-30-[a-z0-9-]+$/;
const BASELINE_KEY_RE = /^production\/common-crawl\/audit\/public-source-baseline\/v2\/[a-z0-9][a-z0-9-]{0,63}\/PUBLIC-SOURCE-BASELINE-MANIFEST\.json$/;

function json(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function redacted(message) { return String(message).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlValue(xml, name) { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null; }
function decodeXml(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (item) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[item] ?? item); }
function must(condition, message, errors) { if (!condition) errors.push(message); }

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
  for (const candidate of [{ kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` }, { kind: "user", path: "/user/tokens/verify" }]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") return { kind: candidate.kind, id: body.result.id };
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintReadOnlyChild(token, parent, prefixes, objects) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-only", ttlSeconds: CHILD_TTL_SECONDS, prefixes, objects }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") {
    fail(`Cloudflare read-only child mint failed (HTTP ${response.status}).`);
  }
  return result;
}

async function listObjects(client, prefix) {
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const body = await response.text();
  if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
  if (xmlValue(body, "IsTruncated") === "true") fail("R2 verifier refuses a truncated benchmark listing.");
  const values = [];
  for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const content = match[1];
    const key = xmlValue(content, "Key");
    const size = xmlValue(content, "Size");
    const lastModified = xmlValue(content, "LastModified");
    if (key === null || size === null || lastModified === null || !/^\d+$/.test(size)) fail("R2 ListObjectsV2 returned malformed object metadata.");
    values.push({ key: decodeXml(key), bytes: Number(size), last_modified: lastModified });
  }
  return values;
}

async function headObject(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "HEAD" });
  const length = response.headers.get("content-length");
  return {
    key,
    http_status: response.status,
    content_length: length !== null && /^\d+$/.test(length) ? Number(length) : null,
    content_length_source: length !== null && /^\d+$/.test(length) ? "head_object" : null,
    growthsent_sha256: response.headers.get("x-amz-meta-growthsent-sha256"),
    last_modified: response.headers.get("last-modified"),
  };
}

async function getJson(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject JSON failed for ${key} with HTTP ${response.status}.`);
  try { return { key, bytes: body.length, sha256: sha256(body), value: JSON.parse(body.toString("utf8")) }; }
  catch { fail(`R2 object is not valid UTF-8 JSON: ${key}`); }
}

function expectedKeys(prefix, entry) {
  const suffix = entry?.deterministic_suffix;
  if (typeof suffix !== "string" || !/^[0-9a-f]{16}$/.test(suffix)) fail("Baseline has an invalid deterministic suffix.");
  return [
    `${prefix}BENCHMARK-INPUT-MANIFEST.json`,
    `${prefix}BENCHMARK-SUMMARY.json`,
    `${prefix}BENCHMARK-COMPLETED.json`,
    `${prefix}crawl=CC-MAIN-2026-30/dataset=pages/part-${suffix}.parquet`,
    `${prefix}crawl=CC-MAIN-2026-30/dataset=links/part-${suffix}.parquet`,
    `${prefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`,
    `${prefix}control/wats/part-${suffix}/WAT-COMPLETED.json`,
  ].sort();
}

async function main() {
  const [benchmarkId, outputDirectoryArg] = process.argv.slice(2);
  const baselineKey = process.env.GROWTHSENT_REFERENCE_BASELINE_KEY ?? "";
  const baselineSha256 = process.env.GROWTHSENT_REFERENCE_MANIFEST_SHA256 ?? "";
  if (!BENCHMARK_ID_RE.test(benchmarkId ?? "") || !outputDirectoryArg) fail("Usage: verify-benchmark-wsl.mjs <benchmark-id> <output-directory>");
  if (!BASELINE_KEY_RE.test(baselineKey) || !SHA256_RE.test(baselineSha256)) fail("An exact public-source-baseline v2 key and matching local SHA-256 are required.");
  const parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  const benchmarkPrefix = `${BENCHMARK_ROOT}/${benchmarkId}/`;
  try {
    const parent = await verifyParent(parentToken);
    const child = await mintReadOnlyChild(parentToken, parent, [benchmarkPrefix], [baselineKey]);
    json({ stage: "read_only_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: CHILD_TTL_SECONDS, prefixes: [benchmarkPrefix], objects: [baselineKey] });
    const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
    const baseline = await getJson(client, baselineKey);
    if (baseline.sha256 !== baselineSha256) fail("The published baseline SHA-256 does not match the reviewed local copy.");
    const entries = baseline.value?.entries;
    if (!Array.isArray(entries) || entries.length !== 10 || baseline.value?.semantic_contract?.id !== SEMANTIC_CONTRACT_ID || baseline.value?.semantic_contract?.version !== 2) fail("The published baseline does not declare the reviewed ten-WAT semantic-v2 contract.");
    const entry = entries[0];
    const objects = await listObjects(client, benchmarkPrefix);
    const actualKeys = objects.map((item) => item.key).sort();
    const expected = expectedKeys(benchmarkPrefix, entry);
    const errors = [];
    must(JSON.stringify(actualKeys) === JSON.stringify(expected), "benchmark prefix keys do not exactly match the seven-object contract", errors);
    const listedByKey = new Map(objects.map((item) => [item.key, item]));
    const heads = [];
    for (const key of actualKeys) heads.push(await headObject(client, key));
    for (const head of heads) {
      const listed = listedByKey.get(head.key);
      must(head.http_status === 200, `HeadObject did not return HTTP 200 for ${head.key}`, errors);
      if (head.content_length === null && listed) { head.content_length = listed.bytes; head.content_length_source = "list_objects_v2"; }
      must(head.content_length === listed?.bytes, `object size mismatch for ${head.key}`, errors);
      must(SHA256_RE.test(head.growthsent_sha256 ?? ""), `missing or malformed growthsent SHA-256 metadata for ${head.key}`, errors);
    }
    const headsByKey = new Map(heads.map((item) => [item.key, item]));
    const jsonByKey = new Map();
    for (const key of actualKeys.filter((item) => item.endsWith(".json"))) {
      const item = await getJson(client, key);
      jsonByKey.set(key, item);
      const head = headsByKey.get(key);
      must(head?.content_length === item.bytes && head?.growthsent_sha256 === item.sha256, `JSON R2 integrity mismatch for ${key}`, errors);
    }
    const input = jsonByKey.get(`${benchmarkPrefix}BENCHMARK-INPUT-MANIFEST.json`)?.value;
    const summary = jsonByKey.get(`${benchmarkPrefix}BENCHMARK-SUMMARY.json`)?.value;
    const completion = jsonByKey.get(`${benchmarkPrefix}BENCHMARK-COMPLETED.json`)?.value;
    must(input?.benchmark_id === benchmarkId && input?.input_count === 1 && input?.selected_reference_entry_index === 0, "input manifest identity is invalid", errors);
    must(input?.reference_manifest_sha256 === baselineSha256 && input?.semantic_contract?.id === SEMANTIC_CONTRACT_ID, "input manifest baseline binding is invalid", errors);
    must(summary?.kind === "growthsent-cloudflare-r2-standard1-one-wat-benchmark-summary" && summary?.benchmark_id === benchmarkId && summary?.input_count === 1, "summary identity is invalid", errors);
    must(completion?.kind === "growthsent-cloudflare-r2-standard1-one-wat-benchmark-completed" && completion?.benchmark_id === benchmarkId && completion?.input_count === 1, "completion identity is invalid", errors);
    const summaryHead = headsByKey.get(`${benchmarkPrefix}BENCHMARK-SUMMARY.json`);
    must(completion?.summary?.key === `${benchmarkPrefix}BENCHMARK-SUMMARY.json` && completion?.summary?.bytes === summaryHead?.content_length && completion?.summary?.sha256 === summaryHead?.growthsent_sha256, "completion summary contract differs from R2", errors);
    const outcome = Array.isArray(summary?.outcomes) && summary.outcomes.length === 1 ? summary.outcomes[0] : null;
    const semantic = outcome?.semantic_verification;
    must(outcome?.source_key === entry?.source_key && outcome?.deterministic_suffix === entry?.deterministic_suffix, "outcome source identity differs from the selected baseline entry", errors);
    for (const field of ["pages_count", "links_count", "malformed_count", "canonical_pages_digest", "canonical_links_digest", "canonical_record_digest"]) must(semantic?.[field] === entry?.[field], `${field} differs from the selected baseline entry`, errors);
    must(semantic?.passed === true && semantic?.semantic_contract === SEMANTIC_CONTRACT_ID && semantic?.target_host_bucket_digest === entry?.target_host_bucket?.target_host_bucket_digest, "semantic-v2 verification does not match the selected baseline entry", errors);
    const artifacts = Array.isArray(outcome?.artifacts) ? outcome.artifacts : [];
    must(artifacts.length === 3, "outcome does not contain Pages, Links, and Metrics artifacts", errors);
    for (const artifact of artifacts) {
      const head = headsByKey.get(artifact?.key);
      must(head?.content_length === artifact?.bytes && head?.growthsent_sha256 === artifact?.sha256, `outcome artifact contract differs from R2: ${String(artifact?.key)}`, errors);
    }
    const metricsKey = `${benchmarkPrefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${entry?.deterministic_suffix}.json`;
    const metrics = jsonByKey.get(metricsKey)?.value;
    must(metrics?.benchmark_id === benchmarkId && metrics?.semantic_verification?.canonical_record_digest === entry?.canonical_record_digest, "metrics identity or semantic digest is invalid", errors);
    const watCompletion = jsonByKey.get(`${benchmarkPrefix}control/wats/part-${entry?.deterministic_suffix}/WAT-COMPLETED.json`)?.value;
    must(watCompletion?.benchmark_id === benchmarkId && watCompletion?.source_key === entry?.source_key && watCompletion?.semantic_verification?.passed === true, "per-WAT completion is invalid", errors);
    const finalListed = listedByKey.get(`${benchmarkPrefix}BENCHMARK-COMPLETED.json`);
    const laterObjects = objects.filter((item) => item.last_modified > (finalListed?.last_modified ?? "")).map((item) => item.key);
    must(laterObjects.length === 0, "an object was modified after the benchmark completion marker", errors);
    const report = {
      kind: "growthsent-cloudflare-r2-standard1-one-wat-benchmark-verification-report",
      benchmark_id: benchmarkId,
      benchmark_prefix: benchmarkPrefix,
      reference_baseline: { key: baselineKey, sha256: baseline.sha256, selected_reference_entry_index: 0, semantic_contract: SEMANTIC_CONTRACT_ID },
      r2: { exact_object_count: actualKeys.length, expected_object_count: expected.length, exact_object_keys: actualKeys, total_bytes: heads.reduce((total, item) => total + (item.content_length ?? 0), 0), completion_marker_written_last: laterObjects.length === 0, object_integrity: heads },
      correctness: { reference_equivalence_passed: errors.length === 0, aggregate: summary?.aggregate ?? null, container_runtime: summary?.container_runtime ?? completion?.container_runtime ?? null },
      completion: completion ?? null,
      errors,
    };
    const reportPath = resolve(outputDirectoryArg, "VERIFICATION-REPORT.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    json({ status: errors.length === 0 ? "verified" : "verification_failed", benchmark_id: benchmarkId, object_count: actualKeys.length, total_bytes: report.r2.total_bytes, reference_equivalence_passed: errors.length === 0, error_count: errors.length, report: reportPath });
    if (errors.length > 0) process.exitCode = 1;
  } finally {
    // Credentials exist only in process memory and expire after one hour.
  }
}

main().catch((error) => { json({ status: "failed", error: redacted(error instanceof Error ? error.message : "unknown verifier error") }); process.exitCode = 1; });
