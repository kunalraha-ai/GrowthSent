import { describe, expect, it } from "vitest";
import { domainBucket, normalizeDomain } from "../src/domain.js";

describe("domain normalization", () => {
  it("extracts registrable domain from URLs with subdomains", () => {
    expect(normalizeDomain("https://www.google.com/search?q=test")).toBe("google.com");
  });

  it("handles bare domains", () => {
    expect(normalizeDomain("google.com")).toBe("google.com");
  });

  it("lower-cases mixed input", () => {
    expect(normalizeDomain("Cloudflare.COM")).toBe("cloudflare.com");
  });

  it("returns null for invalid input", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });
});

describe("domain bucket", () => {
  it("maps google.ml to bucket 0", async () => {
    expect(await domainBucket("google.ml")).toBe(0);
  });

  it("returns values in 0..1023", async () => {
    for (const domain of ["cloudflare.com", "github.com", "example.co.uk", "localhost.local"]) {
      const bucket = await domainBucket(domain);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(1024);
    }
  });
});
