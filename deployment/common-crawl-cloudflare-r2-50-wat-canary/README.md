# 50-WAT Cloudflare canary

This package preserves the five-shard, 50-WAT Cloudflare canary and its
baseline, verification, repair, and Worker-retirement helpers. It is retained
as historical validation evidence for the `CC-MAIN-2026-30` corpus.

It is not the default launch path for the completed 100K source corpus or for
the active link-index work. For current work, use the
[GCP link-index package](../common-crawl-gcp-link-index-v1/README.md).

The scripts here require an explicitly approved, newly scoped canary run and
fresh output prefixes. Do not point them at existing completed campaign output.
