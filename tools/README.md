# Data-pipeline tools

`tools/` contains reusable Python modules. They implement contracts and data
transforms; they are not the normal operator interface. For cloud work, start
with the reviewed scripts in `deployment/` so that preflight, secret handling,
immutable-prefix checks, and verification gates are preserved.

## Active link-index v1 modules

| Module | Responsibility |
| --- | --- |
| `common_crawl_link_index_catalog_v1.py` | Builds the exact 100K source-to-link-artifact catalog. |
| `verify_common_crawl_link_index_catalog_v1.py` | Verifies the catalog's source identity and artifact contract. |
| `common_crawl_link_index_materialize_v1.py` | Writes target-domain bucketed materialization output. |
| `common_crawl_link_index_compact_v1.py` | Compacts verified materialized buckets for serving. |
| `common_crawl_gcp_secret_runtime.py` | Retrieves the runtime read-only R2 credential from Secret Manager. |
| `common_crawl_r2_store.py` | Shared R2 and object-contract helpers. |

## Shared Common Crawl contracts

| Module family | Responsibility |
| --- | --- |
| `common_crawl_http_source.py` | Fetches and validates public Common Crawl source data. |
| `common_crawl_semantic_contract_v2.py` | Defines semantic output checks used by v2 processing. |
| `common_crawl_v*_manifest.py` | Reads and validates locked source manifests. |

## Historical modules

Modules with `v1`, `v2`, `gcp_r2_25k`, `benchmark`, `regional_ramp`, or
`backlink_derive` in their names support earlier campaigns, capacity studies,
or legacy derivation paths. Keep them testable and traceable, but do not choose
one as an operational entrypoint without first checking
[deployment/README.md](../deployment/README.md).

## Adding or changing a tool

1. Add a focused Python test in `tests/` using the matching filename prefix.
2. Keep data contracts explicit: validate inputs, use deterministic keys, and
   fail before writing when an invariant is violated.
3. If the change affects an operator workflow, update the owning deployment
   README and its WSL/PowerShell script—not just the module docstring.
4. Run the focused test, syntax-check the changed module, and run
   `git diff --check` before review.
