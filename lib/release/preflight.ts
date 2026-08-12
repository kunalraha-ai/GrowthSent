import { connectToDataFederation } from "../db/data-federation.js";
import { connectToDatabase } from "../db/mongodb.js";
import { verifyDatabaseIndexes } from "../db/indexes.js";
import { hasValidCronAuthorization } from "../jobs/cron-worker.js";

const DATA_FEDERATION_COLLECTIONS = ["pages_prod_2026_30", "links_prod_2026_30"] as const;

export interface ProductionPreflightReport {
  ok: boolean;
  environment: {
    operationalMongoConfigured: boolean;
    dataFederationConfigured: boolean;
    cronSecretConfigured: boolean;
    crawlAdmissionSecretConfigured: boolean;
    mongoAndDataFederationUrisIdentical: boolean;
    databaseNamesIdentical: boolean;
  };
  operationalMongo: {
    reachable: boolean;
    missingIndexes: string[];
  };
  dataFederation: {
    reachable: boolean;
    collections: Record<string, { visible: boolean; metadataPartitions: number | null; multiplePartitionsVisible: boolean }>;
  };
  worker: {
    protected: boolean;
  };
  errors: string[];
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Reads configuration and bounded database metadata only. It never creates
 * indexes, writes documents, or reads Common Crawl data rows.
 */
export async function runProductionPreflight(): Promise<ProductionPreflightReport> {
  const appUri = process.env.MONGODB_URI?.trim();
  const dataFederationUri = process.env.MONGODB_DATA_FEDERATION_URI?.trim();
  const appDbName = process.env.MONGODB_DB_NAME?.trim();
  const dataFederationDbName = process.env.MONGODB_DATA_FEDERATION_DB_NAME?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const report: ProductionPreflightReport = {
    ok: false,
    environment: {
      operationalMongoConfigured: configured(appUri) && configured(appDbName),
      dataFederationConfigured: configured(dataFederationUri) && configured(dataFederationDbName),
      cronSecretConfigured: configured(cronSecret),
      crawlAdmissionSecretConfigured: configured(process.env.CRAWL_ADMISSION_SECRET) || configured(process.env.SESSION_SECRET),
      // Boolean comparison only: URIs are never serialized into the report.
      mongoAndDataFederationUrisIdentical: Boolean(appUri && dataFederationUri && appUri === dataFederationUri),
      databaseNamesIdentical: Boolean(appDbName && dataFederationDbName && appDbName === dataFederationDbName),
    },
    operationalMongo: { reachable: false, missingIndexes: [] },
    dataFederation: { reachable: false, collections: {} },
    worker: { protected: hasValidCronAuthorization(cronSecret ? `Bearer ${cronSecret}` : undefined, cronSecret) },
    errors: [],
  };

  if (!report.environment.operationalMongoConfigured) report.errors.push("operational_mongodb_not_configured");
  if (!report.environment.dataFederationConfigured) report.errors.push("data_federation_not_configured");
  if (!report.environment.cronSecretConfigured) report.errors.push("cron_secret_not_configured");
  if (!report.environment.crawlAdmissionSecretConfigured) report.errors.push("crawl_admission_secret_not_configured");
  if (report.environment.mongoAndDataFederationUrisIdentical) report.errors.push("mongo_and_data_federation_uri_identical");
  if (report.environment.databaseNamesIdentical) report.errors.push("mongo_and_data_federation_database_identical");

  if (report.environment.operationalMongoConfigured) {
    try {
      const { db } = await connectToDatabase();
      const indexes = await verifyDatabaseIndexes(db);
      report.operationalMongo.reachable = true;
      report.operationalMongo.missingIndexes = indexes.filter((index) => !index.present).map((index) => `${index.collection}.${index.name}`);
      if (report.operationalMongo.missingIndexes.length > 0) report.errors.push("required_mongodb_indexes_missing");
    } catch {
      report.errors.push("operational_mongodb_unreachable");
    }
  }

  // Never open a Data Federation connection when configuration already proves
  // it points at the operational database. The safe report above is enough to
  // fail preflight without touching the wrong data path.
  if (
    report.environment.dataFederationConfigured &&
    !report.environment.mongoAndDataFederationUrisIdentical &&
    !report.environment.databaseNamesIdentical
  ) {
    try {
      const { db } = await connectToDataFederation();
      report.dataFederation.reachable = true;
      for (const collectionName of DATA_FEDERATION_COLLECTIONS) {
        try {
          // $collStats is metadata-oriented and bounded to avoid a row scan or
          // countDocuments call. Atlas Data Federation exposes one metadata
          // record per discovered Parquet source/partition for this mapping.
          const metadata = await db.collection(collectionName).aggregate([
            { $collStats: { storageStats: {} } },
            { $limit: 64 },
          ], { maxTimeMS: 5_000 }).toArray();
          const partitions = metadata.length;
          report.dataFederation.collections[collectionName] = {
            visible: true,
            metadataPartitions: partitions,
            multiplePartitionsVisible: partitions > 1,
          };
          if (partitions <= 1) report.errors.push(`data_federation_${collectionName}_does_not_expose_multiple_partitions`);
        } catch {
          report.dataFederation.collections[collectionName] = { visible: false, metadataPartitions: null, multiplePartitionsVisible: false };
          report.errors.push(`data_federation_${collectionName}_unavailable`);
        }
      }
    } catch {
      report.errors.push("data_federation_unreachable");
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}
