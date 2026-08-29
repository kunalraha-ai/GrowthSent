import type { RootPageEvaluation } from "../crawler/crawler.js";

export type AuditTargetErrorCode =
  | "AUDIT_URL_INVALID"
  | "AUDIT_URL_UNSUPPORTED"
  | "AUDIT_TARGET_RESTRICTED"
  | "AUDIT_HOST_UNRESOLVABLE";

export class AuditTargetValidationError extends Error {
  constructor(
    readonly code: AuditTargetErrorCode,
    message: string,
    readonly statusCode: 400 | 422
  ) {
    super(message);
    this.name = "AuditTargetValidationError";
  }
}

/**
 * Maps SSRF validator outcomes to safe, actionable API errors. The raw
 * validation text is intentionally never exposed because it can include
 * implementation details about the crawler's network policy.
 */
export function auditTargetValidationError(reason: string | undefined): AuditTargetValidationError {
  switch (reason) {
    case "Only HTTP and HTTPS URLs are allowed.":
    case "Only standard HTTP and HTTPS ports are allowed.":
    case "URLs containing credentials are not allowed.":
      return new AuditTargetValidationError(
        "AUDIT_URL_UNSUPPORTED",
        "Use a public HTTP or HTTPS website URL without credentials or a custom port.",
        400
      );
    case "Access to local or internal hostnames is prohibited.":
    case "Access to private or reserved IP addresses is prohibited.":
    case "Host resolves to a restricted address.":
    case "Host resolved to an unsupported address family.":
      return new AuditTargetValidationError(
        "AUDIT_TARGET_RESTRICTED",
        "This address points to a local, private, or restricted network and cannot be audited.",
        400
      );
    case "Unable to resolve host safely.":
      return new AuditTargetValidationError(
        "AUDIT_HOST_UNRESOLVABLE",
        "We could not resolve this website safely from our crawler. Check the hostname and try again shortly.",
        422
      );
    default:
      return new AuditTargetValidationError(
        "AUDIT_URL_INVALID",
        "Enter a valid public website URL, such as https://example.com.",
        400
      );
  }
}

export type PublicAuditFailureCode =
  | "AUDIT_TARGET_RESTRICTED"
  | "AUDIT_REDIRECT_INVALID"
  | "AUDIT_RESPONSE_UNREADABLE"
  | "AUDIT_RESPONSE_TOO_LARGE"
  | "AUDIT_TIMED_OUT"
  | "AUDIT_CONNECTION_FAILED"
  | "AUDIT_REDIRECT_LIMIT"
  | "AUDIT_ROOT_UNAVAILABLE"
  | "AUDIT_ROOT_NOT_HTML"
  | "AUDIT_ROOT_HTTP_ERROR"
  | "AUDIT_FAILED";

export interface PublicAuditFailure {
  code: PublicAuditFailureCode;
  message: string;
}

/**
 * Stored crawl failure categories are controlled enumerations, but old rows
 * and future worker versions are treated as untrusted and use the fallback.
 */
export function publicAuditFailure(failureCategory: unknown): PublicAuditFailure {
  switch (failureCategory as NonNullable<RootPageEvaluation["failureCategory"]>) {
    case "blocked_by_safety_policy":
      return {
        code: "AUDIT_TARGET_RESTRICTED",
        message: "This website redirected to a local, private, or restricted address and cannot be audited.",
      };
    case "invalid_redirect":
      return {
        code: "AUDIT_REDIRECT_INVALID",
        message: "The website returned a redirect that could not be followed safely. Try its final public HTTPS URL.",
      };
    case "response_body_unavailable":
      return {
        code: "AUDIT_RESPONSE_UNREADABLE",
        message: "The website did not provide a readable page body for the audit.",
      };
    case "response_size_limit":
      return {
        code: "AUDIT_RESPONSE_TOO_LARGE",
        message: "The homepage is too large to audit safely.",
      };
    case "timeout":
      return {
        code: "AUDIT_TIMED_OUT",
        message: "The website took too long to respond. Try again shortly.",
      };
    case "network":
      return {
        code: "AUDIT_CONNECTION_FAILED",
        message: "We could not connect to this website. Check that it is publicly reachable and try again.",
      };
    case "redirect_limit":
      return {
        code: "AUDIT_REDIRECT_LIMIT",
        message: "The website redirected too many times to complete the audit. Try its final public HTTPS URL.",
      };
    case "missing_root_result":
      return {
        code: "AUDIT_ROOT_UNAVAILABLE",
        message: "We could not retrieve the requested homepage for the audit.",
      };
    case "non_html_response":
      return {
        code: "AUDIT_ROOT_NOT_HTML",
        message: "This URL does not return an HTML webpage. Try the public website homepage.",
      };
    case "unexpected_http_status":
      return {
        code: "AUDIT_ROOT_HTTP_ERROR",
        message: "The homepage did not return a successful HTML response. Check that it is public and accessible to crawlers.",
      };
    default:
      return {
        code: "AUDIT_FAILED",
        message: "The audit could not be completed. Please try again later.",
      };
  }
}
