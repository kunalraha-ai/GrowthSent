#!/usr/bin/env node
/** Stage a reviewed regional run or exact fresh-prefix recovery; never an unbounded run. */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
const WRANGLER = ["--offline", "--yes", "wrangler@4.126.0"];

function fail(message) { throw new Error(message); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlTag(body, name) { return new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? null; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function safeError(error) {
  const redacted = (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
  return redacted.length <= 512 ? redacted : redacted.slice(0, 256) + " ... " + redacted.slice(-256);
}
function safeCloudflareErrors(body) { return (Array.isArray(body?.errors) ? body.errors : []).slice(0, 3).map((item) => ({ code: item?.code ?? null, message: typeof item?.message === "string" ? item.message.slice(0, 240) : null })); }

async function stdinText() { const parts = []; for await (const part of process.stdin) parts.push(part); return Buffer.concat(parts).toString("utf8").trim(); }

function run(command, args, { cwd, input, env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input ?? "");
  });
}

async function runRequired(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) fail(`${command} failed before a new Container start request; ${safeError(`${result.stdout}\n${result.stderr}`)}`);
  return result;
}

async function cloudflareFetch(path, token, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) } });
  let body = null; try { body = await response.json(); } catch { /* safe error below */ }
  return { response, body };
}

async function verifyParent(token) {
  for (const candidate of [{ kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` }, { kind: "user", path: "/user/tokens/verify" }]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") return { id: body.result.id, kind: candidate.kind };
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintChild(token, parent, prefix, ttlSeconds) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-write", ttlSeconds, prefixes: [prefix] }),
  });
  const credentials = body?.result;
  if (!response.ok || !body?.success || typeof credentials?.accessKeyId !== "string" || !SHA256_RE.test(credentials?.secretAccessKey ?? "") || typeof credentials?.sessionToken !== "string") {
    fail(`Cloudflare Temporary Credentials API mint failed (${response.status}; ${JSON.stringify(safeCloudflareErrors(body))}).`);
  }
  return credentials;
}

async function preflightRegion(credentials, prefix) {
  const client = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, service: "s3" });
  const sentinel = `${prefix}TASK-COMPLETED.json`;
  const getResponse = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}/${encodedKey(sentinel)}`, { method: "GET", headers: { Range: "bytes=0-0" } });
  const getBody = (await getResponse.text()).slice(0, 4096);
  const get = { http_status: getResponse.status, r2_error_code: xmlTag(getBody, "Code"), object_exists: getResponse.ok };
  if (get.http_status !== 404 || get.r2_error_code !== "NoSuchKey" || get.object_exists) fail(`Regional GetObject preflight failed (${get.http_status}; ${get.r2_error_code ?? "no R2 error code"}).`);
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const listResponse = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const listBody = (await listResponse.text()).slice(0, 131072);
  const keyCount = (listBody.match(/<Key>/g) ?? []).length;
  const truncated = xmlTag(listBody, "IsTruncated") === "true";
  if (listResponse.status !== 200 || keyCount !== 0 || truncated) fail(`Regional ListObjectsV2 preflight failed (${listResponse.status}; key_count=${keyCount}; truncated=${truncated}).`);
  return { get, list: { http_status: listResponse.status, key_count: keyCount, truncated } };
}

async function boto3Preflight(bundle, credentials, prefix) {
  const input = JSON.stringify({ account_id: ACCOUNT_ID, bucket: BUCKET, key: `${prefix}TASK-COMPLETED.json`, prefix, access_key_id: credentials.accessKeyId, secret_access_key: credentials.secretAccessKey, session_token: credentials.sessionToken });
  const packages = process.env.GROWTHSENT_BOTO3_SITE_PACKAGES;
  const pythonPath = packages ? `${packages}:${process.env.PYTHONPATH ?? ""}` : process.env.PYTHONPATH;
  const result = await run("python3", [resolve(bundle, "r2-boto3-preflight.py")], { cwd: bundle, input, env: { ...process.env, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) } });
  let diagnostic; try { diagnostic = JSON.parse(result.stdout); } catch { fail("boto3 regional preflight returned no safe diagnostic."); }
  if (result.code !== 0 || diagnostic.get_http_status !== 404 || diagnostic.get_error_code !== "NoSuchKey" || diagnostic.list_http_status !== 200 || diagnostic.key_count !== 0 || diagnostic.truncated !== false) fail("Regional boto3 preflight failed; no Worker was deployed.");
  return diagnostic;
}

function workerUrlFromDeploy(output) { return /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i.exec(output)?.[0] ?? null; }

async function workerStatus(url) {
  const response = await fetch(`${url}/_growthsent_standard1_regional_ramp/status`, { method: "GET" });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

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

function validatePlan(plan, mode) {
  const enamRecovery = mode === "--approved-enam-recovery";
  const incompleteRecovery = mode === "--approved-incomplete-recovery";
  const remainingRecovery = mode === "--approved-remaining-recovery";
  const highCapacityPartialRecovery = mode === "--approved-128-partial-recovery";
  const highCapacityTenThousandPartialRecovery = mode === "--approved-256-partial-recovery";
  const highCapacityTenThousandFailedLaneRecovery = mode === "--approved-256-failed-lane-recovery";
  const highCapacityTenThousand = mode === "--approved-256-ten-thousand-wat-run";
  const highCapacityTenThousandRecovery = highCapacityTenThousandPartialRecovery || highCapacityTenThousandFailedLaneRecovery;
  const recovery = enamRecovery || incompleteRecovery || remainingRecovery || highCapacityPartialRecovery || highCapacityTenThousandRecovery;
  const thousand = mode === "--approved-thousand-wat-run";
  const tenThousand = mode === "--approved-ten-thousand-wat-run";
  const highCapacityCheckpoint = mode === "--approved-128-capacity-checkpoint";
  const expectedKind = enamRecovery ? ENAM_RECOVERY_PLAN_KIND : incompleteRecovery ? INCOMPLETE_RECOVERY_PLAN_KIND : remainingRecovery ? REMAINING_RECOVERY_PLAN_KIND : highCapacityPartialRecovery ? HIGH_CAPACITY_PARTIAL_RECOVERY_PLAN_KIND : highCapacityTenThousandPartialRecovery ? HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PLAN_KIND : highCapacityTenThousandFailedLaneRecovery ? HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PLAN_KIND : highCapacityTenThousand ? HIGH_CAPACITY_TEN_THOUSAND_PLAN_KIND : NORMAL_PLAN_KIND;
  const expectedRegions = enamRecovery ? ["ENAM"] : highCapacityPartialRecovery || highCapacityTenThousandRecovery ? plan?.recovery?.recovery_regions : highCapacityTenThousand ? HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region) : REGIONS;
  const expectedTaskCount = enamRecovery ? 18 : incompleteRecovery ? 408 : remainingRecovery ? 234 : highCapacityPartialRecovery || highCapacityTenThousandRecovery ? plan?.recovery?.recovery_task_count : thousand ? 1000 : tenThousand || highCapacityTenThousand ? 10000 : highCapacityCheckpoint ? 1000 : null;
  const expectedProfile = enamRecovery ? ENAM_RECOVERY_PROFILE : incompleteRecovery ? INCOMPLETE_RECOVERY_PROFILE : remainingRecovery ? REMAINING_RECOVERY_PROFILE : highCapacityPartialRecovery ? HIGH_CAPACITY_PARTIAL_RECOVERY_PROFILE : highCapacityTenThousandPartialRecovery ? HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_PROFILE : highCapacityTenThousandFailedLaneRecovery ? HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_PROFILE : highCapacityTenThousand ? HIGH_CAPACITY_TEN_THOUSAND_PROFILE : thousand ? THOUSAND_WAT_PROFILE : tenThousand ? TEN_THOUSAND_WAT_PROFILE : highCapacityCheckpoint ? HIGH_CAPACITY_CHECKPOINT_PROFILE : CAPACITY_CHECKPOINT_PROFILE;
  const expectedMaxConcurrent = highCapacityCheckpoint || highCapacityPartialRecovery || highCapacityTenThousandRecovery || highCapacityTenThousand ? 32 : 4;
  const expectedCredentialPolicy = CREDENTIAL_POLICIES[expectedProfile];
  if (plan?.kind !== expectedKind || typeof plan?.run_id !== "string" || !Number.isInteger(plan?.task_count) || !Array.isArray(expectedRegions) || expectedRegions.length < 1 || !Array.isArray(plan?.regions) || plan.regions.length !== expectedRegions.length) fail("The local plan is not the reviewed regional deployment contract.");
  if (plan.execution_profile !== expectedProfile || !matchesCredentialPolicy(plan.credential_policy, expectedCredentialPolicy)) fail("The local plan credential profile is not the reviewed deployment policy.");
  if (recovery || thousand || tenThousand || highCapacityCheckpoint || highCapacityTenThousand ? plan.task_count !== expectedTaskCount : plan.task_count < 50 || plan.task_count > 100) fail("The local plan task count is outside its reviewed bound.");
  const regionNames = plan.regions.map((item) => item?.region);
  if (JSON.stringify(regionNames) !== JSON.stringify(expectedRegions) || ((highCapacityPartialRecovery || highCapacityTenThousandRecovery || highCapacityTenThousand) ? plan.max_concurrent_total !== plan.regions.reduce((total, item) => total + item?.max_concurrent, 0) : plan.max_concurrent_total !== expectedRegions.length * expectedMaxConcurrent)) fail("Regional plan lanes do not match the reviewed active-container policy.");
  if (plan.regions.some((item, index) => {
    const highCapacityLane = highCapacityTenThousand || highCapacityTenThousandRecovery ? HIGH_CAPACITY_TEN_THOUSAND_LANES.find((lane) => lane.region === item?.region) : null;
    return item?.region_index !== index || item?.region_count !== expectedRegions.length || ((highCapacityPartialRecovery || highCapacityTenThousandRecovery) ? item?.max_concurrent !== Math.min(32, item?.regional_task_count) : item?.max_concurrent !== expectedMaxConcurrent) || item?.max_instances !== item?.max_concurrent + 2 || item?.placement_constraint !== (highCapacityLane?.placement ?? item?.region) || (highCapacityLane !== null && item?.initial_start_delay_seconds !== highCapacityLane.initial_delay) || !SHA256_RE.test(item?.release_sha256 ?? "") || typeof item?.bundle !== "string" || typeof item?.worker_name !== "string" || !Number.isInteger(item?.regional_task_count);
  })) fail("Regional plan contains an unsafe Worker configuration.");
  if (tenThousand && plan.regions.some((item) => item?.regional_task_count !== 2500)) fail("The 10,000-WAT plan does not bind four exact 2,500-task regional lanes.");
  if (highCapacityTenThousand && (plan.start_spacing_seconds_per_lane !== 30 || plan.regions.some((item) => item?.regional_task_count !== 1250))) fail("The 256-slot 10,000-WAT plan does not bind eight exact 1,250-task lanes.");
  if (highCapacityCheckpoint && plan.regions.some((item) => item?.regional_task_count !== 250)) fail("The 128-container checkpoint does not bind four exact 250-task regional lanes.");
  if (!SHA256_RE.test(plan.selected_inputs_sha256 ?? "") || plan.r2_root !== `production/common-crawl/cloudflare-r2-regional-ramps/v1/${plan.run_id}/`) fail("Regional plan input or R2 identity is invalid.");
  if (!recovery) return;
  const recoveryPlan = plan.recovery;
  const indexes = recoveryPlan?.recovery_source_indexes;
  if (enamRecovery) {
    if (recoveryPlan?.source_run_id !== "cc-main-2026-30-20260831t121855z-standard1-regional-8381964f" || recoveryPlan?.source_task_count !== 100 || !SHA256_RE.test(recoveryPlan?.source_selected_inputs_sha256 ?? "") || recoveryPlan?.source_region !== "ENAM" || recoveryPlan?.source_region_index !== 1 || recoveryPlan?.source_region_count !== 4 || recoveryPlan?.failed_source_index !== 25 || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "")) fail("ENAM recovery plan does not bind the diagnosed 100-WAT source run.");
    if (!Array.isArray(indexes) || indexes.length !== expectedTaskCount || !indexes.includes(recoveryPlan.failed_source_index) || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= recoveryPlan.source_task_count || index % recoveryPlan.source_region_count !== recoveryPlan.source_region_index || (position > 0 && indexes[position - 1] >= index))) fail("ENAM recovery plan does not contain the exact ordered incomplete ENAM task set.");
    return;
  }
  if (highCapacityPartialRecovery) {
    if (recoveryPlan?.contract_kind !== HIGH_CAPACITY_PARTIAL_RECOVERY_CONTRACT_KIND || recoveryPlan?.source_execution_profile !== HIGH_CAPACITY_CHECKPOINT_PROFILE || typeof recoveryPlan?.source_run_id !== "string" || recoveryPlan?.source_task_count !== 1000 || recoveryPlan?.source_max_concurrent_total !== 128 || !SHA256_RE.test(recoveryPlan?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_plan_sha256 ?? "") || !Array.isArray(recoveryPlan?.recovery_regions) || JSON.stringify(recoveryPlan.recovery_regions) !== JSON.stringify(expectedRegions) || JSON.stringify(expectedRegions) !== JSON.stringify(REGIONS.filter((region) => recoveryPlan?.inventory?.region_incomplete_counts?.[region] > 0)) || recoveryPlan?.inventory?.completed_source_count + recoveryPlan?.inventory?.incomplete_task_count !== 1000 || recoveryPlan?.inventory?.incomplete_task_count !== expectedTaskCount || recoveryPlan?.source_workers?.all_inactive !== true) fail("128-slot partial recovery plan does not bind an audited inactive source run.");
    if (!Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 1000 || (position > 0 && indexes[position - 1] >= index)) || recoveryPlan?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("128-slot partial recovery plan does not contain the exact audited missing source indexes.");
    return;
  }
  if (highCapacityTenThousandPartialRecovery) {
    const sourceLanes = HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region);
    if (recoveryPlan?.contract_kind !== HIGH_CAPACITY_TEN_THOUSAND_PARTIAL_RECOVERY_CONTRACT_KIND || recoveryPlan?.source_execution_profile !== HIGH_CAPACITY_TEN_THOUSAND_PROFILE || typeof recoveryPlan?.source_run_id !== "string" || recoveryPlan?.source_task_count !== 10000 || recoveryPlan?.source_max_concurrent_total !== 256 || !SHA256_RE.test(recoveryPlan?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_plan_sha256 ?? "") || !Array.isArray(recoveryPlan?.recovery_regions) || JSON.stringify(recoveryPlan.recovery_regions) !== JSON.stringify(expectedRegions) || JSON.stringify(expectedRegions) !== JSON.stringify(sourceLanes.filter((region) => recoveryPlan?.inventory?.region_incomplete_counts?.[region] > 0)) || recoveryPlan?.inventory?.completed_source_count + recoveryPlan?.inventory?.incomplete_task_count !== 10000 || recoveryPlan?.inventory?.incomplete_task_count !== expectedTaskCount || recoveryPlan?.source_workers?.all_inactive !== true) fail("256-slot partial recovery plan does not bind an audited inactive source run.");
    if (!Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 10000 || (position > 0 && indexes[position - 1] >= index)) || recoveryPlan?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("256-slot partial recovery plan does not contain the exact audited missing source indexes.");
    if (plan.start_spacing_seconds_per_lane !== 30) fail("256-slot partial recovery plan does not preserve the reviewed lane spacing.");
    return;
  }
  if (highCapacityTenThousandFailedLaneRecovery) {
    const sourceLanes = HIGH_CAPACITY_TEN_THOUSAND_LANES.map((item) => item.region);
    const sourceStates = recoveryPlan?.source_workers?.regions;
    const recoveryRegions = recoveryPlan?.recovery_regions;
    const recoveryLanePositions = new Set((Array.isArray(recoveryRegions) ? recoveryRegions : []).map((region) => sourceLanes.indexOf(region)));
    if (recoveryPlan?.contract_kind !== HIGH_CAPACITY_TEN_THOUSAND_FAILED_LANE_RECOVERY_CONTRACT_KIND || recoveryPlan?.source_execution_profile !== HIGH_CAPACITY_TEN_THOUSAND_PROFILE || typeof recoveryPlan?.source_run_id !== "string" || recoveryPlan?.source_task_count !== 10000 || recoveryPlan?.source_max_concurrent_total !== 256 || !SHA256_RE.test(recoveryPlan?.source_selected_inputs_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_plan_sha256 ?? "") || !Array.isArray(recoveryRegions) || JSON.stringify(recoveryRegions) !== JSON.stringify(expectedRegions) || JSON.stringify(recoveryRegions) !== JSON.stringify(sourceLanes.filter((region) => recoveryPlan?.inventory?.region_incomplete_counts?.[region] > 0) || []) || recoveryPlan?.inventory?.scope !== "terminal_source_lanes_only" || recoveryPlan?.inventory?.scoped_task_count !== recoveryRegions.length * 1250 || recoveryPlan?.inventory?.scoped_task_count + recoveryPlan?.inventory?.unscoped_task_count !== 10000 || recoveryPlan?.inventory?.completed_source_count + recoveryPlan?.inventory?.incomplete_task_count !== recoveryPlan?.inventory?.scoped_task_count || recoveryPlan?.inventory?.incomplete_task_count !== expectedTaskCount || recoveryPlan?.source_workers?.recovery_lanes_inactive !== true || recoveryPlan?.source_workers?.recovery_regions?.join("|") !== recoveryRegions.join("|") || !Array.isArray(sourceStates) || sourceStates.map((item) => item?.region).join("|") !== sourceLanes.join("|")) fail("256-slot failed-lane recovery plan does not bind an audited terminal-lane inventory.");
    if (!Array.isArray(indexes) || indexes.length !== expectedTaskCount || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 10000 || !recoveryLanePositions.has(index % sourceLanes.length) || (position > 0 && indexes[position - 1] >= index)) || recoveryPlan?.recovery_source_indexes_sha256 !== sha256(JSON.stringify(indexes) + "\n")) fail("256-slot failed-lane recovery plan contains source indexes outside its terminal lane partition.");
    if (sourceStates.some((item) => recoveryRegions.includes(item?.region) && (item?.safely_inactive !== true || !["task_failed", "credential_window_elapsed", "completed_with_recoverable_failures"].includes(item?.launch_state)))) fail("256-slot failed-lane recovery plan does not prove every selected source lane is inactive.");
    if (plan.start_spacing_seconds_per_lane !== 30) fail("256-slot failed-lane recovery plan does not preserve the reviewed lane spacing.");
    return;
  }
  const expectedIndexes = incompleteRecoveryIndexes();
  if (incompleteRecovery) {
    if (recoveryPlan?.source_run_id !== "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" || recoveryPlan?.source_task_count !== 1000 || recoveryPlan?.source_selected_inputs_sha256 !== "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5" || recoveryPlan?.source_plan_sha256 !== "876b4543a1fb1ddaee93d66d421c1c384ac3510aca7ef74da8c7ccf98ea99d72" || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "") || recoveryPlan?.inventory?.completion_marker_count !== 592 || recoveryPlan?.inventory?.incomplete_task_count !== 408) fail("incomplete recovery plan does not bind the audited 1,000-WAT source run.");
    if (!Array.isArray(indexes) || JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) fail("incomplete recovery plan does not contain the exact audited missing source indexes.");
    return;
  }
  if (recoveryPlan?.contract_kind !== REMAINING_RECOVERY_CONTRACT_KIND || recoveryPlan?.source_run_id !== "cc-main-2026-30-20260831t155030z-standard1-regional-220a5d98" || recoveryPlan?.source_task_count !== 1000 || recoveryPlan?.source_selected_inputs_sha256 !== "220d65e0ef9aa1c6d1b12ac408e2c3feb71e063abaddc0f89f6040aa18e09ff5" || recoveryPlan?.source_plan_sha256 !== "876b4543a1fb1ddaee93d66d421c1c384ac3510aca7ef74da8c7ccf98ea99d72" || !SHA256_RE.test(recoveryPlan?.contract_sha256 ?? "") || !SHA256_RE.test(recoveryPlan?.source_context_sha256 ?? "") || recoveryPlan?.inventory?.original_completion_marker_count !== 592 || recoveryPlan?.inventory?.prior_recovery_completion_marker_count !== 174 || recoveryPlan?.inventory?.unique_completed_source_count !== 766 || recoveryPlan?.inventory?.remaining_task_count !== 234 || recoveryPlan?.prior_recovery?.run_id !== "cc-main-2026-30-20260901t015900z-standard1-incomplete-156cf3c4" || recoveryPlan?.prior_recovery?.completion_marker_count !== 174 || recoveryPlan?.recovery_source_indexes_sha256 !== REMAINING_RECOVERY_INDEXES_SHA256) fail("remaining recovery plan does not bind the merged 1,000-WAT completion inventory.");
  if (recoveryPlan?.inventory?.original_and_prior_recovery_overlap_count !== 0 || recoveryPlan?.prior_recovery?.container_instances_verified_inactive !== true) fail("remaining recovery plan does not prove a disjoint, inactive prior recovery.");
  if (!Array.isArray(indexes) || indexes.length !== 234 || indexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= 1000 || (position > 0 && indexes[position - 1] >= index)) || sha256(JSON.stringify(indexes) + "\n") !== REMAINING_RECOVERY_INDEXES_SHA256) fail("remaining recovery plan does not contain the exact audited source indexes.");
}

