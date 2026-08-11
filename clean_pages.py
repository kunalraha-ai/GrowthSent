import json

src = "sample-pages.jsonl"
out = "sample-pages-clean.jsonl"

fixed = 0
rows = 0

with open(src, "r", encoding="utf-8") as f, open(out, "w", encoding="utf-8") as w:
    for line in f:
        obj = json.loads(line)

        ct = obj.get("content_type")

        if isinstance(ct, list):
            obj["content_type"] = "; ".join(str(x) for x in ct)
            fixed += 1
        elif ct is not None and not isinstance(ct, str):
            obj["content_type"] = str(ct)
            fixed += 1

        w.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        rows += 1

print("rows =", rows)
print("content_type_fixed =", fixed)
print("output =", out)
