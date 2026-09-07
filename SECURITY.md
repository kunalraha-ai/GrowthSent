# Security policy

## Supported version

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Earlier commits and forks | No |

## Reporting a vulnerability

Do not report vulnerabilities through public GitHub issues, pull requests, or
discussions.

Use GitHub's private vulnerability-reporting feature from the repository's
**Security** tab when it is enabled. If private reporting is unavailable,
contact a repository maintainer privately through the repository owner or
organization profile. Include:

- A clear description of the issue and its impact.
- A minimal, non-destructive reproduction or proof of concept.
- Affected files, endpoints, or deployment components.
- Any suggested mitigation, if you have one.

Do not include production credentials, private user data, or destructive
payloads in the report.

## Scope

Security reports are especially welcome for authentication and session handling,
authorization, SSRF and crawler protections, API input validation, cloud
credential handling, R2/GCS isolation, and dependency vulnerabilities.

We will assess reports privately, coordinate remediation where appropriate, and
credit reporters only with their permission. There is no bug-bounty program or
guaranteed response-time agreement at this time.
