import json
from urllib.parse import urlparse

src = "sample-wat.jsonl"
out = "sample-growthsent.jsonl"

written = 0

with open(src, "r", encoding="utf-8") as f, open(out, "w", encoding="utf-8") as w:
    for line in f:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        envelope = obj.get("Envelope", {})
        payload = envelope.get("Payload-Metadata", {})
        http = payload.get("HTTP-Response-Metadata")
        warc = envelope.get("WARC-Header-Metadata", {})

        if not http:
            continue

        source_url = warc.get("WARC-Target-URI")
        if not source_url:
            continue

        html = http.get("HTML-Metadata", {})
        head = html.get("Head", {})
        metas = head.get("Metas", [])
        head_links = head.get("Link", [])
        links = html.get("Links", [])

        description = None
        for meta in metas:
            if meta.get("name", "").lower() == "description":
                description = meta.get("content")
                break

        canonical = None
        for link in head_links:
            if link.get("rel", "").lower() == "canonical":
                canonical = link.get("url")
                break

        outgoing = []
        for link in links:
            if link.get("path") == "A@/href" and link.get("url"):
                outgoing.append({
                    "url": link.get("url"),
                    "anchor": link.get("text")
                })

        record = {
            "crawl": "CC-MAIN-2026-30",
            "source_url": source_url,
            "source_host": urlparse(source_url).hostname,
            "crawled_at": warc.get("WARC-Date"),
            "status": http.get("Response-Message", {}).get("Status"),
            "content_type": http.get("Headers", {}).get("Content-Type"),
            "title": head.get("Title"),
            "description": description,
            "canonical": canonical,
            "links": outgoing
        }

        w.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        written += 1

print("pages_written =", written)
print("output =", out)
