import { CreateIndexesOptions, Db, IndexSpecification } from "mongodb";
import { connectToDatabase } from "./mongodb.js";

/**
 * This manifest is the single reviewable source of truth for legacy MongoDB
 * indexes. It is deliberately not run during normal HTTP traffic.
 */
export interface ManagedIndexDefinition {
  collection: string;
  name: string;
  key: IndexSpecification;
  options?: CreateIndexesOptions;
  /** Unique indexes need a duplicate audit against the target database first. */
  requiresDuplicateAudit?: boolean;
  /** TTL indexes can delete existing expired documents once created. */
  requiresExplicitTtlApproval?: boolean;
  /** Mirrors sparse/partial index inclusion for the duplicate audit. */
  duplicateAuditMatch?: Record<string, unknown>;
  description: string;
}

export const DATABASE_INDEX_MANIFEST: readonly ManagedIndexDefinition[] = [
  {
    collection: "users",
    name: "users_email_unique",
    key: { email: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One local account per normalized email.",
  },
  {
    collection: "users",
    name: "users_google_id_unique_sparse",
    key: { googleId: 1 },
    options: { unique: true, sparse: true },
    requiresDuplicateAudit: true,
    duplicateAuditMatch: { googleId: { $exists: true } },
    description: "One Google subject per account while allowing password-only users.",
  },
  {
    collection: "users",
    name: "users_github_id_unique_sparse",
    key: { githubId: 1 },
    options: { unique: true, sparse: true },
    requiresDuplicateAudit: true,
    duplicateAuditMatch: { githubId: { $exists: true } },
    description: "One GitHub subject per account while allowing password-only users.",
  },
  {
    collection: "sessions",
    name: "sessions_token_hash_unique",
    key: { tokenHash: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "Session-token lookup and collision protection.",
  },
  {
    collection: "sessions",
    name: "sessions_expires_at_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    requiresExplicitTtlApproval: true,
    description: "Expire server-side sessions at their stored expiry time.",
  },
  {
    collection: "websites",
    name: "websites_user_hostname_unique",
    key: { userId: 1, hostname: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One saved hostname per user.",
  },
  {
    collection: "scans",
    name: "scans_website_created_at",
    key: { websiteId: 1, createdAt: -1 },
    description: "Website scan history.",
  },
  {
    collection: "scans",
    name: "scans_owner_created_at",
    key: { ownerUserId: 1, createdAt: -1 },
    description: "Authenticated standalone scan lookup.",
  },
  {
    collection: "scans",
    name: "scans_queue_due",
    key: { status: 1, nextAttemptAt: 1, createdAt: 1 },
    description: "Durable worker queued-scan selection.",
  },
  {
    collection: "scans",
    name: "scans_lease_expiry",
    key: { status: 1, leaseExpiresAt: 1 },
    description: "Recovery of expired scan-worker leases.",
  },
  {
    collection: "pages",
    name: "pages_scan_normalized_url",
    key: { scanId: 1, normalizedUrl: 1 },
    description: "Scan page lookup and replacement.",
  },
  {
    collection: "issues",
    name: "issues_scan_severity_rule",
    key: { scanId: 1, severity: 1, ruleId: 1 },
    description: "Per-scan issue filtering.",
  },
  {
    collection: "crawlJobs",
    name: "crawl_jobs_job_id_unique",
    key: { jobId: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "Opaque audit-job identity.",
  },
  {
    collection: "crawlJobs",
    name: "crawl_jobs_queue_due",
    key: { status: 1, nextAttemptAt: 1, createdAt: 1 },
    description: "Durable worker queued-audit selection.",
  },
  {
    collection: "crawlJobs",
    name: "crawl_jobs_lease_expiry",
    key: { status: 1, leaseExpiresAt: 1 },
    description: "Recovery of expired audit-worker leases.",
  },
  {
    collection: "crawlJobs",
    name: "crawl_jobs_status_created_at",
    key: { status: 1, createdAt: 1 },
    description: "Bounded oldest-pending queue-health lookup.",
  },
  {
    collection: "crawlAdmission",
    name: "crawl_admission_expires_at_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    requiresExplicitTtlApproval: true,
    description: "Expire short-lived crawl quota, cooldown, and claim records.",
  },
  {
    collection: "backlinkQueryProtection",
    name: "backlink_query_protection_expires_at_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    requiresExplicitTtlApproval: true,
    description: "Expire short-lived backlink request quotas and shared result leases.",
  },
  {
    collection: "crawlSnapshots",
    name: "crawl_snapshots_scan_unique",
    key: { scanId: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One trend snapshot per completed audit scan.",
  },
  {
    collection: "crawlSnapshots",
    name: "crawl_snapshots_website_created_at",
    key: { websiteId: 1, createdAt: -1 },
    description: "Website trend history.",
  },
  {
    collection: "seoIssueHistory",
    name: "seo_issue_history_identity_unique",
    key: { websiteId: 1, ruleId: 1, affectedUrl: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One lifecycle record for each website/rule/URL identity.",
  },
  {
    collection: "seoIssueHistory",
    name: "seo_issue_history_website_last_detected",
    key: { websiteId: 1, lastDetectedAt: -1 },
    description: "Website issue-history listing.",
  },
  {
    collection: "monitoringSnapshots",
    name: "monitoring_snapshots_website_created_at",
    key: { websiteId: 1, createdAt: -1 },
    description: "Monitoring trend history.",
  },
  {
    collection: "analyticsEvents",
    name: "analytics_events_website_timestamp",
    key: { websiteId: 1, timestamp: -1 },
    description: "Website analytics date-range retrieval.",
  },
  {
    collection: "analyticsEvents",
    name: "analytics_events_timestamp_ttl",
    key: { timestamp: 1 },
    options: { expireAfterSeconds: 90 * 24 * 60 * 60 },
    requiresExplicitTtlApproval: true,
    description: "Expire raw analytics events after 90 days.",
  },
  {
    collection: "analyticsAggregates",
    name: "analytics_aggregates_website_date_unique",
    key: { websiteId: 1, date: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One daily aggregate per website/date.",
  },
  {
    collection: "integrations",
    name: "integrations_user_website_provider_unique",
    key: { userId: 1, websiteId: 1, provider: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One active provider configuration per website/user.",
  },
  {
    collection: "apiKeys",
    name: "api_keys_key_hash_unique",
    key: { keyHash: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "Prevent an API-key hash collision.",
  },
  {
    collection: "loginOAuthStates",
    name: "login_oauth_states_state_unique",
    key: { state: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One-time social-login CSRF state.",
  },
  {
    collection: "loginOAuthStates",
    name: "login_oauth_states_expires_at_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    requiresExplicitTtlApproval: true,
    description: "Expire unused social-login states.",
  },
  {
    collection: "googleOAuthStates",
    name: "google_oauth_states_state_unique",
    key: { state: 1 },
    options: { unique: true },
    requiresDuplicateAudit: true,
    description: "One-time Google integration OAuth state.",
  },
  {
    collection: "googleOAuthStates",
    name: "google_oauth_states_expires_at_ttl",
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    requiresExplicitTtlApproval: true,
    description: "Expire unused Google integration states.",
  },
];

export interface UniqueIndexDuplicateAudit {
  collection: string;
  name: string;
  duplicateGroups: number;
}

export interface IndexProvisionResult {
  collection: string;
  name: string;
}

export interface IndexProvisionOptions {
  /** Must be true before any `requiresDuplicateAudit` definition is created. */
  includeUnique?: boolean;
  /** Confirms that the built-in target-database duplicate audit should run. */
  auditUniqueIndexes?: boolean;
  /** Must be true before TTL indexes are created, because they expire data. */
  includeTtl?: boolean;
}

export interface IndexVerificationResult {
  collection: string;
  name: string;
  present: boolean;
}

/** Read-only index verification used by the release preflight. */
export async function verifyDatabaseIndexes(db: Db): Promise<IndexVerificationResult[]> {
  const byCollection = new Map<string, ManagedIndexDefinition[]>();
  for (const definition of DATABASE_INDEX_MANIFEST) {
    const definitions = byCollection.get(definition.collection) || [];
    definitions.push(definition);
    byCollection.set(definition.collection, definitions);
  }

  const results: IndexVerificationResult[] = [];
  for (const [collection, definitions] of byCollection) {
    const indexes = await db.collection(collection).listIndexes().toArray();
    const names = new Set(indexes.map((index) => index.name));
    for (const definition of definitions) {
      results.push({ collection, name: definition.name, present: names.has(definition.name) });
    }
  }
  return results;
}

function uniqueDefinitions(definitions: readonly ManagedIndexDefinition[]): ManagedIndexDefinition[] {
  return definitions.filter((definition) => definition.requiresDuplicateAudit);
}

function groupIdForIndex(definition: ManagedIndexDefinition): Record<string, string> {
  const groupId: Record<string, string> = {};
  for (const field of Object.keys(definition.key as Record<string, unknown>)) {
    groupId[field] = `$${field}`;
  }
  return groupId;
}

/**
 * Read-only preflight. It deliberately reports counts/names only so duplicate
 * user identifiers or URLs are not copied to deploy logs.
 */
export async function auditUniqueIndexDuplicates(
  db: Db,
  definitions: readonly ManagedIndexDefinition[] = uniqueDefinitions(DATABASE_INDEX_MANIFEST)
): Promise<UniqueIndexDuplicateAudit[]> {
  const duplicates: UniqueIndexDuplicateAudit[] = [];
  for (const definition of definitions) {
    const groups = await db
      .collection(definition.collection)
      .aggregate([
        ...(definition.duplicateAuditMatch ? [{ $match: definition.duplicateAuditMatch }] : []),
        { $group: { _id: groupIdForIndex(definition), count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1_000 },
      ])
      .toArray();
    if (groups.length > 0) {
      duplicates.push({ collection: definition.collection, name: definition.name, duplicateGroups: groups.length });
    }
  }
  return duplicates;
}

/**
 * Controlled, idempotent provisioning. The caller must opt into every write;
 * no HTTP request invokes this by default. Every selected definition is tried
 * even if another one fails, then failures are surfaced together.
 */
export async function provisionDatabaseIndexesForDb(
  db: Db,
  options: IndexProvisionOptions = {}
): Promise<IndexProvisionResult[]> {
  const includeUnique = options.includeUnique === true;
  const includeTtl = options.includeTtl === true;
  if (includeUnique && options.auditUniqueIndexes !== true) {
    throw new Error("Unique index provisioning requires an explicit duplicate audit.");
  }

  const selected = DATABASE_INDEX_MANIFEST.filter(
    (definition) =>
      (includeUnique || !definition.requiresDuplicateAudit) &&
      (includeTtl || !definition.requiresExplicitTtlApproval)
  );

  if (includeUnique) {
    const duplicateGroups = await auditUniqueIndexDuplicates(db, uniqueDefinitions(selected));
    if (duplicateGroups.length > 0) {
      const names = duplicateGroups.map((item) => `${item.collection}.${item.name}`).join(", ");
      throw new Error(`Unique index provisioning aborted: duplicate groups found in ${names}.`);
    }
  }

  const successes: IndexProvisionResult[] = [];
  const failures: string[] = [];
  for (const definition of selected) {
    try {
      await db.collection(definition.collection).createIndex(definition.key, {
        name: definition.name,
        ...definition.options,
      });
      successes.push({ collection: definition.collection, name: definition.name });
    } catch {
      // Continue so a single index definition cannot silently prevent all later
      // indexes from being provisioned. Do not log raw driver details.
      failures.push(`${definition.collection}.${definition.name}`);
    }
  }

  if (failures.length > 0) {
    console.error(`[DatabaseIndexes] Provisioning failed for: ${failures.join(", ")}`);
    throw new Error(`Database index provisioning failed for: ${failures.join(", ")}`);
  }
  return successes;
}

/**
 * Backwards-compatible entry point used by a deliberately gated deploy hook.
 * It never creates a unique index unless both caller options are explicit.
 */
export async function initializeDatabaseIndexes(options: IndexProvisionOptions = {}): Promise<void> {
  const { db } = await connectToDatabase();
  await provisionDatabaseIndexesForDb(db, options);
}
