import type { Db } from "mongodb";
import { connectToDatabase } from "../db/mongodb.js";
import { getCrawlQueueHealth } from "./crawl-admission.js";

interface WorkerHealthDocument {
  _id: "audit-worker";
  lastStartedAt?: Date;
  lastSuccessAt?: Date;
  lastFinishedAt?: Date;
  lastOutcome?: "success" | "failure";
  lastDurationMs?: number;
  auditClaimed?: boolean;
  legacyScanClaimed?: boolean;
  auditStatus?: string;
  auditAttempt?: number;
  auditQueueAgeMs?: number;
  updatedAt: Date;
}

export async function recordWorkerInvocationStarted(): Promise<void> {
  const { db } = await connectToDatabase();
  const now = new Date();
  await db.collection<WorkerHealthDocument>("workerHealth").updateOne(
    { _id: "audit-worker" },
    { $set: { lastStartedAt: now, updatedAt: now } },
    { upsert: true }
  );
}

export async function recordWorkerInvocationFinished(input: {
  startedAtMs: number;
  outcome: "success" | "failure";
  auditClaimed?: boolean;
  legacyScanClaimed?: boolean;
  auditStatus?: string;
  auditAttempt?: number;
  auditQueueAgeMs?: number;
}): Promise<void> {
  const { db } = await connectToDatabase();
  const now = new Date();
  await db.collection<WorkerHealthDocument>("workerHealth").updateOne(
    { _id: "audit-worker" },
    {
      $set: {
        lastFinishedAt: now,
        ...(input.outcome === "success" ? { lastSuccessAt: now } : {}),
        lastOutcome: input.outcome,
        lastDurationMs: Math.max(0, Date.now() - input.startedAtMs),
        auditClaimed: Boolean(input.auditClaimed),
        legacyScanClaimed: Boolean(input.legacyScanClaimed),
        auditStatus: input.auditStatus,
        auditAttempt: input.auditAttempt,
        auditQueueAgeMs: input.auditQueueAgeMs,
        updatedAt: now,
      },
    },
    { upsert: true }
  );
}

export interface InternalWorkerHealth {
  configured: boolean;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: "success" | "failure" | null;
  lastDurationMs: number | null;
  auditClaimed: boolean | null;
  legacyScanClaimed: boolean | null;
  lastAuditStatus: string | null;
  lastAuditAttempt: number | null;
  lastAuditQueueAgeMs: number | null;
  queue: Awaited<ReturnType<typeof getCrawlQueueHealth>>;
}

function iso(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Internal authenticated health check. It returns no target URLs or owners. */
export async function getInternalWorkerHealth(db?: Db): Promise<InternalWorkerHealth> {
  const database = db || (await connectToDatabase()).db;
  const [health, queue] = await Promise.all([
    database.collection<WorkerHealthDocument>("workerHealth").findOne({ _id: "audit-worker" }),
    getCrawlQueueHealth(database),
  ]);
  return {
    configured: Boolean(process.env.CRON_SECRET?.trim()),
    lastStartedAt: iso(health?.lastStartedAt),
    lastSuccessAt: iso(health?.lastSuccessAt),
    lastFinishedAt: iso(health?.lastFinishedAt),
    lastOutcome: health?.lastOutcome || null,
    lastDurationMs: health?.lastDurationMs ?? null,
    auditClaimed: health ? Boolean(health.auditClaimed) : null,
    legacyScanClaimed: health ? Boolean(health.legacyScanClaimed) : null,
    lastAuditStatus: health?.auditStatus || null,
    lastAuditAttempt: health?.auditAttempt ?? null,
    lastAuditQueueAgeMs: health?.auditQueueAgeMs ?? null,
    queue,
  };
}
