import json

filename = "sample-growthsent.jsonl"

total_bytes = 0
link_bytes = 0
pages = 0
link_count = 0

with open(filename, "r", encoding="utf-8") as f:
    for line in f:
        obj = json.loads(line)

        total_bytes += len(line.encode("utf-8"))

        links = obj.get("links", [])

        link_bytes += len(
            json.dumps(
                links,
                ensure_ascii=False,
                separators=(",", ":")
            ).encode("utf-8")
        )

        link_count += len(links)
        pages += 1

print("pages =", pages)
print("links =", link_count)
print("avg_links_per_page =", round(link_count / pages, 1))
print("total_MB =", round(total_bytes / 1_000_000, 1))
print("links_MB =", round(link_bytes / 1_000_000, 1))
print("links_percent =", round(link_bytes / total_bytes * 100, 1))
