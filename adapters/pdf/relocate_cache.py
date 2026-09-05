#!/usr/bin/env python
"""Point a Docling cache's image URIs at the artifacts sitting beside it.

`DoclingDocument.save_as_json(..., ImageRefMode.REFERENCED)` writes **absolute**
paths for every page image and picture crop. That makes a cache directory
non-portable in a way that fails silently and expensively: move it to another
machine, or let the directory it was written next to get cleaned, and every
image stops resolving while `--reuse-json` still reports a successful run. The
figures just disappear — a paper that scored `figs=7/7` scores `figs=0/7` and
nothing raises.

This rewrites each `<stem>.docling.json` so every URI whose file exists in the
sibling `<stem>.docling_artifacts/` directory points there instead. It only
touches URIs it can resolve, and reports the ones it cannot.

  python relocate_cache.py <run dir> [<run dir> ...] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

URI = re.compile(r'"uri"\s*:\s*"([^"]+)"')


def relocate(run: Path, dry_run: bool) -> tuple[int, int, int]:
    rewritten = unchanged = unresolved = 0
    for cache in sorted(run.glob("*/*.docling.json")):
        stem = cache.name[: -len(".docling.json")]
        artifacts = cache.parent / f"{stem}.docling_artifacts"
        if not artifacts.is_dir():
            continue
        text = cache.read_text()
        changes = 0
        missing = 0

        def point_home(match: re.Match) -> str:
            nonlocal changes, missing
            uri = match.group(1)
            name = uri.rsplit("/", 1)[-1]
            target = artifacts / name
            if not target.is_file():
                missing += 1
                return match.group(0)
            if uri == str(target):
                return match.group(0)
            changes += 1
            return f'"uri": "{target}"'

        updated = URI.sub(point_home, text)
        unresolved += missing
        if changes:
            rewritten += 1
            if not dry_run:
                cache.write_text(updated)
        else:
            unchanged += 1
    return rewritten, unchanged, unresolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    total = [0, 0, 0]
    for raw in args.runs:
        run = Path(raw).expanduser()
        rewritten, unchanged, unresolved = relocate(run, args.dry_run)
        print(f"{run}: {rewritten} rewritten, {unchanged} already correct, {unresolved} URIs with no local file")
        total = [a + b for a, b in zip(total, (rewritten, unchanged, unresolved))]
    print(f"total: {total[0]} rewritten, {total[1]} already correct, {total[2]} unresolved")
    if total[2]:
        print("unresolved URIs mean the artifacts directory is incomplete; those images will not render")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
