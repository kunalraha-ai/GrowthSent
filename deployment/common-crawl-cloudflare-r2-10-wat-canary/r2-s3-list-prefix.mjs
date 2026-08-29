import { AwsClient } from "aws4fetch";

const input = JSON.parse(await new Response(process.stdin).text());
const required = ["endpoint", "bucket", "prefix", "accessKeyId", "secretAccessKey"];
for (const name of required) {
  if (!input[name]) throw new Error(`missing ${name}`);
}

const query = new URLSearchParams({ "list-type": "2", prefix: input.prefix, "max-keys": String(input.maxKeys ?? 1000) });
const url = `${input.endpoint}/${encodeURIComponent(input.bucket)}?${query}`;
const client = new AwsClient({
  accessKeyId: input.accessKeyId,
  secretAccessKey: input.secretAccessKey,
  ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
  service: "s3",
});
const response = await client.fetch(url, { method: "GET" });
const body = await response.text();
if (!response.ok) {
  const field = (name) => new RegExp(`<${name}>([^<]{1,256})</${name}>`).exec(body)?.[1] ?? null;
  process.stdout.write(JSON.stringify({ operation: "ListObjectsV2", http_status: response.status, r2_error_code: field("Code"), r2_error_message: field("Message") }));
} else {
  const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1]);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
  process.stdout.write(JSON.stringify({ operation: "ListObjectsV2", http_status: response.status, prefix: input.prefix, keys, truncated }));
}
