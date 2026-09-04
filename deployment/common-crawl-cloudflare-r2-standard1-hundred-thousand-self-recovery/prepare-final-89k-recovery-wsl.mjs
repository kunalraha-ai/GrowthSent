#!/usr/bin/env node
/**
 * Create a read-only source-identity completion inventory for a terminal
 * final-89K run.  It never writes R2 or deploys a Worker.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const CRAWL = "CC-MAIN-2026-30";
const PLAN_KIND = "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-plan-v1";
const PROFILE = "regional-1440-remaining-eighty-nine-thousand-self-recovery";
const CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-final-89k-recovery-contract-v1";
const COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1";
const TERMINAL_STATES = new Set(["completed", "completed_with_recoverable_failures"]);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LIST_PAGES = 2048;
const JSON_CONCURRENCY = 16;
const READ_CHILD_TTL_SECONDS = 3600;
const MAX_JSON_BYTES = 2_000_000;

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonicalJson(item))));
  if (value !== null && typeof value === "object") { const ordered = {}; for (const key of Object.keys(value).sort()) ordered[key] = JSON.parse(canonicalJson(value[key])); return JSON.stringify(ordered); }
  return JSON.stringify(value);
}
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlValue(xml, name) { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null; }
function decodeXml(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (item) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[item] ?? item); }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512); }

async function stdinText() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8").trim(); }
async function cloudflareFetch(path, token, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) } });
  let body = null; try { body = await response.json(); } catch { /* checked below */ }
  return { response, body };
}
async function verifyParent(token) {
  for (const candidate of [{ kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` }, { kind: "user", path: "/user/tokens/verify" }]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") return { id: body.result.id, kind: candidate.kind };
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}
async function mintReadChild(token, parent, prefix) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, { method: "POST", body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-only", ttlSeconds: READ_CHILD_TTL_SECONDS, prefixes: [prefix] }) });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") fail("Cloudflare read-only child mint failed.");
  return result;
}
async function concurrentMap(items, limit, mapper) {
  const output = new Array(items.length); let next = 0;
  async function worker() { while (true) { const index = next; next += 1; if (index >= items.length) return; output[index] = await mapper(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}
async function getJson(client, key) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.ok) {
      if (bytes.length > MAX_JSON_BYTES) fail(`Completion marker exceeds the JSON bound: ${key}`);
      try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`Completion marker is not valid JSON: ${key}`); }
    }
    last = `R2 GetObject completion marker failed with HTTP ${response.status}.`;
    if (![429, 500, 502, 503].includes(response.status) || attempt === 5) break;
    await new Promise((done) => setTimeout(done, (attempt + 1) * 1000));
  }
  fail(`${last} (${key})`);
}
async function inventoryMarkerKeys(client, root, keyInfo) {
  const markers = []; const partial = new Set(); const seen = new Set(); let continuation = null; let objectCount = 0;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({ "list-type": "2", prefix: root, "max-keys": "1000" });
    if (continuation !== null) query.set("continuation-token", continuation);
    const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
    const xml = await response.text();
    if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      objectCount += 1;
      const raw = xmlValue(match[1], "Key"); if (raw === null) fail("R2 inventory key was malformed.");
      const info = keyInfo(decodeXml(raw));
      if (info.leaf === "TASK-COMPLETED.json") markers.push(info); else partial.add(info.source_index);
    }
    if (xmlValue(xml, "IsTruncated") !== "true") return { markers, partial, object_count: objectCount };
    const next = xmlValue(xml, "NextContinuationToken");
    continuation = next === null ? null : decodeXml(next);
    if (continuation === null || continuation.length === 0 || seen.has(continuation)) fail("R2 inventory continuation token was unsafe.");
    seen.add(continuation);
  }
  fail(`R2 inventory exceeded the ${String(MAX_LIST_PAGES)}-page bound.`);
}
async function terminalLaneChecks(context) {
  const checks = await Promise.all(context.lanes.map(async (lane) => {
    const response = await fetch(`${lane.worker_url}/_growthsent_standard1_regional_ramp/status`, { headers: { "User-Agent": "curl/8.5.0", Accept: "application/json" } });
    if (!response.ok) fail(`${lane.lane} Worker status failed with HTTP ${response.status}.`);
    const status = await response.json(); const state = status?.launch?.state;
    const active = status?.active_tasks;
    const safe = status?.run_id === context.run_id && status?.region === lane.lane && status?.control_secret_configured === true && TERMINAL_STATES.has(state) && Array.isArray(active) && active.length === 0;
    return { lane: lane.lane, launch_state: state, active_task_count: Array.isArray(active) ? active.length : null, safely_inactive: safe };
  }));
  if (!checks.every((item) => item.safely_inactive)) fail("Every final 89K source lane must be terminal and inactive before recovery inventory.");
  return checks;
}

async function main() {
  const [contextArg, contractArg] = process.argv.slice(2);
  if (!contextArg || !contractArg) fail("Usage: prepare-final-89k-recovery-wsl.mjs <FINAL-89K-RUN-CONTEXT.json> <RECOVERY-CONTRACT.json>");
  const contextPath = resolve(contextArg); const contextBytes = await readFile(contextPath); const context = JSON.parse(contextBytes.toString("utf8"));
  const planPath = resolve(dirname(contextPath), "SELF-RECOVERY-RUN-PLAN.json"); const planBytes = await readFile(planPath); const plan = JSON.parse(planBytes.toString("utf8"));
  const planPayload = { ...plan }; delete planPayload.plan_sha256;
  if (context?.kind !== PLAN_KIND || plan?.kind !== PLAN_KIND || context?.execution_profile !== PROFILE || plan?.execution_profile !== PROFILE || context?.run_id !== plan?.run_id || context?.r2_root !== plan?.r2_root || context?.task_count !== 89000 || plan?.processing_window?.source_index_start !== 11000 || plan?.processing_window?.source_index_end_exclusive !== 100000 || plan?.processing_window?.task_count !== 89000 || plan?.lanes?.length !== 45 || plan?.plan_sha256 !== sha256(canonicalJson(planPayload))) fail("The supplied final 89K context and plan are not a reviewed original campaign.");
  const sourceManifestPath = resolve(plan?.source_manifest?.path ?? ""); const sourceBytes = await readFile(sourceManifestPath); const source = JSON.parse(sourceBytes.toString("utf8"));
  if (sha256(sourceBytes) !== plan?.source_manifest?.file_sha256 || source?.kind !== "common-crawl-v2-base-manifest" || source?.crawl !== CRAWL || !Array.isArray(source?.inputs) || source.inputs.length !== 100000 || source?.manifest_sha256 !== plan?.source_manifest?.claim_sha256 || source?.inputs_sha256 !== plan?.source_manifest?.inputs_sha256) fail("The locked 100K source manifest is not bound to the original final campaign.");
  const laneByLower = new Map(); const sourceByIndex = new Map();
  for (const [laneIndex, lane] of plan.lanes.entries()) {
    const selectedPath = resolve(lane.bundle, "selected-inputs.json"); const selectedBytes = await readFile(selectedPath); const selected = JSON.parse(selectedBytes.toString("utf8"));
    if (sha256(selectedBytes) !== lane.selected_inputs_sha256 || !Array.isArray(selected?.inputs) || !Array.isArray(selected?.source_indexes) || selected.inputs.length !== selected.source_indexes.length || selected?.input_count !== 100000 || selected?.selected_inputs_sha256 !== sha256(Buffer.from(`${JSON.stringify(selected.inputs)}\n`))) fail(`The ${lane.lane} selected input binding is invalid.`);
    const byTask = new Map();
    for (let position = 0; position < selected.source_indexes.length; position += 1) {
      const sourceIndex = selected.source_indexes[position]; const input = selected.inputs[position];
      if (!Number.isInteger(sourceIndex) || sourceIndex < 11000 || sourceIndex >= 100000 || sourceIndex % 45 !== laneIndex || input?.source_key !== source.inputs[sourceIndex] || typeof input?.deterministic_suffix !== "string" || byTask.has(sourceIndex) || sourceByIndex.has(sourceIndex)) fail(`The ${lane.lane} selected source identity is invalid.`);
      byTask.set(sourceIndex, input); sourceByIndex.set(sourceIndex, { lane: lane.lane, selected_inputs_sha256: lane.selected_inputs_sha256, input });
    }
    laneByLower.set(lane.lane.toLowerCase(), { lane, byTask });
  }
  if (sourceByIndex.size !== 89000) fail("The original final campaign does not bind exactly 89,000 source identities.");
  let parentToken = await stdinText(); if (!parentToken) fail("A parent Cloudflare API token is required.");
  try {
    const sourceWorkers = await terminalLaneChecks(context);
    const parent = await verifyParent(parentToken); const credentials = await mintReadChild(parentToken, parent, context.r2_root);
    const client = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, service: "s3", region: "auto" });
    const inventory = await inventoryMarkerKeys(client, context.r2_root, (key) => {
      const match = new RegExp(`^${escaped(context.r2_root)}lane=([a-z0-9-]+)/tasks/task-(\\d+)/(.+)$`).exec(key);
      if (match === null) fail(`R2 inventory contains an unexpected object key: ${key}`);
      const lane = laneByLower.get(match[1]); const taskIndex = Number(match[2]) - 1;
      if (lane === undefined || !Number.isInteger(taskIndex) || !lane.byTask.has(taskIndex)) fail(`R2 inventory task key is outside its reviewed source lane: ${key}`);
      return { key, lane: lane.lane, task_index: taskIndex, source_index: taskIndex, input: lane.byTask.get(taskIndex), leaf: match[3] };
    });
    const completedIndexes = await concurrentMap(inventory.markers, JSON_CONCURRENCY, async (marker) => {
      const value = await getJson(client, marker.key);
      if (value?.kind !== COMPLETION_KIND || value?.run_id !== context.run_id || value?.region !== marker.lane.lane || value?.task_index !== marker.task_index || value?.task_number !== marker.task_index + 1 || value?.source_key !== marker.input.source_key || value?.deterministic_suffix !== marker.input.deterministic_suffix || value?.selected_inputs_sha256 !== marker.lane.selected_inputs_sha256 || value?.source_manifest_sha256 !== plan.source_manifest.file_sha256 || value?.input_count !== 1) fail(`Completion marker source identity is invalid: ${marker.key}`);
      return marker.source_index;
    });
    const completed = new Set(completedIndexes); const missing = [];
    for (let index = 11000; index < 100000; index += 1) if (!completed.has(index)) missing.push(index);
    const byLane = Object.fromEntries(plan.lanes.map((lane) => [lane.lane, { completed: 0, missing: 0 }]));
    for (let index = 11000; index < 100000; index += 1) byLane[sourceByIndex.get(index).lane][completed.has(index) ? "completed" : "missing"] += 1;
    const contract = { format_version: 1, kind: CONTRACT_KIND, crawl: CRAWL, source_run_id: context.run_id, source_execution_profile: PROFILE, source_task_count: 89000, source_processing_window: { source_index_start: 11000, source_index_end_exclusive: 100000 }, source_r2_root: context.r2_root, source_context_sha256: sha256(contextBytes), source_plan_sha256: sha256(planBytes), source_manifest_file_sha256: plan.source_manifest.file_sha256, source_manifest_claim_sha256: plan.source_manifest.claim_sha256, source_manifest_inputs_sha256: plan.source_manifest.inputs_sha256, verified_reuse_proof: plan.verified_reuse_proof, source_workers: { all_inactive: true, checked_at: new Date().toISOString(), lanes: sourceWorkers }, inventory: { listed_at: new Date().toISOString(), method: "Cloudflare R2 ListObjectsV2 plus immutable TASK-COMPLETED source-identity checks", object_count: inventory.object_count, completion_marker_count: completedIndexes.length, completed_source_count: completed.size, incomplete_task_count: missing.length, partial_task_prefix_count: [...inventory.partial].filter((index) => !completed.has(index)).length, duplicate_valid_completion_marker_count: completedIndexes.length - completed.size, lane_counts: byLane }, recovery_task_count: missing.length, recovery_source_indexes: missing, recovery_source_indexes_sha256: sha256(Buffer.from(`${JSON.stringify(missing)}\n`)) };
    contract.contract_sha256 = sha256(canonicalJson(contract));
    await writeFile(resolve(contractArg), `${JSON.stringify(contract, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    emit({ status: "final_89k_recovery_inventory_ready", source_run_id: context.run_id, completed_task_count: completed.size, incomplete_task_count: missing.length, contract: resolve(contractArg) });
  } finally { parentToken = ""; }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
