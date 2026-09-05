#!/usr/bin/env python
"""Build the caption-to-region adjudication benchmark from a corpus run.

Spec 046 lets a model adjudicate residual ambiguities and nothing else. The one
residual that dominates the remaining figure failures is: several figures and
several `Figure N` captions sit on one page, and geometry alone does not say
which caption belongs to which region. This script turns that into a scored
task with ground truth that does not come from our own rules.

Ground truth is Docling's own picture->caption attachment, kept only where two
independent signals agree:

  * every picture on the page carries exactly one caption reference, and
  * the caption labels, sorted by the geometry of their regions in reading
    order, come out in ascending label order.

A page where Docling's attachment and the label sequence disagree is dropped
rather than guessed at, so the gold answers are ones a careful reader would
also give. Regions and captions are then relabelled R1..Rn / C1..Cn and shuffled
with a per-page seed, so a model cannot win by echoing input order.

Usage:
  python build_dataset.py <corpus run dir> --out dataset.json [--limit 60]
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

LABEL = re.compile(r"^\s*(?:fig(?:ure)?s?\.?)\s*([0-9]+(?:\.[0-9]+)*[a-z]?)\b", re.I)


def label_key(text: str) -> tuple | None:
    match = LABEL.match(text)
    if not match:
        return None
    parts = match.group(1).rstrip(".").split(".")
    try:
        return tuple(int(re.sub(r"[^0-9]", "", part) or 0) for part in parts)
    except ValueError:
        return None


def box(prov: dict) -> dict:
    b = prov["bbox"]
    # Docling stores BOTTOMLEFT origin; report top-down so "above/below" reads naturally.
    return {"left": round(b["l"], 1), "right": round(b["r"], 1), "top": round(b["t"], 1), "bottom": round(b["b"], 1)}


def reading_order(entry: dict, page_width: float) -> tuple:
    """Two-column reading order: left column first, then top-down."""
    b = entry["bbox"]
    column = 0 if (b["left"] + b["right"]) / 2 < page_width / 2 else 1
    return (column, -b["top"])


def resolve(document: dict, ref: str) -> dict | None:
    kind, _, index = ref.lstrip("#/").partition("/")
    try:
        return document[kind][int(index)]
    except (KeyError, IndexError, ValueError):
        return None


def page_items(document: dict) -> dict[int, dict]:
    pages: dict[int, dict] = {}
    for index, picture in enumerate(document.get("pictures") or []):
        prov = (picture.get("prov") or [None])[0]
        captions = picture.get("captions") or []
        if not prov or len(captions) != 1:
            continue
        caption = resolve(document, captions[0]["$ref"])
        if not caption or caption.get("label") != "caption":
            continue
        caption_prov = (caption.get("prov") or [None])[0]
        text = (caption.get("text") or caption.get("orig") or "").strip()
        key = label_key(text)
        if not caption_prov or key is None or caption_prov["page_no"] != prov["page_no"]:
            continue
        pages.setdefault(prov["page_no"], {"pictures": []})["pictures"].append(
            {
                "picture": f"#/pictures/{index}",
                "bbox": box(prov),
                "caption": " ".join(text.split())[:400],
                "captionBbox": box(caption_prov),
                "labelKey": key,
            }
        )
    return pages


def build_items(run_dir: Path) -> list[dict]:
    items: list[dict] = []
    for docling in sorted(run_dir.glob("*/*.docling.json")):
        stem = docling.name[: -len(".docling.json")]
        try:
            document = json.loads(docling.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        sizes = {int(k): v.get("size", {}) for k, v in (document.get("pages") or {}).items()}
        for page_no, page in page_items(document).items():
            entries = page["pictures"]
            if len(entries) < 2:
                continue
            keys = [entry["labelKey"] for entry in entries]
            if len(set(keys)) != len(keys):
                continue
            width = float(sizes.get(page_no, {}).get("width") or 612)
            height = float(sizes.get(page_no, {}).get("height") or 792)
            ordered = sorted(entries, key=lambda e: reading_order(e, width))
            if [e["labelKey"] for e in ordered] != sorted(keys):
                continue  # geometry and the label sequence disagree: not gold

            rng = random.Random(f"{stem}:{page_no}")
            regions = list(entries)
            captions = list(entries)
            rng.shuffle(regions)
            rng.shuffle(captions)
            region_id = {id(entry): f"R{i + 1}" for i, entry in enumerate(regions)}
            caption_id = {id(entry): f"C{i + 1}" for i, entry in enumerate(captions)}
            items.append(
                {
                    "id": f"{stem}#p{page_no}",
                    "paper": stem,
                    "page": page_no,
                    "pageSize": {"width": round(width, 1), "height": round(height, 1)},
                    "regions": [{"id": region_id[id(e)], "bbox": e["bbox"]} for e in regions],
                    "captions": [
                        {"id": caption_id[id(e)], "bbox": e["captionBbox"], "text": e["caption"]} for e in captions
                    ],
                    "gold": {caption_id[id(e)]: region_id[id(e)] for e in entries},
                    "figureCount": len(entries),
                }
            )
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run")
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--seed", type=int, default=52)
    parser.add_argument("--per-paper", type=int, default=3)
    args = parser.parse_args()

    items = build_items(Path(args.run))
    rng = random.Random(args.seed)
    # Hard pages (4+ figures on one page) first, so a cap never crowds them out.
    order = sorted(items, key=lambda item: -item["figureCount"])
    rng.shuffle(order)
    order.sort(key=lambda item: -item["figureCount"])
    seen: dict[str, int] = {}
    picked: list[dict] = []
    for item in order:
        if seen.get(item["paper"], 0) >= args.per_paper:
            continue
        seen[item["paper"]] = seen.get(item["paper"], 0) + 1
        picked.append(item)
        if len(picked) >= args.limit:
            break
    rng.shuffle(picked)

    Path(args.out).write_text(json.dumps({"items": picked, "candidates": len(items)}, indent=1))
    bucket = lambda item: str(item["figureCount"]) if item["figureCount"] < 4 else "4+"  # noqa: E731
    counts = {name: sum(1 for p in picked if bucket(p) == name) for name in ("2", "3", "4+")}
    print(f"{len(items)} gold pages found in {args.run}; wrote {len(picked)} to {args.out}")
    print("figures per page:", counts)
    print("papers represented:", len({p['paper'] for p in picked}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
