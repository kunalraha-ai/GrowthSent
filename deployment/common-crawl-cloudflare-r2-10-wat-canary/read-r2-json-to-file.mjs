import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const input = JSON.parse(await new Response(process.stdin).text());
const required = [
  "endpoint",
  "bucket",
  "key",
  "accessKeyId",
  "secretAccessKey",
  "destination",
];
for (const name of required) {
  if (typeof input[name] !== "string" || !input[name]) {
    throw new Error(`missing ${name}`);
  }
}

const encodedKey = input.key.split("/").map(encodeURIComponent).join("/");
const url = `${input.endpoint}/${encodeURIComponent(input.bucket)}/${encodedKey}`;
const client = new AwsClient({
  accessKeyId: input.accessKeyId,
  secretAccessKey: input.secretAccessKey,
  service: "s3",
});
const response = await client.fetch(url, { method: "GET" });
const body = new Uint8Array(await response.arrayBuffer());
if (!response.ok) {
  process.stdout.write(JSON.stringify({
    operation: "GetObject audit manifest",
    http_status: response.status,
    key: input.key,
  }));
  process.exitCode = 0;
} else {
  if (body.byteLength > 2_000_000) {
    throw new Error("audit manifest exceeds the 2 MB safety limit");
  }
  JSON.parse(new TextDecoder().decode(body));
  const destination = resolve(input.destination);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body, { flag: "wx" });
  process.stdout.write(JSON.stringify({
    operation: "GetObject audit manifest",
    http_status: response.status,
    key: input.key,
    content_length: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    destination,
  }));
}
