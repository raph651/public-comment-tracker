#!/usr/bin/env python3
"""Convert a Regulations.gov bulk export CSV into the pipeline's JSONL store.

    python3 scripts/ingest_bulk.py ~/Downloads/mvs-uwdd-cjwx.csv

Writes data/list.jsonl and data/details.jsonl, replacing whatever is there:
the export is the authoritative baseline, and the API delta worker only adds
rows that are missing from it afterwards.

The export carries the comment body in the `Comment` column (often overlooked
because `Abstract` is empty for submissions), plus the submitter identity that
the v4 API only returns on a per-comment detail call.
"""
import csv
import json
import os
import re
import sys

CAMPAIGN = re.compile(r"\b(MM\d+)\b", re.IGNORECASE)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2

    src = sys.argv[1]
    if not os.path.exists(src):
        print(f"error: no such file: {src}", file=sys.stderr)
        return 1

    csv.field_size_limit(10**9)
    out_dir = os.path.join(os.getcwd(), "data")
    os.makedirs(out_dir, exist_ok=True)

    list_rows, detail_rows = [], []
    skipped = 0

    with open(src, newline="", encoding="utf-8", errors="replace") as handle:
        for row in csv.DictReader(handle):
            if (row.get("Document Type") or "").strip() != "Public Submission":
                continue  # the proposed rule itself

            doc_id = (row.get("Document ID") or "").strip()
            if not doc_id:
                skipped += 1
                continue

            title = (row.get("Title") or "").strip() or f"Comment {doc_id}"
            posted = (row.get("Posted Date") or "").strip()
            match = CAMPAIGN.search(title)

            list_rows.append(
                {
                    "id": doc_id,
                    "title": title,
                    "postedDate": posted,
                    "lastModifiedDate": (row.get("Received Date") or posted).strip(),
                    "campaignId": match.group(1).upper() if match else None,
                    "withdrawn": (row.get("Is Withdrawn?") or "").strip().lower() == "true",
                }
            )

            first = (row.get("First Name") or "").strip()
            last = (row.get("Last Name") or "").strip()
            submitter = (
                (row.get("Organization Name") or "").strip()
                or " ".join(part for part in (first, last) if part)
                or (row.get("Authors") or "").strip()
            )

            detail_rows.append(
                {
                    "id": doc_id,
                    "text": (row.get("Comment") or "").strip(),
                    "submitterName": submitter,
                }
            )

    with open(os.path.join(out_dir, "list.jsonl"), "w", encoding="utf-8") as out:
        out.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in list_rows))
    with open(os.path.join(out_dir, "details.jsonl"), "w", encoding="utf-8") as out:
        out.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in detail_rows))

    with_text = sum(1 for r in detail_rows if r["text"])
    campaigns = sorted({r["campaignId"] for r in list_rows if r["campaignId"]})
    print(f"ingested {len(list_rows):,} submissions ({with_text:,} with text, {skipped} skipped)")
    print(f"campaign tags: {len(campaigns)} distinct")
    print(f"date range: {min(r['postedDate'] for r in list_rows)} -> {max(r['postedDate'] for r in list_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
