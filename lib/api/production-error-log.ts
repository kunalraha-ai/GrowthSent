import { getMongoOperationPhase, type MongoOperationPhase } from "../db/mongo-diagnostics.js";

type ProductionErrorContext = {
  route: string;
  method: string;
};

type ProductionErrorMetadata = {
  route: "api_v1_audit" | "api_v1_backlinks" | "api_v1_websites" | "api_v1_internal_audit_worker" | "api_v1_auth" | "api_v1_integrations" | "api_v1_analytics" | "other_api_route";
  method: string;
  errorName: string;
  errorMessage?: string;
  mongoCode?: string | number;
  mongoCodeName?: string;
  operationPhase?: MongoOperationPhase;
  stackFrames?: string[];
};

function safeRouteName(route: string): ProductionErrorMetadata["route"] {
  if (/^\/api\/v1\/audit(?:\/|$)/.test(route)) return "api_v1_audit";
  if (route === "/api/v1/backlinks") return "api_v1_backlinks";
  if (/^\/api\/v1\/websites\/[a-f0-9]{24}\/analytics(?:\/|$)/.test(route)) return "api_v1_analytics";
  if (/^\/api\/v1\/websites(?:\/|$)/.test(route)) return "api_v1_websites";
  if (/^\/api\/v1\/internal\/audit-worker(?:\/|$)/.test(route)) return "api_v1_internal_audit_worker";
  if (/^\/api\/v1\/auth(?:\/|$)/.test(route)) return "api_v1_auth";
  if (/^\/api\/v1\/integrations(?:\/|$)/.test(route)) return "api_v1_integrations";
  return "other_api_route";
}

function safeHttpMethod(method: string): string {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : "UNKNOWN";
}

function safeReferenceErrorMessage(message: string): string {
  const isNotDefined = message.match(/^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/);
  if (isNotDefined) return `${isNotDefined[1]} is not defined`;

  const temporalDeadZone = message.match(/^Cannot access '([A-Za-z_$][A-Za-z0-9_$]*)' before initialization$/);
  if (temporalDeadZone) return `Cannot access '${temporalDeadZone[1]}' before initialization`;

  return "ReferenceError message withheld";
}

function safeMongoCode(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  return undefined;
}

function safeMongoCodeName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

function safeMongoErrorMessage(message: string, code: string | number | undefined, codeName: string | undefined): string {
  if (code === 11000 || codeName === "DuplicateKey" || /duplicate key|E11000/i.test(message)) {
    return "MongoDB duplicate-key constraint conflict.";
  }
  if (codeName === "WriteConflict" || /write conflict/i.test(message)) {
    return "MongoDB write conflict.";
  }
  if (codeName === "TransactionNotSupported" || /transaction numbers are only allowed|transactions are not supported|replica set/i.test(message)) {
    return "MongoDB transactions are unavailable on this deployment.";
  }
  if (codeName === "IndexNotFound" || /index not found/i.test(message)) {
    return "MongoDB required index is unavailable.";
  }
  if (codeName === "Unauthorized" || /not authorized|authentication failed/i.test(message)) {
    return "MongoDB authorization failed.";
  }
  if (codeName === "MaxTimeMSExpired" || /timed out|maxTimeMS/i.test(message)) {
    return "MongoDB operation timed out.";
  }
  return "MongoDB server error message withheld.";
}

/**
 * Keep only stack information that identifies our code. In particular, do not
 * emit runtime paths, arguments, request data, or arbitrary error text.
 */
function safeOwnStackFrames(stack: string | undefined): string[] {
  if (!stack) return [];

  const frames = stack.split(/\r?\n/).slice(1).flatMap((frame) => {
    const file = frame.match(/(?:^|[\\/])(api|lib)[\\/]([A-Za-z0-9_.\/[\]-]+?)(?::\d+:\d+)(?:\)?\s*)$/);
    if (!file) return [];

    const relativeFile = `${file[1]}/${file[2]}`;
    const functionName = frame.match(/^\s*at\s+(?:async\s+)?([A-Za-z0-9_$.[\]<>-]+)/)?.[1];
    return [functionName ? `${functionName} (${relativeFile})` : relativeFile];
  });

  return frames.slice(0, 8);
}

/**
 * Builds production-safe error metadata. ReferenceError messages intentionally
 * retain only a source identifier because that is needed to diagnose a missing
 * binding; all other message text is withheld.
 */
export function buildProductionErrorMetadata(
  error: unknown,
  context: ProductionErrorContext
): ProductionErrorMetadata {
  const metadata: ProductionErrorMetadata = {
    route: safeRouteName(context.route),
    method: safeHttpMethod(context.method),
    errorName: error instanceof Error ? error.name : "UnknownError",
  };

  if (error instanceof ReferenceError) {
    metadata.errorMessage = safeReferenceErrorMessage(error.message);
    metadata.stackFrames = safeOwnStackFrames(error.stack);
  }

  if (metadata.errorName === "MongoServerError") {
    const mongoError = error as { code?: unknown; codeName?: unknown; message?: unknown; stack?: unknown };
    const mongoCode = safeMongoCode(mongoError.code);
    const mongoCodeName = safeMongoCodeName(mongoError.codeName);
    if (mongoCode !== undefined) metadata.mongoCode = mongoCode;
    if (mongoCodeName) metadata.mongoCodeName = mongoCodeName;
    metadata.errorMessage = safeMongoErrorMessage(
      typeof mongoError.message === "string" ? mongoError.message : "",
      mongoCode,
      mongoCodeName
    );
    const operationPhase = getMongoOperationPhase(error);
    if (operationPhase) metadata.operationPhase = operationPhase;
    metadata.stackFrames = safeOwnStackFrames(typeof mongoError.stack === "string" ? mongoError.stack : undefined);
  }

  return metadata;
}

export function logProductionApiHandlerError(
  label: string,
  error: unknown,
  context: ProductionErrorContext
): void {
  console.error(label, buildProductionErrorMetadata(error, context));
}
