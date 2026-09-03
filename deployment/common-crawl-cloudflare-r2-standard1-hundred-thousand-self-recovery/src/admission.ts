import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, ExportedHandler } from "cloudflare:workers";

const REVIEWED_GROUPS = new Set(["APAC", "ENAM", "WNAM", "EEUR", "WEUR", "SAM"]);
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LANE = /^(?:APAC|ENAM|WNAM|EEUR|WEUR|SAM)-(?:0[1-9]|[1-9][0-9])$/;
const MAX_SLOT = 32;
const MAX_TASK_INDEX = 99_999;
const MAX_BACKOFF_SECONDS = 300;
const STATE_KEY = "regional-start-admission-state-v1";

type AdmissionEnv = {
  GROWTHSENT_ADMISSION_INTERVAL_SECONDS: string;
  GROWTHSENT_ADMISSION_MAX_BACKOFF_SECONDS: string;
};

type SafeError = { type: string; message: string };
type ClaimRequest = {
  run_id: string;
  placement_group: string;
  lane: string;
  slot: number;
  task_index: number;
};
type FailureRequest = ClaimRequest & { failure: SafeError };
type Decision = {
  granted: boolean;
  retry_after_seconds: number;
  reason: "granted" | "paced" | "capacity_backoff";
};
type AdmissionState = {
  run_id: string;
  placement_group: string;
  next_admission_at_ms: number;
  capacity_backoff_until_ms: number;
  capacity_failure_streak: number;
  last_updated_at: string;
};

function setting(env: AdmissionEnv, name: keyof AdmissionEnv, minimum: number, maximum: number): number {
  const raw = env[name];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("missing or invalid admission setting: " + name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("admission setting is outside reviewed bounds: " + name);
  return value;
}

function safeError(error: unknown): SafeError {
  const type = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  return {
    type: type.slice(0, 128),
    message: raw.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 512),
  };
}

function parseRequest(value: unknown): ClaimRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("regional admission request must be an object");
  const request = value as Record<string, unknown>;
  const runId = request.run_id;
  const group = request.placement_group;
  const lane = request.lane;
  const slot = request.slot;
  const taskIndex = request.task_index;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("regional admission run_id is invalid");
  if (typeof group !== "string" || !REVIEWED_GROUPS.has(group)) throw new Error("regional admission placement_group is invalid");
  if (typeof lane !== "string" || !LANE.test(lane) || !lane.startsWith(group + "-")) throw new Error("regional admission lane is invalid for its placement group");
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > MAX_SLOT) throw new Error("regional admission slot is invalid");
  if (!Number.isSafeInteger(taskIndex) || taskIndex < 0 || taskIndex > MAX_TASK_INDEX) throw new Error("regional admission task_index is invalid");
  return { run_id: runId, placement_group: group, lane, slot, task_index: taskIndex };
}

function parseFailure(value: unknown): FailureRequest {
  const request = parseRequest(value);
  const failure = (value as Record<string, unknown>).failure;
  if (failure === null || typeof failure !== "object" || Array.isArray(failure)) throw new Error("regional admission failure must be an object");
  const item = failure as Record<string, unknown>;
  if (typeof item.type !== "string" || typeof item.message !== "string") throw new Error("regional admission failure shape is invalid");
  return { ...request, failure: { type: item.type.slice(0, 128), message: item.message.slice(0, 512) } };
}

export class GrowthSentStandard1RegionalStartAdmission extends DurableObject<AdmissionEnv> {
  private async stateFor(request: ClaimRequest): Promise<AdmissionState> {
    const existing = await this.ctx.storage.get<AdmissionState>(STATE_KEY);
    if (existing === undefined) {
      return {
        run_id: request.run_id,
        placement_group: request.placement_group,
        next_admission_at_ms: 0,
        capacity_backoff_until_ms: 0,
        capacity_failure_streak: 0,
        last_updated_at: new Date().toISOString(),
      };
    }
    if (existing.run_id !== request.run_id || existing.placement_group !== request.placement_group) {
      throw new Error("regional admission Durable Object identity does not match its immutable run or placement group");
    }
    return existing;
  }

  async claimStart(value: unknown): Promise<Decision> {
    const request = parseRequest(value);
    const state = await this.stateFor(request);
    const currentTime = Date.now();
    if (state.capacity_backoff_until_ms > currentTime) {
      return {
        granted: false,
        retry_after_seconds: Math.min(MAX_BACKOFF_SECONDS, Math.max(1, Math.ceil((state.capacity_backoff_until_ms - currentTime) / 1000))),
        reason: "capacity_backoff",
      };
    }
    if (state.next_admission_at_ms > currentTime) {
      return {
        granted: false,
        retry_after_seconds: Math.min(MAX_BACKOFF_SECONDS, Math.max(1, Math.ceil((state.next_admission_at_ms - currentTime) / 1000))),
        reason: "paced",
      };
    }
    const intervalSeconds = setting(this.env, "GROWTHSENT_ADMISSION_INTERVAL_SECONDS", 1, 60);
    await this.ctx.storage.put<AdmissionState>(STATE_KEY, {
      ...state,
      next_admission_at_ms: currentTime + intervalSeconds * 1000,
      last_updated_at: new Date(currentTime).toISOString(),
    });
    return { granted: true, retry_after_seconds: 0, reason: "granted" };
  }

  async reportCapacityFailure(value: unknown): Promise<void> {
    const request = parseFailure(value);
    const state = await this.stateFor(request);
    const currentTime = Date.now();
    const maxBackoff = setting(this.env, "GROWTHSENT_ADMISSION_MAX_BACKOFF_SECONDS", 30, MAX_BACKOFF_SECONDS);
    const intervalSeconds = setting(this.env, "GROWTHSENT_ADMISSION_INTERVAL_SECONDS", 1, 60);
    const failureStreak = Math.min(6, state.capacity_failure_streak + 1);
    const backoffSeconds = Math.min(maxBackoff, intervalSeconds * (2 ** failureStreak));
    const backoffUntil = currentTime + backoffSeconds * 1000;
    await this.ctx.storage.put<AdmissionState>(STATE_KEY, {
      ...state,
      next_admission_at_ms: Math.max(state.next_admission_at_ms, backoffUntil),
      capacity_backoff_until_ms: backoffUntil,
      capacity_failure_streak: failureStreak,
      last_updated_at: new Date(currentTime).toISOString(),
    });
    console.warn(JSON.stringify({ event: "standard1_regional_admission_capacity_backoff", run_id: request.run_id, placement_group: request.placement_group, lane: request.lane, slot: request.slot, task_index: request.task_index, failure_streak: failureStreak, backoff_seconds: backoffSeconds, ...request.failure }));
  }

  async reportStartSuccess(value: unknown): Promise<void> {
    const request = parseRequest(value);
    const state = await this.stateFor(request);
    if (state.capacity_failure_streak === 0 && state.capacity_backoff_until_ms <= Date.now()) return;
    const currentTime = Date.now();
    await this.ctx.storage.put<AdmissionState>(STATE_KEY, {
      ...state,
      capacity_failure_streak: 0,
      capacity_backoff_until_ms: Math.min(state.capacity_backoff_until_ms, currentTime),
      last_updated_at: new Date(currentTime).toISOString(),
    });
  }
}

export default {
  async fetch(_request: Request): Promise<Response> {
    // This Worker is intentionally private: only explicitly configured Durable
    // Object bindings may call its public RPC methods.
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<AdmissionEnv>;
