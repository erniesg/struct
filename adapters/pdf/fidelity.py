"""Private, source-backed evidence packets; heuristics never certify publication fidelity.

Usage: python fidelity.py --pdf original.pdf --struct struct.json --out evidence/
Optional repeatable --epub and --cache bind packaged outputs/extraction inputs.
Input files are read-only. Only --out is written. No network or model calls.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import hashlib
import io
from importlib.metadata import version, PackageNotFoundError
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

from pdf_links import page_layout_lines
from pdf_text import SourceText, classify_font
from source_raster import SourceRaster

SCHEMA = "struct-source-fidelity-evidence-v1"
LIGATURES = str.maketrans({"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl"})


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_record(path: Path) -> dict:
    path = Path(path).resolve()
    return {"path": str(path), "sha256": digest(path.read_bytes()), "bytes": path.stat().st_size}


def tokens(text: str) -> list[str]:
    """Keep case, operators, punctuation, digits and one-character words.

    Whitespace and known typographic ligatures alone are normalized. Line-end
    hyphen removal is deliberately not guessed; uncertain matches stay pending.
    """
    return re.findall(r"\w+|[^\w\s]", (text or "").translate(LIGATURES), re.UNICODE)


def sequence_position(needle: list[str], haystack: list[str]) -> int | None:
    if not needle:
        return None
    return next((i for i in range(len(haystack) - len(needle) + 1) if haystack[i:i + len(needle)] == needle), None)


def compare_text(source: str, output: str) -> dict:
    a, b = tokens(source), tokens(output)
    position = sequence_position(a, b)
    differences = []
    if position is None:
        for tag, i, j, k, l in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if tag in ("delete", "replace"):
                differences.append({"sourceTokens": a[i:j], "candidateOutputTokens": b[k:l], "operation": tag})
    return {"exactLocalSequence": position is not None, "outputTokenOffset": position, "sourceTokenCount": len(a), "differences": differences}


def boxes(item: dict) -> list[dict]:
    return item.get("evidence", {}).get("boxes", [])


def valid_box(box: dict) -> bool:
    try:
        return (isinstance(box["page"], int) and box["page"] > 0 and all(isinstance(box[k], (float, int)) for k in ("x", "y", "width", "height"))
                and box["width"] > 0 and box["height"] > 0 and box["x"] >= 0 and box["y"] >= 0
                and box["x"] + box["width"] <= 1.001 and box["y"] + box["height"] <= 1.001)
    except (KeyError, TypeError):
        return False


def contains(outer: dict, inner: dict, tolerance: float = .003) -> bool:
    return (valid_box(outer) and outer["page"] == inner["page"] and outer["x"] - tolerance <= inner["x"]
            and outer["y"] - tolerance <= inner["y"] and outer["x"] + outer["width"] + tolerance >= inner["x"] + inner["width"]
            and outer["y"] + outer["height"] + tolerance >= inner["y"] + inner["height"])


def intersects(a: dict, b: dict) -> bool:
    return (valid_box(a) and a["page"] == b["page"] and min(a["x"] + a["width"], b["x"] + b["width"]) > max(a["x"], b["x"])
            and min(a["y"] + a["height"], b["y"] + b["height"]) > max(a["y"], b["y"]))


def union_boxes(items: list[dict]) -> dict | None:
    if not items or len({b["page"] for b in items}) != 1:
        return None
    x, y = min(b["x"] for b in items), min(b["y"] for b in items)
    return {"page": items[0]["page"], "x": x, "y": y, "width": max(b["x"] + b["width"] for b in items) - x,
            "height": max(b["y"] + b["height"] for b in items) - y}


def source_census(pdf: Path) -> tuple[list[dict], list[dict]]:
    """Original Poppler line segmentation, supplemented with original glyphs."""
    from pypdf import PdfReader
    count = len(PdfReader(str(pdf)).pages)
    layout = page_layout_lines(pdf)
    signals = SourceText(pdf)
    pages, warnings = [], []
    try:
        for number in range(1, count + 1):
            raw = layout[number - 1] if number <= len(layout) else None
            glyph_page = signals.page(number)
            glyphs = []
            if glyph_page:
                _ = glyph_page.lines  # computes source baseline/superscript signals
                for index, c in enumerate(glyph_page.chars):
                    glyphs.append({"id": f"p{number:04d}-g{index:06d}", "text": c.text, "font": c.font, "fontFlags": classify_font(c.font),
                                   "baselinePdfY": c.b, "heightPoints": c.height, "superscriptSignal": c.superscript,
                                   "box": {"page": number, "x": c.l / glyph_page.width, "y": 1 - c.t / glyph_page.height,
                                           "width": (c.r - c.l) / glyph_page.width, "height": c.height / glyph_page.height}})
            lines = []
            if raw:
                width, height = raw["width"], raw["height"]
                for index, item in enumerate(raw["lines"]):
                    box = {"page": number, "x": item["xmin"] / width, "y": item["ymin"] / height,
                           "width": (item["xmax"] - item["xmin"]) / width, "height": (item["ymax"] - item["ymin"]) / height}
                    line_glyphs = [g for g in glyphs if contains(box, g["box"])]
                    identity = digest(json.dumps([box, item["text"]], sort_keys=True).encode())[:12]
                    lines.append({"id": f"p{number:04d}-l{index:05d}-{identity}", "text": item["text"], "box": box,
                                  "sourceSequence": index, "glyphIds": [g["id"] for g in line_glyphs],
                                  "fonts": sorted({g["font"] for g in line_glyphs}),
                                  "mathFontCandidate": any(g["fontFlags"]["math"] for g in line_glyphs)})
            if not lines:
                warnings.append({"code": "NO_SOURCE_TEXT_LINES", "page": number, "status": "unreviewed", "detail": "Original page requires visual/OCR census; no completeness inference is possible."})
            if not glyphs:
                warnings.append({"code": "NO_SOURCE_GLYPH_SIGNALS", "page": number, "status": "unreviewed"})
            pages.append({"page": number, "lineMethod": "original-pdf-poppler-bbox-layout", "glyphMethod": "original-pdf-SourceText",
                          "lines": lines, "glyphs": glyphs})
    finally:
        signals.close()
    return pages, warnings


def line_ledger(lines: list[dict], document: dict) -> tuple[list[dict], list[dict]]:
    blocks = document.get("blocks", [])
    ledger, warnings = [], []
    for line in lines:
        candidates, exact = [], []
        for index, block in enumerate(blocks):
            if not any(intersects(box, line["box"]) for box in boxes(block)):
                continue
            comparison = compare_text(line["text"], block.get("text", ""))
            candidate = {"blockId": block["id"], "kind": block.get("kind"), "blockOrder": index,
                         "claimedBoxesContainLine": any(contains(box, line["box"]) for box in boxes(block)), **comparison}
            candidates.append(candidate)
            if comparison["exactLocalSequence"] and candidate["claimedBoxesContainLine"] and block.get("kind") not in ("figure", "equation", "table", "furniture"):
                exact.append(candidate)
        status, reason = "unresolved", "No exact contiguous text sequence in an associated output text region."
        if len(exact) == 1:
            status, reason = "represented", "Exact local source token sequence in one output text block; layout/typography not certified."
        elif len(exact) > 1:
            status, reason = "unreviewed", "Multiple visible text candidates may duplicate one source region."
            warnings.append({"code": "DUPLICATE_SOURCE_LINE_CANDIDATE", "sourceLineId": line["id"], "blockIds": [c["blockId"] for c in exact]})
        elif candidates and any(c["kind"] in ("figure", "equation", "table") for c in candidates):
            status, reason = "unreviewed", "Visual/table claims require object-specific source comparison; their boxes do not establish coverage."
        elif any(c["kind"] == "furniture" for c in candidates):
            status, reason = "unreviewed", "Converter furniture claim requires independent source justification, including edge numerals; the claimed box is not proof."
        # Titles intentionally render from metadata, which has no block box.
        if status == "unresolved" and line["box"]["page"] == 1 and compare_text(line["text"], document.get("metadata", {}).get("title", ""))["exactLocalSequence"]:
            status, reason = "unreviewed", "Possible metadata-title representation; inspect packaged visible header and source title extent."
        ledger.append({"sourceLineId": line["id"], "page": line["box"]["page"], "sourceText": line["text"], "sourceBox": line["box"],
                       "status": status, "reason": reason, "candidates": candidates})
    # Within one output block, source lines must not reverse their mapped order.
    grouped = defaultdict(list)
    for row in ledger:
        if row["status"] == "represented":
            match = next(c for c in row["candidates"] if c["exactLocalSequence"] and c["claimedBoxesContainLine"] and c["kind"] not in ("figure", "equation", "table", "furniture"))
            grouped[match["blockId"]].append((row, match["outputTokenOffset"]))
    for block_id, group in grouped.items():
        group.sort(key=lambda pair: (pair[0]["page"], pair[0]["sourceBox"]["y"], pair[0]["sourceBox"]["x"]))
        for (before, left), (after, right) in zip(group, group[1:]):
            if right <= left:
                before["status"] = after["status"] = "unreviewed"
                warnings.append({"code": "SOURCE_LINE_OUTPUT_REUSED" if right == left else "SOURCE_LINE_ORDER_INVERSION", "blockId": block_id, "sourceLineIds": [before["sourceLineId"], after["sourceLineId"]],
                                 "detail": "Source geometric order disagrees with output sequence; columns/math require visual adjudication."})
    return ledger, warnings


def table_census(block: dict, lines: list[dict]) -> dict:
    table = block.get("table", {})
    cells, flags = [], []
    for cell in table.get("cells", []):
        cb = boxes(cell)
        whole = bool(cb) and all(any(abs(b[k] - parent[k]) < .002 for parent in boxes(block) if parent.get("page") == b.get("page"))
                                 for b in cb for k in ("x", "y", "width", "height"))
        region = [line for line in lines if any(contains(b, line["box"]) for b in cb)]
        source = " ".join(line["text"] for line in sorted(region, key=lambda v: (v["box"]["page"], v["box"]["y"], v["box"]["x"])))
        comparison = compare_text(cell.get("text", ""), source)
        item_flags = []
        if not cb:
            item_flags.append("MISSING_CELL_SOURCE_BOX")
        if whole:
            item_flags.append("CELL_BOX_EQUALS_WHOLE_TABLE")
        if not comparison["exactLocalSequence"]:
            item_flags.append("CELL_VALUE_NOT_EXACT_IN_CLAIMED_REGION")
        if cell.get("row", -1) < 0 or cell.get("column", -1) < 0 or cell.get("row", 0) + cell.get("rowSpan", 1) > table.get("rows", 0) or cell.get("column", 0) + cell.get("columnSpan", 1) > table.get("columns", 0):
            item_flags.append("CELL_OUTSIDE_DECLARED_GRID")
        cells.append({"id": cell.get("id"), "row": cell.get("row"), "column": cell.get("column"), "rowSpan": cell.get("rowSpan", 1),
                      "columnSpan": cell.get("columnSpan", 1), "outputText": cell.get("text", ""), "claimedSourceBoxes": cb,
                      "sourceLineIds": [l["id"] for l in region], "sourceRegionText": source, "flags": item_flags, "status": "unreviewed"})
    columns = defaultdict(list)
    for cell in cells:
        columns[cell["column"]].append(cell)
    for group in columns.values():
        group.sort(key=lambda cell: cell["row"])
        for a, b in zip(group, group[1:]):
            ab, bb = union_boxes(a["claimedSourceBoxes"]), union_boxes(b["claimedSourceBoxes"])
            if ab and bb and ab["page"] == bb["page"] and a["row"] < b["row"] and ab["y"] > bb["y"] + .003:
                flags.append({"code": "CELL_ROW_ORDER_GEOMETRY_CONFLICT", "cellIds": [a["id"], b["id"]]})
    source_lines = [l for l in lines if any(intersects(b, l["box"]) for b in boxes(block))]
    return {"blockId": block["id"], "status": "unreviewed", "declaredRows": table.get("rows"), "declaredColumns": table.get("columns"),
            "sourceLineIds": [l["id"] for l in source_lines], "cells": cells, "flags": flags,
            "requiredReview": "Establish logical rows/header keys/merged cells from original page; exact token presence cannot establish row meaning."}


def image_comparison(source, output) -> dict:
    """Diagnostic only: neither identical pixels nor low error proves crop extent."""
    from PIL import ImageChops, ImageStat
    a, b = source.convert("L"), output.convert("L")
    original_ink = sum(n for value, n in enumerate(a.histogram()) if value < 240) / (a.width * a.height)
    output_ink = sum(n for value, n in enumerate(b.histogram()) if value < 240) / (b.width * b.height)
    difference = sum(ImageStat.Stat(ImageChops.difference(a, b.resize(a.size))).mean) / 255
    flags = []
    if output_ink < .001:
        flags.append("BLANK_OUTPUT_IMAGE")
    if output_ink < .01:
        flags.append("SPARSE_OUTPUT_IMAGE_CHECK_OBJECT_EXTENT")
    if original_ink > .01 and output_ink < original_ink * .25:
        flags.append("SOURCE_INK_MISSING_CANDIDATE")
    if difference > .12:
        flags.append("SOURCE_CROP_PIXEL_DIFFERENCE")
    return {"status": "unreviewed", "sourceInkShare": original_ink, "outputInkShare": output_ink, "meanAbsolutePixelDifference": difference, "flags": flags,
            "limitation": "Pixel comparison is a triage signal; the claimed source box may itself omit the correct object."}


def visual_tasks(document: dict, raster: SourceRaster, out: Path) -> list[dict]:
    from PIL import Image
    assets = {a["id"]: a for a in document.get("assets", [])}
    tasks = []
    folder = out / "visual-tasks"
    folder.mkdir(exist_ok=True)
    for index, block in enumerate(document.get("blocks", [])):
        if block.get("kind") not in ("figure", "equation", "table", "code"):
            continue
        task = {"blockId": block["id"], "kind": block["kind"], "status": "unreviewed", "claimedSourceBoxes": boxes(block), "comparisons": [],
                "requiredReview": "Check complete source extent, placement, caption/object relation, symbols/cells and both output profile readability."}
        for j, box in enumerate(boxes(block)):
            if not valid_box(box):
                task.setdefault("flags", []).append("INVALID_SOURCE_BOX")
                continue
            page = raster.page_image(box["page"])
            rect = tuple(round(value) for value in (box["x"] * page.width, box["y"] * page.height, (box["x"] + box["width"]) * page.width, (box["y"] + box["height"]) * page.height))
            if rect[2] <= rect[0] or rect[3] <= rect[1]:
                task.setdefault("flags", []).append("EMPTY_SOURCE_CROP")
                continue
            crop = page.crop(rect)
            source_file = folder / f"object-{index:05d}-{j:03d}-source.png"
            crop.save(source_file)
            comparison = {"sourceCrop": file_record(source_file), "box": box, "outputs": []}
            for k, aid in enumerate(block.get("fallbackAssetIds", [])):
                asset = assets.get(aid)
                try:
                    if asset is None:
                        raise ValueError("missing asset")
                    raw = asset.get("bytes")
                    data = base64.b64decode(raw, validate=True) if isinstance(raw, str) else bytes(raw)
                    image = Image.open(io.BytesIO(data)); image.load()
                    output_file = folder / f"object-{index:05d}-{j:03d}-asset-{k:03d}.png"
                    image.save(output_file)
                    comparison["outputs"].append({"assetId": aid, "outputCrop": file_record(output_file), **image_comparison(crop, image)})
                except (ValueError, TypeError, OSError) as error:
                    comparison["outputs"].append({"assetId": aid, "status": "unresolved", "flags": ["INVALID_OUTPUT_IMAGE"], "error": str(error)})
            task["comparisons"].append(comparison)
        if block["kind"] in ("figure", "equation") and not block.get("fallbackAssetIds"):
            task.setdefault("flags", []).append("NO_IMAGE_REPRESENTATION_CHECK_SEMANTIC_CONTENT")
        tasks.append(task)
    return tasks


def annotation_census(pdf: Path) -> list[dict]:
    from pypdf import PdfReader
    reader = PdfReader(str(pdf))
    result = []
    for page_no, page in enumerate(reader.pages, 1):
        for index, ref in enumerate(page.get("/Annots") or []):
            annotation = ref.get_object()
            action = annotation.get("/A")
            action = action.get_object() if action else {}
            result.append({"id": f"p{page_no:04d}-annotation-{index:05d}", "page": page_no,
                           "subtype": str(annotation.get("/Subtype", "")), "rectPdfPoints": [float(v) for v in annotation.get("/Rect", [])],
                           "actionType": str(action.get("/S", "")), "uri": str(action["/URI"]) if "/URI" in action else None,
                           "destination": str(annotation.get("/Dest", action.get("/D", ""))), "contents": str(annotation.get("/Contents", "")),
                           "status": "unreviewed", "requiredReview": "Verify this occurrence's visible anchor and destination; no distinct-URI deduplication."})
    return result


def epub_inventory(path: Path) -> dict:
    result = {**file_record(path), "status": "unreviewed", "members": [], "documents": [], "flags": []}
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            data = archive.read(item.filename)
            result["members"].append({"path": item.filename, "bytes": len(data), "sha256": digest(data)})
            if item.filename.endswith((".xhtml", ".opf", ".ncx")):
                try:
                    root = ET.fromstring(data)
                    result["documents"].append({"path": item.filename, "ids": [node.attrib["id"] for node in root.iter() if "id" in node.attrib],
                                                "references": [{"tag": node.tag, "href": node.attrib.get("href"), "src": node.attrib.get("src")} for node in root.iter() if "href" in node.attrib or "src" in node.attrib]})
                except ET.ParseError as error:
                    result["flags"].append({"code": "INVALID_PACKAGED_XML", "path": item.filename, "error": str(error)})
    result["requiredReview"] = "Validate rendered DOM/asset resolution, EPUBCheck, navigation and overflow/screenshots on both profiles; this inventory does not simulate pagination."
    return result


def code_identity() -> dict:
    root = Path(__file__).resolve().parents[2]
    def git(*args):
        process = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
        return process.stdout if process.returncode == 0 else None
    head, diff, names = git("rev-parse", "HEAD"), git("diff", "HEAD", "--", "src", "adapters/pdf"), git("ls-files", "--cached", "--others", "--exclude-standard", "src", "adapters/pdf")
    files = set((names or b"").decode().splitlines()) | {str(Path(__file__).relative_to(root))}
    return {"scope": "Evidence-generator working source tree; EPUB producer revision is unknown unless separately bound by supplied cache/build report.", "head": head.decode().strip() if head else None, "trackedDiffSha256": digest(diff) if diff is not None else None,
            "files": [file_record(root / name) for name in sorted(files) if (root / name).is_file()],
            "limitation": "Working file hashes bind uncommitted implementation; external tool/runtime versions are recorded separately."}


def tool_versions() -> dict:
    versions = {}
    for name in ("pypdf", "docling-parse", "Pillow"):
        try:
            versions[name] = version(name)
        except PackageNotFoundError:
            versions[name] = None
    for command in ("pdftoppm", "pdftotext"):
        try:
            result = subprocess.run([command, "-v"], capture_output=True, text=True, timeout=10)
            versions[command] = (result.stdout or result.stderr).strip().splitlines()[0]
        except (OSError, subprocess.TimeoutExpired, IndexError):
            versions[command] = None
    return versions


def preflight_output(out: Path, inputs: set[Path]) -> None:
    """Reserve every generated namespace without following output symlinks.

    Inputs may coexist in an output parent, but never in generated subtrees.
    Reject aliases before any directory creation or raster write. Existing
    generated symlinks are rejected even when they point to a non-input path,
    since writing through them would leave the named output namespace.
    """
    files = (out / "evidence.json", out / "evidence.md")
    folders = (out / "source-pages", out / "visual-tasks")
    for folder in folders:
        resolved = folder.resolve()
        if any(path == resolved or resolved in path.parents for path in inputs):
            raise ValueError(f"output subtree would overwrite an input: {folder}")
        if folder.exists() and not folder.is_dir():
            raise ValueError(f"output subtree is not a directory: {folder}")
    existing = [*files, *folders]
    for folder in folders:
        if folder.is_dir() and not folder.is_symlink():
            existing.extend(folder.rglob("*"))
    for path in existing:
        if path.is_symlink():
            raise ValueError(f"generated output path is a symlink alias: {path}")
        if path.resolve() in inputs or (path.is_file() and any(source.is_file() and path.samefile(source) for source in inputs)):
            raise ValueError(f"generated output would overwrite an input: {path}")


def build_packet(pdf: Path, struct_path: Path, out: Path, epub_paths=(), cache_paths=()) -> dict:
    pdf, struct_path, out = Path(pdf).resolve(), Path(struct_path).resolve(), Path(out).resolve()
    epub_paths, cache_paths = tuple(epub_paths), tuple(cache_paths)
    inputs = {pdf, struct_path, *(Path(p).resolve() for p in epub_paths), *(Path(p).resolve() for p in cache_paths)}
    preflight_output(out, inputs)
    out.mkdir(parents=True, exist_ok=True)
    code_before = code_identity()
    source_record, struct_record = file_record(pdf), file_record(struct_path)
    document = json.loads(struct_path.read_text())
    pages, warnings = source_census(pdf)
    lines = [line for page in pages for line in page["lines"]]
    ledger, order_warnings = line_ledger(lines, document)
    warnings.extend(order_warnings)
    with SourceRaster(pdf, expected_sha256=source_record["sha256"]) as raster:
        source_folder = out / "source-pages"; source_folder.mkdir(exist_ok=True)
        for page in pages:
            file = source_folder / f"page-{page['page']:04d}.png"
            with raster.page_image(page["page"]) as image:
                image.save(file)
            page["originalRaster"] = file_record(file)
        visuals = visual_tasks(document, raster, out)
    if document.get("source", {}).get("sha256") != source_record["sha256"]:
        warnings.append({"code": "STRUCT_SOURCE_HASH_MISMATCH", "status": "unresolved"})
    packet = {"schema": SCHEMA, "status": "review-required", "source": source_record, "struct": struct_record,
              "cacheInputs": [file_record(Path(p)) for p in cache_paths], "code": code_before,
              "methods": {"lineMatching": "Original PDF lines; exact local contiguous tokens inside associated claimed boxes; case/operators/punctuation retained.",
                          "normalization": "Whitespace and five known typographic ligatures only; no inferred dehyphenation or global bag matching.",
                          "raster": "Original PDF, Poppler, 144 dpi; never cached converter page rasters.", "python": sys.version, "toolVersions": tool_versions()},
              "pages": pages, "lineLedger": ledger, "annotations": annotation_census(pdf),
              "tables": [table_census(block, lines) for block in document.get("blocks", []) if block.get("kind") == "table"],
              "visualTasks": visuals, "packagedOutputs": [epub_inventory(Path(p)) for p in epub_paths],
              "warnings": warnings,
              "pendingChecks": ["Independent source visual/table/note/math object census, including uncaptioned objects.",
                                "Scanned-page OCR and glyph coverage where original text is absent or incorrect.",
                                "Logical reading order across blocks, columns, floats and equations; glyph typography and mathematical semantics.",
                                "Every table cell's logical row/column/value and every visual crop's complete extent and caption relationship.",
                                "Every note/link occurrence and destination; metadata header rendering; output-only and duplicate source content.",
                                "Both device profile DOM overflow, screenshots, EPUBCheck and actual pagination/usability review."]}
    if file_record(pdf) != source_record or file_record(struct_path) != struct_record:
        packet["warnings"].append({"code": "INPUT_CHANGED_DURING_PACKET_BUILD", "status": "unresolved"})
    if code_identity() != code_before:
        packet["warnings"].append({"code": "CODE_CHANGED_DURING_PACKET_BUILD", "status": "unreviewed"})
    packet["lineStatusCounts"] = dict(Counter(row["status"] for row in ledger))
    # This is explicitly a local text-evidence count, never a fidelity percentage.
    (out / "evidence.json").write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n")
    report = ["# Private source fidelity evidence", "", f"Source: `{pdf.name}` — SHA-256 `{source_record['sha256']}`", "",
              "Status: **review-required**. Exact local text matches establish only that line's token sequence in an associated block; they do not certify whole-document completeness or usability.", "",
              "## Line evidence dispositions", "", "| Disposition | Count |", "|---|---:|"]
    report.extend(f"| {status} | {count} |" for status, count in sorted(packet["lineStatusCounts"].items()))
    report += ["", f"Source pages: {len(pages)}; annotation occurrences: {len(packet['annotations'])}; table review tasks: {len(packet['tables'])}; visual review tasks: {len(packet['visualTasks'])}; packaged outputs: {len(packet['packagedOutputs'])}.",
               "", "## Pending mandatory review", ""]
    report.extend(f"- {item}" for item in packet["pendingChecks"])
    report += ["", "## Warnings", ""] + [f"- `{item['code']}`: {json.dumps(item, ensure_ascii=False)}" for item in warnings]
    report += ["", "## Unresolved source lines", "", "Full glyphs, source boxes, candidates, differences and all pending object comparisons are in evidence.json. Original page rasters and crop pairs accompany it.", ""]
    report.extend(f"- Page {row['page']} `{row['sourceLineId']}`: {row['sourceText']}" for row in ledger if row["status"] == "unresolved")
    (out / "evidence.md").write_text("\n".join(report) + "\n")
    return packet


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--struct", required=True, type=Path, dest="struct_path")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--epub", action="append", type=Path, default=[])
    parser.add_argument("--cache", action="append", type=Path, default=[])
    args = parser.parse_args()
    packet = build_packet(args.pdf, args.struct_path, args.out, args.epub, args.cache)
    print(json.dumps({"status": packet["status"], "packet": str(args.out.resolve() / "evidence.json"), "lineStatusCounts": packet["lineStatusCounts"]}))


if __name__ == "__main__":
    main()
