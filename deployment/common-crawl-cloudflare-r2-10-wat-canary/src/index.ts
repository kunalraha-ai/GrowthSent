import { Container } from "@cloudflare/containers";
import type { DurableObjectNamespace, ExportedHandler } from "cloudflare:workers";

const LAUNCH_KEY = "growthsent-canary-launch";
const START_FAILURE_KEY = "growthsent-canary-start-failure";
const TERMINAL_KEY = "growthsent-canary-terminal";
const CONTROL_TOKEN_MIN_BYTES = 32;
const CONTROL_TOKEN_MAX_BYTES = 128;
const controlTokenEncoder = new TextEncoder();

type CanaryEnv = {
  CANARY_CONTAINER: DurableObjectNamespace<GrowthSentTenWatContainer>;
  CANARY_TRIGGER_TOKEN: string;
  GROWTHSENT_CANARY_ID: string;
  GROWTHSENT_CONTAINER_INSTANCE_TYPE: string;
  GROWTHSENT_HARD_TIMEOUT_SECONDS: string;
  GROWTHSENT_R2_ACCESS_KEY_ID: string;
  GROWTHSENT_R2_ACCOUNT_ID: string;
  GROWTHSENT_R2_BUCKET: string;
  GROWTHSENT_R2_SECRET_ACCESS_KEY: string;
  GROWTHSENT_R2_SESSION_TOKEN: string;
  GROWTHSENT_REFERENCE_MANIFEST_SHA256: string;
  GROWTHSENT_RELEASE_SHA256: string;
};

type LaunchRecord = {
  recorded_at: string;
  state: "starting" | "start_accepted" | "start_failed";
  type?: string;
  message?: string;
};

type TerminalRecord = {
  recorded_at: string;
  phase: "started" | "stopped" | "error";
  exit_code?: number;
  reason?: string;
  type?: string;
  message?: string;
};

type StartFailureRecord = ReturnType<typeof diagnosticError> & { recorded_at: string };
type StartResult = { accepted: boolean; canary_id: string };

