"""List the concrete failing instances behind each scorecard criterion.

The scorecard says *how many* documents fail each reader criterion; this tool
says *which objects* fail and why, straight from the run directory: the
lowercase-starting paragraphs and their predecessors, the `Figure N` /
`Table N` labels the EPUB lacks and what the draft did with that caption,
caption-less figures, unlinked footnotes with the superscript runs on their
page, unresolved link annotations with the block under them, and furniture
that leaked into the flow. Counts only leave the machine; text stays local.

Usage: python triage.py <run-dir> [--pdfs dir ...] [--only stem ...] [--exclude stem ...] [--workers N] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from evaluate import (  # noqa: E402
    CAPTION_RE,
    _canonical_uri,
    _caption_labels,
    _running_lines,
    _strip,
    lowercase_start_paragraphs,
    PAGE_NUMBER_RE,
)
from pdf_links import attach_words, extract_links, page_layout_lines, page_text_lines, word_boxes  # noqa: E402
from pdf_text import SourceText  # noqa: E402


def _body_html(epub: Path) -> str:
    with zipfile.ZipFile(epub) as zf:
        texts = {name: zf.read(name).decode("utf-8") for name in zf.namelist() if name.endswith(".xhtml")}
    return "\n".join(html for name, html in sorted(texts.items()) if not name.endswith("nav.xhtml"))


def _lowercase_instances(body_html: str) -> list[dict]:
    """The evaluator's own lowercase-start walk, with the offending paragraphs."""
    return [{"prev_tail": before[-70:], "text": text[:90]} for before, text in lowercase_start_paragraphs(body_html)]


def _blocks_by_label(draft: dict) -> dict[str, list[dict]]:
    by_label: dict[str, list[dict]] = {}
    for block in draft["blocks"]:
        label = block.get("label")
        if label:
            by_label.setdefault(label, []).append(block)
    return by_label


def _caption_block(draft: dict, kind: str, number: str) -> dict | None:
    word = "Table" if kind == "table" else r"Figure|Fig\.?"
    pattern = re.compile(r"^\W*(?:\d{1,3}\s+)?(" + word + r")\s*" + number + r"\b", re.IGNORECASE)
    for block in draft["blocks"]:
        if pattern.match(block["text"] or ""):
            return block
    return None


def _caption_page(pages: list[list[str]], kind: str, number: str) -> tuple[int | None, str]:
    for page_index, lines in enumerate(pages, start=1):
        if number in _caption_labels(lines)[kind]:
            for line in lines:
                match = CAPTION_RE.match(line)
                if match and match.group(2) == number and (match.group(1).lower().startswith("t")) == (kind == "table"):
                    return page_index, line.strip()[:80]
    return None, ""


