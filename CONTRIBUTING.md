# Contributing to GrowthSent

Thanks for helping improve GrowthSent. Contributions can include code, tests,
documentation, design feedback, reproducible bug reports, and product ideas.
The goal is simple: make each change understandable, safe, and useful to the
people who rely on GrowthSent's SEO evidence and link data.

## Before you begin

1. Read the [repository guide](docs/repository-guide.md) to find the right
   subsystem.
2. Review open issues and pull requests before beginning substantial work.
3. Read the [Code of Conduct](CODE_OF_CONDUCT.md) and
   [Security policy](SECURITY.md).
4. For a feature, design change, data-pipeline change, or behaviour that could
   surprise users, open an issue or discussion first. This avoids duplicate
   effort and lets maintainers agree on scope before implementation.
5. Be respectful, specific, and constructive in issues, reviews, and commits.
   Assume good intent and focus feedback on the work, not the person.

Small typo fixes and narrowly scoped documentation corrections can be sent
directly as pull requests.

## Ways to contribute

- Report a reproducible bug, including expected and actual behaviour.
- Propose a feature with its user problem, constraints, and success criteria.
- Improve documentation, accessibility, tests, examples, or developer tooling.
- Fix a labelled issue after confirming that nobody is already working on it.

When filing an issue, do not include credentials, private customer data,
session cookies, production URLs that should remain confidential, or raw cloud
logs containing sensitive identifiers.

## Local setup

### Prerequisites

- Node.js 20.19 or later
- pnpm 11.18 or later
- Python 3.12 or later for Common Crawl and link-index tooling

### Get running

Fork the repository, then clone your fork and create a focused branch:

```bash
git clone <your-fork-url>
cd GrowthSent
git switch -c feat/short-description
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Use `.env` only for local development. Never commit it or any credential.
The dashboard is served by Vite; the serverless API entrypoints live under
`api/` and use the project configuration described in
[docs/deployment.md](docs/deployment.md).

## Choose the correct place for a change

| Change | Location |
| --- | --- |
| Dashboard UI, navigation, and visual state | `src/` and `src/components/dashboard/` |
| API request handling, authentication, or authorization | `api/` and the matching `lib/` module |
| Audit crawling and evidence-based SEO rules | `lib/crawler/`, `lib/audits/`, `lib/seo/` |
| GSC and analytics behaviour | `lib/integrations/`, `lib/analytics/` |
| Link-index data contracts and transforms | `tools/common_crawl_link_index_*.py` plus focused Python tests |
| Cloud launcher or deployment contract | the owning package in `deployment/` |
| Long-lived instructions | `docs/` or the owning package README |

Do not move historical manifests, completion markers, or deployment packages
as part of cosmetic cleanup. They are evidence for previous campaign results.

## Coding and documentation standards

- Keep pull requests focused on one user-visible outcome or one engineering
  concern.
- Follow the surrounding TypeScript, Python, and Tailwind conventions rather
  than introducing a competing style.
- Prefer clear names, small functions, explicit error handling, and comments
  that explain non-obvious constraints rather than restating code.
- Update tests when behaviour changes; a regression test is required for a
  production failure mode.
- Update durable docs when an API contract, environment requirement, operator
  workflow, or repository boundary changes.
- Never present mock data as verified audit, GSC, or backlink data.
- Preserve keyboard access, labels, contrast, and responsive behaviour in UI
  changes.

## Required checks

Run the smallest relevant checks while developing. Before requesting review of
a web application change, run:

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

For Python pipeline work, run the matching focused test as well. For example:

```bash
python tests/common_crawl_link_index_materialize.test.py
```

See [tests/README.md](tests/README.md) for test conventions and more examples.
If a check cannot run locally, say why in the pull request and include the
closest validation you did run.

## Data-pipeline safety

The Common Crawl corpus and link-index pipeline use immutable output contracts.
Contributors must follow these rules:

- Do not run a cloud launcher, deploy a Worker, submit a Batch job, or mutate
  R2/GCS data as part of an ordinary pull request.
- Do not alter locked source manifests, completion markers, verified output,
  or recovery contracts to make a test pass.
- Use reviewed scripts inside the relevant `deployment/` package for any
  maintainer-approved cloud operation. Do not turn a `tools/` module into an
  improvised production command.
- Keep parent tokens, child credentials, service-account keys, and secrets out
  of source, shell history, command arguments, logs, bundles, and commits.
- Use fresh prefixes and immutable write preconditions for approved cloud work.

## Commit and pull request process

1. Sync your branch with the target branch before opening a pull request.
2. Use a concise, imperative commit subject, such as `Fix collapsed sidebar
   alignment` or `Document materialization probe verification`.
3. Open one pull request per cohesive change. Avoid drive-by formatting,
   generated artifacts, lockfile churn unrelated to the change, and bundled
   refactors.
4. Link the relevant issue with `Fixes #123` when applicable.
5. Complete the pull-request description using this checklist:

   - What changed and why?
   - What user, API, data-contract, or operational behaviour is affected?
   - Which tests and checks did you run?
   - Are there any follow-up tasks, migration steps, or known limitations?
   - For UI changes, include before/after screenshots or a short recording.

Maintainers may request changes, split a broad pull request, or close a change
whose maintenance cost outweighs its benefit. A review request is a discussion,
not a promise of merge timing.

## Reporting security issues

Do not open a public issue for a suspected vulnerability, credential exposure,
or data-isolation failure. Use GitHub's private security advisory flow when it
is available for the repository; otherwise contact a repository maintainer
privately through the repository owner or organization profile. Include a
minimal reproduction and avoid publishing exploit details until a fix is
available.

## License notice

GrowthSent is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution for inclusion, you agree to license that contribution under the
same terms unless you explicitly state otherwise. Do not submit code, content,
or assets that you do not have the right to contribute.
