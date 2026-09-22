import { parquetRead } from "hyparquet";
import { TopHeap } from "./heap.js";
import { toNumber } from "./numbers.js";
import { getZstdCompressor } from "./zstd.js";

let compressorPrepared = false;
let compressors: { ZSTD: (input: Uint8Array, uncompressedSize: number) => Uint8Array } | undefined;

async function ensureCompressors(): Promise<void> {
  if (compressorPrepared) return;
  compressors = { ZSTD: await getZstdCompressor() };
  compressorPrepared = true;
}

type AsyncBufferLike = {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
};

interface ColumnData {
  columnName: string;
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

interface PendingChunk {
  rowStart: number;
  rowEnd: number;
  received: number;
  columns: Record<string, ArrayLike<unknown>>;
}

export interface ReadOptions<T> {
  file: AsyncBufferLike;
  columns: string[];
  domain: string;
  scoreColumn?: string;
  limit: number;
  offset: number;
  build(row: Record<string, unknown>): T;
}

export interface ReadResult<T> {
  rows: T[];
  total: number;
}

function newPendingChunk(rowStart: number, rowEnd: number): PendingChunk {
  return { rowStart, rowEnd, received: 0, columns: {} };
}

function chunkReady(entry: PendingChunk, expected: number): boolean {
  return entry.received === expected;
}

function columnArrays(entry: PendingChunk): Record<string, ArrayLike<unknown>> {
  return entry.columns;
}

/**
 * Stream a domain-partitioned Parquet file and return the matching rows.
 *
 * Uses hyparquet in column-chunk mode so the entire bucket never has to fit in
 * memory. For endpoints that order by a count column, a min-heap keeps only the
 * top (offset + limit) rows, which keeps memory bounded even when a single
 * domain has millions of matches (e.g. broken backlink candidates).
 */
export async function readDomainRows<T>(options: ReadOptions<T>): Promise<ReadResult<T>> {
  const { file, columns, domain, scoreColumn, limit, offset, build } = options;
  await ensureCompressors();

  const readColumns = columns.includes("target_domain") ? columns : ["target_domain", ...columns];

  const keep = offset + limit;
  const heap = scoreColumn ? new TopHeap<T>(Math.max(1, keep)) : null;
  let total = 0;
  const pending = new Map<string, PendingChunk>();

  await parquetRead({
    file,
    compressors,
    columns: readColumns,
    onChunk(chunk: ColumnData) {
      const key = `${chunk.rowStart}-${chunk.rowEnd}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = newPendingChunk(chunk.rowStart, chunk.rowEnd);
        pending.set(key, entry);
      }
      entry.columns[chunk.columnName] = chunk.columnData;
      entry.received++;

      if (chunkReady(entry, readColumns.length)) {
        processRange(entry);
        pending.delete(key);
      }
    },
  });

  if (heap) {
    const sorted = heap.toSorted();
    return { rows: sorted.slice(offset, offset + limit), total };
  }

  // Unscored reads should only be used for small result sets (e.g. summary).
  // This branch exists for completeness; it is not used for listing rows.
  return { rows: [], total };

  function processRange(entry: PendingChunk) {
    const arrays = columnArrays(entry);
    const filterColumn = arrays["target_domain"];
    const scoreArray = scoreColumn ? arrays[scoreColumn] : undefined;
    const count = entry.rowEnd - entry.rowStart;

    for (let i = 0; i < count; i++) {
      if (filterColumn[i] !== domain) continue;
      total++;

      const row: Record<string, unknown> = {};
      for (const col of readColumns) {
        row[col] = arrays[col][i];
      }

      const item = build(row);

      if (heap) {
        const score = scoreArray ? toNumber(scoreArray[i]) : 0;
        heap.push(score, item);
      }
    }
  }
}

/**
 * Read the domain_summary parquet for a single domain row.
 */
export async function readDomainSummary<T>(file: AsyncBufferLike, domain: string, build: (row: Record<string, unknown>) => T): Promise<T | null> {
  await ensureCompressors();
  const readColumns = ["target_domain", "inbound_link_count", "referring_domain_count"];
  let result: T | null = null;
  const pending = new Map<string, PendingChunk>();

  await parquetRead({
    file,
    compressors,
    columns: readColumns,
    onChunk(chunk: ColumnData) {
      const key = `${chunk.rowStart}-${chunk.rowEnd}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = newPendingChunk(chunk.rowStart, chunk.rowEnd);
        pending.set(key, entry);
      }
      entry.columns[chunk.columnName] = chunk.columnData;
      entry.received++;

      if (chunkReady(entry, readColumns.length)) {
        processRange(entry);
        pending.delete(key);
      }
    },
  });

  return result;

  function processRange(entry: PendingChunk) {
    const arrays = columnArrays(entry);
    const filterColumn = arrays["target_domain"];
    const count = entry.rowEnd - entry.rowStart;
    for (let i = 0; i < count; i++) {
      if (filterColumn[i] !== domain) continue;
      const row: Record<string, unknown> = {};
      for (const col of readColumns) {
        row[col] = arrays[col][i];
      }
      result = build(row);
      return;
    }
  }
}
