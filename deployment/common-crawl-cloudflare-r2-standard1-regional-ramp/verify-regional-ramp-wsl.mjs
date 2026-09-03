#!/usr/bin/env node
/** Read-only verifier for a completed regional capacity run or exact recovery. */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const REGIONS = ["APAC", "ENAM", "WNAM", "WEUR"];
const NORMAL_PLAN_KIND = "growthsent-cloudflare-r2-standard1-regional-ramp-plan";
const ENAM_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-enam-recovery-plan";
const INCOMPLETE_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-incomplete-recovery-plan";
const REMAINING_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-remaining-recovery-plan";
const HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-128-partial-recovery-plan";
const HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan";
const HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-plan";
const HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-plan";
const CAPACITY_CHECKPOINT_PROFILE = "regional-capacity-checkpoint";
const THOUSAND_WAT_PROFILE = "regional-thousand-wat";
const TEN_THOUSAND_WAT_PROFILE = "regional-ten-thousand-wat";
const HIGH_CAPACITY_CHECKPOINT_PROFILE = "regional-128-capacity-checkpoint";
const HIGH_CAPACITY_TEN_THOUSAND_PROFILE = "regional-256-ten-thousand-wat";
const ENAM_RECOVERY_PROFILE = "enam-recovery";
const INCOMPLETE_RECOVERY_PROFILE = "regional-incomplete-recovery";
const REMAINING_RECOVERY_PROFILE = "regional-remaining-recovery";
const HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE = "regional-128-partial-recovery";
const HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE = "regional-256-ten-thousand-partial-recovery";
const HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE = "regional-256-ten-thousand-failed-lane-recovery";
const HIGH_CAPACITY_TEN_THOUSAND_LANES = [
  { region: "APAC-A", placement: "APAC", initial_delay: 0 }, { region: "APAC-B", placement: "APAC", initial_delay: 10 },
  { region: "ENAM-A", placement: "ENAM", initial_delay: 0 }, { region: "ENAM-B", placement: "ENAM", initial_delay: 10 },
  { region: "WNAM-A", placement: "WNAM", initial_delay: 0 }, { region: "WNAM-B", placement: "WNAM", initial_delay: 10 },
  { region: "WEUR-A", placement: "WEUR", initial_delay: 0 }, { region: "WEUR-B", placement: "WEUR", initial_delay: 10 },
];
const REMAINING_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-remaining-recovery-contract-v1";
const HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-128-partial-recovery-contract-v1";
const HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-contract-v1";
const HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND = "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-contract-v1";
const REMAINING_RECOVERY_INDEXES_SHA256 = "577fc70b3fb0c01dc0e47c6c74590757106297af0759af7f2f7b25bf0ff057eb";
const CREDENTIAL_POLICIES = {
  [CAPACITY_CHECKPOINT_PROFILE]: { id: "regional-two-hour-v1", child_ttl_seconds: 7200, start_guard_seconds: 0 },
  [THOUSAND_WAT_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [TEN_THOUSAND_WAT_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [HIGH_CAPACITY_CHECKPOINT_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [ENAM_RECOVERY_PROFILE]: { id: "regional-two-hour-v1", child_ttl_seconds: 7200, start_guard_seconds: 0 },
  [INCOMPLETE_RECOVERY_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [REMAINING_RECOVERY_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
  [HIGH_CAPACITY_TEN_THOUSAND_PROFILE]: { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 },
};
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_READ_CHILD_TTL_SECONDS = 3600;
const TEN_THOUSAND_READ_CHILD_TTL_SECONDS = 21600;
const MAX_LIST_PAGES = 64;
const OBJECT_HEAD_CONCURRENCY = 16;
const JSON_VERIFY_CONCURRENCY = 12;
const MAX_JSON_BYTES = 2_000_000;

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlValue(xml, name) { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null; }
function decodeXml(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity] ?? entity); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512); }
function required(value, label) { if (typeof value !== "string" || value.length === 0) fail(`${label} must be text`); return value; }
function must(condition, message, errors) { if (!condition) errors.push(message); }

async function concurrentMap(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) fail("Verifier concurrency limit is invalid.");
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

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

async function mintReadChild(token, parent, prefix, ttlSeconds) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, { method: "POST", body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-only", ttlSeconds, prefixes: [prefix] }) });
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
      const key = xmlValue(match[1], "Key"); const size = xmlValue(match[1], "Size"); const lastModified = xmlValue(match[1], "LastModified");
      if (key === null || size === null || lastModified === null || !/^\d+$/.test(size)) fail("R2 ListObjectsV2 returned malformed metadata.");
      objects.push({ key: decodeXml(key), bytes: Number(size), last_modified: lastModified });
    }
    if (xmlValue(body, "IsTruncated") !== "true") return objects;
    const rawNextToken = xmlValue(body, "NextContinuationToken");
    const nextToken = rawNextToken === null ? null : decodeXml(rawNextToken);
    if (nextToken === null || nextToken.length === 0 || seenContinuationTokens.has(nextToken)) fail("R2 ListObjectsV2 returned an unsafe continuation token.");
    seenContinuationTokens.add(nextToken);
    continuationToken = nextToken;
  }
  fail(`R2 ListObjectsV2 exceeded the ${String(MAX_LIST_PAGES)}-page verifier bound.`);
}

