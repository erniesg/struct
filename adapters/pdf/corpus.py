#!/usr/bin/env python3
"""Build, run and score a corpus of papers, from a manifest that records it.

    corpus.py fetch   <root> [--count N]   add papers, recording where each came from
    corpus.py run     <root> <set>         convert and score one set
    corpus.py compare <root> <set> <base>  per-paper criteria against a snapshot
    corpus.py status  <root>               what the manifest holds

Why a manifest rather than a directory of PDFs: a measurement is only worth
something if someone else can get the same corpus. `corpus.json` records, for
every paper, where it came from, the sha256 of the bytes that were scored, and
which set it belongs to — so the corpus can be rebuilt, and so which papers
were held out is a fact on disk rather than a claim.

The split is computed from each file's own digest, not chosen:

    heldout when int(sha256[:8], 16) % 3 == 0, else dev

A held-out paper is converted and scored ONCE, at the end of a piece of work.
Reading its failures and fixing them makes it a dev paper, and the number it
gave stops meaning anything. That is not a rule this file can enforce; it is
written here because it is the only thing that makes the number honest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ATOM = "{http://www.w3.org/2005/Atom}"
MANIFEST = "corpus.json"
SCHEMA = "pdf-corpus-manifest-1"

# Typography differs far more between a maths preprint, a biology journal and
# an economics working paper than between two arXiv cs papers, and it is the
# typography the rules read.
CATEGORIES = [
    "cs.CL", "cs.LG", "cs.CV", "cs.SE", "cs.CR",
    "math.PR", "math.AP", "math.CO",
    "stat.ME", "econ.EM", "q-fin.ST",
    "physics.optics", "cond-mat.stat-mech", "astro-ph.GA",
    "q-bio.NC", "q-bio.PE", "eess.SP", "nlin.AO",
]
# arXiv asks for one request every three seconds and answers 403 when pushed;
# every call goes through `_get`, which waits and retries rather than dropping
# the category and quietly shrinking the corpus.
MIN_INTERVAL = 3.0
RETRIES = 4

_last_call = 0.0


def _get(url: str, timeout: int = 120) -> bytes:
    global _last_call
    for attempt in range(RETRIES):
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in (403, 429, 503) or attempt == RETRIES - 1:
                raise
            time.sleep(MIN_INTERVAL * (2 ** attempt))  # back off, then try again
    raise RuntimeError("unreachable")


def load(root: Path) -> dict:
    path = root / MANIFEST
    if path.exists():
        return json.loads(path.read_text())
    return {"schemaVersion": SCHEMA, "rule": "heldout when int(sha256[:8],16) % 3 == 0", "documents": {}}


def save(root: Path, manifest: dict) -> None:
    manifest["counts"] = {}
    for entry in manifest["documents"].values():
        manifest["counts"][entry["set"]] = manifest["counts"].get(entry["set"], 0) + 1
    (root / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")


def assign(digest: str) -> str:
    return "heldout" if int(digest[:8], 16) % 3 == 0 else "dev"


def used_elsewhere(evidence: Path) -> set[str]:
    """Digests already scored in an earlier corpus: a paper the rules have
    seen cannot measure whether they generalise."""
    found = set()
    for pdf in evidence.glob("runs/*/_pdfs/*.pdf"):
        try:
            found.add(hashlib.sha256(pdf.read_bytes()).hexdigest())
        except OSError:
            continue
    return found


def fetch(root: Path, count: int, evidence: Path) -> int:
    manifest = load(root)
    pdfs = root / "pdfs"
    pdfs.mkdir(parents=True, exist_ok=True)
    seen = used_elsewhere(evidence) | {e["sha256"] for e in manifest["documents"].values()}
    per_category = max(1, count // len(CATEGORIES))
    added = 0

    for category in CATEGORIES:
        url = (f"http://export.arxiv.org/api/query?search_query=cat:{category}"
               f"&sortBy=submittedDate&sortOrder=descending&max_results={per_category * 4}")
        try:
            feed = ET.fromstring(_get(url, timeout=60))
        except Exception as error:
            print(f"  {category}: listing unavailable ({type(error).__name__}) — no papers taken", file=sys.stderr)
            continue
        taken = 0
        for entry in feed.findall(f"{ATOM}entry"):
            if taken >= per_category:
                break
            stem = (entry.findtext(f"{ATOM}id") or "").rsplit("/", 1)[-1]
            if not stem or f"{stem}.pdf" in manifest["documents"]:
                continue
            source = f"https://arxiv.org/pdf/{stem}"
            try:
                body = _get(source)
            except Exception:
                continue
            if not body.startswith(b"%PDF") or len(body) < 40_000:
                continue
            digest = hashlib.sha256(body).hexdigest()
            if digest in seen:
                continue
            (pdfs / f"{stem}.pdf").write_bytes(body)
            manifest["documents"][f"{stem}.pdf"] = {
                "source": source, "category": category, "sha256": digest,
                "bytes": len(body), "set": assign(digest),
            }
            seen.add(digest)
            taken += 1
            added += 1
        print(f"  {category}: {taken}")
    save(root, manifest)
    print(f"added {added}; {json.dumps(manifest['counts'])}")
    return 0


def adopt(root: Path, folder: Path, evidence: Path) -> int:
    """Take local PDFs into the corpus, recording where they came from."""
    manifest = load(root)
    pdfs = root / "pdfs"
    pdfs.mkdir(parents=True, exist_ok=True)
    seen = used_elsewhere(evidence) | {e["sha256"] for e in manifest["documents"].values()}
    added = 0
    for pdf in sorted(folder.glob("*.pdf")):
        body = pdf.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if digest in seen:
            continue
        (pdfs / pdf.name).write_bytes(body)
        manifest["documents"][pdf.name] = {
            "source": f"local:{pdf}", "category": "local", "sha256": digest,
            "bytes": len(body), "set": assign(digest),
        }
        seen.add(digest)
        added += 1
    save(root, manifest)
    print(f"adopted {added} from {folder}; {json.dumps(manifest['counts'])}")
    return 0


def run(root: Path, which: str, workers: int, struct: Path) -> int:
    """Convert and score one set, from the manifest rather than a directory
    listing, so a run is always exactly the papers the manifest names."""
    manifest = load(root)
    names = sorted(n for n, e in manifest["documents"].items() if e["set"] == which)
    if not names:
        print(f"no papers in set {which!r}", file=sys.stderr)
        return 1
    run_dir = root / "runs" / which
    (run_dir / "_pdfs").mkdir(parents=True, exist_ok=True)
    for name in names:
        link = run_dir / "_pdfs" / name
        if not link.exists():
            link.symlink_to((root / "pdfs" / name).resolve())
    log = run_dir / "_run.log"
    with log.open("w") as handle:
        code = subprocess.run(
            [str(Path.home() / ".venvs/docling/bin/python"), str(struct / "adapters/pdf/pdf2epub.py"),
             str(run_dir / "_pdfs"), "--out", str(run_dir), "--profiles", "paperPro,paperProMove",
             "--workers", str(workers)], stdout=handle, stderr=subprocess.STDOUT).returncode
    subprocess.run(["node", str(struct / "adapters/pdf/scorecard.mjs"), str(run_dir / "corpus-report.json"),
                    "--out", str(run_dir / "_scorecard.json")], check=False)
    print(f"{which}: {len(names)} papers, adapter exit {code}, log {log}")
    return summarise(run_dir)


def summarise(run_dir: Path) -> int:
    path = run_dir / "_scorecard.json"
    if not path.exists():
        print("no scorecard written", file=sys.stderr)
        return 1
    card = json.loads(path.read_text())
    docs = card["perDocument"]
    clean = [d for d in docs if not any(v == "fail" for v in d["criteria"].values())]
    print(f"{len(clean)}/{len(docs)} papers clean on every applicable criterion")
    for document in docs:
        failed = [k for k, v in document["criteria"].items() if v == "fail"]
        if failed:
            print(f"   FAIL {document['basename']}: {', '.join(failed)}")
    return 0


def compare(root: Path, which: str, baseline: Path) -> int:
    card = json.loads((root / "runs" / which / "_scorecard.json").read_text())
    base = json.loads(baseline.read_text())
    before = {d["basename"]: d["criteria"] for d in base["perDocument"]}
    moved = 0
    for document in card["perDocument"]:
        was = before.get(document["basename"])
        if was is None:
            continue
        for criterion, verdict in document["criteria"].items():
            if was.get(criterion) != verdict:
                print(f"  {document['basename']} {criterion}: {was.get(criterion)} -> {verdict}")
                moved += 1
    print(f"{moved} criterion changes against {baseline.name}")
    return 0


def status(root: Path) -> int:
    manifest = load(root)
    print(json.dumps({"counts": manifest.get("counts", {}), "rule": manifest.get("rule")}, indent=1))
    by_category: dict[str, int] = {}
    for entry in manifest["documents"].values():
        by_category[entry["category"]] = by_category.get(entry["category"], 0) + 1
    print("by category:", json.dumps(by_category, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("fetch", "adopt", "run", "compare", "status"):
        child = sub.add_parser(name)
        child.add_argument("root", type=Path)
        if name == "fetch":
            child.add_argument("--count", type=int, default=72)
        if name == "adopt":
            child.add_argument("folder", type=Path)
        if name in ("run", "compare"):
            child.add_argument("set")
        if name == "run":
            child.add_argument("--workers", type=int, default=3)
            child.add_argument("--struct", type=Path, default=HERE.parent.parent)
        if name == "compare":
            child.add_argument("baseline", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    evidence = root.parent
    if args.command == "fetch":
        return fetch(root, args.count, evidence)
    if args.command == "adopt":
        return adopt(root, args.folder.resolve(), evidence)
    if args.command == "run":
        return run(root, args.set, args.workers, args.struct.resolve())
    if args.command == "compare":
        return compare(root, args.set, args.baseline.resolve())
    return status(root)


if __name__ == "__main__":
    sys.exit(main())
