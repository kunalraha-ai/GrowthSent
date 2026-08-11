# Common Crawl provider

GrowthSent can use Common Crawl as an archive-backed crawl provider for cold, on-demand analysis. It is selected server-side with:

```text
CRAWL_DATA_PROVIDER=common-crawl
```

The default is `live`. The HTTP API does not accept a provider parameter, so tenants cannot select the archive provider or increase archive workload. The selected value is persisted on each queued `scan` or `crawlJobs` document; changing the environment only affects jobs created after the change.

Archive work is admitted only inside the claimed durable worker. The initial policy allows two Common Crawl retrievals globally across worker processes and one active retrieval per authenticated tenant or anonymous trusted-ingress IP. The stored requester key is an HMAC derived from `SESSION_SECRET`, not a raw user ID or IP, and is never serialized in API responses. On Vercel the ingress adapter uses the platform-provided `x-vercel-forwarded-for`; outside Vercel it deliberately ignores browser-supplied forwarding headers and uses the immediate peer address, which is conservative until a self-hosted trusted-proxy integration is added. When capacity is occupied, the job returns to `queued` with a short delay without consuming a crawl retry. This policy requires the deployment's existing `SESSION_SECRET`; if it is absent or invalid, Common Crawl job creation fails closed while live crawling remains unaffected.

## Execution and persistence

Routes continue to enqueue work only. `processDurableCrawlWork()` claims the existing scan/audit lease, selects the persisted provider, runs Common Crawl outside the Vercel request lifecycle, then uses the existing SEO analysis and fenced MongoDB transaction to publish `scans`, `pages`, issues, and snapshots. The provider itself never writes to MongoDB.

Archive pages use the existing page representation and carry optional provenance:

- Common Crawl collection ID
- WARC filename, offset, and length
- validated CDX timestamp and WARC capture timestamp

Completed scans retain redacted measurements for index latency, indexed records, S3/range requests, compressed/decompressed bytes, parsing time, Mongo persistence time, total job duration, failures, and retries. No raw response body, provider headers, target URL, or remote error is logged as instrumentation.

## Bounded retrieval

The provider discovers the latest valid collection from `https://index.commoncrawl.org/collinfo.json`, reconstructs the trusted index endpoint, then requests a bounded CDX JSON response scoped to the exact host or URL. It post-filters every result to the requested host.

Only strictly validated WARC `filename`, `offset`, and `length` fields are used. The provider creates a fixed `https://data.commoncrawl.org/` URL and requests exactly that byte range. It rejects redirects, non-206 range responses, content-range mismatches, unsafe hostnames, invalid filenames, corrupt gzip/WARC data, non-HTML payloads, unsupported encodings, oversize bodies, and malformed records.

Hard caps keep the first implementation intentionally conservative: ten pages, two concurrent range requests, 1 MiB compressed per range, 8 MiB compressed per job (including retry/error range bodies), 2.25 MiB decompressed per record, 12 MiB decompressed per job, a 2 MiB HTML page limit, and a 90-second provider deadline. The deadline bounds target validation, DNS, HTTP, retry sleep, decompression, and normalization checkpoints. Only transient DNS/network/timeout/429/5xx faults retry; malformed or corrupt archive data is terminal.

Historical captures do not represent current `robots.txt`, sitemaps, or live origin latency. The existing SEO engine therefore suppresses those source-incompatible checks for Common Crawl results instead of fabricating findings from archive transport behavior.

## Benchmark

The benchmark is read-only and never imports MongoDB services:

```bash
pnpm benchmark:common-crawl -- --url https://example.com/ --allow-network
```

It requires explicit network opt-in (`--allow-network` or `COMMON_CRAWL_BENCHMARK_ALLOW_NETWORK=1`) and prints a redacted JSON result with an `under-3-seconds`, `3-to-30-seconds`, `30-seconds-to-3-minutes`, or `over-3-minutes` duration band.

## Deliberate limitation: backlinks

This implementation queries the URL index and range-fetches WARC response records for pages on the requested host. It can observe outbound links from those selected pages, but it **does not discover inbound backlinks**. Reverse-link discovery requires a transposed web-graph/reverse-link index or global processing pipeline (for example, a separately designed Common Crawl Web Graph or Athena/global-index workflow). WAT/WET pointers are not inferred from WARC pointers and are out of scope for this on-demand provider.