def triage_one(stem: str, run_dir: Path, pdf: Path) -> dict:
    out_dir = run_dir / stem
    report_path = out_dir / f"{stem}.report.json"
    draft_path = out_dir / f"{stem}.struct-draft.json"
    epub = next(iter(sorted(out_dir.glob("*-paperpro.epub"))), None)
    if not report_path.exists() or not draft_path.exists() or epub is None:
        return {"stem": stem, "error": "missing outputs"}
    report = json.loads(report_path.read_text())
    if report.get("code"):
        return {"stem": stem, "error": report["code"]}
    draft = json.loads(draft_path.read_text())
    body_html = _body_html(epub)
    pages = page_text_lines(pdf)
    result: dict = {"stem": stem, "pages": len(pages)}

    # prose
    lowercase = _lowercase_instances(body_html)
    prose_count = sum(1 for p in re.findall(r"<p(?:\s[^>]*)?>(.*?)</p>", re.sub(r"<aside[^>]*>.*?</aside>", "", body_html, flags=re.S), re.S) if len(_strip(p).strip()) > 40)
    result["prose"] = {"lowercase": lowercase, "prose_paragraphs": prose_count, "coverage": report["completeness"]["textCoverage"]}

    # figures
    exp = report["expectations"]
    missing_figures = []
    for number in exp["figureLabels"]:
        if number in exp["figureLabelsFound"]:
            continue
        page, line = _caption_page(pages, "figure", number)
        block = _caption_block(draft, "figure", number)
        missing_figures.append(
            {
                "label": number,
                "caption_page": page,
                "caption_line": line,
                "draft_kind": block["kind"] if block else None,
                "draft_has_asset": bool(block and block.get("fallbackAssetIds")),
                "draft_text": (block["text"][:60] if block else None),
                "draft_signals": (block["evidence"].get("signals") if block else None),
            }
        )
    captionless = []
    for block in draft["blocks"]:
        if block["kind"] == "figure" and not block["text"]:
            box = block["evidence"]["boxes"][0] if block["evidence"]["boxes"] else None
            captionless.append(
                {
                    "id": block["id"],
                    "page": block["page"],
                    "box": [round(box["x"], 2), round(box["y"], 2), round(box["width"], 2), round(box["height"], 2)] if box else None,
                    "area": round(box["width"] * box["height"], 3) if box else None,
                    "signals": block["evidence"].get("signals"),
                    "asset": bool(block.get("fallbackAssetIds")),
                }
            )
    result["figures"] = {"missing": missing_figures, "captionless": captionless}

    # tables
    missing_tables = []
    for number in exp["tableLabels"]:
        if number in exp["tableLabelsFound"]:
            continue
        page, line = _caption_page(pages, "table", number)
        block = _caption_block(draft, "table", number)
        missing_tables.append(
            {
                "label": number,
                "caption_page": page,
                "caption_line": line,
                "draft_kind": block["kind"] if block else None,
                "draft_semantic": bool(block and block.get("table")),
                "draft_has_asset": bool(block and block.get("fallbackAssetIds")),
                "draft_signals": (block["evidence"].get("signals") if block else None),
            }
        )
    result["tables"] = {"missing": missing_tables, "fallback": report["build"].get("tables_fallback_image", 0)}

    # footnotes: unlinked notes and the superscript runs on their page
    linked_notes = {t for r in draft["relationships"] if r["kind"] == "footnote" for t in r["to"]}
    unlinked = []
    source_text = None
    for block in draft["blocks"]:
        if block["kind"] != "footnote" or not block.get("label") or block["id"] in linked_notes:
            continue
        if source_text is None:
            source_text = SourceText(pdf)
        page_text = source_text.page(block["page"]) if block["page"] else None
        runs = []
        if page_text is not None:
            runs = [f"{m.text}@{m.left_context[-10:]}" for m in page_text.markers if not m.at_line_start][:12]
        unlinked.append({"label": block["label"], "page": block["page"], "text": block["text"][:60], "page_markers": runs})
    if source_text is not None:
        source_text.close()
    result["footnotes"] = {"unlinked": unlinked, "marked": report["build"].get("footnotes_with_marker", 0), "linked": report["build"].get("footnotes_linked", 0)}

    # links: unresolved URI annotations and the draft block under each
    running = _running_lines(pages, page_layout_lines(pdf))
    links, sizes = extract_links(pdf)
    attach_words(links, word_boxes(pdf), sizes)
    out_hrefs = {_canonical_uri(href.replace("&amp;", "&")) for href in re.findall(r'<a[^>]*\shref="([^"]+)"', body_html)}
    unresolved_links = []
    seen_uris = set()
    for link in links:
        if link.kind != "uri" or not link.uri:
            continue
        visible = link.text.strip()
        if not visible:
            continue
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", visible.lower()))
        if key in running or re.fullmatch(r"[\d\s.,]+", visible):
            continue
        width, height = sizes.get(link.page, (0.0, 0.0))
        if height and width:
            l, b, r, t = link.rect
            if t / height >= 0.92 or b / height <= 0.08 or r / width <= 0.07 or l / width >= 0.93:
                continue
        uri = _canonical_uri(link.uri)
        if uri in out_hrefs or uri in seen_uris:
            continue
        seen_uris.add(uri)
        l, b, r, t = link.rect
        cx, cy = (l + r) / 2 / width, 1 - (b + t) / 2 / height
        under = None
        for block in draft["blocks"]:
            if block["page"] != link.page:
                continue
            for box in block["evidence"]["boxes"]:
                if box["x"] - 0.005 <= cx <= box["x"] + box["width"] + 0.005 and box["y"] - 0.005 <= cy <= box["y"] + box["height"] + 0.005:
                    under = block
                    break
            if under:
                break
        unresolved_links.append(
            {
                "page": link.page,
                "text": visible[:50],
                "uri": link.uri[:70],
                "under_kind": under["kind"] if under else None,
                "under_text": (under["text"][:60] if under else None),
                "in_epub_text": bool(under and visible[:20] and visible[:20] in body_html),
            }
        )
    result["links"] = {"unresolved": unresolved_links, "expected": report["completeness"]["expectedHyperlinkCount"], "mapped": report["completeness"]["mappedHyperlinkCount"]}

    # furniture leaks
    edge_numbers = set()
    for page in pages:
        for line in page[:6] + page[-6:]:
            if PAGE_NUMBER_RE.match(line):
                edge_numbers.add(line.strip())
    leaks = []
    for p in re.findall(r"<p(?:\s[^>]*)?>(.*?)</p>", re.sub(r"<aside[^>]*>.*?</aside>", "", body_html, flags=re.S), re.S):
        text = _strip(p).strip()
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
        if key in running or (PAGE_NUMBER_RE.match(text) and text in edge_numbers):
            leaks.append(text[:80])
    result["furniture"] = {"leaks": leaks, "running": sorted(running)[:12]}
    return result


