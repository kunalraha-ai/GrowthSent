import json

src = "sample-growthsent.jsonl"
out = "sample-pages.jsonl"

pages = 0

with open(src, "r", encoding="utf-8") as f, open(out, "w", encoding="utf-8") as w:
    for line in f:
        obj = json.loads(line)

        obj.pop("links", None)

        w.write(
            json.dumps(
                obj,
                ensure_ascii=False,
                separators=(",", ":")
            ) + "\n"
        )

        pages += 1

print("pages_written =", pages)
print("output =", out)
