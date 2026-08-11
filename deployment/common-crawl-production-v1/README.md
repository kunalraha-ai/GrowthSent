# GrowthSent Common Crawl production-v1 bundle

This bundle contains only the proven WAT-to-Pages/Links-Parquet ingestion
implementation, its locked CC-MAIN-2026-30 first-1,000 input manifest, the
small manifest materializer, and the exact Python runtime dependencies.

It contains no AWS credential, database code, dictionary optimizer, WAT data,
or application deployment code. `BUNDLE-MANIFEST.json` records SHA-256 and
byte size for every bundled file.

Before invoking the ingestion command, materialize the locked list:

```bash
/opt/growthsent/venv/bin/python tools/common_crawl_v1_manifest.py \
  --manifest manifests/cc-main-2026-30-first-1000.json \
  --count 1000 \
  --output manifests/cc-main-2026-30-first-1000.paths
```

The materializer verifies the full list hash:

```text
6ce2c0c06612de9d8816d6075a25b15929209504f346305dae8ee9ced03b3b7a
```

For the controlled smoke test, materialize `--count 1`. Its SHA-256 is
`a129b99c34135f0dd380a3ac3c29fc331ee4f996c9d2765bfe8bd328706cea8e` and
its deterministic Pages, Links, and metrics part suffix is `a129b99c34135f0d`.
The later locked 1,000-file command recognizes this one-file manifest only as
an ordered-prefix promotion and resumes the published triplet.
