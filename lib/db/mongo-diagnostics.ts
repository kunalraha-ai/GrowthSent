export type MongoOperationPhase =
  | "session_validation"
  | "audit_database_connect"
  | "audit_website_ownership_query"
  | "audit_admission_transaction"
  | "audit_admission_active_claim_insert"
  | "audit_admission_active_claim_lookup"
  | "audit_admission_active_claim_recovery"
  | "audit_admission_quota_update"
  | "audit_admission_target_cooldown_update"
  | "audit_admission_queue_update"
  | "audit_admission_job_enqueue"
  | "backlink_protection_database_connect"
  | "backlink_quota_update"
  | "backlink_cache_read"
  | "backlink_cache_lease_claim"
  | "backlink_cache_publish"
  | "backlink_cache_release"
  | "database_index_provision";

const operationPhaseByError = new WeakMap<object, MongoOperationPhase>();

function isErrorObject(error: unknown): error is object {
  return typeof error === "object" && error !== null;
}

/**
 * Associates an error with a static application operation label. The mapping
 * is process-local and contains no request or database data.
 */
export function recordMongoOperationPhase(error: unknown, phase: MongoOperationPhase): void {
  if (isErrorObject(error) && !operationPhaseByError.has(error)) {
    operationPhaseByError.set(error, phase);
  }
}

export function getMongoOperationPhase(error: unknown): MongoOperationPhase | undefined {
  return isErrorObject(error) ? operationPhaseByError.get(error) : undefined;
}

/** Keeps the closest failing MongoDB operation available to the outer safe logger. */
export async function withMongoOperationPhase<T>(
  phase: MongoOperationPhase,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    recordMongoOperationPhase(error, phase);
    throw error;
  }
}
