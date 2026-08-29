import { createHash } from "node:crypto";
import { SignJWT } from "jose";

const input = JSON.parse(await new Response(process.stdin).text());
const required = ["endpoint", "accountId", "parentAccessKeyId", "parentSecretAccessKey", "bucket", "prefix", "ttlSeconds"];
for (const name of required) {
  if (!input[name]) throw new Error(`missing ${name}`);
}

const claims = { bucket: input.bucket, scope: input.scope ?? "object-read-write" };
if (Array.isArray(input.actions) && input.actions.length > 0) {
  claims.actions = input.actions;
}
if (input.paths !== false) {
  claims.paths = {
    prefixPaths: input.prefixPaths ?? [input.prefix],
    objectPaths: input.objectPaths ?? [],
  };
}

const jwt = await new SignJWT(claims)
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject(input.accountId)
  .setIssuer(input.parentAccessKeyId)
  .setAudience(new URL(input.endpoint).host)
  .setIssuedAt()
  .setExpirationTime(`${input.ttlSeconds}s`)
  .sign(new TextEncoder().encode(input.parentSecretAccessKey));

const sessionPayload = `jwt/${jwt}`;
const sessionToken = input.sessionEncoding === "base64url"
  ? Buffer.from(sessionPayload, "utf8").toString("base64url")
  : input.sessionEncoding === "base64-no-padding"
    ? Buffer.from(sessionPayload, "utf8").toString("base64").replace(/=+$/, "")
    : Buffer.from(sessionPayload, "utf8").toString("base64");

process.stdout.write(JSON.stringify({
  accessKeyId: input.parentAccessKeyId,
  secretAccessKey: createHash("sha256").update(jwt).digest("hex"),
  sessionToken,
}));
