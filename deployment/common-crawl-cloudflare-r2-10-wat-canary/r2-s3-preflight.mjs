import { AwsClient } from "aws4fetch";

const input = JSON.parse(await new Response(process.stdin).text());
const required = ["endpoint", "bucket", "key", "accessKeyId", "secretAccessKey"];
for (const name of required) {
  if (!input[name]) throw new Error(`missing ${name}`);
}

const encodedKey = input.key.split("/").map(encodeURIComponent).join("/");
const url = `${input.endpoint}/${encodeURIComponent(input.bucket)}/${encodedKey}`;
const client = new AwsClient({
  accessKeyId: input.accessKeyId,
  secretAccessKey: input.secretAccessKey,
  ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
  service: "s3",
});
const response = await client.fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
const body = (await response.text()).slice(0, 4096);
const field = (name) => new RegExp(`<${name}>([^<]{1,256})</${name}>`).exec(body)?.[1] ?? null;
process.stdout.write(JSON.stringify({
  operation: "GetObject range preflight",
  http_status: response.status,
  r2_error_code: field("Code"),
  r2_error_message: field("Message"),
  object_exists: response.ok,
}));
