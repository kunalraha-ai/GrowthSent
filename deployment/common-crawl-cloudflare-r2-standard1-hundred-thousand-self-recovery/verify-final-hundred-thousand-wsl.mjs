#!/usr/bin/env node
/**
 * Fast, read-only closure proof for the 100,000-WAT campaign.
 *
 * The prior final-89K inventory already validated 88,968 immutable completion
 * markers. Repeating that inventory would add hours of equivalent R2 reads.
 * This verifier binds that immutable contract to the prior 11K reuse proof and
 * directly validates the 32 task artifacts which closed the remaining gap.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const CRAWL = "CC-MAIN-2026-30";
const FINAL_RECOVERY_KIND = "growthsent-cloudflare-r2-standard1-final-89k-recovery-plan-v1";
const FINAL_RECOVERY_PROFILE = "regional-1440-final-eighty-nine-thousand-recovery";
const FINAL_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-final-89k-recovery-contract-v1";
const REUSE_PROOF_KIND = "growthsent-cloudflare-r2-standard1-verified-reuse-proof-v1";
const COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1";
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_LIST_PAGES = 8;
const MAX_JSON_BYTES = 2_000_000;
const TASK_CONCURRENCY = 8;
const R2_READ_ATTEMPTS = 8;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function endpoint() {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function encodedKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function xmlValue(xml, name) {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null;
}

function decodeXml(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'",
  })[entity] ?? entity);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512);
}

function must(condition, message) {
  if (!condition) fail(message);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function transportReason(error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return (cause instanceof Error ? cause.message : String(cause)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 256);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function concurrentMap(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function cloudflareFetch(path, token, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status checks below report invalid responses without logging credentials.
  }
  return { response, body };
}

async function verifyParent(token) {
  for (const candidate of [
    { kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` },
    { kind: "user", path: "/user/tokens/verify" },
  ]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") {
      return { id: body.result.id, kind: candidate.kind };
    }
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintReadChild(token, parent, prefix) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({
      bucket: BUCKET,
      parentAccessKeyId: parent.id,
      permission: "object-read-only",
      ttlSeconds: 3600,
      prefixes: [prefix],
    }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") {
    fail("Cloudflare read-only child credential mint failed.");
  }
  return result;
}

async function r2FetchWithRetry(client, { label, url, method }) {
  let lastError = "unknown R2 transport failure";
  for (let attempt = 1; attempt <= R2_READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.fetch(url, { method });
      if (![403, 408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === R2_READ_ATTEMPTS) return response;
      lastError = `HTTP ${response.status}`;
      await response.arrayBuffer();
    } catch (error) {
      lastError = transportReason(error);
    }
    if (attempt < R2_READ_ATTEMPTS) await sleep(Math.min(15_000, attempt * 1_000));
  }
  fail(`${label} failed after ${R2_READ_ATTEMPTS} attempts: ${lastError}`);
}

async function listObjects(client, prefix) {
  const objects = [];
  const seenTokens = new Set();
  let continuationToken = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
    if (continuationToken !== null) query.set("continuation-token", continuationToken);
    const response = await r2FetchWithRetry(client, { label: "R2 ListObjectsV2", url: `${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, method: "GET" });
    const body = await response.text();
    if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlValue(match[1], "Key");
      const size = xmlValue(match[1], "Size");
      const lastModified = xmlValue(match[1], "LastModified");
      if (key === null || size === null || lastModified === null || !/^\d+$/.test(size)) fail("R2 ListObjectsV2 returned malformed metadata.");
      objects.push({ key: decodeXml(key), bytes: Number(size), last_modified: lastModified });
    }
    if (xmlValue(body, "IsTruncated") !== "true") return objects;
    const rawNext = xmlValue(body, "NextContinuationToken");
    const next = rawNext === null ? null : decodeXml(rawNext);
    if (next === null || next.length === 0 || seenTokens.has(next)) fail("R2 ListObjectsV2 returned an unsafe continuation token.");
    seenTokens.add(next);
    continuationToken = next;
  }
  fail(`R2 ListObjectsV2 exceeded the ${String(MAX_LIST_PAGES)}-page verification bound.`);
}

async function headObject(client, key) {
  const response = await r2FetchWithRetry(client, { label: "R2 HeadObject", url: `${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, method: "HEAD" });
  const length = response.headers.get("content-length");
  return {
    status: response.status,
    content_length: length !== null && /^\d+$/.test(length) ? Number(length) : null,
    sha256: response.headers.get("x-amz-meta-growthsent-sha256"),
  };
}

async function getJson(client, key) {
  const response = await r2FetchWithRetry(client, { label: "R2 GetObject", url: `${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, method: "GET" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject JSON failed with HTTP ${response.status}: ${key}`);
  if (bytes.length > MAX_JSON_BYTES) fail(`R2 JSON exceeds the verification size bound: ${key}`);
  try {
    return { bytes: bytes.length, sha256: sha256(bytes), value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail(`R2 object is not valid JSON: ${key}`);
  }
}

function taskPrefix(root, lane, taskIndex) {
  return `${root}lane=${lane.toLowerCase()}/tasks/task-${String(taskIndex + 1).padStart(4, "0")}/`;
}

function expectedKeys(root, lane, inputs) {
  const keys = [];
  for (const [taskIndex, input] of inputs.entries()) {
    const prefix = taskPrefix(root, lane, taskIndex);
    const suffix = input.deterministic_suffix;
    keys.push(
      `${prefix}TASK-INPUT-MANIFEST.json`,
      `${prefix}crawl=CC-MAIN-2026-30/dataset=pages/part-${suffix}.parquet`,
      `${prefix}crawl=CC-MAIN-2026-30/dataset=links/part-${suffix}.parquet`,
      `${prefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`,
      `${prefix}control/wats/part-${suffix}/WAT-COMPLETED.json`,
      `${prefix}TASK-SUMMARY.json`,
      `${prefix}TASK-COMPLETED.json`,
    );
  }
  return keys.sort();
}

async function loadProof(contextPath) {
  const contextBytes = await readFile(contextPath);
  const context = JSON.parse(contextBytes.toString("utf8"));
  const planPath = resolve(dirname(contextPath), "FINAL-89K-RECOVERY-RUN-PLAN.json");
  const planBytes = await readFile(planPath);
  const plan = JSON.parse(planBytes.toString("utf8"));

  must(context?.kind === FINAL_RECOVERY_KIND && plan?.kind === FINAL_RECOVERY_KIND, "The supplied context is not a final 89K recovery plan.");
  must(context?.execution_profile === FINAL_RECOVERY_PROFILE && plan?.execution_profile === FINAL_RECOVERY_PROFILE, "The final recovery execution profile is invalid.");
  must(context?.run_id === plan?.run_id && context?.r2_root === plan?.r2_root && context?.task_count === 32, "The final recovery context and plan do not agree.");
  must(Array.isArray(plan?.lanes) && plan.lanes.length === 1, "The final recovery must contain one capacity-neutral lane.");
  const lane = plan.lanes[0];
  must(lane?.lane === "APAC-01" && lane?.regional_task_count === 32 && lane?.max_concurrent === 32 && lane?.max_instances === 32, "The final recovery lane shape is invalid.");
  must(context?.lanes?.length === 1 && context.lanes[0]?.lane === lane.lane && context.lanes[0]?.prefix === `${context.r2_root}lane=apac-01/`, "The final recovery context does not bind APAC-01.");

  const contractPath = resolve(plan?.recovery?.contract_path ?? "");
  const contractBytes = await readFile(contractPath);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  const contractPayload = { ...contract };
  delete contractPayload.contract_sha256;
  must(contract?.contract_sha256 === plan?.recovery?.contract_sha256 && sha256(canonicalJson(contractPayload)) === contract.contract_sha256, "The final 89K recovery contract digest is invalid.");
  must(contract?.kind === FINAL_RECOVERY_CONTRACT_KIND && contract?.crawl === CRAWL && contract?.source_task_count === 89000, "The final 89K recovery contract is invalid.");
  must(contract?.inventory?.completed_source_count === 88968 && contract?.inventory?.incomplete_task_count === 32 && contract?.inventory?.duplicate_valid_completion_marker_count === 0, "The final 89K immutable completion inventory is not the reviewed 88,968-plus-32 split.");

  const recoveryIndexes = contract?.recovery_source_indexes;
  must(Array.isArray(recoveryIndexes) && recoveryIndexes.length === 32 && sameArray(recoveryIndexes, plan?.recovery?.recovery_source_indexes ?? []), "The recovery source identity set is invalid.");
  must(recoveryIndexes.every((index, position) => Number.isInteger(index) && index >= 11000 && index < 100000 && (position === 0 || recoveryIndexes[position - 1] < index)), "The recovery source identities are not a disjoint ordered range subset.");
  must(sha256(Buffer.from(`${JSON.stringify(recoveryIndexes)}\n`)) === contract?.recovery_source_indexes_sha256 && contract.recovery_source_indexes_sha256 === plan?.recovery?.recovery_source_indexes_sha256, "The recovery source identity digest is invalid.");

  const reusePath = resolve(plan?.verified_reuse_proof?.path ?? "");
  const reuseBytes = await readFile(reusePath);
  const reuse = JSON.parse(reuseBytes.toString("utf8"));
  must(sha256(reuseBytes) === plan?.verified_reuse_proof?.file_sha256, "The prior 11K reuse proof digest is invalid.");
  must(reuse?.kind === REUSE_PROOF_KIND && reuse?.crawl === CRAWL && reuse?.completed_source_count === 11000 && reuse?.remaining_source_count === 89000, "The prior 11K reuse proof is invalid.");
  const completedRange = reuse?.completed_source_index_ranges?.[0];
  const remainingRange = reuse?.remaining_source_index_ranges?.[0];
  must(
    Array.isArray(reuse?.completed_source_index_ranges)
      && reuse.completed_source_index_ranges.length === 1
      && completedRange?.start === 0
      && completedRange?.end_exclusive === 11000
      && Array.isArray(reuse?.remaining_source_index_ranges)
      && reuse.remaining_source_index_ranges.length === 1
      && remainingRange?.start === 11000
      && remainingRange?.end_exclusive === 100000,
    "The reuse proof does not partition the locked 100K source range.",
  );

  const sourcePath = resolve(plan?.source_manifest?.path ?? "");
  const sourceBytes = await readFile(sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8"));
  must(sha256(sourceBytes) === plan?.source_manifest?.file_sha256 && source?.kind === "common-crawl-v2-base-manifest" && source?.crawl === CRAWL && Array.isArray(source?.inputs) && source.inputs.length === 100000, "The locked 100K source manifest is invalid.");
  must(source?.manifest_sha256 === plan?.source_manifest?.claim_sha256 && source?.inputs_sha256 === plan?.source_manifest?.inputs_sha256, "The locked 100K source manifest claims do not match the recovery plan.");

  const selectedPath = resolve(lane.bundle, "selected-inputs.json");
  const selectedBytes = await readFile(selectedPath);
  const selected = JSON.parse(selectedBytes.toString("utf8"));
  must(sha256(selectedBytes) === lane.selected_inputs_sha256 && selected?.kind === "growthsent-cloudflare-r2-standard1-regional-inputs-v1" && Array.isArray(selected?.inputs) && selected.inputs.length === 32, "The final recovery selected-input manifest is invalid.");
  for (const [taskIndex, input] of selected.inputs.entries()) {
    const sourceIndex = recoveryIndexes[taskIndex];
    must(input?.source_key === source.inputs[sourceIndex] && /^[0-9a-f]{16}$/.test(input?.deterministic_suffix ?? ""), `The selected recovery input at task ${taskIndex + 1} is not bound to its locked source identity.`);
  }

  must(reuse.completed_source_count + contract.inventory.completed_source_count + selected.inputs.length === source.inputs.length, "The audited evidence chain does not close the 100K source count.");
  return { context, plan, lane, contract, reuse, source, inputs: selected.inputs };
}

async function verifyRecoveryArtifacts(client, proof) {
  const { context, lane, inputs } = proof;
  const root = context.r2_root;
  const prefix = `${root}lane=${lane.lane.toLowerCase()}/`;
  const objects = await listObjects(client, prefix);
  const expected = expectedKeys(root, lane.lane, inputs);
  const actual = objects.map((item) => item.key).sort();
  must(sameArray(actual, expected), "Final recovery R2 keys do not exactly match the immutable seven-object-per-task contract.");
  const listed = new Map(objects.map((item) => [item.key, item]));
  const headResults = await concurrentMap(actual, 16, async (key) => [key, await headObject(client, key)]);
  const heads = new Map(headResults);

  const tasks = await concurrentMap(inputs, TASK_CONCURRENCY, async (input, taskIndex) => {
    const prefixTask = taskPrefix(root, lane.lane, taskIndex);
    const suffix = input.deterministic_suffix;
    const keys = {
      input: `${prefixTask}TASK-INPUT-MANIFEST.json`,
      pages: `${prefixTask}crawl=CC-MAIN-2026-30/dataset=pages/part-${suffix}.parquet`,
      links: `${prefixTask}crawl=CC-MAIN-2026-30/dataset=links/part-${suffix}.parquet`,
      metrics: `${prefixTask}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`,
      wat: `${prefixTask}control/wats/part-${suffix}/WAT-COMPLETED.json`,
      summary: `${prefixTask}TASK-SUMMARY.json`,
      complete: `${prefixTask}TASK-COMPLETED.json`,
    };

    for (const key of Object.values(keys)) {
      const head = heads.get(key);
      const listedObject = listed.get(key);
      must(head?.status === 200, `HeadObject failed for final recovery task ${taskIndex + 1}.`);
      const contentLength = head.content_length ?? listedObject?.bytes;
      must(contentLength === listedObject?.bytes && SHA256_RE.test(head.sha256 ?? ""), `R2 object metadata is invalid for final recovery task ${taskIndex + 1}.`);
    }

    const json = {};
    for (const [name, key] of Object.entries({ input: keys.input, metrics: keys.metrics, wat: keys.wat, summary: keys.summary, complete: keys.complete })) {
      json[name] = await getJson(client, key);
      const head = heads.get(key);
      const listedObject = listed.get(key);
      must(json[name].bytes === listedObject?.bytes && json[name].sha256 === head?.sha256, `JSON integrity metadata differs from final recovery R2 content for task ${taskIndex + 1}.`);
    }

    const taskIdentity = (value) => value?.run_id === context.run_id && value?.region === lane.lane && value?.task_index === taskIndex && value?.source_key === input.source_key;
    const suffixIdentity = (value) => taskIdentity(value) && value?.deterministic_suffix === suffix;
    must(json.input.value?.run_id === context.run_id && json.input.value?.region === lane.lane && json.input.value?.task_index === taskIndex && json.input.value?.input_count === 1 && json.input.value?.inputs?.[0]?.source_key === input.source_key && json.input.value?.inputs?.[0]?.deterministic_suffix === suffix, `Input identity is invalid for final recovery task ${taskIndex + 1}.`);
    must(suffixIdentity(json.wat.value), `WAT completion identity is invalid for final recovery task ${taskIndex + 1}.`);
    must(taskIdentity(json.summary.value), `Summary identity is invalid for final recovery task ${taskIndex + 1}.`);
    must(json.complete.value?.kind === COMPLETION_KIND && suffixIdentity(json.complete.value) && json.complete.value?.selected_inputs_sha256 === lane.selected_inputs_sha256, `Completion identity is invalid for final recovery task ${taskIndex + 1}.`);
    const observation = json.metrics.value?.semantic_observation;
    must(json.metrics.value?.regional_ramp?.run_id === context.run_id && json.metrics.value?.regional_ramp?.region === lane.lane && json.metrics.value?.regional_ramp?.task_index === taskIndex && observation?.contract === "growthsent-semantic-records-v2", `Semantic metrics identity is invalid for final recovery task ${taskIndex + 1}.`);
    const artifacts = Array.isArray(json.complete.value?.artifacts) ? json.complete.value.artifacts : [];
    must(artifacts.length === 3, `Final recovery task ${taskIndex + 1} does not bind exactly three immutable artifacts.`);
    for (const artifact of artifacts) {
      const head = heads.get(artifact?.key);
      const listedObject = listed.get(artifact?.key);
      const contentLength = head?.content_length ?? listedObject?.bytes;
      must(contentLength === artifact?.bytes && head?.sha256 === artifact?.sha256, `Artifact contract differs from R2 for final recovery task ${taskIndex + 1}.`);
    }
    const completeTimestamp = listed.get(keys.complete)?.last_modified ?? "";
    const laterObjects = Object.values(keys).filter((key) => (listed.get(key)?.last_modified ?? "") > completeTimestamp);
    must(laterObjects.length === 0, `Final recovery task ${taskIndex + 1} has an object modified after TASK-COMPLETED.`);
    return { task_index: taskIndex, source_key: input.source_key };
  });

  return { object_count: objects.length, total_bytes: objects.reduce((total, item) => total + item.bytes, 0), tasks };
}

async function main() {
  const [contextArg, outputDirectoryArg] = process.argv.slice(2);
  if (!contextArg || !outputDirectoryArg) fail("Usage: verify-final-hundred-thousand-wsl.mjs <FINAL-89K-RECOVERY-RUN-CONTEXT.json> <output-directory>");
  const contextPath = resolve(contextArg);
  const outputDirectory = resolve(outputDirectoryArg);
  const proof = await loadProof(contextPath);
  const parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  const parent = await verifyParent(parentToken);
  const child = await mintReadChild(parentToken, parent, proof.context.r2_root);
  emit({ stage: "read_only_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: 3600, prefixes: [proof.context.r2_root] });
  const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
  const recovery = await verifyRecoveryArtifacts(client, proof);
  const report = {
    kind: "growthsent-cloudflare-r2-final-100k-verification-report-v1",
    crawl: CRAWL,
    source_manifest: {
      input_count: proof.source.inputs.length,
      file_sha256: proof.plan.source_manifest.file_sha256,
      claim_sha256: proof.plan.source_manifest.claim_sha256,
      inputs_sha256: proof.plan.source_manifest.inputs_sha256,
    },
    evidence_chain: {
      prior_verified_reuse_sources: proof.reuse.completed_source_count,
      original_final_89k_immutable_completion_markers: proof.contract.inventory.completed_source_count,
      directly_verified_final_recovery_sources: recovery.tasks.length,
      total_completed_source_identities: proof.reuse.completed_source_count + proof.contract.inventory.completed_source_count + recovery.tasks.length,
      source_index_partition: [
        { start: 0, end_exclusive: 11000, source_count: proof.reuse.completed_source_count },
        { start: 11000, end_exclusive: 100000, source_count: proof.contract.inventory.completed_source_count + recovery.tasks.length },
      ],
    },
    final_recovery: {
      run_id: proof.context.run_id,
      r2_root: proof.context.r2_root,
      task_count: recovery.tasks.length,
      object_count: recovery.object_count,
      total_bytes: recovery.total_bytes,
      recovery_source_indexes_sha256: proof.contract.recovery_source_indexes_sha256,
    },
    passed: true,
  };
  await writeFile(resolve(outputDirectory, "FINAL-100K-VERIFICATION-REPORT.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  emit({ status: "verified", crawl: CRAWL, source_identity_count: report.evidence_chain.total_completed_source_identities, final_recovery_task_count: recovery.tasks.length, final_recovery_object_count: recovery.object_count, final_recovery_total_bytes: recovery.total_bytes, report: resolve(outputDirectory, "FINAL-100K-VERIFICATION-REPORT.json") });
}

main().catch((error) => {
  emit({ status: "failed", error: safeError(error) });
  process.exitCode = 1;
});
