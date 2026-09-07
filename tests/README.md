# Test guide

Tests are grouped by runtime rather than by a single framework. Run the
smallest relevant set while developing, then use the application checks before
reviewing UI or API changes.

## Web application checks

Run from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs the TypeScript test suite through `tests/run-all.mjs`.

## Python pipeline checks

Python tests are invoked directly so a data-pipeline contributor can run only
the affected contract test. Examples:

```bash
python tests/common_crawl_link_index_materialize.test.py
python tests/common_crawl_cloudflare_r2_standard1_hundred_thousand_self_recovery.test.py
python tests/common_crawl_wat_ingest.test.py
```

Use Python 3.12 or later and install the repository's Common Crawl
requirements before running a test that imports optional pipeline packages.

## Test naming and placement

- Application tests use `*.test.ts` and live directly in this directory.
- Pipeline tests use `*.test.py` and follow the module or deployment contract
  they cover.
- Add a regression test for every production failure mode before changing a
  deployment launcher or data writer.
- Tests must not require production credentials, mutate cloud output, or use
  a real campaign prefix.

## Before review

At minimum, run the focused tests for the changed code and:

```bash
git diff --check
```

For a UI/API change, also run the web application checks. For a cloud data
change, run the focused Python test plus any package-level build or shell
syntax check described by the owning deployment README.
