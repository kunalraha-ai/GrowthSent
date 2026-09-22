import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  DOMAIN_JSON_CONTAINER: DurableObjectNamespace<DomainJsonContainer>;
  DOMAIN_JSON_QUEUE: Queue<{ bucket: number }>;
  R2_DOMAIN_JSON_TOKEN: string;
  ADMIN_SECRET: string;
}

function isAdminAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

export class DomainJsonContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
}

const SERVING_PREFIX =
  "production/link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416/serving";
const OUTPUT_PREFIX = "production/link-index/v1/domain-json/v1";
const CONTAINER_ENV = (env: Env) => ({
  GROWTHSENT_R2_DOMAIN_JSON_TOKEN: env.R2_DOMAIN_JSON_TOKEN,
  GROWTHSENT_SERVING_PREFIX: SERVING_PREFIX,
  GROWTHSENT_OUTPUT_PREFIX: OUTPUT_PREFIX,
  GROWTHSENT_WORK_DIR: "/tmp/growthsent",
  GROWTHSENT_TOP_N: "100",
  GROWTHSENT_UPLOAD_THREADS: "64",
  GROWTHSENT_BATCH_SIZE: "2048",
});
const POOL_SIZE = 50;
const DO_ID = "singleton-v4";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBucketOnContainer(
  container: Container,
  bucket: number,
): Promise<Record<string, unknown>> {
  const start = await container.fetch("http://container/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket }),
  });
  if (!start.ok) {
    const text = await start.text();
    throw new Error(`container /run returned ${start.status}: ${text}`);
  }

  const startedAt = Date.now();
  try {
    while (true) {
      if (Date.now() - startedAt > 1_800_000) {
        throw new Error(`bucket ${bucket} timed out after 30 minutes`);
      }
      await sleep(5_000);

      const statusResp = await container.fetch("http://container/status");
      if (!statusResp.ok) {
        const text = await statusResp.text();
        throw new Error(`container /status returned ${statusResp.status}: ${text}`);
      }
      const status = (await statusResp.json()) as {
        running: boolean;
        done?: boolean;
        error?: string;
        result?: Record<string, unknown>;
      };

      if (status.error) {
        throw new Error(`bucket ${bucket} failed: ${status.error}`);
      }
      if (!status.running || status.done) {
        return status.result ?? {};
      }
    }
  } catch (error) {
    // Kill the container so retries get a fresh instance. Some buckets can
    // hang DuckDB; leaving the DO running blocks this worker slot.
    try {
      await container.destroy();
    } catch {
      // Ignore destroy errors; the container may already be gone.
    }
    throw error;
  }
}

function doIdForBucket(bucket: number): string {
  return `worker-${bucket % POOL_SIZE}`;
}

async function startContainer(env: Env, id = DO_ID): Promise<Container> {
  const container = getContainer(env.DOMAIN_JSON_CONTAINER, id);
  await container.start({
    entrypoint: ["python", "/opt/growthsent/container_entrypoint.py"],
    envVars: CONTAINER_ENV(env),
  });
  return container;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (!isAdminAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/admin/direct") {
      const bucket = parseInt(url.searchParams.get("bucket") || "", 10);
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= 1024) {
        return jsonResponse({ error: "invalid bucket" }, 400);
      }
      const container = await startContainer(env, "direct-test");
      const result = await runBucketOnContainer(container, bucket);
      return jsonResponse(result);
    }

    if (request.method !== "POST" || url.pathname !== "/admin/trigger") {
      return jsonResponse({ error: "not found" }, 404);
    }

    const bucketsParam = url.searchParams.get("buckets");
    const buckets: number[] = bucketsParam
      ? bucketsParam
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < 1024)
      : Array.from({ length: 1024 }, (_, i) => i);

    for (const bucket of buckets) {
      await env.DOMAIN_JSON_QUEUE.send({ bucket });
    }

    return jsonResponse({
      status: "triggered",
      triggered: buckets.length,
      buckets,
    });
  },

  async queue(
    batch: MessageBatch<{ bucket: number }>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      const { bucket } = message.body;
      const container = await startContainer(env, doIdForBucket(bucket));
      await runBucketOnContainer(container, bucket);
      message.ack();
    }
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
