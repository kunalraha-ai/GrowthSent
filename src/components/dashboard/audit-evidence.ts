/**
 * UI-only evidence boundary. A normal-looking row is not evidence that its
 * HTML or metadata was available to the audit. Keep this deliberately small
 * and shared so every audit surface treats failed fetches consistently.
 */
export function isSuccessfulAuditPage(page: any): boolean {
  return page?.statusCode === 200 && !page?.fetchFailureCategory && !page?.error;
}

export function isAuditResultEvaluable(scanResult: any): boolean {
  const pages: any[] = scanResult?.pages || [];
  const rootUrl = scanResult?.scan?.url;
  const rootPage = rootUrl ? pages.find((page) => page?.url === rootUrl) : pages[0];
  return isSuccessfulAuditPage(rootPage);
}
