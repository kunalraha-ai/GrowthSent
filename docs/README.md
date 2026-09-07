# Documentation guide

This directory contains the human-facing documentation for GrowthSent. Start
with the document that matches the work you are doing rather than reading
historical runbooks in chronological order.

## Start here

| If you need to… | Read… |
| --- | --- |
| Understand the repository and find the owning code | [Repository guide](repository-guide.md) |
| See what is complete, in progress, and not yet product-serving | [Project status](project-status.md) |
| Understand the application and data boundaries | [Architecture](architecture.md) |
| Work on a feature or prepare a pull request | [Contributing](../CONTRIBUTING.md) |
| Deploy the web application | [Application deployment](deployment.md) |
| Run the active link-index pipeline | [GCP link-index deployment guide](../deployment/common-crawl-gcp-link-index-v1/README.md) |
| Find a deployment package and determine whether it is historical | [Deployment guide](../deployment/README.md) |
| Understand API behaviour | [API guide](api.md) |
| Review security expectations | [Security guide](security.md) |

## Product documentation

- [Analytics and Search Intelligence](analytics.md)
- [Crawler behaviour](crawler.md)
- [SEO rules](seo-rules.md)
- [External MVP release checklist](external-mvp-release.md)

## Common Crawl history and evidence

The documents below are retained as historical technical evidence. They are
useful when tracing a contract or artifact, but they are not the default
operating instructions for the current GCP link-index pipeline.

- [Common Crawl overview](common-crawl.md)
- [WAT ingestion](common-crawl-wat-ingestion.md)
- [Production v1](common-crawl-production-v1.md)
- [Production v2](common-crawl-production-v2.md)
- [Production v2 10K run](common-crawl-production-v2-10k.md)
- [Terra Ultra review](terra-ultra-review.md)

## Session handoff material

The root-level [`context.md`](../context.md) is a detailed operational handoff
for AI-assisted work. It records decisions, command history, and transient
run context. It is not the canonical product or operator manual; update the
documents in this directory when a durable process changes.
