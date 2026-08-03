import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const secret = process.env.GOOGLE_CLIENT_SECRET || "";
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const loginRedirect = process.env.GOOGLE_LOGIN_REDIRECT_URI || "";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      GOOGLE_CLIENT_ID: clientId ? `${clientId.slice(0, 12)}...${clientId.slice(-8)}` : "(empty)",
      GOOGLE_CLIENT_SECRET_length: secret.length,
      GOOGLE_CLIENT_SECRET_prefix: secret.slice(0, 7),
      GOOGLE_CLIENT_SECRET_suffix: secret.slice(-4),
      GOOGLE_CLIENT_SECRET_has_whitespace: secret !== secret.trim(),
      GOOGLE_LOGIN_REDIRECT_URI: loginRedirect || "(not set, using default)",
      NEXT_PUBLIC_APP_URL: appUrl || "(not set)",
      computed_redirect: loginRedirect || `${(appUrl || "http://localhost:8443").replace(/\/$/, "")}/api/v1/auth/google/callback`,
    })
  );
}
