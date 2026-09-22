/// <reference types="@cloudflare/workers-types" />

import { parquetRead, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVING_PREFIX = 'production/link-index/v1/serving/cc-main-2026-30-index-compact-20260910145140-16416/serving'
const DOMAIN_JSON_PREFIX = 'production/link-index/v1/domain-json/v1'
const BUCKET_COUNT = 1024

const TABLE_COLUMNS: Record<string, string[]> = {
  domain_summary: ['target_domain', 'inbound_link_count', 'referring_domain_count'],
  referring_domains: ['target_domain', 'source_domain', 'inbound_link_count'],
  anchors: ['target_domain', 'anchor', 'inbound_link_count'],
  top_pages: ['target_domain', 'target_url', 'inbound_link_count', 'referring_domain_count'],
  broken_backlink_candidates: ['target_domain', 'target_url', 'source_domain', 'source_url', 'observed_link_count'],
  domain_edges: ['source_domain', 'target_domain', 'link_count'],
}

interface Env {
  GROWTHSENT_BUCKET: R2Bucket
  API_TOKEN?: string
}

type Row = Record<string, unknown>

interface DomainJsonTable<T> {
  total: number
  items: T[]
}

interface DomainJsonPayload {
  format_version: number
  domain: string
  bucket: number
  summary: {
    inbound_link_count: number
    referring_domain_count: number
  }
  referring_domains: DomainJsonTable<{
    source_domain: string
    inbound_link_count: number
  }>
  anchors: DomainJsonTable<{
    anchor: string
    inbound_link_count: number
  }>
  top_pages: DomainJsonTable<{
    target_url: string
    inbound_link_count: number
    referring_domain_count: number
  }>
  broken_backlinks: DomainJsonTable<{
    target_url: string
    source_domain: string
    source_url: string
    observed_link_count: number
  }>
}

// ---------------------------------------------------------------------------
// Domain normalization and bucket routing
// ---------------------------------------------------------------------------

function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase()
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      value = new URL(value).hostname
    } catch {
      // fall through to simple stripping
    }
  } else {
    value = value.replace(/^www\./, '')
  }
  value = value.replace(/^www\./, '')
  value = value.replace(/:\d+$/, '')
  value = value.replace(/\/$/, '')
  return value
}

