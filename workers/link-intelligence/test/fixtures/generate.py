#!/usr/bin/env python3
"""Generate tiny Parquet fixtures for the link-intelligence Worker tests.

These are not real Common Crawl data; they only exercise the same schemas and
keep the repository small. Run from the worker project root:

    python test/fixtures/generate.py
"""

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

OUT_DIR = Path(__file__).parent


def write_fixture(name: str, columns: dict[str, list], compression: str = "zstd") -> None:
    arrays = {k: pa.array(v) for k, v in columns.items()}
    table = pa.Table.from_pydict(arrays)
    pq.write_table(table, OUT_DIR / f"{name}_0000.parquet", compression=compression)


def main() -> int:
    domain = "google.ml"

    write_fixture(
        "domain_summary",
        {
            "target_domain": [domain],
            "inbound_link_count": [42_000],
            "referring_domain_count": [1_200],
        },
    )

    write_fixture(
        "referring_domains",
        {
            "target_domain": [domain] * 6,
            "source_domain": ["example.com", "news.ycombinator.com", "wikipedia.org", "github.com", "reddit.com", "twitter.com"],
            "inbound_link_count": [9_000, 8_000, 7_000, 6_000, 5_000, 4_000],
        },
    )

    write_fixture(
        "anchors",
        {
            "target_domain": [domain] * 6,
            "anchor": ["click here", "google", "search", "maps", "mail", "docs"],
            "inbound_link_count": [12_000, 11_000, 10_000, 9_000, 8_000, 7_000],
        },
    )

    write_fixture(
        "top_pages",
        {
            "target_domain": [domain] * 4,
            "target_url": ["https://www.google.ml/", "https://mail.google.ml/", "https://maps.google.ml/", "https://docs.google.ml/"],
            "inbound_link_count": [20_000, 15_000, 10_000, 5_000],
            "referring_domain_count": [900, 800, 700, 600],
        },
    )

    write_fixture(
        "broken_backlink_candidates",
        {
            "target_domain": [domain, domain],
            "target_url": ["https://www.google.ml/old-product", "https://www.google.ml/dead-link"],
            "source_domain": ["example.com", "orphan-source.org"],
            "source_url": ["https://example.com/page1", "https://orphan-source.org/post"],
            "observed_link_count": [30, 12],
        },
    )

    print(f"Fixtures written to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
