type ProductionErrorContext = {
  route: string;
  method: string;
};

type ProductionErrorMetadata = {
  route: "api_v1_websites" | "other_api_route";
  method: string;
  errorName: string;
  errorMessage?: string;
  stackFrames?: string[];
};

function safeRouteName(route: string): ProductionErrorMetadata["route"] {
  return route === "/api/v1/websites" ? "api_v1_websites" : "other_api_route";
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

  return metadata;
}

export function logProductionApiHandlerError(
  label: string,
  error: unknown,
  context: ProductionErrorContext
): void {
  console.error(label, buildProductionErrorMetadata(error, context));
}
