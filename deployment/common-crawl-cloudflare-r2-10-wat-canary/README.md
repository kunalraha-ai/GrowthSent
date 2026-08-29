# Cloudflare Container 10-WAT canary

This is an isolated, temporary ten-WAT Cloudflare Container canary. It uses
public Common Crawl HTTPS, exactly one `standard-4` instance, one source
stream at a time, a 110-minute hard timeout, and a fresh R2 canary prefix.

The original 10K Pages/Links artifacts are absent from R2, so this canary
does not claim golden-artifact equivalence. Before a new run, build and publish
the explicitly labelled public-source semantic v2 baseline:

1. `tools/build_common_crawl_public_baseline_v2.py` reconstructs exactly the
   locked ten WATs locally and removes its ephemeral Pages/Links outputs.
2. `publish-public-baseline-v2-wsl.sh` conditionally publishes only the
   baseline manifest and a completion marker, last, to
   `production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/`.
3. `provision-and-start-wsl.sh` packages that v2 manifest and refuses older
   digest contracts before a Worker can be deployed.

The v2 contract is a single versioned, order-independent semantic comparison:
canonicalized records are individually SHA-256 hashed, those row hashes are
sorted per dataset, and the Pages/Links and target-host-bucket digests are
checked exactly. The runner never tries alternate historical digest formulas.

Run only the Ubuntu/WSL scripts. The PowerShell v1 preflight and launcher are
deliberately retired and fail before any cloud action. WSL prompts for a
short-lived parent Cloudflare API token without echoing it; it is used only to
mint a narrowly scoped temporary R2 child credential. Neither token is written
to the bundle, Worker, logs, or command arguments.

After a canary reaches a terminal state,
`verify-canary-wsl.sh --canary-id <id>` performs a read-only R2 integrity and
reference-baseline verification. It confirms the live R2 baseline hash matches
the local reviewed copy, then checks exact keys, SHA metadata, full JSON
hashes, semantic results, and completion-marker-last ordering.
