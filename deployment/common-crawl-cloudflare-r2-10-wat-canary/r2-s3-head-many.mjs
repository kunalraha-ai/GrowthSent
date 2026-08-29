import { AwsClient } from "aws4fetch";

const input = JSON.parse(await new Response(process.stdin).text());
const required = ["endpoint", "bucket", "keys", "accessKeyId", "secretAccessKey"];
for (const name of required) {
  if (!input[name]) throw new Error(`missing ${name}`);
}
if (!Array.isArray(input.keys) || input.keys.length > 100) throw new Error("keys must contain at most 100 values");

const client = new AwsClient({
  accessKeyId: input.accessKeyId,
  secretAccessKey: input.secretAccessKey,
  service: "s3",
});
const objects = [];
for (const key of input.keys) {
  if (typeof key !== "string" || !key) throw new Error("invalid object key");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const response = await client.fetch(`${input.endpoint}/${encodeURIComponent(input.bucket)}/${encodedKey}`, { method: "HEAD" });
  objects.push({
    key,
    http_status: response.status,
    content_length: Number(response.headers.get("content-length")),
    growthsent_sha256: response.headers.get("x-amz-meta-growthsent-sha256"),
  });
}
process.stdout.write(JSON.stringify({ operation: "HeadObject", objects }));