async function headObject(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "HEAD" });
  const length = response.headers.get("content-length");
  const contentLength = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  return { key, http_status: response.status, content_length: contentLength, content_length_source: contentLength === null ? null : "head_object", growthsent_sha256: response.headers.get("x-amz-meta-growthsent-sha256") };
}

async function getJson(client, key) {
  const response = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(key)}`, { method: "GET" });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) fail(`R2 GetObject JSON failed for ${key} with HTTP ${response.status}.`);
  if (body.length > MAX_JSON_BYTES) fail(`R2 JSON object exceeds the ${String(MAX_JSON_BYTES)}-byte verifier limit: ${key}`);
  let value; try { value = JSON.parse(body.toString("utf8")); } catch { fail(`R2 object is not valid UTF-8 JSON: ${key}`); }
  return { bytes: body.length, sha256: sha256(body), value };
}

function taskPrefix(root, region, taskIndex) { return `${root}region=${region.toLowerCase()}/tasks/task-${String(taskIndex + 1).padStart(4, "0")}/`; }

function taskIndexesForRegion(regionPlan, regionCount, taskCount) {
  const indexes = [];
  for (let index = regionPlan.region_index; index < taskCount; index += regionCount) indexes.push(index);
  return indexes;
}

function expectedKeys(root, regionPlan, inputs, regionCount) {
  const keys = [];
  for (const index of taskIndexesForRegion(regionPlan, regionCount, inputs.length)) {
    const prefix = taskPrefix(root, regionPlan.region, index); const suffix = inputs[index].deterministic_suffix;
    keys.push(`${prefix}TASK-INPUT-MANIFEST.json`, `${prefix}crawl=CC-MAIN-2026-30/dataset=pages/part-${suffix}.parquet`, `${prefix}crawl=CC-MAIN-2026-30/dataset=links/part-${suffix}.parquet`, `${prefix}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`, `${prefix}control/wats/part-${suffix}/WAT-COMPLETED.json`, `${prefix}TASK-SUMMARY.json`, `${prefix}TASK-COMPLETED.json`);
  }
  return keys.sort();
}

function sameArray(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

function matchesCredentialPolicy(value, expected) {
  return value?.id === expected.id && value?.child_ttl_seconds === expected.child_ttl_seconds && value?.start_guard_seconds === expected.start_guard_seconds;
}

function incompleteRecoveryIndexes() {
  const indexes = [];
  for (let index = 51; index <= 999; index += 4) indexes.push(index);
  for (let index = 652; index <= 996; index += 4) indexes.push(index);
  for (let index = 670; index <= 998; index += 4) indexes.push(index);
  return indexes.sort((left, right) => left - right);
}

async function loadLocalContract(contextPath) {
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const planPath = resolve(dirname(contextPath), "RUN-PLAN.json");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const enamRecovery = plan?.kind === ENAM_RECOVERY_PLAN_KIND;
  const incompleteRecovery = plan?.kind === INCOMPLETE_RECOVERY_PLAN_KIND;
  const remainingRecovery = plan?.kind === REMAINING_RECOVERY_PLAN_KIND;
  const highCapacityPartialRecovery = plan?.kind === HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND;
  const highCapacityTenThousandPartialRecovery = plan?.kind === HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND;
  const highCapacityTenThousandFailedLaneRecovery = plan?.kind === HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND;
  const highCapacityTenThousand = plan?.kind === HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND;
  const highCapacityTenThousandRecovery = highCapacityTenThousandPartialRecovery || highCapacityTenThousandFailedLaneRecovery;
  const recovery = enamRecovery || incompleteRecovery || remainingRecovery || highCapacityPartialRecovery || highCapacityTenThousandRecovery;
  const executionProfile = enamRecovery ? plan.execution_profile ?? ENAM_RECOVERY_PROFILE : incompleteRecovery ? plan.execution_profile ?? INCOMPLETE_RECOVERY_PROFILE : remainingRecovery ? plan.execution_profile ?? REMAINING_RECOVERY_PROFILE : highCapacityPartialRecovery ? plan.execution_profile ?? HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE : highCapacityTenThousandPartialRecovery ? plan.execution_profile ?? HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE : highCapacityTenThousandFailedLaneRecovery ? plan.execution_profile ?? HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE : highCapacityTenThousand ? plan.execution_profile ?? HIGH_CAPACITY_TEN_THOUSAND_PROFILE : plan.execution_profile ?? CAPACITY_CHECKPOINT_PROFILE;
  const thousand = executionProfile === THOUSAND_WAT_PROFILE;
  const tenThousand = executionProfile === TEN_THOUSAND_WAT_PROFILE;
  const highCapacityCheckpoint = executionProfile === HIGH_CAPACITY_CHECKPOINT_PROFILE;
  const highCapacityTenThousandProfile = executionProfile === HIGH_CAPACITY_TEN_THOUSAND_PROFILE;
  if (highCapacityTenThousand !== highCapacityTenThousandProfile) fail("The plan kind and execution profile must agree for the 256-slot 10,000-WAT run.");
  const expectedCredentialPolicy = CREDENTIAL_POLICIES[executionProfile];
  const expectedRegions = enamRecovery ? ["ENAM"] : highCapacityPartialRecovery || highCapacityTenThousandRecovery ? plan?.recovery?.recovery_regions : highCapacityTenThousandProfile ? HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region) : REGIONS;
  const expectedTaskCount = enamRecovery ? 18 : incompleteRecovery ? 408 : remainingRecovery ? 234 : highCapacityPartialRecovery || highCapacityTenThousandRecovery ? plan?.recovery?.recovery_task_count : thousand ? 1000 : tenThousand || highCapacityTenThousandProfile ? 10000 : highCapacityCheckpoint ? 1000 : null;
  const expectedMaxConcurrent = highCapacityCheckpoint || highCapacityPartialRecovery || highCapacityTenThousandRecovery || highCapacityTenThousandProfile ? 32 : 4;
  const requiresCredentialPolicy = thousand || tenThousand || highCapacityTenThousandProfile || highCapacityCheckpoint || highCapacityPartialRecovery || highCapacityTenThousandRecovery || incompleteRecovery || remainingRecovery;
  if (expectedCredentialPolicy === undefined || ![NORMAL_PLAN_KIND, ENAM_RECOVERY_PLAN_KIND, INCOMPLETE_RECOVERY_PLAN_KIND, REMAINING_RECOVERY_PLAN_KIND, HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND, HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND, HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND, HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND].includes(plan?.kind) || context?.run_id !== plan?.run_id || context?.task_count !== plan?.task_count || context?.execution_profile !== undefined && context.execution_profile !== executionProfile || !Array.isArray(expectedRegions) || expectedRegions.length < 1 || !Array.isArray(plan?.regions) || plan.regions.length !== expectedRegions.length || (recovery || thousand || tenThousand || highCapacityTenThousandProfile || highCapacityCheckpoint ? plan.task_count !== expectedTaskCount : plan.task_count < 50 || plan.task_count > 100)) fail("Context and local plan do not form a reviewed regional-run contract.");
  if ((plan.credential_policy !== undefined && !matchesCredentialPolicy(plan.credential_policy, expectedCredentialPolicy)) || (context.credential_policy !== undefined && !matchesCredentialPolicy(context.credential_policy, expectedCredentialPolicy)) || (requiresCredentialPolicy && (!matchesCredentialPolicy(plan.credential_policy, expectedCredentialPolicy) || !matchesCredentialPolicy(context.credential_policy, expectedCredentialPolicy)))) fail("Context and local plan do not bind the reviewed R2 credential policy.");
  if (JSON.stringify(plan.regions.map((item) => item?.region)) !== JSON.stringify(expectedRegions) || ((highCapacityPartialRecovery || highCapacityTenThousandRecovery || highCapacityTenThousandProfile) && plan.max_concurrent_total !== plan.regions.reduce((total, item) => total + item?.max_concurrent, 0)) || plan.regions.some((item, index) => {
    const highCapacityLane = highCapacityTenThousandProfile || highCapacityTenThousandRecovery ? HIGH_CAPACITY_TEN_THOUSAND_LANES.find((lane) => lane.region === item?.region) : null;
    return item?.region_index !== index || (item?.region_count ?? expectedRegions.length) !== expectedRegions.length || ((highCapacityPartialRecovery || highCapacityTenThousandRecovery) ? item?.max_concurrent !== Math.min(32, item?.regional_task_count) : item?.max_concurrent !== expectedMaxConcurrent) || item?.max_instances !== item?.max_concurrent + 2 || (highCapacityLane !== null && (item?.placement_constraint !== highCapacityLane.placement || item?.initial_start_delay_seconds !== highCapacityLane.initial_delay));
  })) fail("Local regional plan lane configuration is invalid.");
  if (tenThousand && plan.regions.some((item) => item?.regional_task_count !== 2500)) fail("Local 10,000-WAT plan does not bind four exact 2,500-task regional lanes.");
  if (highCapacityTenThousandProfile && (plan.start_spacing_seconds_per_lane !== 30 || plan.regions.some((item) => item?.regional_task_count !== 1250))) fail("Local 256-slot 10,000-WAT plan does not bind eight exact 1,250-task lanes.");
  if (highCapacityCheckpoint && plan.regions.some((item) => item?.regional_task_count !== 250)) fail("Local 128-container checkpoint does not bind four exact 250-task regional lanes.");
  if (enamRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    if (source?.source_run_id !== "cc-main-2026-30-20260831t121855z-standard1-regional-8381964f" || source?.source_task_count !== 100 || source?.source_region !== "ENAM" || source?.source_region_index !== 1 || source?.source_region_count !== 4 || source?.failed_source_index !== 25 || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || !Array.isArray(indexes) || indexes.length !== 18 || !indexes.includes(25) || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 100 || index % 4 !== 1 || (position > 0 && indexes[position - 1] >= index))) fail("Local ENAM recovery plan does not bind the reviewed incomplete task set.");
  }
  if (incompleteRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    if (source?.source_run_id !== "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" || source?.source_task_count !== 1000 || source?.source_selected_inputs_sha256 !== "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5" || source?.source_plan_sha256 !== "876b4543a1fb1ddaee93d66d421c1c384ac3510aca7ef74da8c7ccf98ea99d72" || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || source?.inventory?.object_count !== 4144 || source?.inventory?.completion_marker_count !== 592 || source?.inventory?.incomplete_task_count !== 408 || !Array.isArray(indexes) || JSON.stringify(indexes) !== JSON.stringify(incompleteRecoveryIndexes())) fail("Local incomplete recovery plan does not bind the audited 408-WAT task set.");
  }
  if (remainingRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    if (source?.inventory?.original_and_prior_recovery_overlap_count !== 0 || source?.prior_recovery?.container_instances_verified_inactive !== true) fail("Local remaining recovery plan does not prove a disjoint, inactive prior recovery.");
    if (source?.contract_kind !== REMAINING_RECOVERY_CONTRACT_KIND || source?.source_run_id !== "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" || source?.source_task_count !== 1000 || source?.source_selected_inputs_sha256 !== "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5" || source?.source_plan_sha256 !== "876b4543a1fb1ddaee93d66d421c1c384ac3510aca7ef74da8c7ccf98ea99d72" || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || source?.inventory?.original_completion_marker_count !== 592 || source?.inventory?.prior_recovery_completion_marker_count !== 174 || source?.inventory?.unique_completed_source_count !== 766 || source?.inventory?.remaining_task_count !== 234 || source?.prior_recovery?.run_id !== "cc-main-2026-30-20260901t015900z-standard1-incomplete-156cf3c4" || source?.prior_recovery?.completion_marker_count !== 174 || source?.recovery_source_indexes_sha256 !== REMAINING_RECOVERY_INDEXES_SHA256 || !Array.isArray(indexes) || indexes.length !== 234 || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 1000 || (position > 0 && indexes[position - 1] >= index)) || sha256(JSON.stringify(indexes) + "\n") !== REMAINING_RECOVERY_INDEXES_SHA256) fail("Local remaining recovery plan does not bind the merged 1,000-WAT completion inventory.");
  }
  if (highCapacityPartialRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    if (source?.contract_kind !== HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND || source?.source_execution_profile !== HIGH_CAPACITY_CHECKPOINT_PROFILE || typeof source?.source_run_id !== "string" || source?.source_task_count !== 1000 || source?.source_max_concurrent_total !== 128 || !SHA256_RE.test(source?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || !SHA256_RE.test(source?.source_plan_sha256 ?? "") || source?.source_workers?.all_inactive !== true || !Array.isArray(source?.recovery_regions) || JSON.stringify(source.recovery_regions) !== JSON.stringify(expectedRegions) || JSON.stringify(expectedRegions) !== JSON.stringify(REGIONS.filter((region) => source?.inventory?.region_incomplete_counts?.[region] > 0)) || source?.inventory?.completed_source_count + source?.inventory?.incomplete_task_count !== 1000 || source?.inventory?.incomplete_task_count !== expectedTaskCount || !Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 1000 || (position > 0 && indexes[position - 1] >= index)) || source?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("Local 128-slot partial recovery plan does not bind the audited incomplete task set.");
  }
  if (highCapacityTenThousandPartialRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    const sourceLanes = HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region);
    if (source?.contract_kind !== HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND || source?.source_execution_profile !== HIGH_CAPACITY_TEN_THOUSAND_PROFILE || typeof source?.source_run_id !== "string" || source?.source_task_count !== 10000 || source?.source_max_concurrent_total !== 256 || !SHA256_RE.test(source?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || !SHA256_RE.test(source?.source_plan_sha256 ?? "") || source?.source_workers?.all_inactive !== true || !Array.isArray(source?.recovery_regions) || JSON.stringify(source.recovery_regions) !== JSON.stringify(expectedRegions) || JSON.stringify(expectedRegions) !== JSON.stringify(sourceLanes.filter((region) => source?.inventory?.region_incomplete_counts?.[region] > 0)) || source?.inventory?.completed_source_count + source?.inventory?.incomplete_task_count !== 10000 || source?.inventory?.incomplete_task_count !== expectedTaskCount || !Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 10000 || (position > 0 && indexes[position - 1] >= index)) || source?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("Local 256-slot partial recovery plan does not bind the audited incomplete task set.");
  }
  if (highCapacityTenThousandFailedLaneRecovery) {
    const source = plan.recovery;
    const indexes = source?.recovery_source_indexes;
    const sourceLanes = HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region);
    const recoveryRegions = source?.recovery_regions;
    const lanePositions = new Set((Array.isArray(recoveryRegions) ? recoveryRegions : []).map((region) => sourceLanes.indexOf(region)));
    if (source?.contract_kind !== HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND || source?.source_execution_profile !== HIGH_CAPACITY_TEN_THOUSAND_PROFILE || typeof source?.source_run_id !== "string" || source?.source_task_count !== 10000 || source?.source_max_concurrent_total !== 256 || !SHA256_RE.test(source?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(source?.contract_sha256 ?? "") || !SHA256_RE.test(source?.source_context_sha256 ?? "") || !SHA256_RE.test(source?.source_plan_sha256 ?? "") || source?.source_workers?.recovery_lanes_inactive !== true || !Array.isArray(recoveryRegions) || JSON.stringify(recoveryRegions) !== JSON.stringify(expectedRegions) || JSON.stringify(recoveryRegions) !== JSON.stringify(sourceLanes.filter((region) => source?.inventory?.region_incomplete_counts?.[region] > 0) || []) || source?.inventory?.scope !== "terminal_source_lanes_only" || source?.inventory?.scoped_task_count !== recoveryRegions.length * 1250 || source?.inventory?.scoped_task_count + source?.inventory?.unscoped_task_count !== 10000 || source?.inventory?.completed_source_count + source?.inventory?.incomplete_task_count !== source?.inventory?.scoped_task_count || source?.inventory?.incomplete_task_count !== expectedTaskCount || !Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 10000 || !lanePositions.has(index % sourceLanes.length) || (position > 0 && indexes[position - 1] >= index)) || source?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("Local 256-slot failed-lane recovery plan does not bind the audited terminal source partitions.");
  }
  const selectedPath = resolve(required(plan.regions[0]?.bundle, "plan bundle"), "selected-inputs.json");
  const selectedBytes = await readFile(selectedPath);
  if (sha256(selectedBytes) !== context.selected_inputs_sha256 || sha256(selectedBytes) !== plan.selected_inputs_sha256) fail("Local selected-input manifest does not match the run context.");
  const selected = JSON.parse(selectedBytes.toString("utf8"));
  const inputs = selected?.inputs;
  if (selected?.kind !== "growthsent-cloudflare-r2-standard1-regional-inputs-v1" || !Array.isArray(inputs) || inputs.length !== context.task_count) fail("Local selected-input manifest is invalid.");
  for (const item of inputs) if (typeof item?.source_key !== "string" || !/^[0-9a-f]{16}$/.test(item?.deterministic_suffix ?? "")) fail("Local selected-input manifest has an invalid task entry.");
  return { context, plan, inputs, recovery, enamRecovery, incompleteRecovery, remainingRecovery, highCapacityPartialRecovery, highCapacityTenThousandPartialRecovery, highCapacityTenThousandFailedLaneRecovery, tenThousand, highCapacityCheckpoint, highCapacityTenThousand: highCapacityTenThousandProfile };
}

async function verifyRegion(client, root, runId, regionPlan, inputs, regionCount) {
  const region = regionPlan.region;
  const prefix = `${root}region=${region.toLowerCase()}/`;
  const objects = await listObjects(client, prefix);
  const actualKeys = objects.map((item) => item.key).sort();
  const expected = expectedKeys(root, regionPlan, inputs, regionCount);
  const errors = [];
  must(sameArray(actualKeys, expected), `${region}: keys do not exactly match its seven-object-per-task contract`, errors);
  const listed = new Map(objects.map((item) => [item.key, item]));
  const heads = new Map();
  const headResults = await concurrentMap(actualKeys, OBJECT_HEAD_CONCURRENCY, async (key) => [key, await headObject(client, key)]);
  for (const [key, head] of headResults) {
    heads.set(key, head);
    const listedObject = listed.get(key);
    must(head.http_status === 200, `${region}: HeadObject failed for ${key}`, errors);
    // R2 can omit Content-Length from a signed HEAD response. ListObjectsV2
    // includes the authoritative object Size, so it is the safe fallback.
    if (head.content_length === null && listedObject !== undefined) {
      head.content_length = listedObject.bytes;
      head.content_length_source = "list_objects_v2";
    }
    must(head.content_length === listedObject?.bytes, `${region}: HeadObject size differs for ${key}`, errors);
    must(SHA256_RE.test(head.growthsent_sha256 ?? ""), `${region}: SHA-256 metadata is invalid for ${key}`, errors);
  }
  const taskObjects = new Map();
  for (const object of objects) {
    const match = /^(.*\/tasks\/task-\d+\/)/.exec(object.key);
    if (match !== null) taskObjects.set(match[1], [...(taskObjects.get(match[1]) ?? []), object]);
  }
  const taskIndexes = taskIndexesForRegion(regionPlan, regionCount, inputs.length);
  const taskChecks = await concurrentMap(taskIndexes, JSON_VERIFY_CONCURRENCY, async (index) => {
    const taskErrors = [];
    const source = inputs[index]; const prefixTask = taskPrefix(root, region, index); const suffix = source.deterministic_suffix;
    const jsonKeys = {
      input: `${prefixTask}TASK-INPUT-MANIFEST.json`, metrics: `${prefixTask}crawl=CC-MAIN-2026-30/dataset=metrics/part-${suffix}.json`, wat: `${prefixTask}control/wats/part-${suffix}/WAT-COMPLETED.json`, summary: `${prefixTask}TASK-SUMMARY.json`, complete: `${prefixTask}TASK-COMPLETED.json`,
    };
    const json = {};
    for (const [name, key] of Object.entries(jsonKeys)) {
      const item = await getJson(client, key); json[name] = item;
      const head = heads.get(key); must(head?.content_length === item.bytes && head?.growthsent_sha256 === item.sha256, `${region}: JSON integrity mismatch for task ${index + 1} ${name}`, taskErrors);
    }
    const input = json.input.value; const metrics = json.metrics.value; const wat = json.wat.value; const summary = json.summary.value; const complete = json.complete.value;
    const taskIdentity = (value) => value?.run_id === runId && value?.region === region && value?.task_index === index && value?.source_key === source.source_key;
    const suffixIdentity = (value) => taskIdentity(value) && value?.deterministic_suffix === suffix;
    must(input?.run_id === runId && input?.region === region && input?.task_index === index && input?.input_count === 1 && input?.inputs?.[0]?.source_key === source.source_key && input?.inputs?.[0]?.deterministic_suffix === suffix, `${region}: task ${index + 1} input identity is invalid`, taskErrors);
    must(suffixIdentity(wat), `${region}: task ${index + 1} WAT completion identity is invalid`, taskErrors);
    must(taskIdentity(summary), `${region}: task ${index + 1} summary identity is invalid`, taskErrors);
    must(suffixIdentity(complete), `${region}: task ${index + 1} completion identity is invalid`, taskErrors);
    const observation = metrics?.semantic_observation;
    must(metrics?.regional_ramp?.run_id === runId && metrics?.regional_ramp?.region === region && metrics?.regional_ramp?.task_index === index && observation?.contract === "growthsent-semantic-records-v2", `${region}: task ${index + 1} semantic observation is invalid`, taskErrors);
    const artifacts = Array.isArray(complete?.artifacts) ? complete.artifacts : [];
    must(artifacts.length === 3, `${region}: task ${index + 1} does not have exactly three immutable artifacts`, taskErrors);
    for (const artifact of artifacts) {
      const head = heads.get(artifact?.key); must(head?.content_length === artifact?.bytes && head?.growthsent_sha256 === artifact?.sha256, `${region}: task ${index + 1} artifact contract differs from R2`, taskErrors);
    }
    const completionObject = listed.get(jsonKeys.complete); const later = (taskObjects.get(prefixTask) ?? []).filter((item) => item.last_modified > (completionObject?.last_modified ?? ""));
    must(later.length === 0, `${region}: task ${index + 1} has objects modified after completion`, taskErrors);
    return { errors: taskErrors, report: { task_index: index, source_key: source.source_key, pages_count: observation?.pages_count ?? null, links_count: observation?.links_count ?? null, source_bytes: metrics?.source_transport?.downloaded_bytes ?? null, source_retries: metrics?.source_transport?.retries ?? null } };
  });
  for (const check of taskChecks) errors.push(...check.errors);
  const taskReports = taskChecks.map((check) => check.report).sort((left, right) => left.task_index - right.task_index);
  return { region, object_count: actualKeys.length, total_bytes: objects.reduce((total, item) => total + item.bytes, 0), tasks: taskReports, errors };
}

async function main() {
  const [contextPathArg, outputDirectoryArg] = process.argv.slice(2);
  if (!contextPathArg || !outputDirectoryArg) fail("Usage: verify-regional-ramp-wsl.mjs <REGIONAL-RAMP-CONTEXT.json> <output-directory>");
  const contextPath = resolve(contextPathArg); const outputDirectory = resolve(outputDirectoryArg);
  const { context, plan, inputs, recovery, enamRecovery, incompleteRecovery, remainingRecovery, highCapacityPartialRecovery, highCapacityTenThousandPartialRecovery, highCapacityTenThousandFailedLaneRecovery, tenThousand, highCapacityCheckpoint, highCapacityTenThousand } = await loadLocalContract(contextPath);
  const parentToken = await stdinText(); if (!parentToken) fail("A parent Cloudflare API token is required.");
  try {
    const parent = await verifyParent(parentToken);
    const readChildTtlSeconds = tenThousand || highCapacityTenThousand || highCapacityTenThousandPartialRecovery || highCapacityTenThousandFailedLaneRecovery ? TEN_THOUSAND_READ_CHILD_TTL_SECONDS : DEFAULT_READ_CHILD_TTL_SECONDS;
    const child = await mintReadChild(parentToken, parent, context.r2_root, readChildTtlSeconds);
    emit({ stage: "read_only_child", accepted: true, parent_token_kind: parent.kind, ttl_seconds: readChildTtlSeconds, prefixes: [context.r2_root] });
    const client = new AwsClient({ accessKeyId: child.accessKeyId, secretAccessKey: child.secretAccessKey, sessionToken: child.sessionToken, service: "s3" });
    const regions = [];
    for (const regionPlan of plan.regions) regions.push(await verifyRegion(client, context.r2_root, context.run_id, regionPlan, inputs, plan.regions.length));
    const errors = regions.flatMap((item) => item.errors);
    const report = { kind: enamRecovery ? "growthsent-cloudflare-r2-standard1-enam-recovery-verification-report" : incompleteRecovery ? "growthsent-cloudflare-r2-standard1-incomplete-recovery-verification-report" : remainingRecovery ? "growthsent-cloudflare-r2-standard1-remaining-recovery-verification-report" : highCapacityPartialRecovery ? "growthsent-cloudflare-r2-standard1-128-partial-recovery-verification-report" : highCapacityTenThousandPartialRecovery ? "growthsent-cloudflare-r2-standard1-256-ten-thousand-partial-recovery-verification-report" : highCapacityTenThousandFailedLaneRecovery ? "growthsent-cloudflare-r2-standard1-256-ten-thousand-failed-lane-recovery-verification-report" : highCapacityTenThousand ? "growthsent-cloudflare-r2-standard1-256-ten-thousand-verification-report" : tenThousand ? "growthsent-cloudflare-r2-standard1-ten-thousand-verification-report" : highCapacityCheckpoint ? "growthsent-cloudflare-r2-standard1-128-capacity-checkpoint-verification-report" : "growthsent-cloudflare-r2-standard1-regional-ramp-verification-report", run_id: context.run_id, r2_root: context.r2_root, task_count: context.task_count, selected_inputs_sha256: context.selected_inputs_sha256, recovery: recovery ? plan.recovery : null, read_only_child_ttl_seconds: readChildTtlSeconds, regions, total_object_count: regions.reduce((total, item) => total + item.object_count, 0), total_bytes: regions.reduce((total, item) => total + item.total_bytes, 0), passed: errors.length === 0, errors };
    await writeFile(resolve(outputDirectory, "VERIFICATION-REPORT.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    emit({ status: errors.length === 0 ? "verified" : "verification_failed", run_id: context.run_id, task_count: context.task_count, object_count: report.total_object_count, total_bytes: report.total_bytes, error_count: errors.length, report: resolve(outputDirectory, "VERIFICATION-REPORT.json") });
    if (errors.length > 0) process.exitCode = 1;
  } finally { /* parent credential is never written or logged */ }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
