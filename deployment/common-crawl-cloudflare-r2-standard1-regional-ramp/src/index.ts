import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace, DurableObjectState, ExportedHandler } from "cloudflare:workers";

const CONTROL_TOKEN_MIN_BYTES = 32;
const CONTROL_TOKEN_MAX_BYTES = 128;
const REVIEWED_PLACEMENT_GROUPS = new Set(["APAC", "ENAM", "WNAM", "EEUR", "WEUR", "SAM"]);
// The original four-region and A/B lane names remain valid. The launch-disabled
// 100,000-WAT control plane adds numbered lanes across six well-provisioned
// placement groups. ME, OC, and AFR are deliberately excluded: Containers
// documents those as limited-capacity regions that cannot be used exclusively.
const REVIEWED_REGION_LANE = /^(?:APAC|ENAM|WNAM|EEUR|WEUR|SAM)(?:-(?:[AB]|0[1-9]|[1-9][0-9]))?$/;
const COORDINATOR_KEY = "growthsent-standard1-regional-ramp-coordinator";
const TASK_LAUNCH_KEY = "growthsent-standard1-regional-ramp-slot-launch";
const TASK_FAILURE_KEY = "growthsent-standard1-regional-ramp-slot-start-failure";
const TASK_TERMINAL_KEY = "growthsent-standard1-regional-ramp-slot-terminal";
const POLL_SECONDS = 20;
const MAX_RETRY_SECONDS = 300;
const MAX_TASK_ATTEMPTS = 12;
// A completed task is proven only by its immutable R2 completion marker. A
// task-level runner or source fault must therefore be retried independently;
// it must never terminate the whole regional lane. Three fresh task-process
// attempts are enough to smooth short-lived network/source faults without
// multiplying the inner eight-attempt HTTPS budget indefinitely.
const MAX_RUNTIME_TASK_ATTEMPTS = 3;
const UNCERTAIN_START_RECONCILIATION_SECONDS = 60;
const MAX_CONTAINER_LABEL_NAME_BYTES = 16;
const MAX_CREDENTIAL_START_GUARD_SECONDS = 21_600;
const RUNNER_PORT = 8080;
const encoder = new TextEncoder();

type RampEnv = {
  RAMP_CONTAINER: DurableObjectNamespace<GrowthSentStandard1RegionalRampContainer>;
  RAMP_COORDINATOR: DurableObjectNamespace<GrowthSentStandard1RegionalRampCoordinator>;
  // This binding is absent from the previously verified small-run profiles.
  // The future 100K profile binds it to a separate Worker-owned Durable
  // Object namespace so sibling Workers in one physical region share an
  // allocation permit stream.
  REGIONAL_ADMISSION?: DurableObjectNamespace<RegionalStartAdmissionContract>;
  RAMP_TRIGGER_TOKEN: string;
  GROWTHSENT_RAMP_ID: string;
  GROWTHSENT_REGION: string;
  GROWTHSENT_PLACEMENT_GROUP?: string;
  GROWTHSENT_REGION_INDEX: string;
  GROWTHSENT_REGION_COUNT: string;
  // Optional only for a verified-reuse campaign.  Older profiles omit it and
  // therefore retain their original zero-based global task range.
  GROWTHSENT_SOURCE_INDEX_START?: string;
  GROWTHSENT_TASK_COUNT: string;
  GROWTHSENT_REGIONAL_TASK_COUNT: string;
  GROWTHSENT_MAX_CONCURRENT: string;
  GROWTHSENT_START_SPACING_SECONDS: string;
  GROWTHSENT_INITIAL_START_DELAY_SECONDS: string;
  GROWTHSENT_RELEASE_SHA256: string;
  GROWTHSENT_SELECTED_INPUTS_SHA256: string;
  GROWTHSENT_CONTAINER_INSTANCE_TYPE: string;
  GROWTHSENT_HARD_TIMEOUT_SECONDS: string;
  GROWTHSENT_R2_ACCOUNT_ID: string;
  GROWTHSENT_R2_BUCKET: string;
  GROWTHSENT_R2_ACCESS_KEY_ID: string;
  GROWTHSENT_R2_SECRET_ACCESS_KEY: string;
  GROWTHSENT_R2_SESSION_TOKEN: string;
  GROWTHSENT_R2_CREDENTIAL_NOT_AFTER: string;
  GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS: string;
  [name: string]: unknown;
};

type SafeError = { type: string; message: string };
type TaskTerminalRecord = {
  recorded_at: string;
  phase: "started" | "stopped" | "error";
  task_index: number | null;
  local_task_number: number | null;
  exit_code?: number;
  reason?: string;
} & Partial<SafeError>;
type TaskLaunchRecord = {
  recorded_at: string;
  state: "start_pending" | "start_accepted";
  task_index: number;
  local_task_number: number;
  attempts: number;
} & Partial<SafeError>;
type RunnerStatus = {
  state: "idle" | "running" | "succeeded" | "failed";
  task_index: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: SafeError | null;
};
type TaskStatus = {
  state: string;
  terminal: TaskTerminalRecord | null;
  launch: TaskLaunchRecord | null;
  start_failure: SafeError | null;
  runner: RunnerStatus | null;
  runner_error: SafeError | null;
};
type StartTaskOutcome = {
  accepted: boolean;
  retryable: boolean;
  reconciled: boolean;
  task_index: number;
  local_task_number: number;
  attempts: number;
  failure?: SafeError;
  retry_after_seconds?: number;
};
type RetryRecord = {
  kind: "start" | "reconcile" | "task";
  task_index: number;
  local_task_number: number;
  container_slot: number;
  attempts: number;
  next_retry_at: string;
  failure: SafeError;
};
type InFlightTask = {
  task_index: number;
  local_task_number: number;
  container_slot: number;
  attempts: number;
  accepted_at: string;
};
type RegionalRampRecord = {
  recorded_at: string;
  updated_at: string;
  state: "launching" | "completed" | "completed_with_recoverable_failures" | "task_failed" | "credential_window_elapsed";
  next_local_task_number: number;
  accepted_count: number;
  completed_count: number;
  recoverable_failed_count: number;
  in_flight: InFlightTask[];
  retry: RetryRecord | null;
  terminal_failure?: { task_index: number; local_task_number: number; failure: SafeError };
  last_recoverable_failure?: { task_index: number; local_task_number: number; failure: SafeError };
};

