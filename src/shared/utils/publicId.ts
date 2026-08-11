import { randomBytes } from "crypto";

export type EntityPrefix =
  | "gs_usr_"
  | "gs_prj_"
  | "gs_mem_"
  | "gs_dom_"
  | "gs_pag_"
  | "gs_mtd_"
  | "gs_aud_"
  | "gs_iss_"
  | "gs_aio_"
  | "gs_blk_"
  | "gs_gsc_"
  | "gs_ga4_"
  | "gs_key_"
  | "gs_job_"
  | "gs_cch_"
  | "gs_snp_"
  | "gs_src_"
  | "gs_kwd_"
  | "gs_rnk_"
  | "gs_doc_"
  | "gs_act_"
  | "gs_cfg_";

/**
 * Generates a K-Sortable UUIDv7 formatted string prefixed with the entity prefix.
 * Example: generatePublicId("gs_usr_") => "gs_usr_018f3a5b9c007a1b9c007a1b9c007a1b"
 */
export function generatePublicId(prefix: EntityPrefix): string {
  const timestamp = Date.now();
  const hexTimestamp = timestamp.toString(16).padStart(12, "0");
  const randomHex = randomBytes(10).toString("hex");
  return `${prefix}${hexTimestamp}${randomHex}`;
}
