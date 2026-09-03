#!/usr/bin/env node
/** Create a read-only, exact recovery contract for a stopped high-capacity run. */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const CRAWL = "CC-MAIN-2026-30";
const REGIONS = ["APAC", "ENAM", "WNAM", "WEUR"];
const NORMAL_PLAN_KIND = "growthsent-cloudflare-r2-standard1-regional-ramp-plan";
const HIGH_CAPACITY_CHECKPOINT_PROFILE = "regional-128-capacity-checkpoint";
const HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan";
const HIGH_CAPACITY_TEN_THOUSAND_PROFILE = "regional-256-ten-thousand-wat";
const HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-contract-v1";
const HIGH_CAPACITY_TEN_THOUSAND_LANES = [
  { region: "APAC-A", placement: "APAC", initial_delay: 0 }, { region: "APAC-B", placement: "APAC", initial_delay: 10 },
  { region: "ENAM-A", placement: "ENAM", initial_delay: 0 }, { region: "ENAM-B", placement: "ENAM", initial_delay: 10 },
  { region: "WNAM-A", placement: "WNAM", initial_delay: 0 }, { region: "WNAM-B", placement: "WNAM", initial_delay: 10 },
  { region: "WEUR-A", placement: "WEUR", initial_delay: 0 }, { region: "WEUR-B", placement: "WEUR", initial_delay: 10 },
];
const TASK_COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1";
const READ_CHILD_TTL_SECONDS = 3600;
const MAX_LIST_PAGES = 64;
const JSON_CONCURRENCY = 16;
const MAX_JSON_BYTES = 2_000_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RECOVERABLE_TERMINAL_STATES = new Set(["task_failed", "credential_window_elapsed", "completed_with_recoverable_failures"]);

const RECOVERY_SHAPES = {
  [HIGH_CAPACITY_CHECKPOINT_PROFILE]: {
    contract_kind: "growthsent-cloudflare-r2-standard1-128-partial-recovery-contract-v1",
    plan_kind: NORMAL_PLAN_KIND,
    task_count: 1000,
    max_concurrent_total: 128,
    regions: REGIONS,
    lane: (region, index) => ({ region, placement: region, initial_delay: index * 15, task_count: 250 }),
    source_shard_id: 10,
  },
  [HIGH_CAPACITY_TEN_THOUSAND_PROFILE]: {
    contract_kind: "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-contract-v1",
    plan_kind: HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND,
    task_count: 10000,
    max_concurrent_total: 256,
    regions: HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region),
    lane: (_region, index) => ({ ...HIGH_CAPACITY_TEN_THOUSAND_LANES[index], task_count: 1250 }),
    source_shard_id: null,
  },
};

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) { return Buffer.from(`${JSON.stringify(value, Object.keys(value ?? {}).sort())}\n`, "utf8"); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlValue(xml, name) { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null; }
function decodeXml(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity] ?? entity); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512); }
function requiredText(value, label) { if (typeof value !== "string" || value.length === 0) fail(`${label} must be text.`); return value; }

async function stdinText() { const parts = []; for await (const part of process.stdin) parts.push(part); return Buffer.concat(parts).toString("utf8").trim(); }

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
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((prefix) => typeof prefix !== "string" || !prefix.endsWith("/"))) fail("Read-only recovery credential prefixes are invalid.");
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-only", ttlSeconds: READ_CHILD_TTL_SECONDS, prefixes }),
  });
  const result = body?.result;
  if (!response.ok || !body?.success || typeof result?.accessKeyId !== "string" || !SHA256_RE.test(result?.secretAccessKey ?? "") || typeof result?.sessionToken !== "string") fail("Cloudflare read-only child mint failed.");
  return result;
}

