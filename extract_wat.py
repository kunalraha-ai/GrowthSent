import gzip, json

src = "sample.warc.wat.gz"
out = "sample-wat.jsonl"

written = 0

with gzip.open(src, "rt", errors="replace") as f, open(out, "w", encoding="utf-8") as w:
    while True:
        line = f.readline()
        if not line:
            break

        if line.startswith("Content-Type: application/json"):
            content_length = None

            while True:
                header = f.readline()
                if not header:
                    break
                if header.strip() == "":
                    break
                if header.lower().startswith("content-length:"):
                    content_length = int(header.split(":", 1)[1].strip())

            if content_length:
                payload = f.read(content_length)
                try:
                    obj = json.loads(payload)
                    w.write(json.dumps(obj, separators=(",", ":")) + "\n")
                    written += 1
                except json.JSONDecodeError:
                    pass

print("records_written =", written)
print("output =", out)