async function waitForSafeWorker(url, expected) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    const status = await workerStatus(url);
    if (status?.run_id === expected.runId && status?.region === expected.region && status?.control_secret_configured === true && status?.launch === null && Array.isArray(status?.active_tasks) && status.active_tasks.length === 0) return status;
  }
  fail(`Fresh ${expected.region} Worker state was not safe to schedule; no Container start request was sent for it.`);
}

async function main() {
  const [mode, planPath] = process.argv.slice(2);
  if (!(["--approved-regional-capacity-run", "--approved-thousand-wat-run", "--approved-ten-thousand-wat-run", "--approved-256-ten-thousand-wat-run", "--approved-128-capacity-checkpoint", "--approved-enam-recovery", "--approved-incomplete-recovery", "--approved-remaining-recovery", "--approved-128-partial-recovery", "--approved-256-partial-recovery", "--approved-256-failed-lane-recovery"].includes(mode)) || !planPath) fail("Usage: provision-and-start-wsl.mjs <--approved-regional-capacity-run|--approved-thousand-wat-run|--approved-ten-thousand-wat-run|--approved-256-ten-thousand-wat-run|--approved-128-capacity-checkpoint|--approved-enam-recovery|--approved-incomplete-recovery|--approved-remaining-recovery|--approved-128-partial-recovery|--approved-256-partial-recovery|--approved-256-failed-lane-recovery> <RUN-PLAN.json>");
  const planFile = resolve(planPath);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  validatePlan(plan, mode);
  const enamRecovery = mode === "--approved-enam-recovery";
  const incompleteRecovery = mode === "--approved-incomplete-recovery";
  const remainingRecovery = mode === "--approved-remaining-recovery";
  const highCapacityPartialRecovery = mode === "--approved-128-partial-recovery";
  const highCapacityTenThousandPartialRecovery = mode === "--approved-256-partial-recovery";
  const highCapacityTenThousandFailedLaneRecovery = mode === "--approved-256-failed-lane-recovery";
  const highCapacityTenThousand = mode === "--approved-256-ten-thousand-wat-run";
  const recovery = enamRecovery || incompleteRecovery || remainingRecovery || highCapacityPartialRecovery || highCapacityTenThousandPartialRecovery || highCapacityTenThousandFailedLaneRecovery;
  const tenThousand = mode === "--approved-ten-thousand-wat-run";
  const highCapacityCheckpoint = mode === "--approved-128-capacity-checkpoint";
  const recoveryStage = enamRecovery ? "enam_recovery" : incompleteRecovery ? "incomplete_recovery" : remainingRecovery ? "remaining_recovery" : highCapacityPartialRecovery ? "high_capacity_partial_recovery" : highCapacityTenThousandPartialRecovery ? "high_capacity_ten_thousand_partial_recovery" : highCapacityTenThousandFailedLaneRecovery ? "high_capacity_ten_thousand_failed_lane_recovery" : highCapacityTenThousand ? "high_capacity_ten_thousand" : tenThousand ? "ten_thousand" : highCapacityCheckpoint ? "high_capacity_checkpoint" : "regional";
  const contextName = enamRecovery ? "ENAM-RECOVERY-CONTEXT.json" : incompleteRecovery ? "INCOMPLETE-RECOVERY-CONTEXT.json" : remainingRecovery ? "REMAINING-RECOVERY-CONTEXT.json" : highCapacityPartialRecovery ? "HIGH-CAPACITY-PARTIAL-RECOVERY-CONTEXT.json" : highCapacityTenThousandPartialRecovery ? "HIGH-CAPACITY-TEN-THOUSAND-PARTIAL-RECOVERY-CONTEXT.json" : highCapacityTenThousandFailedLaneRecovery ? "HIGH-CAPACITY-TEN-THOUSAND-FAILED-LANE-RECOVERY-CONTEXT.json" : highCapacityTenThousand ? "HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json" : tenThousand ? "TEN-THOUSAND-RAMP-CONTEXT.json" : highCapacityCheckpoint ? "HIGH-CAPACITY-CHECKPOINT-CONTEXT.json" : "REGIONAL-RAMP-CONTEXT.json";
  const credentialPolicy = plan.credential_policy;
  let parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  const regions = [];
  try {
    const parent = await verifyParent(parentToken);
    for (const regionPlan of plan.regions) {
      const bundle = resolve(regionPlan.bundle);
      const config = JSON.parse(await readFile(resolve(bundle, "wrangler.jsonc"), "utf8"));
      const regionPrefix = `${plan.r2_root}region=${regionPlan.region.toLowerCase()}/`;
      const container = config?.containers?.[0];
      const bindings = config?.durable_objects?.bindings;
      const validBindings = Array.isArray(bindings) && bindings.some((item) => item?.name === "RAMP_CONTAINER" && item?.class_name === "GrowthSentStandard1RegionalRampContainer") && bindings.some((item) => item?.name === "RAMP_COORDINATOR" && item?.class_name === "GrowthSentStandard1RegionalRampCoordinator");
      if (config?.name !== regionPlan.worker_name || config?.vars?.GROWTHSENT_RAMP_ID !== plan.run_id || config?.vars?.GROWTHSENT_REGION !== regionPlan.region || config?.vars?.GROWTHSENT_REGION_INDEX !== String(regionPlan.region_index) || config?.vars?.GROWTHSENT_REGION_COUNT !== String(plan.regions.length) || config?.vars?.GROWTHSENT_TASK_COUNT !== String(plan.task_count) || config?.vars?.GROWTHSENT_REGIONAL_TASK_COUNT !== String(regionPlan.regional_task_count) || config?.vars?.GROWTHSENT_SELECTED_INPUTS_SHA256 !== plan.selected_inputs_sha256 || config?.vars?.GROWTHSENT_MAX_CONCURRENT !== String(regionPlan.max_concurrent) || config?.vars?.GROWTHSENT_START_SPACING_SECONDS !== String(plan.start_spacing_seconds_per_lane) || config?.vars?.GROWTHSENT_INITIAL_START_DELAY_SECONDS !== String(regionPlan.initial_start_delay_seconds) || config?.vars?.GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS !== String(credentialPolicy.start_guard_seconds) || config?.vars?.GROWTHSENT_HARD_TIMEOUT_SECONDS !== "6600" || container?.instance_type !== "standard-1" || container?.max_instances !== regionPlan.max_instances || container?.constraints?.regions?.[0] !== regionPlan.placement_constraint || !validBindings) fail(`The ${regionPlan.region} local bundle is not the reviewed deployment configuration.`);
      const credentials = await mintChild(parentToken, parent, regionPrefix, credentialPolicy.child_ttl_seconds);
      const credentialNotAfter = new Date(Date.now() + credentialPolicy.child_ttl_seconds * 1000).toISOString();
      const aws4fetch = await preflightRegion(credentials, regionPrefix);
      const boto3 = await boto3Preflight(bundle, credentials, regionPrefix);
      regions.push({ ...regionPlan, bundle, region_prefix: regionPrefix, credential_not_after: credentialNotAfter, credentials });
      emit({ stage: `${recoveryStage}_preflighted`, region: regionPlan.region, scope: "object-read-write", ttl_seconds: credentialPolicy.child_ttl_seconds, prefix: regionPrefix, child_aws4fetch: aws4fetch, child_boto3: boto3 });
    }
    emit({ stage: recovery ? `all_${recoveryStage}_checks_preflighted` : "all_regions_preflighted", region_count: regions.length, task_count: plan.task_count, worker_deployed: false, container_started: false });

    for (const item of regions) {
      await runRequired("npx", [...WRANGLER, "deploy", "--dry-run", "--config", "wrangler.jsonc"], { cwd: item.bundle });
      const deploy = await runRequired("npx", [...WRANGLER, "deploy", "--config", "wrangler.jsonc"], { cwd: item.bundle });
      item.worker_url = workerUrlFromDeploy(`${deploy.stdout}\n${deploy.stderr}`);
      if (!item.worker_url) fail(`${item.region} Worker deployed but Wrangler did not report a workers.dev URL; no secrets were installed for it.`);
      item.trigger_token = randomBytes(32).toString("base64url");
      const secrets = {
        GROWTHSENT_R2_ACCESS_KEY_ID: item.credentials.accessKeyId,
        GROWTHSENT_R2_SECRET_ACCESS_KEY: item.credentials.secretAccessKey,
        GROWTHSENT_R2_SESSION_TOKEN: item.credentials.sessionToken,
        GROWTHSENT_R2_CREDENTIAL_NOT_AFTER: item.credential_not_after,
        RAMP_TRIGGER_TOKEN: item.trigger_token,
      };
      await runRequired("npx", [...WRANGLER, "secret", "bulk", "--name", item.worker_name], { cwd: item.bundle, input: JSON.stringify(secrets) });
      await waitForSafeWorker(item.worker_url, { runId: plan.run_id, region: item.region });
      emit({ stage: `${recoveryStage}_worker_ready`, region: item.region, worker: item.worker_name });
    }

    const contextPath = resolve(planFile, "..", contextName);
    await writeFile(contextPath, `${JSON.stringify({ kind: plan.kind, execution_profile: plan.execution_profile, credential_policy: plan.credential_policy, run_id: plan.run_id, r2_root: plan.r2_root, selected_inputs_sha256: plan.selected_inputs_sha256, task_count: plan.task_count, max_concurrent_total: plan.max_concurrent_total, start_spacing_seconds_per_lane: plan.start_spacing_seconds_per_lane, child_credential_ttl_seconds: credentialPolicy.child_ttl_seconds, parent_token_kind: parent.kind, recovery: recovery ? plan.recovery : null, regions: regions.map((item) => ({ region: item.region, placement_constraint: item.placement_constraint, initial_start_delay_seconds: item.initial_start_delay_seconds, worker_name: item.worker_name, worker_url: item.worker_url, region_prefix: item.region_prefix, credential_not_after: item.credential_not_after, regional_task_count: item.regional_task_count, max_concurrent: item.max_concurrent, max_instances: item.max_instances, release_sha256: item.release_sha256 })) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (const item of regions) {
      const start = await fetch(`${item.worker_url}/_growthsent_standard1_regional_ramp/start`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: item.trigger_token });
      let body = null; try { body = await start.json(); } catch { /* checked below */ }
      if (start.status !== 202 || body?.accepted !== true || body?.run_id !== plan.run_id || body?.region !== item.region) fail(`${item.region} regional schedule was not accepted (HTTP ${start.status}); do not retry this launcher because an earlier lane may be running.`);
      emit({ stage: `${recoveryStage}_schedule_accepted`, region: item.region, http_status: 202, task_count: item.regional_task_count });
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    }
    emit({ status: enamRecovery ? "live_enam_recovery_accepted" : incompleteRecovery ? "live_incomplete_recovery_accepted" : remainingRecovery ? "live_remaining_recovery_accepted" : highCapacityPartialRecovery ? "live_128_partial_recovery_accepted" : highCapacityTenThousandPartialRecovery ? "live_256_partial_recovery_accepted" : highCapacityTenThousandFailedLaneRecovery ? "live_256_failed_lane_recovery_accepted" : highCapacityTenThousand ? "live_256_ten_thousand_wat_accepted" : tenThousand ? "live_ten_thousand_wat_accepted" : highCapacityCheckpoint ? "live_128_capacity_checkpoint_accepted" : "live_regional_capacity_run_accepted", run_id: plan.run_id, task_count: plan.task_count, context: contextPath });
  } finally {
    parentToken = "";
    for (const item of regions) { item.credentials = null; item.trigger_token = ""; }
  }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