async function listObjects(client, prefix) {
  const objects = [];
  const seenContinuationTokens = new Set();
  let continuationToken = null;
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
    const rawNext = xmlValue(body, "NextContinuationToken"); const next = rawNext === null ? null : decodeXml(rawNext);
    if (next === null || next.length === 0 || seenContinuationTokens.has(next)) fail("R2 ListObjectsV2 returned an unsafe continuation token.");
    seenContinuationTokens.add(next); continuationToken = next;
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

function taskPrefix(root, region, taskIndex) { return `${root}region=${region.toLowerCase()}/tasks/task-${String(taskIndex + 1).padStart(4, "0")}/`; }

async function sourceWorkerStates(context, regions) {
  if (!Array.isArray(context?.regions) || context.regions.length !== regions.length) fail("Source context does not contain every expected regional Worker.");
  const checks = await Promise.all(context.regions.map(async (item, index) => {
    const region = regions[index]; const url = requiredText(item?.worker_url, `${region} source Worker URL`);
    const response = await fetch(`${url}/_growthsent_standard1_regional_ramp/status`, { method: "GET" });
    if (!response.ok) fail(`${region} source Worker status failed with HTTP ${response.status}.`);
    const status = await response.json(); const activeTasks = status?.active_tasks;
    const launchState = status?.launch?.state;
    const terminalStates = new Set(["completed", "completed_with_recoverable_failures", "task_failed", "credential_window_elapsed"]);
    const allActiveTasksTerminal = Array.isArray(activeTasks) && activeTasks.every((task) => (
      task?.status?.state === "stopped"
      || (task?.status?.runner?.state === "succeeded" && task?.status?.runner?.exit_code === 0)
    ));
    if (status?.run_id !== context.run_id || status?.region !== region || status?.control_secret_configured !== true || !Array.isArray(activeTasks)) fail(`${region} source Worker status is not bound to the reviewed source run.`);
    return {
      region,
      worker_url: url,
      launch_state: launchState,
      active_task_count: activeTasks.length,
      all_active_tasks_terminal: allActiveTasksTerminal,
      safely_inactive: terminalStates.has(launchState) && allActiveTasksTerminal,
    };
  }));
  return checks;
}

async function sourceWorkersAreInactive(context, regions) {
  const checks = await sourceWorkerStates(context, regions);
  if (!checks.every((item) => item.safely_inactive)) {
    const unsafe = checks.find((item) => !item.safely_inactive);
    fail(`${unsafe.region} source Worker is not safely inactive for recovery.`);
  }
  return { all_inactive: true, checked_at: new Date().toISOString(), regions: checks };
}

async function loadSource(contextPath) {
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const planPath = resolve(dirname(contextPath), "RUN-PLAN.json");
  const planBytes = await readFile(planPath); const plan = JSON.parse(planBytes.toString("utf8"));
  const shape = RECOVERY_SHAPES[context?.execution_profile];
  if (shape === undefined) fail("Source context is not a reviewed high-capacity checkpoint or 256-slot run.");
  const required = { kind: shape.plan_kind, execution_profile: context.execution_profile, task_count: shape.task_count, max_concurrent_total: shape.max_concurrent_total };
  if (Object.entries(required).some(([key, value]) => context?.[key] !== value || plan?.[key] !== value) || context?.run_id !== plan?.run_id || context?.r2_root !== plan?.r2_root || context?.selected_inputs_sha256 !== plan?.selected_inputs_sha256 || !Array.isArray(plan?.regions) || plan.regions.length !== shape.regions.length) fail("Source context and plan are not the reviewed high-capacity contract.");
  for (const [index, region] of shape.regions.entries()) {
    const lane = shape.lane(region, index); const item = plan.regions[index];
    if (item?.region !== region || item?.region_index !== index || item?.region_count !== shape.regions.length || item?.placement_constraint !== lane.placement || item?.initial_start_delay_seconds !== lane.initial_delay || item?.regional_task_count !== lane.task_count || item?.max_concurrent !== 32 || item?.max_instances !== 34) fail("Source context and plan have an unsafe high-capacity lane configuration.");
  }
  const selectedPath = resolve(requiredText(plan.regions[0]?.bundle, "source plan bundle"), "selected-inputs.json");
  const selectedBytes = await readFile(selectedPath); const selected = JSON.parse(selectedBytes.toString("utf8")); const inputs = selected?.inputs;
  if (sha256(selectedBytes) !== context.selected_inputs_sha256 || sha256(selectedBytes) !== plan.selected_inputs_sha256 || selected?.input_count !== shape.task_count || !Array.isArray(inputs) || inputs.length !== shape.task_count || inputs.some((item) => typeof item?.source_key !== "string" || !/^[0-9a-f]{16}$/.test(item?.deterministic_suffix ?? ""))) fail("Source selected-input manifest is invalid.");
  const sourceManifest = plan.source_manifest;
  const sourceManifestPath = requiredText(sourceManifest?.path, "source manifest path");
  const sourceManifestBytes = await readFile(sourceManifestPath); const sourceManifestDocument = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (sha256(sourceManifestBytes) !== sourceManifest?.file_sha256 || sourceManifestDocument?.manifest_sha256 !== sourceManifest?.claim_sha256 || sourceManifest?.source_shard_id !== shape.source_shard_id) fail("Source manifest does not match the reviewed high-capacity plan.");
  return { context, plan, inputs, planPath, sourceManifest, shape };
}

async function main() {
  const [contextArg, contractArg, mode] = process.argv.slice(2);
  const requestedLaneText = typeof mode === "string" && mode.startsWith("--failed-lanes-only=") ? mode.slice("--failed-lanes-only=".length) : null;
  const failedLanesOnly = mode === "--failed-lanes-only" || requestedLaneText !== null;
  if (!contextArg || !contractArg || (mode !== undefined && !failedLanesOnly)) fail("Usage: prepare-128-partial-recovery-wsl.mjs <HIGH-CAPACITY-RUN-CONTEXT.json> <RECOVERY-CONTRACT.json> [--failed-lanes-only[=APAC-B,...]]");
  const contextPath = resolve(contextArg); const contractPath = resolve(contractArg);
  const { context, plan, inputs, planPath, sourceManifest, shape } = await loadSource(contextPath);
  if (failedLanesOnly && context.execution_profile !== HIGH_CAPACITY_TEN_THOUSAND_PROFILE) fail("Failed-lane recovery is only reviewed for the 256-slot 10,000-WAT profile.");
  let parentToken = await stdinText(); if (!parentToken) fail("A parent Cloudflare API token is required.");
  try {
    const parent = await verifyParent(parentToken);
    let sourceWorkers;
    let recoveryRegions;
    if (failedLanesOnly) {
      const checks = await sourceWorkerStates(context, shape.regions);
      const requestedRegions = requestedLaneText === null
        ? null
        : requestedLaneText.split(",").filter((region, index, values) => region.length > 0 && values.indexOf(region) === index);
      if (requestedRegions !== null && (requestedRegions.length === 0 || requestedRegions.some((region) => !shape.regions.includes(region)))) {
        fail("The requested selective failed-lane recovery set is not a reviewed source lane subset.");
      }
      const eligibleRegions = new Set(checks.filter((item) => item.safely_inactive && RECOVERABLE_TERMINAL_STATES.has(item.launch_state)).map((item) => item.region));
      if (requestedRegions !== null && requestedRegions.some((region) => !eligibleRegions.has(region))) {
        fail("A requested selective failed-lane recovery source Worker is not safely terminal.");
      }
      recoveryRegions = shape.regions.filter((region) => requestedRegions === null ? eligibleRegions.has(region) : requestedRegions.includes(region));
      if (recoveryRegions.length === 0) fail("No terminal failed source lanes are eligible for selective recovery.");
      const activeRegions = checks.filter((item) => !recoveryRegions.includes(item.region)).map((item) => item.region);
      sourceWorkers = {
        all_inactive: checks.every((item) => item.safely_inactive),
        recovery_lanes_inactive: true,
        checked_at: new Date().toISOString(),
        recovery_regions: recoveryRegions,
        ...(requestedRegions === null ? {} : { requested_recovery_regions: requestedRegions }),
        active_or_excluded_regions: activeRegions,
        regions: checks,
      };
    } else {
      sourceWorkers = await sourceWorkersAreInactive(context, shape.regions);
      recoveryRegions = shape.regions;
    }
    const recoveryPrefixes = recoveryRegions.map((region) => `${context.r2_root}region=${region.toLowerCase()}/`);
    const child = await mintReadChild(parentToken, parent, failedLanesOnly ? recoveryPrefixes : [context.r2_root]);
    emit({ stage: "read_only_recovery_inventory_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: READ_CHILD_TTL_SECONDS, prefixes: failedLanesOnly ? recoveryPrefixes : [context.r2_root] });
    const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
    const objects = (await concurrentMap(recoveryPrefixes, Math.min(8, recoveryPrefixes.length), (prefix) => listObjects(client, prefix))).flat();
    const objectKeys = new Set(objects.map((item) => item.key));
    const targetIndexes = inputs.map((_, taskIndex) => taskIndex).filter((taskIndex) => recoveryRegions.includes(shape.regions[taskIndex % shape.regions.length]));
    const byPrefix = new Map();
    for (const object of objects) {
      const lanePattern = shape.regions.map((region) => region.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const match = new RegExp(`^${context.r2_root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}region=(${lanePattern})/tasks/task-(\\d+)/`).exec(object.key);
      if (match === null) fail(`Source inventory contains an unexpected key outside the task contract: ${object.key}`);
      const taskIndex = Number(match[2]) - 1; const expectedRegion = shape.regions[taskIndex % shape.regions.length]?.toLowerCase();
      if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= inputs.length || match[1] !== expectedRegion) fail(`Source inventory task prefix is outside the regional assignment contract: ${object.key}`);
      const prefix = taskPrefix(context.r2_root, shape.regions[taskIndex % shape.regions.length], taskIndex);
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
    const completionKeys = [];
    for (const taskIndex of targetIndexes) {
      const key = `${taskPrefix(context.r2_root, shape.regions[taskIndex % shape.regions.length], taskIndex)}TASK-COMPLETED.json`;
      if (objectKeys.has(key)) completionKeys.push({ taskIndex, key });
    }
    const completedIndexes = await concurrentMap(completionKeys, JSON_CONCURRENCY, async ({ taskIndex, key }) => {
      const completion = await getJson(client, key); const source = inputs[taskIndex]; const region = shape.regions[taskIndex % shape.regions.length];
      if (completion?.kind !== TASK_COMPLETION_KIND || completion?.run_id !== context.run_id || completion?.region !== region || completion?.task_index !== taskIndex || completion?.source_key !== source.source_key || completion?.deterministic_suffix !== source.deterministic_suffix) fail(`Source completion marker has a conflicting identity for task ${taskIndex + 1}.`);
      return taskIndex;
    });
    const completed = new Set(completedIndexes); const incompleteIndexes = []; const completionCounts = Object.fromEntries(shape.regions.map((region) => [region, 0])); const incompleteCounts = Object.fromEntries(shape.regions.map((region) => [region, 0])); let partialTaskPrefixCount = 0;
    for (const taskIndex of targetIndexes) {
      const region = shape.regions[taskIndex % shape.regions.length];
      if (completed.has(taskIndex)) { completionCounts[region] += 1; continue; }
      incompleteIndexes.push(taskIndex); incompleteCounts[region] += 1;
      if ((byPrefix.get(taskPrefix(context.r2_root, region, taskIndex)) ?? 0) > 0) partialTaskPrefixCount += 1;
    }
    const contract = {
      format_version: 1,
      kind: failedLanesOnly ? HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND : shape.contract_kind,
      crawl: CRAWL,
      source_run_id: context.run_id,
      source_execution_profile: context.execution_profile,
      source_task_count: shape.task_count,
      source_max_concurrent_total: shape.max_concurrent_total,
      source_selected_inputs_sha256: context.selected_inputs_sha256,
      source_manifest_sha256: sourceManifest.file_sha256,
      source_manifest_claim_sha256: sourceManifest.claim_sha256,
      source_shard_id: sourceManifest.source_shard_id,
      source_context_sha256: sha256(await readFile(contextPath)),
      source_plan_sha256: sha256(await readFile(planPath)),
      source_workers: sourceWorkers,
      inventory: {
        listed_at: new Date().toISOString(), method: "Cloudflare R2 ListObjectsV2 plus TASK-COMPLETED identity checks", object_count: objects.length,
        completion_marker_count: completedIndexes.length, completed_source_count: completedIndexes.length, incomplete_task_count: incompleteIndexes.length,
        partial_task_prefix_count: partialTaskPrefixCount, region_completion_counts: completionCounts, region_incomplete_counts: incompleteCounts,
        ...(failedLanesOnly ? { scoped_task_count: targetIndexes.length, unscoped_task_count: inputs.length - targetIndexes.length, scope: "terminal_source_lanes_only" } : {}),
      },
      recovery_task_count: incompleteIndexes.length,
      recovery_regions: shape.regions.filter((region) => incompleteCounts[region] > 0),
      recovery_source_indexes: incompleteIndexes,
      recovery_source_indexes_sha256: sha256(Buffer.from(`${JSON.stringify(incompleteIndexes)}\n`, "utf8")),
    };
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    emit({ status: "recovery_inventory_ready", source_run_id: context.run_id, completed_task_count: completedIndexes.length, incomplete_task_count: incompleteIndexes.length, partial_task_prefix_count: partialTaskPrefixCount, contract: contractPath });
  } finally { parentToken = ""; }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