function validateDomain(domain: string): string | null {
  if (!domain) return 'domain is required'
  if (domain.length > 256) return 'domain too long'
  if (!/^[a-z0-9\.\-_]+$/.test(domain)) return 'invalid domain characters'
  return null
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function domainKey(domain: string): string {
  return bytesToBase64Url(new TextEncoder().encode(domain))
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function domainBucket(domain: string): Promise<number> {
  const hex = await sha256Hex(domain)
  return (parseInt(hex.slice(0, 3), 16) >> 2) % BUCKET_COUNT
}

// ---------------------------------------------------------------------------
// R2-backed AsyncBuffer for hyparquet
// ---------------------------------------------------------------------------

interface AsyncBufferLike {
  byteLength: number
  slice(start: number, end?: number): Promise<ArrayBuffer> | ArrayBuffer
}

async function asyncBufferFromR2(bucket: R2Bucket, key: string): Promise<AsyncBufferLike> {
  const head = await bucket.head(key)
  if (!head) throw new Error(`not found: ${key}`)
  const size = Number(head.size)
  return {
    byteLength: size,
    slice(start: number, end?: number): Promise<ArrayBuffer> {
      const lastByte = end === undefined ? size - 1 : end - 1
      const headers = new Headers()
      headers.set('Range', `bytes=${start}-${lastByte}`)
      return bucket.get(key, { range: headers }).then(obj => {
        if (!obj || !('body' in obj)) throw new Error(`range read failed for ${key}`)
        return obj.arrayBuffer()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Streaming Parquet helpers
// ---------------------------------------------------------------------------

interface ColumnChunk {
  columnName: string
  columnData: ArrayLike<unknown>
  rowStart: number
  rowEnd: number
}

interface PendingChunk {
  rowStart: number
  rowEnd: number
  received: number
  columns: Record<string, ArrayLike<unknown>>
}

function newPendingChunk(rowStart: number, rowEnd: number): PendingChunk {
  return { rowStart, rowEnd, received: 0, columns: {} }
}

function chunkReady(entry: PendingChunk, expected: number): boolean {
  return entry.received === expected
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return 0
}

class TopHeap<T> {
  private heap: Array<{ score: number; item: T }> = []

  constructor(private size: number) {}

  push(score: number, item: T): void {
    const heap = this.heap
    if (heap.length < this.size) {
      heap.push({ score, item })
      this.bubbleUp(heap.length - 1)
      return
    }
    if (score <= heap[0].score) return
    heap[0] = { score, item }
    this.bubbleDown(0)
  }

  toSorted(): T[] {
    return [...this.heap]
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.item)
  }

  private bubbleUp(index: number): void {
    const heap = this.heap
    const node = heap[index]
    while (index > 0) {
      const parentIndex = (index - 1) >> 1
      const parent = heap[parentIndex]
      if (node.score >= parent.score) break
      heap[index] = parent
      index = parentIndex
    }
    heap[index] = node
  }

  private bubbleDown(index: number): void {
    const heap = this.heap
    const node = heap[index]
    const half = heap.length >> 1
    while (index < half) {
      let childIndex = (index << 1) + 1
      let child = heap[childIndex]
      const rightIndex = childIndex + 1
      if (rightIndex < heap.length && heap[rightIndex].score < child.score) {
        childIndex = rightIndex
        child = heap[rightIndex]
      }
      if (node.score <= child.score) break
      heap[index] = child
      index = childIndex
    }
    heap[index] = node
  }
}

interface ReadTopResult<T> {
  rows: T[]
  total: number
}

async function readTopRows<T>(
  file: AsyncBufferLike,
  columns: string[],
  domain: string,
  scoreColumn: string,
  limit: number,
  offset: number,
  build: (row: Row) => T,
): Promise<ReadTopResult<T>> {
  const readColumns = columns.includes('target_domain') ? columns : ['target_domain', ...columns]
  const keep = offset + limit
  const heap = new TopHeap<T>(Math.max(1, keep))
  let total = 0
  const pending = new Map<string, PendingChunk>()

  await parquetRead({
    file,
    compressors,
    columns: readColumns,
    onChunk(chunk: ColumnChunk) {
      const key = `${chunk.rowStart}-${chunk.rowEnd}`
      let entry = pending.get(key)
      if (!entry) {
        entry = newPendingChunk(chunk.rowStart, chunk.rowEnd)
        pending.set(key, entry)
      }
      entry.columns[chunk.columnName] = chunk.columnData
      entry.received++

      if (chunkReady(entry, readColumns.length)) {
        processRange(entry)
        pending.delete(key)
      }
    },
  })

  const sorted = heap.toSorted()
  return { rows: sorted.slice(offset, offset + limit), total }

  function processRange(entry: PendingChunk): void {
    const arrays = entry.columns
    const filterColumn = arrays['target_domain']
    const scoreArray = arrays[scoreColumn]
    const count = entry.rowEnd - entry.rowStart

    for (let i = 0; i < count; i++) {
      if (filterColumn[i] !== domain) continue
      total++

      const row: Row = {}
      for (const col of readColumns) {
        row[col] = arrays[col][i]
      }

      const item = build(row)
      const score = scoreArray ? toNumber(scoreArray[i]) : 0
      heap.push(score, item)
    }
  }
}

async function readFirstRow<T>(
  file: AsyncBufferLike,
  columns: string[],
  domain: string,
  build: (row: Row) => T,
): Promise<T | null> {
  const readColumns = columns.includes('target_domain') ? columns : ['target_domain', ...columns]
  let result: T | null = null
  const pending = new Map<string, PendingChunk>()

  await parquetRead({
    file,
    compressors,
    columns: readColumns,
    onChunk(chunk: ColumnChunk) {
      const key = `${chunk.rowStart}-${chunk.rowEnd}`
      let entry = pending.get(key)
      if (!entry) {
        entry = newPendingChunk(chunk.rowStart, chunk.rowEnd)
        pending.set(key, entry)
      }
      entry.columns[chunk.columnName] = chunk.columnData
      entry.received++

      if (chunkReady(entry, readColumns.length)) {
        processRange(entry)
        pending.delete(key)
      }
    },
  })

  return result

  function processRange(entry: PendingChunk): void {
    if (result) return
    const arrays = entry.columns
    const filterColumn = arrays['target_domain']
    const count = entry.rowEnd - entry.rowStart
    for (let i = 0; i < count; i++) {
      if (filterColumn[i] !== domain) continue
      const row: Row = {}
      for (const col of readColumns) {
        row[col] = arrays[col][i]
      }
      result = build(row)
      return
    }
  }
}

async function readTableSize(bucket: R2Bucket, table: string, bucketIndex: number): Promise<number> {
  const key = `${SERVING_PREFIX}/table=${table}/target_bucket=${String(bucketIndex).padStart(4, '0')}/part.parquet`
  const head = await bucket.head(key)
  return head ? Number(head.size) : 0
}

async function loadDomainJson(bucket: R2Bucket, domain: string): Promise<DomainJsonPayload | null> {
  const key = `${DOMAIN_JSON_PREFIX}/${domainKey(domain)}.json`
  try {
    const obj = await bucket.get(key)
    if (!obj || !('body' in obj)) return null
    const text = await obj.text()
    const data = JSON.parse(text) as DomainJsonPayload
    return data.format_version === 1 ? data : null
  } catch {
    return null
  }
}

async function readTopRowsObjects<T>(
  file: AsyncBufferLike,
  columns: string[],
  domain: string,
  scoreColumn: string,
  limit: number,
  offset: number,
  build: (row: Row) => T,
): Promise<ReadTopResult<T>> {
  const readColumns = columns.includes('target_domain') ? columns : ['target_domain', ...columns]
  const keep = offset + limit
  const heap = new TopHeap<T>(Math.max(1, keep))

  const rows = await parquetReadObjects({
    file,
    compressors,
    columns: readColumns,
    filter: { target_domain: { $eq: domain } },
    usePageIndex: true,
    useOffsetIndex: true,
    rowFormat: 'object',
  })

  const total = rows.length
  for (const row of rows) {
    const score = toNumber(row[scoreColumn])
    heap.push(score, build(row))
  }

  const sorted = heap.toSorted()
  return { rows: sorted.slice(offset, offset + limit), total }
}

async function readFilteredTable(
  bucket: R2Bucket,
  table: string,
  bucketIndex: number,
  domain: string,
): Promise<Row[]> {
  const key = `${SERVING_PREFIX}/table=${table}/target_bucket=${String(bucketIndex).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(bucket, key)
  const columns = TABLE_COLUMNS[table]
  const rows: Row[] = []
  const pending = new Map<string, PendingChunk>()

  await parquetRead({
    file,
    compressors,
    columns,
    onChunk(chunk: ColumnChunk) {
      const key = `${chunk.rowStart}-${chunk.rowEnd}`
      let entry = pending.get(key)
      if (!entry) {
        entry = newPendingChunk(chunk.rowStart, chunk.rowEnd)
        pending.set(key, entry)
      }
      entry.columns[chunk.columnName] = chunk.columnData
      entry.received++

      if (chunkReady(entry, columns.length)) {
        processRange(entry)
        pending.delete(key)
      }
    },
  })

  return rows

  function processRange(entry: PendingChunk): void {
    const arrays = entry.columns
    const filterColumn = arrays['target_domain']
    const count = entry.rowEnd - entry.rowStart
    for (let i = 0; i < count; i++) {
      if (filterColumn[i] !== domain) continue
      const row: Row = {}
      for (const col of columns) {
        row[col] = arrays[col][i]
      }
      rows.push(row)
    }
  }
}

function pickLimit(params: URLSearchParams): number {
  const raw = params.get('limit')
  const n = raw ? parseInt(raw, 10) : 20
  if (!Number.isFinite(n) || n < 1) return 20
  return Math.min(n, 100)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  })
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status)
}

// ---------------------------------------------------------------------------
// Domain Rating heuristic
// ---------------------------------------------------------------------------

function computeDomainRating(inboundLinks: number): number {
  const score = Math.log10(inboundLinks + 1) * 10
  return Math.min(100, Math.round(score * 10) / 10)
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleDomainRating(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      domain_rating: computeDomainRating(cached.summary.inbound_link_count),
      inbound_link_count: cached.summary.inbound_link_count,
      referring_domain_count: cached.summary.referring_domain_count,
      note: 'preliminary heuristic; real Domain Rating requires graph authority scoring',
    })
  }

  const bucket = await domainBucket(domain)
  const key = `${SERVING_PREFIX}/table=domain_summary/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, key)

  const row = await readFirstRow(file, TABLE_COLUMNS.domain_summary, domain, (r) => ({
    inbound_link_count: toNumber(r.inbound_link_count),
    referring_domain_count: toNumber(r.referring_domain_count),
  }))

  if (!row) {
    return jsonResponse({ domain, domain_rating: 0, inbound_link_count: 0, referring_domain_count: 0, note: 'domain not found' })
  }

  return jsonResponse({
    domain,
    domain_rating: computeDomainRating(row.inbound_link_count),
    inbound_link_count: row.inbound_link_count,
    referring_domain_count: row.referring_domain_count,
    note: 'preliminary heuristic; real Domain Rating requires graph authority scoring',
  })
}

async function handleBacklinks(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const limit = pickLimit(url.searchParams)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      total: cached.referring_domains.total,
      referring_domains: cached.referring_domains.items.slice(0, limit).map(r => ({
        source_domain: r.source_domain,
        inbound_link_count: r.inbound_link_count,
      })),
    })
  }

  const bucket = await domainBucket(domain)
  const key = `${SERVING_PREFIX}/table=referring_domains/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, key)

  const { rows, total } = await readTopRows(
    file,
    TABLE_COLUMNS.referring_domains,
    domain,
    'inbound_link_count',
    limit,
    0,
    r => ({
      source_domain: String(r.source_domain),
      inbound_link_count: toNumber(r.inbound_link_count),
    }),
  )

  return jsonResponse({
    domain,
    total,
    referring_domains: rows,
  })
}

async function handleAnchors(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const limit = pickLimit(url.searchParams)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      total: cached.anchors.total,
      anchors: cached.anchors.items.slice(0, limit).map(r => ({
        anchor: r.anchor,
        inbound_link_count: r.inbound_link_count,
      })),
    })
  }

  const bucket = await domainBucket(domain)
  const key = `${SERVING_PREFIX}/table=anchors/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, key)

  const { rows, total } = await readTopRowsObjects(
    file,
    TABLE_COLUMNS.anchors,
    domain,
    'inbound_link_count',
    limit,
    0,
    r => ({
      anchor: String(r.anchor),
      inbound_link_count: toNumber(r.inbound_link_count),
    }),
  )

  return jsonResponse({
    domain,
    total,
    anchors: rows,
  })
}

async function handleTopPages(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const limit = pickLimit(url.searchParams)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      total: cached.top_pages.total,
      top_pages: cached.top_pages.items.slice(0, limit).map(r => ({
        target_url: r.target_url,
        inbound_link_count: r.inbound_link_count,
        referring_domain_count: r.referring_domain_count,
      })),
    })
  }

  const bucket = await domainBucket(domain)
  const key = `${SERVING_PREFIX}/table=top_pages/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, key)

  const { rows, total } = await readTopRowsObjects(
    file,
    TABLE_COLUMNS.top_pages,
    domain,
    'inbound_link_count',
    limit,
    0,
    r => ({
      target_url: String(r.target_url),
      inbound_link_count: toNumber(r.inbound_link_count),
      referring_domain_count: toNumber(r.referring_domain_count),
    }),
  )

  return jsonResponse({
    domain,
    total,
    top_pages: rows,
  })
}

async function handleBroken(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const limit = pickLimit(url.searchParams)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      total: cached.broken_backlinks.total,
      note: 'candidates only; HTTP validation not performed',
      broken_backlink_candidates: cached.broken_backlinks.items.slice(0, limit).map(r => ({
        target_url: r.target_url,
        source_domain: r.source_domain,
        source_url: r.source_url,
        observed_link_count: r.observed_link_count,
      })),
    })
  }

  const bucket = await domainBucket(domain)
  const key = `${SERVING_PREFIX}/table=broken_backlink_candidates/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, key)

  const { rows, total } = await readTopRowsObjects(
    file,
    TABLE_COLUMNS.broken_backlink_candidates,
    domain,
    'observed_link_count',
    limit,
    0,
    r => ({
      target_url: String(r.target_url),
      source_domain: String(r.source_domain),
      source_url: String(r.source_url),
      observed_link_count: toNumber(r.observed_link_count),
    }),
  )

  return jsonResponse({
    domain,
    total,
    note: 'candidates only; HTTP validation not performed',
    broken_backlink_candidates: rows,
  })
}

