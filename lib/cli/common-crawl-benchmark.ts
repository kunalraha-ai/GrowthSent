import { CommonCrawlProvider, CommonCrawlProviderError } from "../crawler/providers/common-crawl.js";

interface BenchmarkArguments {
  url?: string;
  allowNetwork: boolean;
  maxPages?: number;
}

function parseArguments(argv: string[]): BenchmarkArguments {
  const parsed: BenchmarkArguments = { allowNetwork: process.env.COMMON_CRAWL_BENCHMARK_ALLOW_NETWORK === "1" };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    // pnpm forwards its conventional script separator to this command on
    // Windows, so accept it without treating it as an input option.
    if (argument === "--") continue;
    if (argument === "--allow-network") {
      parsed.allowNetwork = true;
      continue;
    }
    if (argument === "--url") {
      parsed.url = argv[++index];
      continue;
    }
    if (argument === "--max-pages") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("--max-pages must be an integer from 1 to 10.");
      parsed.maxPages = value;
      continue;
    }
    throw new Error("Unknown benchmark argument.");
  }
  return parsed;
}

function safeHostname(input: string | undefined): string {
  if (!input) return "invalid";
  try {
    const formatted = input.includes("://") ? input : `https://${input}`;
    return new URL(formatted).hostname.toLowerCase() || "invalid";
  } catch {
    return "invalid";
  }
}

function durationBand(milliseconds: number): string {
  if (milliseconds < 3_000) return "under-3-seconds";
  if (milliseconds < 30_000) return "3-to-30-seconds";
  if (milliseconds < 180_000) return "30-seconds-to-3-minutes";
  return "over-3-minutes";
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args.url) throw new Error("A target is required: --url https://example.com/");
  if (!args.allowNetwork) {
    throw new Error("Network access is disabled. Pass --allow-network or set COMMON_CRAWL_BENCHMARK_ALLOW_NETWORK=1.");
  }

  const provider = new CommonCrawlProvider();
  const startedAt = Date.now();
  try {
    const result = await provider.crawl(args.url, { maxPages: args.maxPages });
    const totalDurationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        provider: "common-crawl",
        targetHost: safeHostname(args.url),
        durationBand: durationBand(totalDurationMs),
        totalDurationMs,
        pagesNormalized: result.pages.length,
        metrics: result.commonCrawlMetrics,
      })
    );
  } catch (error) {
    const totalDurationMs = Date.now() - startedAt;
    const commonCrawlError = error instanceof CommonCrawlProviderError ? error : undefined;
    console.log(
      JSON.stringify({
        provider: "common-crawl",
        targetHost: safeHostname(args.url),
        durationBand: durationBand(totalDurationMs),
        totalDurationMs,
        status: "failed",
        errorCode: commonCrawlError?.code || "BENCHMARK_INPUT_ERROR",
        retryable: commonCrawlError?.retryable || false,
        metrics: commonCrawlError?.metrics,
      })
    );
    process.exitCode = 1;
  }
}

main().catch(() => {
  // Keep CLI failures redacted: do not echo input URLs or transport details.
  console.error("Common Crawl benchmark could not start safely.");
  process.exitCode = 2;
});