def _find_pdf(stem: str, pdf_dirs: list[Path]) -> Path | None:
    for directory in pdf_dirs:
        candidate = directory / f"{stem}.pdf"
        if candidate.exists():
            return candidate
    return None


def _work(args):
    stem, run_dir, pdf = args
    try:
        return triage_one(stem, run_dir, pdf)
    except Exception as error:  # pragma: no cover
        return {"stem": stem, "error": f"{type(error).__name__}: {error}"}


def summarize(results: list[dict]) -> None:
    fig_kinds: Counter = Counter()
    tab_kinds: Counter = Counter()
    link_kinds: Counter = Counter()
    lowercase_docs = 0
    for result in results:
        if result.get("error"):
            print(f"!! {result['stem']}: {result['error']}")
            continue
        stem = result["stem"]
        prose = result["prose"]
        n = len(prose["lowercase"])
        if n:
            lowercase_docs += 1
            print(f"\n== {stem} PROSE {n}/{prose['prose_paragraphs']} lowercase, coverage {prose['coverage']}")
            for inst in prose["lowercase"][:6]:
                print(f"   …{inst['prev_tail']!r}\n     -> {inst['text']!r}")
        elif prose["coverage"] < 0.98:
            print(f"\n== {stem} PROSE coverage {prose['coverage']}")
        figures = result["figures"]
        if figures["missing"] or figures["captionless"]:
            print(f"\n== {stem} FIGURES missing {len(figures['missing'])} captionless {len(figures['captionless'])}")
            for m in figures["missing"]:
                kind = f"{m['draft_kind']}{'+asset' if m['draft_has_asset'] else ''}" if m["draft_kind"] else "not-in-draft"
                fig_kinds[kind] += 1
                print(f"   Figure {m['label']} p{m['caption_page']} draft={kind} {m['draft_signals'] or ''} | {m['caption_line']}")
            for c in figures["captionless"][:8]:
                print(f"   captionless {c['id']} p{c['page']} box={c['box']} area={c['area']} {c['signals']}")
        tables = result["tables"]
        if tables["missing"]:
            print(f"\n== {stem} TABLES missing {len(tables['missing'])} (fallback crops {tables['fallback']})")
            for m in tables["missing"]:
                kind = f"{m['draft_kind']}{'+semantic' if m['draft_semantic'] else ''}{'+asset' if m['draft_has_asset'] else ''}" if m["draft_kind"] else "not-in-draft"
                tab_kinds[kind] += 1
                print(f"   Table {m['label']} p{m['caption_page']} draft={kind} {m['draft_signals'] or ''} | {m['caption_line']}")
        notes = result["footnotes"]
        if notes["unlinked"]:
            print(f"\n== {stem} FOOTNOTES unlinked {len(notes['unlinked'])} of {notes['marked']}")
            for u in notes["unlinked"]:
                print(f"   [{u['label']}] p{u['page']} {u['text']!r} markers={u['page_markers']}")
        links = result["links"]
        if links["unresolved"]:
            print(f"\n== {stem} LINKS unresolved {len(links['unresolved'])} ({links['mapped']}/{links['expected']})")
            for u in links["unresolved"][:10]:
                link_kinds[u["under_kind"] or "none"] += 1
                print(f"   p{u['page']} {u['text']!r} -> {u['uri']} under={u['under_kind']} {u['under_text']!r}")
        furniture = result["furniture"]
        if furniture["leaks"]:
            print(f"\n== {stem} FURNITURE leaks {len(furniture['leaks'])}")
            for leak in furniture["leaks"][:6]:
                print(f"   {leak!r}")
    print("\n## totals")
    print("lowercase-failing docs:", lowercase_docs)
    print("missing figure labels by draft state:", dict(fig_kinds))
    print("missing table labels by draft state:", dict(tab_kinds))
    print("unresolved links by block under:", dict(link_kinds))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_dir")
    parser.add_argument("--pdfs", nargs="*", default=[str(Path.home() / "Downloads/Papers")])
    parser.add_argument("--only", nargs="*", default=None)
    parser.add_argument("--exclude", nargs="*", default=None)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    run_dir = Path(args.run_dir)
    pdf_dirs = [Path(p) for p in args.pdfs]
    stems = sorted(p.name for p in run_dir.iterdir() if p.is_dir())
    if args.only:
        stems = [s for s in stems if s in set(args.only)]
    if args.exclude:
        stems = [s for s in stems if s not in set(args.exclude)]
    jobs = []
    for stem in stems:
        pdf = _find_pdf(stem, pdf_dirs)
        if pdf is None:
            print(f"!! {stem}: no PDF found", file=sys.stderr)
            continue
        jobs.append((stem, run_dir, pdf))
    if args.workers > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(_work, jobs))
    else:
        results = [_work(job) for job in jobs]
    results.sort(key=lambda r: r["stem"])
    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=1))
    summarize(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
