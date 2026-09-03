#!/usr/bin/env node
/**
 * Build a read-only recovery contract from an original 256-slot 10K run and
 * one or more terminal recovery runs. Completion is keyed by the immutable
 * Common Crawl source identity, not a coordinator's local task counter.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const CRAWL = "CC-MAIN-2026-30";
const PROFILE = "regional-256-ten-thousand-wat";
const PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan";
const RECOVERY_PROFILE = "regional-256-ten-thousand-failed-lane-recovery";
const RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-plan";
const CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-contract-v1";
const COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1";
const LANES = ["APAC-A", "APAC-B", "ENAM-A", "ENAM-B", "WNAM-A", "WNAM-B", "WEUR-A", "WEUR-B"];
const TERMINAL_STATES = new Set(["completed", "completed_with_recoverable_failures", "task_failed", "credential_window_elapsed"]);
const RECOVERABLE_SOURCE_STATES = new Set(["completed_with_recoverable_failures", "task_failed", "credential_window_elapsed"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const READ_CHILD_TTL_SECONDS = 3_600;
const MAX_LIST_PAGES = 256;
const JSON_CONCURRENCY = 24;
const MAX_JSON_BYTES = 2_000_000;

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512); }
function requiredText(value, label) { if (typeof value !== "string" || value.length === 0) fail(`${label} must be text.`); return value; }
function xmlValue(xml, name) { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null; }
function decodeXml(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (item) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[item] ?? item); }

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

async function mintReadChild(token, parent, prefixes) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-only", ttlSeconds: READ_CHILD_TTL_SECONDS, prefixes }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") fail("Cloudflare read-only child mint failed.");
  return result;
}

async function listObjects(client, prefix) {
  const objects = []; const seen = new Set(); let continuationToken = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
    if (continuationToken !== null) query.set("continuation-token", continuationToken);
    const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
    const body = await response.text();
    if (!response.ok) fail(`R2 ListObjectsV2 failed with HTTP ${response.status}.`);
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlValue(match[1], "Key"); const size = xmlValue(match[1], "Size");
      if (key === null || size === null || !/^\d+$/.test(size)) fail("R2 ListObjectsV2 returned malformed metadata.");
      objects.push({ key: decodeXml(key), bytes: Number(size) });
    }
    if (xmlValue(body, "IsTruncated") !== "true") return objects;
    const raw = xmlValue(body, "NextContinuationToken"); const next = raw === null ? null : decodeXml(raw);
    if (next === null || next.length === 0 || seen.has(next)) fail("R2 ListObjectsV2 returned an unsafe continuation token.");
    seen.add(next); continuationToken = next;
  }
  fail(`R2 ListObjectsV2 exceeded the ${String(MAX_LIST_PAGES)}-page inventory bound.`);
}

async function getJson(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject JSON failed for ${key} with HTTP ${response.status}.`);
  if (bytes.length > MAX_JSON_BYTES) fail(`R2 completion marker exceeds the inventory JSON bound: ${key}`);
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`R2 completion marker is not valid UTF-8 JSON: ${key}`); }
}

async function concurrentMap(items, limit, mapper) {
  const results = new Array(items.length); let next = 0;
  async function worker() { while (true) { const index = next; next += 1; if (index >= items.length) return; results[index] = await mapper(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function validateInputs(document, label) {
  const inputs = document?.inputs;
  if (!Array.isArray(inputs) || document?.input_count !== inputs.length || !SHA256_RE.test(document?.selected_inputs_sha256 ?? "")) fail(`${label} selected input manifest is invalid.`);
  // The embedded digest intentionally covers only the immutable source-input
  // array. The surrounding manifest has its own digest in the run context.
  if (sha256(Buffer.from(`${JSON.stringify(inputs)}\n`, "utf8")) !== document.selected_inputs_sha256) fail(`${label} selected input manifest digest is invalid.`);
  const byKey = new Map();
  for (const [index, item] of inputs.entries()) {
    if (typeof item?.source_key !== "string" || !/^[0-9a-f]{16}$/.test(item?.deterministic_suffix ?? "") || byKey.has(item.source_key)) fail(`${label} selected input identity is invalid.`);
    byKey.set(item.source_key, { index, suffix: item.deterministic_suffix });
  }
  return { inputs, byKey };
}

async function loadRun(contextPath, original = null) {
  const resolvedContext = resolve(contextPath);
  const contextBytes = await readFile(resolvedContext); const context = JSON.parse(contextBytes.toString("utf8"));
  const planPath = resolve(dirname(resolvedContext), "RUN-PLAN.json"); const planBytes = await readFile(planPath); const plan = JSON.parse(planBytes.toString("utf8"));
  const expectedKind = original === null ? PLAN_KIND : RECOVERY_PLAN_KIND;
  const expectedProfile = original === null ? PROFILE : RECOVERY_PROFILE;
  if (context?.kind !== expectedKind || plan?.kind !== expectedKind || context?.execution_profile !== expectedProfile || plan?.execution_profile !== expectedProfile || context?.run_id !== plan?.run_id || context?.r2_root !== plan?.r2_root || context?.task_count !== plan?.task_count || context?.selected_inputs_sha256 !== plan?.selected_inputs_sha256 || !Array.isArray(plan?.regions) || plan.regions.length < 1 || plan.regions.length > LANES.length || (original === null && (context?.task_count !== 10_000 || context?.max_concurrent_total !== 256))) fail("A supplied completion context is not a reviewed original or failed-lane 256-slot run.");
  if (!requiredText(context.r2_root, "run R2 root").endsWith("/") || !requiredText(context.run_id, "run id")) fail("A supplied completion context has invalid run identity.");
  const regions = new Map();
  for (const [index, region] of plan.regions.entries()) {
    if (typeof region?.region !== "string" || !LANES.includes(region.region) || regions.has(region.region) || region?.region_index !== index || region?.region_count !== plan.regions.length || !requiredText(region?.worker_url ?? context?.regions?.[index]?.worker_url, `${region.region} worker URL`)) fail("A supplied completion context has an invalid lane declaration.");
    regions.set(region.region, { index, workerUrl: region.worker_url ?? context.regions[index].worker_url });
  }
  const selectedPath = resolve(requiredText(plan.regions[0]?.bundle, "run bundle"), "selected-inputs.json");
  const selectedBytes = await readFile(selectedPath); const selected = JSON.parse(selectedBytes.toString("utf8")); const selectedInputs = validateInputs(selected, context.run_id);
  if (sha256(selectedBytes) !== context.selected_inputs_sha256 || sha256(selectedBytes) !== plan.selected_inputs_sha256 || selectedInputs.inputs.length !== context.task_count) fail("A supplied completion context does not bind its local selected input file.");
  const manifest = plan.source_manifest;
  const manifestPath = resolve(requiredText(manifest?.path, "source manifest path")); const manifestBytes = await readFile(manifestPath); const manifestDocument = JSON.parse(manifestBytes.toString("utf8"));
  if (sha256(manifestBytes) !== manifest?.file_sha256 || manifestDocument?.manifest_sha256 !== manifest?.claim_sha256 || manifestDocument?.kind !== "common-crawl-v2-base-manifest" || manifestDocument?.crawl !== CRAWL || !Array.isArray(manifestDocument?.inputs) || manifestDocument.inputs.length !== 10_000) fail("A supplied completion context does not bind the locked 10,000-WAT source manifest.");
  if (original !== null) {
    const recovery = plan.recovery;
    if (recovery?.source_run_id !== original.context.run_id || recovery?.source_task_count !== 10_000 || recovery?.source_selected_inputs_sha256 !== original.context.selected_inputs_sha256 || manifest.file_sha256 !== original.manifest.file_sha256 || manifest.claim_sha256 !== original.manifest.claim_sha256) fail("A supplemental completion context is not bound to the original 10,000-WAT run.");
    for (const item of selectedInputs.inputs) if (!original.inputByKey.has(item.source_key) || original.inputByKey.get(item.source_key).suffix !== item.deterministic_suffix) fail("A supplemental completion context selected an input outside the original locked source set.");
  }
  const inputByKey = new Map();
  for (const [index, sourceKey] of manifestDocument.inputs.entries()) {
    const selectedItem = selectedInputs.inputs[index];
    if (original === null && (selectedItem?.source_key !== sourceKey || typeof selectedItem?.deterministic_suffix !== "string")) fail("The original selected input manifest does not preserve locked source ordering.");
    if (original === null) inputByKey.set(sourceKey, { index, suffix: selectedItem.deterministic_suffix });
  }
  return { context, plan, contextPath: resolvedContext, contextSha256: sha256(contextBytes), planPath, planSha256: sha256(planBytes), selectedInputs, regions, manifest, manifestDocument, inputByKey };
}

async function checkRunInactive(run) {
  const checks = await Promise.all([...run.regions.entries()].map(async ([region, lane]) => {
    const response = await fetch(`${lane.workerUrl}/_growthsent_standard1_regional_ramp/status`, { method: "GET" });
    if (!response.ok) fail(`${region} Worker status failed with HTTP ${response.status}.`);
    const status = await response.json(); const active = status?.active_tasks;
    const allTerminal = Array.isArray(active) && active.every((task) => task?.status?.state === "stopped" || (task?.status?.runner?.state === "succeeded" && task?.status?.runner?.exit_code === 0));
    const launchState = status?.launch?.state;
    if (status?.run_id !== run.context.run_id || status?.region !== region || status?.control_secret_configured !== true || !Array.isArray(active)) fail(`${region} Worker status is not bound to its reviewed run.`);
    return { region, worker_url: lane.workerUrl, launch_state: launchState, active_task_count: active.length, all_active_tasks_terminal: allTerminal, safely_inactive: TERMINAL_STATES.has(launchState) && allTerminal };
  }));
  if (!checks.every((item) => item.safely_inactive)) fail("Every original and supplemental Worker must be terminal before aggregate recovery.");
  return checks;
}

function markerKeyInfo(run, key) {
  const match = new RegExp(`^${escaped(run.context.r2_root)}region=([a-z0-9-]+)/tasks/task-(\\d+)/(.+)$`).exec(key);
  if (match === null) return null;
  const region = match[1].toUpperCase(); const taskIndex = Number(match[2]) - 1;
  if (!run.regions.has(region) || !Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= run.context.task_count) fail(`Run inventory task key is outside the reviewed task contract: ${key}`);
  const lane = run.regions.get(region);
  if (taskIndex % run.regions.size !== lane.index) fail(`Run inventory task key is assigned to the wrong regional lane: ${key}`);
  return { region, taskIndex, leaf: match[3] };
}

async function main() {
  const [sourceArg, supplementalArg, contractArg] = process.argv.slice(2);
  if (!sourceArg || !supplementalArg || !contractArg) fail("Usage: prepare-aggregate-256-recovery-wsl.mjs <ORIGINAL-CONTEXT.json> <RECOVERY-CONTEXT.json|...> <RECOVERY-CONTRACT.json>");
  const supplementalPaths = supplementalArg.split("|").filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
  if (supplementalPaths.length < 1 || supplementalPaths.length > 8) fail("Aggregate recovery requires one to eight distinct supplemental completion contexts.");
  const original = await loadRun(sourceArg);
  const supplemental = await Promise.all(supplementalPaths.map((path) => loadRun(path, original)));
  const runs = [original, ...supplemental];
  if (new Set(runs.map((run) => run.context.run_id)).size !== runs.length || new Set(runs.map((run) => run.context.r2_root)).size !== runs.length) fail("Aggregate recovery contexts must describe distinct immutable runs.");
  let parentToken = await stdinText(); if (!parentToken) fail("A parent Cloudflare API token is required.");
  try {
    const originalChecks = await checkRunInactive(original);
    await Promise.all(supplemental.map(checkRunInactive));
    const parent = await verifyParent(parentToken);
    const prefixes = runs.map((run) => run.context.r2_root);
    const child = await mintReadChild(parentToken, parent, prefixes);
    emit({ stage: "read_only_aggregate_recovery_inventory_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: READ_CHILD_TTL_SECONDS, prefixes });
    const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
    const inventories = await concurrentMap(runs, Math.min(8, runs.length), async (run) => ({ run, objects: await listObjects(client, run.context.r2_root) }));
    const partialSources = new Set(); const markerCandidates = [];
    for (const { run, objects } of inventories) {
      for (const object of objects) {
        const info = markerKeyInfo(run, object.key); if (info === null) fail(`Run inventory contains an unexpected key outside its R2 root: ${object.key}`);
        const input = run.selectedInputs.inputs[info.taskIndex];
        if (input === undefined) fail(`Run inventory references an absent selected input: ${object.key}`);
        const originalInput = original.inputByKey.get(input.source_key);
        if (originalInput === undefined || originalInput.suffix !== input.deterministic_suffix) fail(`Run inventory source identity is not part of the locked 10,000-WAT set: ${object.key}`);
        if (info.leaf === "TASK-COMPLETED.json") markerCandidates.push({ run, key: object.key, info, input, originalInput });
        else partialSources.add(originalInput.index);
      }
    }
    const markers = await concurrentMap(markerCandidates, JSON_CONCURRENCY, async (candidate) => {
      const marker = await getJson(client, candidate.key);
      if (marker?.kind !== COMPLETION_KIND || marker?.run_id !== candidate.run.context.run_id || marker?.region !== candidate.info.region || marker?.task_index !== candidate.info.taskIndex || marker?.task_number !== candidate.info.taskIndex + 1 || marker?.source_key !== candidate.input.source_key || marker?.deterministic_suffix !== candidate.input.deterministic_suffix || marker?.selected_inputs_sha256 !== candidate.run.context.selected_inputs_sha256 || marker?.source_manifest_sha256 !== candidate.run.manifest.file_sha256 || marker?.input_count !== 1) fail(`Completion marker identity is invalid: ${candidate.key}`);
      return candidate.originalInput.index;
    });
    const completed = new Set(markers); const missing = [];
    const completionByLane = Object.fromEntries(LANES.map((lane) => [lane, 0])); const incompleteByLane = Object.fromEntries(LANES.map((lane) => [lane, 0]));
    for (let index = 0; index < 10_000; index += 1) {
      const lane = LANES[index % LANES.length];
      if (completed.has(index)) completionByLane[lane] += 1; else { missing.push(index); incompleteByLane[lane] += 1; }
    }
    const recoveryRegions = LANES.filter((lane) => incompleteByLane[lane] > 0);
    if (missing.length > 0 && recoveryRegions.some((lane) => !RECOVERABLE_SOURCE_STATES.has(originalChecks.find((item) => item.region === lane)?.launch_state))) fail("A missing WAT belongs to a source lane that is not terminal-recoverable; recovery is deliberately refused.");
    const scopedTaskCount = recoveryRegions.length * 1250;
    const completedInScope = recoveryRegions.reduce((total, lane) => total + completionByLane[lane], 0);
    const partialTaskPrefixCount = [...partialSources].filter((index) => !completed.has(index)).length;
    const contract = {
      format_version: 1,
      kind: CONTRACT_KIND,
      crawl: CRAWL,
      source_run_id: original.context.run_id,
      source_execution_profile: PROFILE,
      source_task_count: 10_000,
      source_max_concurrent_total: 256,
      source_selected_inputs_sha256: original.context.selected_inputs_sha256,
      source_manifest_sha256: original.manifest.file_sha256,
      source_manifest_claim_sha256: original.manifest.claim_sha256,
      source_shard_id: original.manifest.source_shard_id,
      source_context_sha256: original.contextSha256,
      source_plan_sha256: original.planSha256,
      source_workers: { all_inactive: originalChecks.every((item) => item.safely_inactive), recovery_lanes_inactive: true, checked_at: new Date().toISOString(), recovery_regions: recoveryRegions, aggregate_completion_contexts: supplemental.map((run) => ({ run_id: run.context.run_id, r2_root: run.context.r2_root, context_sha256: run.contextSha256, plan_sha256: run.planSha256 })), regions: originalChecks },
      inventory: { listed_at: new Date().toISOString(), method: "Cloudflare R2 ListObjectsV2 plus immutable TASK-COMPLETED source-identity checks across original and terminal recovery roots", object_count: inventories.reduce((total, item) => total + item.objects.length, 0), completion_marker_count: completedInScope, completed_source_count: completedInScope, incomplete_task_count: missing.length, partial_task_prefix_count: partialTaskPrefixCount, scoped_task_count: scopedTaskCount, unscoped_task_count: 10_000 - scopedTaskCount, scope: "terminal_source_lanes_only", region_completion_counts: completionByLane, region_incomplete_counts: incompleteByLane, aggregate_unique_completed_source_count: completed.size, duplicate_valid_completion_marker_count: markers.length - completed.size },
      recovery_task_count: missing.length,
      recovery_regions: recoveryRegions,
      recovery_source_indexes: missing,
      recovery_source_indexes_sha256: sha256(Buffer.from(`${JSON.stringify(missing)}\n`, "utf8")),
    };
    await writeFile(resolve(contractArg), `${JSON.stringify(contract, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    emit({ status: "aggregate_recovery_inventory_ready", source_run_id: original.context.run_id, completed_task_count: completed.size, incomplete_task_count: missing.length, recovery_regions: recoveryRegions, duplicate_valid_completion_marker_count: markers.length - completed.size, contract: resolve(contractArg) });
  } finally { parentToken = ""; }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
