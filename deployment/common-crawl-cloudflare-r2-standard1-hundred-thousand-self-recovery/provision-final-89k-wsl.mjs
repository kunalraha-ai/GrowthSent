#!/usr/bin/env node
/**
 * Provision the reviewed remaining-89K campaign under published account limits.
 *
 * This is intentionally separate from the local compile gate.  It is capable
 * of changing Cloudflare state only when called with its explicit approval
 * flag, a reviewed plan, and a parent token on stdin. The parent token never
 * reaches a Worker or Container.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ACCOUNT_ID = "4a30e8ac877d9f65ee9a0ecc5df16146";
const BUCKET = "growthsent-data-lake";
const PLAN_KIND = "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-plan-v1";
const EXECUTION_PROFILE = "regional-1440-remaining-eighty-nine-thousand-self-recovery";
const CREDENTIAL_POLICY = { id: "regional-six-day-v1", child_ttl_seconds: 518400, start_guard_seconds: 10800 };
const SHA256 = /^[0-9a-f]{64}$/;
const WRANGLER = ["--offline", "--yes", "wrangler@4.126.0"];
const EXPECTED_GROUP_LANES = { APAC: 8, ENAM: 8, WNAM: 8, EEUR: 7, WEUR: 7, SAM: 7 };
let failureLogDirectory = null;

function fail(message) { throw new Error(message); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function endpoint() { return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`; }
function encodedKey(key) { return key.split("/").map(encodeURIComponent).join("/"); }
function xmlTag(body, name) { return new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? null; }
function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonicalJson(item))));
  if (value !== null && typeof value === "object") {
    const ordered = {};
    for (const key of Object.keys(value).sort()) ordered[key] = JSON.parse(canonicalJson(value[key]));
    return JSON.stringify(ordered);
  }
  return JSON.stringify(value);
}
function safeError(error) {
  const text = (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
  return text.length <= 512 ? text : text.slice(0, 512);
}
function safeCommandOutput(text) {
  return text.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 131072);
}
function safeCloudflareErrors(body) {
  return (Array.isArray(body?.errors) ? body.errors : []).slice(0, 3).map((item) => ({ code: item?.code ?? null, message: typeof item?.message === "string" ? item.message.slice(0, 240) : null }));
}

async function stdinText() {
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  return Buffer.concat(parts).toString("utf8").trim();
}

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
  if (result.code !== 0) {
    const diagnostic = `${command} ${args.join(" ")}\n\nstdout:\n${safeCommandOutput(result.stdout)}\n\nstderr:\n${safeCommandOutput(result.stderr)}\n`;
    let safeLogPath = null;
    if (failureLogDirectory !== null) {
      await mkdir(failureLogDirectory, { recursive: true, mode: 0o700 });
      safeLogPath = resolve(failureLogDirectory, `${Date.now()}-${command.replace(/[^a-z0-9]+/gi, "-")}.log`);
      await writeFile(safeLogPath, diagnostic, { encoding: "utf8", mode: 0o600 });
    }
    fail(`${command} failed before a new Container start request; ${safeError(`${result.stdout}\n${result.stderr}`)}${safeLogPath === null ? "" : ` Safe diagnostic: ${safeLogPath}`}`);
  }
  return result;
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
  for (const candidate of [{ kind: "account", path: `/accounts/${ACCOUNT_ID}/tokens/verify` }, { kind: "user", path: "/user/tokens/verify" }]) {
    const { response, body } = await cloudflareFetch(candidate.path, token, { method: "GET" });
    if (response.ok && body?.success && body?.result?.status === "active" && typeof body.result.id === "string") return { id: body.result.id, kind: candidate.kind };
  }
  fail("The parent Cloudflare API token could not be verified as active.");
}

async function mintChild(token, parent, prefix) {
  const { response, body } = await cloudflareFetch(`/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`, token, {
    method: "POST",
    body: JSON.stringify({ bucket: BUCKET, parentAccessKeyId: parent.id, permission: "object-read-write", ttlSeconds: CREDENTIAL_POLICY.child_ttl_seconds, prefixes: [prefix] }),
  });
  const credentials = body?.result;
  if (!response.ok || !body?.success || typeof credentials?.accessKeyId !== "string" || !SHA256.test(credentials?.secretAccessKey ?? "") || typeof credentials?.sessionToken !== "string") {
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
  if (get.http_status !== 404 || get.r2_error_code !== "NoSuchKey" || get.object_exists) fail(`Fresh lane GetObject preflight failed (${get.http_status}; ${get.r2_error_code ?? "no R2 error code"}).`);
  const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
  const listResponse = await client.fetch(`${endpoint()}/${encodeURIComponent(BUCKET)}?${query}`, { method: "GET" });
  const listBody = (await listResponse.text()).slice(0, 131072);
  const keyCount = (listBody.match(/<Key>/g) ?? []).length;
  const truncated = xmlTag(listBody, "IsTruncated") === "true";
  if (listResponse.status !== 200 || keyCount !== 0 || truncated) fail(`Fresh lane ListObjectsV2 preflight failed (${listResponse.status}; key_count=${keyCount}; truncated=${truncated}).`);
  return { get, list: { http_status: listResponse.status, key_count: keyCount, truncated } };
}

async function boto3Preflight(bundle, credentials, prefix) {
  const input = JSON.stringify({ account_id: ACCOUNT_ID, bucket: BUCKET, key: `${prefix}TASK-COMPLETED.json`, prefix, access_key_id: credentials.accessKeyId, secret_access_key: credentials.secretAccessKey, session_token: credentials.sessionToken });
  const packages = process.env.GROWTHSENT_BOTO3_SITE_PACKAGES;
  const pythonPath = packages ? `${packages}:${process.env.PYTHONPATH ?? ""}` : process.env.PYTHONPATH;
  const result = await run("python3", [resolve(bundle, "r2-boto3-preflight.py")], { cwd: bundle, input, env: { ...process.env, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) } });
  let diagnostic;
  try { diagnostic = JSON.parse(result.stdout); } catch { fail("boto3 fresh-lane preflight returned no safe diagnostic."); }
  if (result.code !== 0 || diagnostic.get_http_status !== 404 || diagnostic.get_error_code !== "NoSuchKey" || diagnostic.list_http_status !== 200 || diagnostic.key_count !== 0 || diagnostic.truncated !== false) fail("Fresh lane boto3 preflight failed; no Worker was deployed.");
  return diagnostic;
}

function workerUrlFromDeploy(output) { return /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i.exec(output)?.[0] ?? null; }
async function workerStatus(url) {
  const response = await fetch(`${url}/_growthsent_standard1_regional_ramp/status`, { method: "GET" });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}
async function waitForSafeWorker(url, expected) {
  const deadline = Date.now() + 300000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    const status = await workerStatus(url);
    lastStatus = status;
    if (status?.run_id === expected.run_id && status?.region === expected.lane && status?.control_secret_configured === true && status?.launch === null && Array.isArray(status?.active_tasks) && status.active_tasks.length === 0) return;
  }
  const safeLastStatus = lastStatus === null ? null : {
    run_id: typeof lastStatus?.run_id === "string" ? lastStatus.run_id : null,
    region: typeof lastStatus?.region === "string" ? lastStatus.region : null,
    control_secret_configured: lastStatus?.control_secret_configured === true,
    launch_state: typeof lastStatus?.launch?.state === "string" ? lastStatus.launch.state : null,
    active_task_count: Array.isArray(lastStatus?.active_tasks) ? lastStatus.active_tasks.length : null,
  };
  fail(`Fresh ${expected.lane} Worker state was not safe to schedule within five minutes; no Container start request was sent for it. Last safe status: ${JSON.stringify(safeLastStatus)}.`);
}

function planDigest(plan) {
  const payload = { ...plan };
  delete payload.plan_sha256;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function validatePlan(plan) {
  if (plan?.kind !== PLAN_KIND || plan?.execution_profile !== EXECUTION_PROFILE || !SHA256.test(plan?.plan_sha256 ?? "") || plan.plan_sha256 !== planDigest(plan)) fail("The local final 89K plan digest or identity is invalid.");
  if (plan?.source_manifest?.input_count !== 100000 || plan?.processing_window?.source_index_start !== 11000 || plan?.processing_window?.source_index_end_exclusive !== 100000 || plan?.processing_window?.task_count !== 89000) fail("The local final 89K source window is not the reviewed globally disjoint range.");
  if (plan?.verified_reuse_proof?.completed_source_count !== 11000 || !SHA256.test(plan?.verified_reuse_proof?.proof_sha256 ?? "")) fail("The local final 89K plan lacks the verified 11K reuse proof binding.");
  if (plan?.credential_policy?.id !== CREDENTIAL_POLICY.id || plan?.credential_policy?.child_ttl_seconds !== CREDENTIAL_POLICY.child_ttl_seconds || plan?.credential_policy?.start_guard_seconds !== CREDENTIAL_POLICY.start_guard_seconds) fail("The final 89K credential policy is not the reviewed six-day policy.");
  if (plan?.r2_root !== `production/common-crawl/cloudflare-r2-final-campaigns/v1/${plan.run_id}/`) fail("The final 89K R2 root is invalid.");
  if (plan?.topology?.lane_count !== 45 || plan?.topology?.slots_per_lane !== 32 || plan?.topology?.max_concurrent_total !== 1440 || plan?.topology?.max_instances_per_lane !== 32 || plan?.topology?.admission_interval_seconds_per_placement_group !== 6 || plan?.topology?.admission_max_backoff_seconds !== 300) fail("The final 89K topology differs from the reviewed 1,440-slot policy.");
  if (!Array.isArray(plan?.lanes) || plan.lanes.length !== 45 || plan.lanes.reduce((total, lane) => total + lane?.regional_task_count, 0) !== 89000) fail("The final 89K lane partition is incomplete.");
  const groupCounts = {};
  for (const [index, lane] of plan.lanes.entries()) {
    groupCounts[lane?.placement_group] = (groupCounts[lane?.placement_group] ?? 0) + 1;
    if (lane?.lane_index !== index || lane?.lane_count !== 45 || lane?.source_index_start !== 11000 || lane?.max_concurrent !== 32 || lane?.max_instances !== 32 || !SHA256.test(lane?.release_sha256 ?? "") || (lane?.selected_inputs_sha256 !== undefined && !SHA256.test(lane.selected_inputs_sha256)) || typeof lane?.bundle !== "string" || typeof lane?.worker_name !== "string" || typeof lane?.lane !== "string") fail("A final 89K lane is not a reviewed immutable deployment bundle.");
  }
  if (JSON.stringify(groupCounts) !== JSON.stringify(EXPECTED_GROUP_LANES)) fail("The final 89K placement-group lane allocation is invalid.");
  if (![
    "disabled; a separately reviewed launcher and explicit approval are required",
    "disabled; capacity approval and a separately reviewed launcher are required",
  ].includes(plan?.remote_start)) fail("The plan was not produced by the launch-disabled final builder.");
}

async function main() {
  const [mode, planPath] = process.argv.slice(2);
  if (mode !== "--approved-final-89k-run" || !planPath) fail("Usage: provision-final-89k-wsl.mjs --approved-final-89k-run <SELF-RECOVERY-RUN-PLAN.json>");
  const planFile = resolve(planPath);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  validatePlan(plan);
  failureLogDirectory = resolve(planFile, "..", "FINAL-89K-SAFE-LOGS");
  let parentToken = await stdinText();
  if (!parentToken) fail("A parent Cloudflare API token is required.");
  const lanes = [];
  try {
    const parent = await verifyParent(parentToken);
    for (const lanePlan of plan.lanes) {
      const bundle = resolve(lanePlan.bundle);
      const config = JSON.parse(await readFile(resolve(bundle, "wrangler.jsonc"), "utf8"));
      const selectedInputsSha256 = createHash("sha256").update(await readFile(resolve(bundle, "selected-inputs.json"))).digest("hex");
      if (lanePlan.selected_inputs_sha256 !== undefined && lanePlan.selected_inputs_sha256 !== selectedInputsSha256) fail(`The ${lanePlan.lane} plan and selected-input manifest are not bound to the same immutable input set.`);
      const prefix = `${plan.r2_root}lane=${lanePlan.lane.toLowerCase()}/`;
      const container = config?.containers?.[0];
      const bindings = config?.durable_objects?.bindings;
      const validBindings = Array.isArray(bindings) && bindings.some((item) => item?.name === "RAMP_CONTAINER" && item?.class_name === "GrowthSentStandard1RegionalRampContainer") && bindings.some((item) => item?.name === "RAMP_COORDINATOR" && item?.class_name === "GrowthSentStandard1RegionalRampCoordinator") && bindings.some((item) => item?.name === "REGIONAL_ADMISSION" && item?.script_name === plan.admission_worker?.worker_name);
      if (config?.name !== lanePlan.worker_name || config?.vars?.GROWTHSENT_RAMP_ID !== plan.run_id || config?.vars?.GROWTHSENT_REGION !== lanePlan.lane || config?.vars?.GROWTHSENT_REGION_INDEX !== String(lanePlan.lane_index) || config?.vars?.GROWTHSENT_REGION_COUNT !== "45" || config?.vars?.GROWTHSENT_SOURCE_INDEX_START !== "11000" || config?.vars?.GROWTHSENT_TASK_COUNT !== "89000" || config?.vars?.GROWTHSENT_REGIONAL_TASK_COUNT !== String(lanePlan.regional_task_count) || config?.vars?.GROWTHSENT_SELECTED_INPUTS_SHA256 !== selectedInputsSha256 || config?.vars?.GROWTHSENT_MAX_CONCURRENT !== "32" || config?.vars?.GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS !== "10800" || config?.vars?.GROWTHSENT_HARD_TIMEOUT_SECONDS !== "6600" || container?.instance_type !== "standard-1" || container?.max_instances !== 32 || container?.constraints?.regions?.[0] !== lanePlan.placement_group || !validBindings) fail(`The ${lanePlan.lane} local bundle is not the reviewed final deployment configuration.`);
      const credentials = await mintChild(parentToken, parent, prefix);
      const aws4fetch = await preflightRegion(credentials, prefix);
      const boto3 = await boto3Preflight(bundle, credentials, prefix);
      lanes.push({ ...lanePlan, bundle, prefix, credentials, credential_not_after: new Date(Date.now() + CREDENTIAL_POLICY.child_ttl_seconds * 1000).toISOString() });
      emit({ stage: "final_89k_lane_preflighted", lane: lanePlan.lane, placement_group: lanePlan.placement_group, scope: "object-read-write", ttl_seconds: CREDENTIAL_POLICY.child_ttl_seconds, prefix, child_aws4fetch: aws4fetch, child_boto3: boto3 });
    }
    emit({ stage: "all_final_89k_lanes_preflighted", lane_count: lanes.length, task_count: 89000, lane_worker_deployed: false, container_started: false });

    const admissionBundle = resolve(plan.admission_worker?.bundle ?? "");
    const admissionConfig = JSON.parse(await readFile(resolve(admissionBundle, "wrangler.jsonc"), "utf8"));
    if (admissionConfig?.name !== plan.admission_worker?.worker_name || admissionConfig?.vars?.GROWTHSENT_ADMISSION_INTERVAL_SECONDS !== "6" || admissionConfig?.vars?.GROWTHSENT_ADMISSION_MAX_BACKOFF_SECONDS !== "300") fail("The regional admission bundle is not the reviewed final deployment configuration.");
    await runRequired("npx", [...WRANGLER, "deploy", "--dry-run", "--config", "wrangler.jsonc"], { cwd: admissionBundle });
    await runRequired("npx", [...WRANGLER, "deploy", "--config", "wrangler.jsonc"], { cwd: admissionBundle });
    emit({ stage: "final_89k_admission_worker_ready", worker: plan.admission_worker.worker_name });

    for (const lane of lanes) {
      await runRequired("npx", [...WRANGLER, "deploy", "--dry-run", "--config", "wrangler.jsonc"], { cwd: lane.bundle });
      const deploy = await runRequired("npx", [...WRANGLER, "deploy", "--config", "wrangler.jsonc"], { cwd: lane.bundle });
      lane.worker_url = workerUrlFromDeploy(`${deploy.stdout}\n${deploy.stderr}`);
      if (!lane.worker_url) fail(`${lane.lane} Worker deployed but Wrangler did not report a workers.dev URL; no secrets were installed for it.`);
      lane.trigger_token = randomBytes(32).toString("base64url");
      await runRequired("npx", [...WRANGLER, "secret", "bulk", "--name", lane.worker_name], { cwd: lane.bundle, input: JSON.stringify({ GROWTHSENT_R2_ACCESS_KEY_ID: lane.credentials.accessKeyId, GROWTHSENT_R2_SECRET_ACCESS_KEY: lane.credentials.secretAccessKey, GROWTHSENT_R2_SESSION_TOKEN: lane.credentials.sessionToken, GROWTHSENT_R2_CREDENTIAL_NOT_AFTER: lane.credential_not_after, RAMP_TRIGGER_TOKEN: lane.trigger_token }) });
      await waitForSafeWorker(lane.worker_url, { run_id: plan.run_id, lane: lane.lane });
      emit({ stage: "final_89k_lane_worker_ready", lane: lane.lane, worker: lane.worker_name });
    }

    const contextPath = resolve(planFile, "..", "FINAL-89K-RUN-CONTEXT.json");
    await writeFile(contextPath, `${JSON.stringify({ kind: plan.kind, execution_profile: plan.execution_profile, run_id: plan.run_id, r2_root: plan.r2_root, task_count: 89000, processing_window: plan.processing_window, verified_reuse_proof: plan.verified_reuse_proof, topology: plan.topology, credential_policy: plan.credential_policy, published_limit_basis: plan.published_limit_basis, parent_token_kind: parent.kind, lanes: lanes.map((lane) => ({ lane: lane.lane, placement_group: lane.placement_group, worker_name: lane.worker_name, worker_url: lane.worker_url, prefix: lane.prefix, credential_not_after: lane.credential_not_after, regional_task_count: lane.regional_task_count, max_concurrent: lane.max_concurrent, max_instances: lane.max_instances, release_sha256: lane.release_sha256 })) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (const lane of lanes) {
      const start = await fetch(`${lane.worker_url}/_growthsent_standard1_regional_ramp/start`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: lane.trigger_token });
      let body = null; try { body = await start.json(); } catch { /* checked below */ }
      if (start.status !== 202 || body?.accepted !== true || body?.run_id !== plan.run_id || body?.region !== lane.lane) fail(`${lane.lane} schedule was not accepted (HTTP ${start.status}); do not retry this launcher because an earlier lane may be running.`);
      emit({ stage: "final_89k_lane_schedule_accepted", lane: lane.lane, placement_group: lane.placement_group, http_status: 202, task_count: lane.regional_task_count });
    }
    emit({ status: "live_final_89k_self_recovery_accepted", run_id: plan.run_id, task_count: 89000, max_concurrent_total: 1440, context: contextPath });
  } finally {
    parentToken = "";
    for (const lane of lanes) { lane.credentials = null; lane.trigger_token = ""; }
  }
}

main().catch((error) => { emit({ status: "failed", error: safeError(error) }); process.exitCode = 1; });