type RegionalStartAdmissionRequest = {
  run_id: string;
  placement_group: string;
  lane: string;
  slot: number;
  task_index: number;
};
type RegionalStartAdmissionDecision = {
  granted: boolean;
  retry_after_seconds: number;
  reason: "granted" | "paced" | "capacity_backoff";
};
type RegionalStartAdmissionFailure = RegionalStartAdmissionRequest & { failure: SafeError };

// The admission DO lives in a separate future control-plane Worker. This
// declaration supplies precise RPC types without exporting a second runtime
// class from every lane Worker.
declare class RegionalStartAdmissionContract extends DurableObject<RampEnv> {
  claimStart(request: RegionalStartAdmissionRequest): Promise<RegionalStartAdmissionDecision>;
  reportCapacityFailure(request: RegionalStartAdmissionFailure): Promise<void>;
  reportStartSuccess(request: RegionalStartAdmissionRequest): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function safeError(error: unknown): SafeError {
  const type = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .replace(/(?:authorization|token|secret|access[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .slice(0, 512);
  return { type, message };
}

function setting(env: RampEnv, name: string, minimum: number, maximum: number): number {
  const raw = env[name];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("missing or invalid runtime setting: " + name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("runtime setting is outside reviewed bounds: " + name);
  return value;
}

function envText(env: RampEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error("missing runtime secret or setting: " + name);
  return value;
}

function optionalSetting(env: RampEnv, name: string, defaultValue: number, minimum: number, maximum: number): number {
  if (env[name] === undefined) return defaultValue;
  return setting(env, name, minimum, maximum);
}

function regionSettings(env: RampEnv): { region: string; regionIndex: number; regionCount: number; sourceIndexStart: number; taskCount: number; regionalTaskCount: number; maxConcurrent: number } {
  const region = envText(env, "GROWTHSENT_REGION");
  if (!REVIEWED_REGION_LANE.test(region)) throw new Error("GROWTHSENT_REGION is not a reviewed placement region or lane");
  const regionCount = setting(env, "GROWTHSENT_REGION_COUNT", 1, 45);
  const regionIndex = setting(env, "GROWTHSENT_REGION_INDEX", 0, regionCount - 1);
  const sourceIndexStart = optionalSetting(env, "GROWTHSENT_SOURCE_INDEX_START", 0, 0, 99_999);
  const taskCount = setting(env, "GROWTHSENT_TASK_COUNT", 1, 100_000);
  if (sourceIndexStart + taskCount > 100_000) throw new Error("source task window exceeds the locked 100,000-WAT manifest");
  const regionalTaskCount = setting(env, "GROWTHSENT_REGIONAL_TASK_COUNT", 0, 2_500);
  const expectedRegionalTaskCount = taskCount <= regionIndex ? 0 : Math.floor((taskCount - 1 - regionIndex) / regionCount) + 1;
  if (regionalTaskCount !== expectedRegionalTaskCount) throw new Error("regional task count does not match its deterministic lane allocation");
  const maxConcurrent = setting(env, "GROWTHSENT_MAX_CONCURRENT", 1, 32);
  if (maxConcurrent > regionalTaskCount && regionalTaskCount > 0) throw new Error("regional concurrency exceeds its deterministic lane size");
  setting(env, "GROWTHSENT_HARD_TIMEOUT_SECONDS", 6600, 6600);
  return { region, regionIndex, regionCount, sourceIndexStart, taskCount, regionalTaskCount, maxConcurrent };
}

function placementGroup(env: RampEnv): string | null {
  const configured = env.GROWTHSENT_PLACEMENT_GROUP;
  if (configured === undefined) return null;
  if (typeof configured !== "string" || !REVIEWED_PLACEMENT_GROUPS.has(configured)) {
    throw new Error("GROWTHSENT_PLACEMENT_GROUP is not a reviewed high-capacity placement group");
  }
  return configured;
}

function placementLocationHint(group: string): "apac" | "enam" | "wnam" | "eeur" | "weur" | "sam" {
  if (group === "APAC") return "apac";
  if (group === "ENAM") return "enam";
  if (group === "WNAM") return "wnam";
  if (group === "EEUR") return "eeur";
  if (group === "WEUR") return "weur";
  if (group === "SAM") return "sam";
  throw new Error("placement group lacks a Durable Object location hint");
}

function parseAdmissionDecision(value: unknown): RegionalStartAdmissionDecision {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("regional admission returned a non-object response");
  const item = value as Record<string, unknown>;
  const granted = item.granted;
  const retryAfterSeconds = item.retry_after_seconds;
  const reason = item.reason;
  if (typeof granted !== "boolean" || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > MAX_RETRY_SECONDS || !(reason === "granted" || reason === "paced" || reason === "capacity_backoff")) {
    throw new Error("regional admission returned an invalid decision");
  }
  return { granted, retry_after_seconds: retryAfterSeconds, reason };
}

function taskIndexForLocalNumber(env: RampEnv, localTaskNumber: number): number {
  const values = regionSettings(env);
  if (!Number.isInteger(localTaskNumber) || localTaskNumber < 1 || localTaskNumber > values.regionalTaskCount) throw new Error("regional local task number is outside its lane");
  return values.sourceIndexStart + values.regionIndex + ((localTaskNumber - 1) * values.regionCount);
}

// Each region has a fixed pool of container Durable Objects. A slot processes
// one WAT at a time, then remains available for its next task. This removes
// the old one-new-container-per-WAT allocation pattern.
function slotName(runId: string, region: string, slot: number): string {
  return runId + "-" + region.toLowerCase() + "-slot-" + String(slot).padStart(2, "0");
}

function retryDelaySeconds(attempts: number, taskIndex: number): number {
  const base = Math.min(MAX_RETRY_SECONDS, 5 * (2 ** Math.min(attempts - 1, 6)));
  return Math.min(MAX_RETRY_SECONDS, base + ((taskIndex * 17 + attempts * 13) % 11));
}

function isRecentPendingStart(launch: TaskLaunchRecord): boolean {
  const recordedAt = Date.parse(launch.recorded_at);
  return Number.isFinite(recordedAt) && Date.now() - recordedAt < UNCERTAIN_START_RECONCILIATION_SECONDS * 1000;
}

function runnerMatches(status: TaskStatus, taskIndex: number, states?: RunnerStatus["state"][]): boolean {
  return status.runner?.task_index === taskIndex && (states === undefined || states.includes(status.runner.state));
}

function isSuccessfulTask(status: TaskStatus, taskIndex: number): boolean {
  return runnerMatches(status, taskIndex, ["succeeded"]);
}

function terminalFailure(status: TaskStatus, taskIndex: number): SafeError | null {
  if (runnerMatches(status, taskIndex, ["failed"])) {
    return status.runner?.error ?? { type: "TaskRunnerExit", message: "task runner exited with code " + String(status.runner?.exit_code) };
  }
  if (status.terminal?.task_index !== taskIndex) return null;
  if (status.terminal.phase === "error") return { type: status.terminal.type ?? "ContainerError", message: status.terminal.message ?? "container lifecycle reported an error" };
  if (status.terminal.phase === "stopped" && status.terminal.exit_code !== 0) return { type: "ContainerExit", message: "container exited with code " + String(status.terminal.exit_code) };
  return null;
}

function isCapacityFailure(failure: SafeError): boolean {
  const message = failure.message.toLowerCase();
  return message.includes("maximum number of running container instances")
    || message.includes("no container instance that can be provided")
    || message.includes("no_container_available");
}

function isRecoverablePartialPrefixFailure(failure: SafeError): boolean {
  return failure.type === "TaskProcessExit"
    && failure.message.includes("partial immutable task prefix requires isolated recovery");
}

function isRetryableTaskFailure(failure: SafeError): boolean {
  const message = failure.message.toLowerCase();
  // These are observed platform/transport failures. The task runner is
  // idempotent for a task with no completed marker, so retrying the same fixed
  // slot is safe. A partial immutable prefix is deliberately excluded and is
  // quarantined before this predicate is consulted.
  return failure.type === "ContainerError"
    || failure.type === "ContainerExit"
    || failure.type === "ContainerUnavailable"
    || message.includes("network connection lost")
    || message.includes("container connectivity was lost")
    || message.includes("common crawl https read failed")
    || message.includes("commoncrawlsourceerror");
}

function isLostTask(status: TaskStatus): boolean {
  return status.runner === null && status.runner_error === null && status.state !== "running";
}

function credentialStartWindow(env: RampEnv): { allowed: boolean; remainingSeconds: number | null; guardSeconds: number } {
  const guardSeconds = setting(env, "GROWTHSENT_R2_CREDENTIAL_START_GUARD_SECONDS", 0, MAX_CREDENTIAL_START_GUARD_SECONDS);
  if (guardSeconds === 0) return { allowed: true, remainingSeconds: null, guardSeconds };
  const notAfter = Date.parse(envText(env, "GROWTHSENT_R2_CREDENTIAL_NOT_AFTER"));
  if (!Number.isFinite(notAfter)) throw new Error("R2 credential expiry is not a valid ISO timestamp");
  const remainingSeconds = Math.floor((notAfter - Date.now()) / 1000);
  return { allowed: remainingSeconds > guardSeconds, remainingSeconds, guardSeconds };
}

function runnerEnvironment(env: RampEnv): Record<string, string> {
  const settings = regionSettings(env);
  const outputPrefix = typeof env.GROWTHSENT_R2_OUTPUT_PREFIX === "string" && env.GROWTHSENT_R2_OUTPUT_PREFIX.length > 0
    ? env.GROWTHSENT_R2_OUTPUT_PREFIX
    : null;
  return {
    GROWTHSENT_R2_ACCOUNT_ID: envText(env, "GROWTHSENT_R2_ACCOUNT_ID"),
    GROWTHSENT_R2_BUCKET: envText(env, "GROWTHSENT_R2_BUCKET"),
    GROWTHSENT_R2_ACCESS_KEY_ID: envText(env, "GROWTHSENT_R2_ACCESS_KEY_ID"),
    GROWTHSENT_R2_SECRET_ACCESS_KEY: envText(env, "GROWTHSENT_R2_SECRET_ACCESS_KEY"),
    GROWTHSENT_R2_SESSION_TOKEN: envText(env, "GROWTHSENT_R2_SESSION_TOKEN"),
    GROWTHSENT_RAMP_ID: envText(env, "GROWTHSENT_RAMP_ID"),
    GROWTHSENT_REGION: settings.region,
    GROWTHSENT_REGION_INDEX: String(settings.regionIndex),
    GROWTHSENT_REGION_COUNT: String(settings.regionCount),
    GROWTHSENT_SOURCE_INDEX_START: String(settings.sourceIndexStart),
    GROWTHSENT_TASK_COUNT: String(settings.taskCount),
    GROWTHSENT_REGIONAL_TASK_COUNT: String(settings.regionalTaskCount),
    GROWTHSENT_RELEASE_SHA256: envText(env, "GROWTHSENT_RELEASE_SHA256"),
    GROWTHSENT_SELECTED_INPUTS_SHA256: envText(env, "GROWTHSENT_SELECTED_INPUTS_SHA256"),
    GROWTHSENT_CONTAINER_INSTANCE_TYPE: envText(env, "GROWTHSENT_CONTAINER_INSTANCE_TYPE"),
    GROWTHSENT_HARD_TIMEOUT_SECONDS: envText(env, "GROWTHSENT_HARD_TIMEOUT_SECONDS"),
    ...(outputPrefix === null ? {} : { GROWTHSENT_R2_OUTPUT_PREFIX: outputPrefix }),
  };
}

function containerLabels(env: RampEnv, region: string, slot: number): Record<string, string> {
  const labels = {
    gs_ramp: envText(env, "GROWTHSENT_RAMP_ID"),
    gs_region: region,
    slot: String(slot),
  };
  for (const name of Object.keys(labels)) {
    if (encoder.encode(name).byteLength > MAX_CONTAINER_LABEL_NAME_BYTES) {
      throw new Error("Container label name exceeds the " + String(MAX_CONTAINER_LABEL_NAME_BYTES) + "-byte platform limit: " + name);
    }
  }
  return labels;
}

function parseRunnerStatus(value: unknown): RunnerStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("task runner returned a non-object status");
  const item = value as Record<string, unknown>;
  const state = item.state;
  const taskIndex = item.task_index;
  if (!(state === "idle" || state === "running" || state === "succeeded" || state === "failed")) throw new Error("task runner returned an invalid state");
  if (taskIndex !== null && (!Number.isInteger(taskIndex) || (taskIndex as number) < 0)) throw new Error("task runner returned an invalid task index");
  const textOrNull = (name: string): string | null => item[name] === null || item[name] === undefined ? null : typeof item[name] === "string" ? item[name] : null;
  const exitCode = item.exit_code === null || item.exit_code === undefined ? null : Number.isInteger(item.exit_code) ? item.exit_code as number : null;
  const errorValue = item.error;
  const error = errorValue === null || errorValue === undefined
    ? null
    : errorValue !== null && typeof errorValue === "object" && !Array.isArray(errorValue) && typeof (errorValue as Record<string, unknown>).type === "string" && typeof (errorValue as Record<string, unknown>).message === "string"
      ? { type: (errorValue as Record<string, string>).type.slice(0, 128), message: (errorValue as Record<string, string>).message.slice(0, 512) }
      : null;
  return { state, task_index: taskIndex as number | null, started_at: textOrNull("started_at"), finished_at: textOrNull("finished_at"), exit_code: exitCode, error };
}

export class GrowthSentStandard1RegionalRampContainer extends Container<RampEnv> {
  defaultPort = RUNNER_PORT;
  sleepAfter = "110m";
  enableInternet = true;

  constructor(ctx: DurableObjectState, env: RampEnv) {
    super(ctx, env);
    // This covers a platform-initiated restart between an RPC and its
    // loopback request: Container.fetch/containerFetch can auto-start the
    // process, and every start must still receive this lane's scoped child
    // credential and immutable-run identity.
    this.envVars = runnerEnvironment(env);
  }

  async onStart(): Promise<void> {
    const launch = (await this.ctx.storage.get<TaskLaunchRecord>(TASK_LAUNCH_KEY)) ?? null;
    await this.ctx.storage.put<TaskTerminalRecord>(TASK_TERMINAL_KEY, {
      phase: "started",
      recorded_at: now(),
      task_index: launch?.task_index ?? null,
      local_task_number: launch?.local_task_number ?? null,
    });
  }

  async onStop(params: { exitCode: number; reason: string }): Promise<void> {
    const launch = (await this.ctx.storage.get<TaskLaunchRecord>(TASK_LAUNCH_KEY)) ?? null;
    await this.ctx.storage.put<TaskTerminalRecord>(TASK_TERMINAL_KEY, {
      phase: "stopped",
      exit_code: params.exitCode,
      reason: params.reason,
      recorded_at: now(),
      task_index: launch?.task_index ?? null,
      local_task_number: launch?.local_task_number ?? null,
    });
  }

  async onError(error: unknown): Promise<void> {
    const launch = (await this.ctx.storage.get<TaskLaunchRecord>(TASK_LAUNCH_KEY)) ?? null;
    await this.ctx.storage.put<TaskTerminalRecord>(TASK_TERMINAL_KEY, {
      phase: "error",
      ...safeError(error),
      recorded_at: now(),
      task_index: launch?.task_index ?? null,
      local_task_number: launch?.local_task_number ?? null,
    });
  }

  private async runnerStatus(): Promise<RunnerStatus> {
    const response = await this.containerFetch("http://localhost/status", { method: "GET" }, this.defaultPort);
    const body = await response.text();
    if (!response.ok) throw new Error("task runner status returned HTTP " + String(response.status));
    if (body.length > 16_384) throw new Error("task runner status response is too large");
    try {
      return parseRunnerStatus(JSON.parse(body));
    } catch (error) {
      throw new Error("task runner status is invalid: " + safeError(error).message);
    }
  }

  async status(): Promise<TaskStatus> {
    const [state, terminal, launch, failure] = await Promise.all([
      this.getState(),
      this.ctx.storage.get<TaskTerminalRecord>(TASK_TERMINAL_KEY),
      this.ctx.storage.get<TaskLaunchRecord>(TASK_LAUNCH_KEY),
      this.ctx.storage.get<SafeError>(TASK_FAILURE_KEY),
    ]);
    let runner: RunnerStatus | null = null;
    let runnerError: SafeError | null = null;
    if (this.ctx.container.running) {
      try {
        runner = await this.runnerStatus();
      } catch (error) {
        runnerError = safeError(error);
      }
    }
    return {
      state: state.status,
      terminal: terminal ?? null,
      launch: launch ?? null,
      start_failure: failure ?? null,
      runner,
      runner_error: runnerError,
    };
  }

  private async requestRegionalStartPermit(taskIndex: number, slot: number): Promise<RegionalStartAdmissionDecision | null> {
    const placement = placementGroup(this.env);
    const admission = this.env.REGIONAL_ADMISSION;
    // Existing verified runs have no shared admission service. The high-scale
    // profile must configure both fields together; accepting just one would
    // silently remove the cold-start safeguard.
    if (placement === null && admission === undefined) return null;
    if (placement === null || admission === undefined) throw new Error("high-capacity regional admission binding is incomplete");
    const request: RegionalStartAdmissionRequest = {
      run_id: envText(this.env, "GROWTHSENT_RAMP_ID"),
      placement_group: placement,
      lane: regionSettings(this.env).region,
      slot,
      task_index: taskIndex,
    };
    return parseAdmissionDecision(await admission.getByName(request.run_id + "-" + placement.toLowerCase(), { locationHint: placementLocationHint(placement) }).claimStart(request));
  }

  private async reportRegionalStartResult(taskIndex: number, slot: number, failure: SafeError | null): Promise<void> {
    const placement = placementGroup(this.env);
    const admission = this.env.REGIONAL_ADMISSION;
    if (placement === null && admission === undefined) return;
    if (placement === null || admission === undefined) return;
    const request: RegionalStartAdmissionRequest = {
      run_id: envText(this.env, "GROWTHSENT_RAMP_ID"),
      placement_group: placement,
      lane: regionSettings(this.env).region,
      slot,
      task_index: taskIndex,
    };
    const stub = admission.getByName(request.run_id + "-" + placement.toLowerCase(), { locationHint: placementLocationHint(placement) });
    try {
      if (failure === null) await stub.reportStartSuccess(request);
      else if (isCapacityFailure(failure)) await stub.reportCapacityFailure({ ...request, failure });
    } catch (error) {
      // Admission telemetry is advisory after an allocation result. Never
      // discard the original result because the governor itself was briefly
      // unavailable; the coordinator will reconcile this slot on its alarm.
      console.warn(JSON.stringify({ event: "standard1_regional_admission_report_failed", run_id: request.run_id, region: request.lane, task_index: taskIndex, ...safeError(error) }));
    }
  }

  async startTask(taskIndex: number, localTaskNumber: number, slot: number): Promise<StartTaskOutcome> {
    const settings = regionSettings(this.env);
    if (taskIndex !== taskIndexForLocalNumber(this.env, localTaskNumber)) throw new Error("coordinator selected a task outside this container lane");
    if (!Number.isInteger(slot) || slot < 1 || slot > settings.maxConcurrent) throw new Error("coordinator selected an invalid fixed container slot");
    const prior = (await this.ctx.storage.get<TaskLaunchRecord>(TASK_LAUNCH_KEY)) ?? null;
    const current = await this.status();
    const priorMatches = prior?.task_index === taskIndex && prior.local_task_number === localTaskNumber;

    if (priorMatches && runnerMatches(current, taskIndex, ["running", "succeeded"])) {
      const attempts = prior?.attempts ?? 1;
      if (prior?.state !== "start_accepted") {
        await Promise.all([
          this.ctx.storage.delete(TASK_FAILURE_KEY),
          this.ctx.storage.put<TaskLaunchRecord>(TASK_LAUNCH_KEY, { state: "start_accepted", task_index: taskIndex, local_task_number: localTaskNumber, attempts, recorded_at: now() }),
        ]);
      }
      return { accepted: true, retryable: false, reconciled: true, task_index: taskIndex, local_task_number: localTaskNumber, attempts };
    }
    if (current.runner?.state === "running" && current.runner.task_index !== taskIndex) {
      return {
        accepted: false,
        retryable: true,
        reconciled: false,
        task_index: taskIndex,
        local_task_number: localTaskNumber,
        attempts: priorMatches ? prior!.attempts : 1,
        failure: { type: "RunnerBusy", message: "fixed container slot is still processing another task" },
      };
    }
    if (priorMatches && prior?.state === "start_pending" && isRecentPendingStart(prior)) {
      return {
        accepted: false,
        retryable: true,
        reconciled: true,
        task_index: taskIndex,
        local_task_number: localTaskNumber,
        attempts: prior.attempts,
        failure: { type: "StartOutcomeUncertain", message: "waiting to reconcile a prior fixed-slot start request" },
      };
    }

    if (!this.ctx.container.running) {
      let decision: RegionalStartAdmissionDecision | null;
      try {
        decision = await this.requestRegionalStartPermit(taskIndex, slot);
      } catch (error) {
        const failure = safeError(error);
        return {
          accepted: false,
          retryable: true,
          reconciled: false,
          task_index: taskIndex,
          local_task_number: localTaskNumber,
          attempts: priorMatches ? prior!.attempts : 0,
          retry_after_seconds: 30,
          failure: { type: "RegionalAdmissionUnavailable", message: failure.message },
        };
      }
      if (decision !== null && !decision.granted) {
        return {
          accepted: false,
          retryable: true,
          reconciled: false,
          task_index: taskIndex,
          local_task_number: localTaskNumber,
          // A pacing denial is not a Container start attempt. Counting it
          // would quarantine work simply because the shared regional pool is
          // intentionally warming gradually.
          attempts: priorMatches ? prior!.attempts : 0,
          retry_after_seconds: Math.max(1, decision.retry_after_seconds),
          failure: { type: decision.reason === "capacity_backoff" ? "RegionalCapacityBackoff" : "RegionalStartPaced", message: "shared " + decision.reason + " admission deferred this container start" },
        };
      }
    }

    const attempts = (priorMatches ? prior?.attempts ?? 0 : 0) + 1;
    await Promise.all([
      this.ctx.storage.delete(TASK_TERMINAL_KEY),
      this.ctx.storage.delete(TASK_FAILURE_KEY),
      this.ctx.storage.put<TaskLaunchRecord>(TASK_LAUNCH_KEY, { state: "start_pending", task_index: taskIndex, local_task_number: localTaskNumber, attempts, recorded_at: now() }),
    ]);
    try {
      if (!this.ctx.container.running) {
        await this.startAndWaitForPorts({
          ports: [this.defaultPort],
          startOptions: {
            envVars: runnerEnvironment(this.env),
            labels: containerLabels(this.env, settings.region, slot),
          },
          cancellationOptions: { portReadyTimeoutMS: 30_000 },
        });
        await this.reportRegionalStartResult(taskIndex, slot, null);
      }
      const response = await this.containerFetch("http://localhost/run-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_index: taskIndex }),
      }, this.defaultPort);
      const responseBody = await response.text();
      if (responseBody.length > 16_384) throw new Error("task runner start response is too large");
      if (response.status !== 200 && response.status !== 202) throw new Error("task runner rejected the task with HTTP " + String(response.status));
    } catch (error) {
      const reconciled = await this.status();
      if (runnerMatches(reconciled, taskIndex, ["running", "succeeded"])) {
        await Promise.all([
          this.ctx.storage.delete(TASK_FAILURE_KEY),
          this.ctx.storage.put<TaskLaunchRecord>(TASK_LAUNCH_KEY, { state: "start_accepted", task_index: taskIndex, local_task_number: localTaskNumber, attempts, recorded_at: now() }),
        ]);
        return { accepted: true, retryable: false, reconciled: true, task_index: taskIndex, local_task_number: localTaskNumber, attempts };
      }
      const failure = safeError(error);
      await this.reportRegionalStartResult(taskIndex, slot, failure);
      await Promise.all([
        this.ctx.storage.put<SafeError>(TASK_FAILURE_KEY, failure),
        this.ctx.storage.put<TaskLaunchRecord>(TASK_LAUNCH_KEY, { state: "start_pending", task_index: taskIndex, local_task_number: localTaskNumber, attempts, ...failure, recorded_at: now() }),
      ]);
      return { accepted: false, retryable: true, reconciled: false, task_index: taskIndex, local_task_number: localTaskNumber, attempts, failure };
    }
    await Promise.all([
      this.ctx.storage.delete(TASK_FAILURE_KEY),
      this.ctx.storage.put<TaskLaunchRecord>(TASK_LAUNCH_KEY, { state: "start_accepted", task_index: taskIndex, local_task_number: localTaskNumber, attempts, recorded_at: now() }),
    ]);
    return { accepted: true, retryable: false, reconciled: false, task_index: taskIndex, local_task_number: localTaskNumber, attempts };
  }
}

export class GrowthSentStandard1RegionalRampCoordinator extends DurableObject<RampEnv> {
  private containerSlot(settings: ReturnType<typeof regionSettings>, slot: number) {
    if (!Number.isInteger(slot) || slot < 1 || slot > settings.maxConcurrent) throw new Error("fixed container slot is outside the reviewed lane pool");
    return this.env.RAMP_CONTAINER.getByName(slotName(this.env.GROWTHSENT_RAMP_ID, settings.region, slot));
  }

  async begin(): Promise<{ accepted: boolean; run_id: string; region: string; regional_task_count: number }> {
    const settings = regionSettings(this.env);
    const existing = await this.ctx.storage.get<RegionalRampRecord>(COORDINATOR_KEY);
    if (existing !== undefined) return { accepted: false, run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, regional_task_count: settings.regionalTaskCount };
    const timestamp = now();
    await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, {
      state: "launching",
      recorded_at: timestamp,
      updated_at: timestamp,
      next_local_task_number: 1,
      accepted_count: 0,
      completed_count: 0,
      recoverable_failed_count: 0,
      in_flight: [],
      retry: null,
    });
    const delaySeconds = setting(this.env, "GROWTHSENT_INITIAL_START_DELAY_SECONDS", 0, 300);
    await this.ctx.storage.setAlarm(Date.now() + delaySeconds * 1000);
    return { accepted: true, run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, regional_task_count: settings.regionalTaskCount };
  }

  async status(): Promise<{ launch: RegionalRampRecord | null; active_tasks: Array<{ task_index: number; local_task_number: number; container_slot: number; status: TaskStatus }> }> {
    const settings = regionSettings(this.env);
    const launch = (await this.ctx.storage.get<RegionalRampRecord>(COORDINATOR_KEY)) ?? null;
    const inFlight = launch?.in_flight ?? [];
    const activeTasks = await Promise.all(inFlight.map(async (task) => ({
      task_index: task.task_index,
      local_task_number: task.local_task_number,
      container_slot: task.container_slot,
      status: await this.containerSlot(settings, task.container_slot).status(),
    })));
    return { launch, active_tasks: activeTasks };
  }

  private async failTask(record: RegionalRampRecord, completedCount: number, remaining: InFlightTask[], task: Pick<InFlightTask, "task_index" | "local_task_number">, failure: SafeError): Promise<void> {
    await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, {
      ...record,
      state: "task_failed",
      completed_count: completedCount,
      in_flight: remaining,
      terminal_failure: { task_index: task.task_index, local_task_number: task.local_task_number, failure },
      updated_at: now(),
    });
    console.error(JSON.stringify({ event: "standard1_regional_task_failed", run_id: this.env.GROWTHSENT_RAMP_ID, region: regionSettings(this.env).region, task_index: task.task_index, ...failure }));
  }

  private async recordRecoverableTaskFailure(record: RegionalRampRecord, completedCount: number, remaining: InFlightTask[], task: Pick<InFlightTask, "task_index" | "local_task_number">, failure: SafeError): Promise<void> {
    const recoverableFailedCount = (record.recoverable_failed_count ?? 0) + 1;
    const settings = regionSettings(this.env);
    const state = record.next_local_task_number > settings.regionalTaskCount && remaining.length === 0
      ? "completed_with_recoverable_failures"
      : "launching";
    const next = {
      ...record,
      state,
      completed_count: completedCount,
      recoverable_failed_count: recoverableFailedCount,
      in_flight: remaining,
      retry: null,
      last_recoverable_failure: { task_index: task.task_index, local_task_number: task.local_task_number, failure },
      updated_at: now(),
    } satisfies RegionalRampRecord;
    console.warn(JSON.stringify({ event: "standard1_regional_task_quarantined_for_recovery", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: task.task_index, recoverable_failed_count: recoverableFailedCount, ...failure }));
    if (state === "completed_with_recoverable_failures") {
      await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, next);
      return;
    }
    await this.persistAndSchedule(next, 1);
  }