async function handleSummary(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('domain') || ''
  const domain = normalizeDomain(raw)
  const err = validateDomain(domain)
  if (err) return errorResponse(err)

  const cached = await loadDomainJson(env.GROWTHSENT_BUCKET, domain)
  if (cached) {
    return jsonResponse({
      domain,
      found: true,
      domain_rating: computeDomainRating(cached.summary.inbound_link_count),
      inbound_link_count: cached.summary.inbound_link_count,
      referring_domain_count: cached.summary.referring_domain_count,
      note: 'preliminary heuristic; real Domain Rating requires graph authority scoring',
    })
  }

  const bucket = await domainBucket(domain)
  const summaryKey = `${SERVING_PREFIX}/table=domain_summary/target_bucket=${String(bucket).padStart(4, '0')}/part.parquet`
  const file = await asyncBufferFromR2(env.GROWTHSENT_BUCKET, summaryKey)

  const row = await readFirstRow(file, TABLE_COLUMNS.domain_summary, domain, r => ({
    inbound_link_count: toNumber(r.inbound_link_count),
    referring_domain_count: toNumber(r.referring_domain_count),
  }))

  if (!row) {
    return jsonResponse({ domain, found: false })
  }

  return jsonResponse({
    domain,
    found: true,
    domain_rating: computeDomainRating(row.inbound_link_count),
    inbound_link_count: row.inbound_link_count,
    referring_domain_count: row.referring_domain_count,
    note: 'preliminary heuristic; real Domain Rating requires graph authority scoring',
  })
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      })
    }

    if (request.method !== 'GET') {
      return errorResponse('method not allowed', 405)
    }

    if (env.API_TOKEN) {
      const auth = request.headers.get('Authorization') || ''
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== env.API_TOKEN) {
        return errorResponse('unauthorized', 401)
      }
    }

    const url = new URL(request.url)
    const cache = caches.default
    const cached = await cache.match(request)
    if (cached) return cached

    let response: Response
    try {
      switch (url.pathname) {
        case '/api/summary':
          response = await handleSummary(request, env, url)
          break
        case '/api/domain-rating':
          response = await handleDomainRating(request, env, url)
          break
        case '/api/backlinks':
          response = await handleBacklinks(request, env, url)
          break
        case '/api/anchors':
          response = await handleAnchors(request, env, url)
          break
        case '/api/top-pages':
          response = await handleTopPages(request, env, url)
          break
        case '/api/broken-backlinks':
          response = await handleBroken(request, env, url)
          break
        default:
          response = jsonResponse({
            ok: true,
            endpoints: [
              'GET /api/summary?domain=<domain>',
              'GET /api/domain-rating?domain=<domain>',
              'GET /api/backlinks?domain=<domain>&limit=20',
              'GET /api/anchors?domain=<domain>&limit=20',
              'GET /api/top-pages?domain=<domain>&limit=20',
              'GET /api/broken-backlinks?domain=<domain>&limit=20',
            ],
          })
      }
    } catch (error: any) {
      response = errorResponse(error.message || 'internal error', 500)
    }

    if (response.status === 200) {
      ctx.waitUntil(cache.put(request, response.clone()))
    }
    return response
  },
}