function diagnosticError(error: unknown): { type: string; message: string } {
  const type = error instanceof Error ? error.name : typeof error;
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .replace(/(?:authorization|token|secret|access[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .slice(0, 512);
  return { type, message };
}

export class GrowthSentTenWatContainer extends Container<CanaryEnv> {
  sleepAfter = "110m";
  enableInternet = true;

  envVars = {
    GROWTHSENT_R2_ACCOUNT_ID: this.env.GROWTHSENT_R2_ACCOUNT_ID,
    GROWTHSENT_R2_BUCKET: this.env.GROWTHSENT_R2_BUCKET,
    GROWTHSENT_R2_ACCESS_KEY_ID: this.env.GROWTHSENT_R2_ACCESS_KEY_ID,
    GROWTHSENT_R2_SECRET_ACCESS_KEY: this.env.GROWTHSENT_R2_SECRET_ACCESS_KEY,
    GROWTHSENT_R2_SESSION_TOKEN: this.env.GROWTHSENT_R2_SESSION_TOKEN,
    GROWTHSENT_CANARY_ID: this.env.GROWTHSENT_CANARY_ID,
    GROWTHSENT_RELEASE_SHA256: this.env.GROWTHSENT_RELEASE_SHA256,
    GROWTHSENT_REFERENCE_MANIFEST_SHA256: this.env.GROWTHSENT_REFERENCE_MANIFEST_SHA256,
    GROWTHSENT_CONTAINER_INSTANCE_TYPE: this.env.GROWTHSENT_CONTAINER_INSTANCE_TYPE,
    GROWTHSENT_HARD_TIMEOUT_SECONDS: this.env.GROWTHSENT_HARD_TIMEOUT_SECONDS,
  };

  async onStart(): Promise<void> {
    await this.ctx.storage.put<TerminalRecord>(TERMINAL_KEY, {
      phase: "started",
      recorded_at: new Date().toISOString(),
    });
  }

  async onStop(params: { exitCode: number; reason: string }): Promise<void> {
    await this.ctx.storage.put<TerminalRecord>(TERMINAL_KEY, {
      phase: "stopped",
      exit_code: params.exitCode,
      reason: params.reason,
      recorded_at: new Date().toISOString(),
    });
  }

  async onError(error: unknown): Promise<void> {
    await this.ctx.storage.put<TerminalRecord>(TERMINAL_KEY, {
      phase: "error",
      ...diagnosticError(error),
      recorded_at: new Date().toISOString(),
    });
  }

  async status(): Promise<{
    state: string;
    terminal: TerminalRecord | null;
    launch: LaunchRecord | null;
    start_failure: StartFailureRecord | null;
  }> {
    const state = await this.getState();
    const terminal = await this.ctx.storage.get<TerminalRecord>(TERMINAL_KEY);
    const launch = await this.ctx.storage.get<LaunchRecord>(LAUNCH_KEY);
    const startFailure = await this.ctx.storage.get<StartFailureRecord>(START_FAILURE_KEY);
    return {
      state: state.status,
      terminal: terminal ?? null,
      launch: launch ?? null,
      start_failure: startFailure ?? null,
    };
  }

  async startOnce(): Promise<StartResult> {
    // Durable Object input gates serialize storage I/O. Do not wrap this
    // request in blockConcurrencyWhile(): the Container SDK has its own
    // lifecycle coordination and nested blocking can deadlock startup.
    const prior = await this.ctx.storage.get<LaunchRecord>(LAUNCH_KEY);
    if (prior !== undefined || this.ctx.container.running) {
      return { accepted: false, canary_id: this.env.GROWTHSENT_CANARY_ID };
    }
    await this.ctx.storage.put<LaunchRecord>(LAUNCH_KEY, {
      state: "starting",
      recorded_at: new Date().toISOString(),
    });

    try {
      await this.start();
    } catch (error) {
      const diagnostic = diagnosticError(error);
      await this.ctx.storage.put<StartFailureRecord>(START_FAILURE_KEY, {
        ...diagnostic,
        recorded_at: new Date().toISOString(),
      });
      await this.ctx.storage.put<LaunchRecord>(LAUNCH_KEY, {
        state: "start_failed",
        ...diagnostic,
        recorded_at: new Date().toISOString(),
      });
      throw error;
    }

    await this.ctx.storage.put<LaunchRecord>(LAUNCH_KEY, {
      state: "start_accepted",
      recorded_at: new Date().toISOString(),
    });
    return { accepted: true, canary_id: this.env.GROWTHSENT_CANARY_ID };
  }
}

async function hasControlToken(request: Request, expected: unknown): Promise<boolean> {
  if (typeof expected !== "string" || expected.length < 32) return false;
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < CONTROL_TOKEN_MIN_BYTES ||
    contentLength > CONTROL_TOKEN_MAX_BYTES
  ) {
    return false;
  }
  const supplied = await request.text();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", controlTokenEncoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", controlTokenEncoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(suppliedHash, expectedHash);
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: CanaryEnv): Promise<Response> {
    const url = new URL(request.url);
    const container = env.CANARY_CONTAINER.getByName(env.GROWTHSENT_CANARY_ID);
    if (request.method === "GET" && url.pathname === "/_growthsent_canary/status") {
      return jsonResponse({
        canary_id: env.GROWTHSENT_CANARY_ID,
        control_secret_configured: typeof env.CANARY_TRIGGER_TOKEN === "string" && env.CANARY_TRIGGER_TOKEN.length >= 32,
        ...(await container.status()),
      });
    }
    if (request.method === "POST" && url.pathname === "/_growthsent_canary/start") {
      if (!(await hasControlToken(request, env.CANARY_TRIGGER_TOKEN))) {
        return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      try {
        const result = await container.startOnce();
        return jsonResponse(result, result.accepted ? 202 : 409);
      } catch (error) {
        const diagnostic = diagnosticError(error);
        console.error(JSON.stringify({ event: "container_start_failed", ...diagnostic }));
        return jsonResponse(
          { accepted: false, canary_id: env.GROWTHSENT_CANARY_ID, error: diagnostic.message },
          503,
        );
      }
    }
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<CanaryEnv>;