  private async retryInFlightTask(record: RegionalRampRecord, completedCount: number, remaining: InFlightTask[], task: InFlightTask, failure: SafeError, attemptLimit = MAX_TASK_ATTEMPTS): Promise<void> {
    const attempts = task.attempts + 1;
    if (attempts > attemptLimit) {
      await this.recordRecoverableTaskFailure(record, completedCount, remaining, task, {
        type: "TaskRetryLimitExceeded",
        message: ("task was quarantined after " + String(attemptLimit) + " bounded retry attempts: " + failure.message).slice(0, 512),
      });
      return;
    }
    const delay = retryDelaySeconds(attempts, task.task_index);
    const retry: RetryRecord = {
      kind: "task",
      task_index: task.task_index,
      local_task_number: task.local_task_number,
      container_slot: task.container_slot,
      attempts,
      next_retry_at: new Date(Date.now() + delay * 1000).toISOString(),
      failure,
    };
    console.warn(JSON.stringify({ event: "standard1_regional_task_retry_scheduled", run_id: this.env.GROWTHSENT_RAMP_ID, region: regionSettings(this.env).region, task_index: task.task_index, container_slot: task.container_slot, attempts, retry_in_seconds: delay, ...failure }));
    await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: remaining, retry, updated_at: now() }, delay);
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<RegionalRampRecord>(COORDINATOR_KEY);
    if (record?.state !== "launching") return;
    const settings = regionSettings(this.env);
    const currentTime = Date.now();
    const currentInFlight = [...record.in_flight];
    const remaining: InFlightTask[] = [];
    let completedCount = record.completed_count;

    if (record.retry !== null && Date.parse(record.retry.next_retry_at) > currentTime) {
      await this.persistAndSchedule({ ...record, updated_at: now() }, Math.max(1, Math.ceil((Date.parse(record.retry.next_retry_at) - currentTime) / 1000)));
      return;
    }

    for (const [position, task] of currentInFlight.entries()) {
      let status: TaskStatus;
      try {
        status = await this.containerSlot(settings, task.container_slot).status();
      } catch (error) {
        const failure = safeError(error);
        const priorAttempts = record.retry?.kind === "reconcile" && record.retry.task_index === task.task_index ? record.retry.attempts : 0;
        const attempts = priorAttempts + 1;
        const delay = retryDelaySeconds(attempts, task.task_index);
        const retry: RetryRecord = { kind: "reconcile", task_index: task.task_index, local_task_number: task.local_task_number, container_slot: task.container_slot, attempts, next_retry_at: new Date(currentTime + delay * 1000).toISOString(), failure };
        const unresolved = [...remaining, ...currentInFlight.slice(position)];
        console.warn(JSON.stringify({ event: "standard1_regional_task_status_retry_scheduled", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: task.task_index, container_slot: task.container_slot, attempts, retry_in_seconds: delay, ...failure }));
        await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: unresolved, retry, updated_at: now() }, delay);
        return;
      }
      if (isSuccessfulTask(status, task.task_index)) {
        completedCount += 1;
        continue;
      }
      if (status.runner_error !== null) {
        const failure = status.runner_error;
        const priorAttempts = record.retry?.kind === "reconcile" && record.retry.task_index === task.task_index ? record.retry.attempts : 0;
        const attempts = priorAttempts + 1;
        const delay = retryDelaySeconds(attempts, task.task_index);
        const retry: RetryRecord = { kind: "reconcile", task_index: task.task_index, local_task_number: task.local_task_number, container_slot: task.container_slot, attempts, next_retry_at: new Date(currentTime + delay * 1000).toISOString(), failure };
        const unresolved = [...remaining, ...currentInFlight.slice(position)];
        console.warn(JSON.stringify({ event: "standard1_regional_runner_status_retry_scheduled", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: task.task_index, container_slot: task.container_slot, attempts, retry_in_seconds: delay, ...failure }));
        await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: unresolved, retry, updated_at: now() }, delay);
        return;
      }
      const failure = terminalFailure(status, task.task_index);
      const unresolved = [...remaining, ...currentInFlight.slice(position + 1)];
      if (failure !== null && isCapacityFailure(failure)) {
        await this.retryInFlightTask(record, completedCount, unresolved, task, failure);
        return;
      }
      if (failure !== null && isRecoverablePartialPrefixFailure(failure)) {
        await this.recordRecoverableTaskFailure(record, completedCount, unresolved, task, failure);
        return;
      }
      if (failure !== null && isRetryableTaskFailure(failure)) {
        await this.retryInFlightTask(record, completedCount, unresolved, task, failure, MAX_RUNTIME_TASK_ATTEMPTS);
        return;
      }
      if (failure !== null) {
        await this.failTask(record, completedCount, unresolved, task, failure);
        return;
      }
      if (isLostTask(status)) {
        await this.retryInFlightTask(record, completedCount, unresolved, task, { type: "ContainerUnavailable", message: "fixed container slot stopped before its task status could be observed" });
        return;
      }
      remaining.push(task);
    }

    const activeRetry = record.retry;
    const retryingTask = activeRetry?.kind === "task";
    const retryingStart = activeRetry?.kind === "start";
    const nextLocalTaskNumber = retryingTask || retryingStart ? activeRetry!.local_task_number : record.next_local_task_number;
    const taskIndex = retryingTask || retryingStart
      ? activeRetry!.task_index
      : nextLocalTaskNumber <= settings.regionalTaskCount
        ? taskIndexForLocalNumber(this.env, nextLocalTaskNumber)
        : null;
    const occupiedSlots = new Set(remaining.map((task) => task.container_slot));
    const containerSlot = retryingTask || retryingStart
      ? activeRetry!.container_slot
      : Array.from({ length: settings.maxConcurrent }, (_, index) => index + 1).find((slot) => !occupiedSlots.has(slot));

    if (nextLocalTaskNumber <= settings.regionalTaskCount && taskIndex !== null && containerSlot !== undefined && (retryingTask || remaining.length < settings.maxConcurrent)) {
      const credentialWindow = credentialStartWindow(this.env);
      if (!credentialWindow.allowed) {
        const failure = {
          type: "R2CredentialWindowElapsed",
          message: "refusing task start with " + String(credentialWindow.remainingSeconds) + " seconds remaining; the reviewed guard is " + String(credentialWindow.guardSeconds) + " seconds",
        };
        await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, {
          ...record,
          state: "credential_window_elapsed",
          completed_count: completedCount,
          in_flight: remaining,
          terminal_failure: { task_index: taskIndex, local_task_number: nextLocalTaskNumber, failure },
          updated_at: now(),
        });
        console.error(JSON.stringify({ event: "standard1_regional_credential_window_elapsed", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: taskIndex, ...failure }));
        return;
      }
      let outcome: StartTaskOutcome;
      try {
        outcome = await this.containerSlot(settings, containerSlot).startTask(taskIndex, nextLocalTaskNumber, containerSlot);
      } catch (error) {
        const failure = safeError(error);
        const priorAttempts = activeRetry?.kind === "start" && activeRetry.task_index === taskIndex ? activeRetry.attempts : 0;
        const attempts = priorAttempts + 1;
        if (attempts > MAX_TASK_ATTEMPTS) {
          await this.recordRecoverableTaskFailure(record, completedCount, remaining, { task_index: taskIndex, local_task_number: nextLocalTaskNumber }, { type: "StartRetryLimitExceeded", message: ("container start was quarantined after " + String(MAX_TASK_ATTEMPTS) + " attempts: " + failure.message).slice(0, 512) });
          return;
        }
        const delay = retryDelaySeconds(attempts, taskIndex);
        const retry: RetryRecord = { kind: "start", task_index: taskIndex, local_task_number: nextLocalTaskNumber, container_slot: containerSlot, attempts, next_retry_at: new Date(currentTime + delay * 1000).toISOString(), failure };
        console.warn(JSON.stringify({ event: "standard1_regional_task_start_rpc_retry_scheduled", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: taskIndex, container_slot: containerSlot, attempts, retry_in_seconds: delay, ...failure }));
        await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: remaining, retry, updated_at: now() }, delay);
        return;
      }
      if (outcome.accepted) {
        remaining.push({ task_index: taskIndex, local_task_number: nextLocalTaskNumber, container_slot: containerSlot, attempts: outcome.attempts, accepted_at: now() });
        const acceptedCount = retryingTask ? record.accepted_count : record.accepted_count + 1;
        const followingTaskNumber = retryingTask ? record.next_local_task_number : nextLocalTaskNumber + 1;
        if (outcome.reconciled) console.info(JSON.stringify({ event: "standard1_regional_task_start_reconciled", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: taskIndex, container_slot: containerSlot, attempts: outcome.attempts }));
        await this.persistAndSchedule({ ...record, accepted_count: acceptedCount, completed_count: completedCount, in_flight: remaining, next_local_task_number: followingTaskNumber, retry: null, updated_at: now() }, setting(this.env, "GROWTHSENT_START_SPACING_SECONDS", 5, 120));
        return;
      }
      if (outcome.attempts > MAX_TASK_ATTEMPTS) {
        const failure = outcome.failure ?? { type: "StartRejected", message: "fixed container slot rejected the task" };
        await this.recordRecoverableTaskFailure(record, completedCount, remaining, { task_index: taskIndex, local_task_number: nextLocalTaskNumber }, { type: "StartRetryLimitExceeded", message: ("container start was quarantined after " + String(MAX_TASK_ATTEMPTS) + " attempts: " + failure.message).slice(0, 512) });
        return;
      }
      if (!outcome.retryable || outcome.failure === undefined) {
        const failure = outcome.failure ?? { type: "StartRejected", message: "fixed container slot rejected the task" };
        await this.failTask(record, completedCount, remaining, { task_index: taskIndex, local_task_number: nextLocalTaskNumber }, failure);
        return;
      }
      // A regional admission denial is a deliberate cold-start pacing signal,
      // not a failed allocation. Honour its persisted retry time and keep the
      // underlying Container attempt counter unchanged.
      const delay = outcome.retry_after_seconds ?? retryDelaySeconds(Math.max(1, outcome.attempts), taskIndex);
      const retry: RetryRecord = { kind: "start", task_index: taskIndex, local_task_number: nextLocalTaskNumber, container_slot: containerSlot, attempts: outcome.attempts, next_retry_at: new Date(currentTime + delay * 1000).toISOString(), failure: outcome.failure };
      console.warn(JSON.stringify({ event: "standard1_regional_start_retry_scheduled", run_id: this.env.GROWTHSENT_RAMP_ID, region: settings.region, task_index: taskIndex, container_slot: containerSlot, attempts: outcome.attempts, retry_in_seconds: delay, ...outcome.failure }));
      await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: remaining, retry, updated_at: now() }, delay);
      return;
    }

    if (record.next_local_task_number > settings.regionalTaskCount && remaining.length === 0 && activeRetry === null) {
      const state = (record.recoverable_failed_count ?? 0) === 0 ? "completed" : "completed_with_recoverable_failures";
      await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, { ...record, state, completed_count: completedCount, in_flight: [], retry: null, updated_at: now() });
      return;
    }
    await this.persistAndSchedule({ ...record, completed_count: completedCount, in_flight: remaining, retry: activeRetry?.kind === "reconcile" ? null : activeRetry, updated_at: now() }, POLL_SECONDS);
  }

  private async persistAndSchedule(record: RegionalRampRecord, delaySeconds: number): Promise<void> {
    await this.ctx.storage.put<RegionalRampRecord>(COORDINATOR_KEY, record);
    await this.ctx.storage.setAlarm(Date.now() + Math.max(1, delaySeconds) * 1000);
  }
}

