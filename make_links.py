import json
from urllib.parse import urljoin, urlparse

src = "sample-growthsent.jsonl"
out = "sample-links.jsonl"

pages = 0
links_written = 0

with open(src, "r", encoding="utf-8") as f, open(out, "w", encoding="utf-8") as w:
    for line in f:
        obj = json.loads(line)

        source_url = obj.get("source_url")
        source_host = obj.get("source_host")

        if not source_url:
            continue

        pages += 1

        for link in obj.get("links", []):
            target = link.get("url")
            if not target:
                continue

            try:
                absolute_target = urljoin(source_url, target)
                target_host = urlparse(absolute_target).hostname
            except Exception:
                continue

            record = {
                "crawl": obj.get("crawl"),
                "source_url": source_url,
                "source_host": source_host,
                "target_url": absolute_target,
                "target_host": target_host,
                "anchor": link.get("anchor"),
                "crawled_at": obj.get("crawled_at")
            }

            w.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            links_written += 1

print("pages_processed =", pages)
print("links_written =", links_written)
print("output =", out)
