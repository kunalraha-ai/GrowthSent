import { timingSafeEqual } from "node:crypto";
import { processDurableCrawlWork } from "./runner.js";
import { recordWorkerInvocationFinished, recordWorkerInvocationStarted } from "./worker-health.js";

export interface CronWorkerRequest {
  method: string;
  authorization?: string;
}

export interface DurableCrawlWorkResult {
  auditClaimed: boolean;
  scanClaimed: boolean;
  auditStatus?: string;
  auditAttempt?: number;
  auditQueueAgeMs?: number;
}

export interface CronWorkerOptions {
  cronSecret?: string;
  processWork?: () => Promise<DurableCrawlWorkResult>;
}

export interface CronWorkerResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export function hasValidCronAuthorization(authorization: string | undefined, cronSecret: string | undefined): boolean {
  if (!cronSecret || !authorization) return false;

  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const received = Buffer.from(authorization, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Handles one authenticated scheduler invocation. The existing durable worker itself
 * claims at most one audit and one legacy scan, so this endpoint must never
 * add a loop to drain the queue inside a serverless invocation.
 */
export async function handleDurableCrawlCronRequest(
  request: CronWorkerRequest,
  options: CronWorkerOptions = {}
): Promise<CronWorkerResponse> {
  if (request.method !== "GET") {
    return { statusCode: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } } };
  }

  const cronSecret = options.cronSecret ?? process.env.CRON_SECRET;
  if (!hasValidCronAuthorization(request.authorization, cronSecret)) {
    return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Unauthorized." } } };
  }

  const startedAtMs = Date.now();
  try {
    await recordWorkerInvocationStarted().catch(() => {
      console.error("[audit-worker] Unable to record worker start.");
    });
    const processWork = options.processWork ?? processDurableCrawlWork;
    const result = await processWork();
    await recordWorkerInvocationFinished({
      startedAtMs,
      outcome: "success",
      auditClaimed: result.auditClaimed,
      legacyScanClaimed: result.scanClaimed,
      auditStatus: result.auditStatus,
      auditAttempt: result.auditAttempt,
      auditQueueAgeMs: result.auditQueueAgeMs,
    }).catch(() => console.error("[audit-worker] Unable to record worker outcome."));
    console.info("[audit-worker] bounded pass completed", {
      jobType: result.auditClaimed ? "audit" : result.scanClaimed ? "legacy_scan" : "none",
      auditClaimed: result.auditClaimed,
      legacyScanClaimed: result.scanClaimed,
      outcome: result.auditStatus || "none",
      attempt: result.auditAttempt ?? null,
      queueAgeMs: result.auditQueueAgeMs ?? null,
      durationMs: Date.now() - startedAtMs,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        auditClaimed: result.auditClaimed,
        scanClaimed: result.scanClaimed,
      },
    };
  } catch (error) {
    await recordWorkerInvocationFinished({ startedAtMs, outcome: "failure" }).catch(() => undefined);
    console.error("[audit-worker] Durable crawl worker invocation failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { statusCode: 500, body: { error: { code: "WORKER_ERROR", message: "Worker invocation failed." } } };
  }
}