async function hasControlToken(request: Request, expected: unknown): Promise<boolean> {
  if (typeof expected !== "string" || expected.length < CONTROL_TOKEN_MIN_BYTES) return false;
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength < CONTROL_TOKEN_MIN_BYTES || contentLength > CONTROL_TOKEN_MAX_BYTES) return false;
  const supplied = await request.text();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: RampEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const values = regionSettings(env);
    const coordinator = env.RAMP_COORDINATOR.getByName(env.GROWTHSENT_RAMP_ID + "-" + values.region.toLowerCase());
    if (request.method === "GET" && path === "/_growthsent_standard1_regional_ramp/status") {
      return response({
        run_id: env.GROWTHSENT_RAMP_ID,
        region: values.region,
        control_secret_configured: typeof env.RAMP_TRIGGER_TOKEN === "string" && env.RAMP_TRIGGER_TOKEN.length >= CONTROL_TOKEN_MIN_BYTES,
        ...(await coordinator.status()),
      });
    }
    if (request.method === "POST" && path === "/_growthsent_standard1_regional_ramp/start") {
      if (!(await hasControlToken(request, env.RAMP_TRIGGER_TOKEN))) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
      try {
        const result = await coordinator.begin();
        return response(result, result.accepted ? 202 : 409);
      } catch (error) {
        const diagnostic = safeError(error);
        console.error(JSON.stringify({ event: "standard1_regional_ramp_schedule_failed", run_id: env.GROWTHSENT_RAMP_ID, region: values.region, ...diagnostic }));
        return response({ accepted: false, run_id: env.GROWTHSENT_RAMP_ID, region: values.region, error: diagnostic.message }, 503);
      }
    }
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<RampEnv>;
