#!/usr/bin/env python
"""Fail-closed independent verification for cached PDF-to-EPUB replays.

Usage:
  python verify_outputs.py --run tuning=/path/to/run --baseline tuning=/path/to/history \
      --out /path/to/verification [--epubcheck epubcheck]

Each run needs ``corpus-report.json``, ``source-report.json``, and
``cache-manifest.json`` at its root.  The source report binds the input name
and digest; the cache manifest binds the exact relocated cache bytes and its
declared image assets.  This verifier intentionally compares report metrics,
not historical output bytes: renderer output can vary across platforms.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterator
from PIL import Image


REQUIRED_METRICS = ("completeness", "readiness", "diagnosticCounts")
REQUIRED_PROFILES = {"paperPro", "paperProMove"}
HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_hash(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def read_json(path: Path, problems: list[str], label: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        problems.append(f"{label}: cannot read JSON ({type(error).__name__})")
        return None
    if not isinstance(value, dict):
        problems.append(f"{label}: JSON root is not an object")
        return None
    return value


def document_index(report: dict[str, Any] | None, problems: list[str], label: str, schema: str | None = None) -> dict[str, dict[str, Any]]:
    if schema and (not report or report.get("schemaVersion") != schema):
        problems.append(f"{label}: schema is missing or invalid")
        return {}
    documents = report.get("documents") if report else None
    if not isinstance(documents, list):
        problems.append(f"{label}: documents is missing or invalid")
        return {}
    if not documents:
        problems.append(f"{label}: documents must be non-empty")
    indexed: dict[str, dict[str, Any]] = {}
    for document in documents:
        basename = document.get("basename") if isinstance(document, dict) else None
        if not isinstance(basename, str) or not basename:
            problems.append(f"{label}: document has no basename")
        elif basename in indexed:
            problems.append(f"{label}: duplicate basename: {basename}")
        else:
            indexed[basename] = document
    return indexed


def manifest_index(manifest: dict[str, Any] | None, problems: list[str], label: str) -> dict[str, dict[str, Any]]:
    if not manifest or manifest.get("schemaVersion") != "pdf-cache-manifest-1":
        problems.append(f"{label}: cache manifest schema is missing or invalid")
        return {}
    return document_index(manifest, problems, label)


def resolved_asset(path: str, root: Path) -> Path:
    candidate = Path(path)
    return (candidate if candidate.is_absolute() else root / candidate).resolve()


def image_is_readable(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
        return True
    except Exception:
        return False


COUNT_METRICS = (
    "sourceTextCharacters", "outputTextCharacters", "missingSourceRegionCount",
    "unresolvedCorruptingJoinCount", "readingOrderDiagnostics", "expectedInlineSpanCount",
    "expectedHyperlinkCount", "mappedHyperlinkCount", "expectedRelationshipCount",
    "resolvedRelationshipCount", "sourceAssetCount", "exportedAssetCount",
    "expectedSemanticTableCount", "resolvedSemanticTableCount", "furnitureExcludedRunCount",
    "furnitureContaminationCount", "equationCount", "internalLinkAnnotations",
)
COVERAGE_METRICS = ("textCoverage", "inlineSpanCoverage", "hyperlinkCoverage", "relationshipCoverage", "assetCoverage", "semanticTableCoverage")
UNRESOLVED_METRICS = ("assets", "captions", "tables", "equations", "citations", "footnoteReferences", "footnotes")


def nonnegative_integer(value: Any) -> bool:
    return type(value) is int and value >= 0


def required_metrics(document: dict[str, Any], prefix: str, problems: list[str]) -> bool:
    """Validate the evaluator's emitted metric schema, once per report."""
    before = len(problems)
    completeness = document.get("completeness")
    invalid = []
    if not isinstance(completeness, dict):
        invalid.append("object")
    else:
        invalid.extend(key for key in COUNT_METRICS if not nonnegative_integer(completeness.get(key)))
        for key in COVERAGE_METRICS:
            value = completeness.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                invalid.append(key)
        unresolved = completeness.get("unresolvedObjects")
        if not isinstance(unresolved, dict) or any(not nonnegative_integer(unresolved.get(key)) for key in UNRESOLVED_METRICS):
            invalid.append("unresolvedObjects")
        pages = completeness.get("ocrRequiredPages")
        if not isinstance(pages, list) or any(not nonnegative_integer(page) or page < 1 for page in pages):
            invalid.append("ocrRequiredPages")
    if invalid:
        problems.append(f"{prefix}: completeness metric schema is invalid: {', '.join(invalid)}")
    readiness = document.get("readiness")
    if (not isinstance(readiness, dict) or readiness.get("status") not in {"ready", "review-required"}
            or type(readiness.get("ready")) is not bool
            or readiness.get("ready") != (readiness.get("status") == "ready")
            or readiness.get("policy") != "docling-epub-reader-criteria-v1"
            or not isinstance(readiness.get("blockingDiagnosticCodes"), list)
            or any(not isinstance(code, str) or not code for code in readiness.get("blockingDiagnosticCodes", []))):
        problems.append(f"{prefix}: readiness metric schema is invalid")
    diagnostics = document.get("diagnosticCounts")
    if not isinstance(diagnostics, dict) or any(not isinstance(code, str) or not code or not nonnegative_integer(count) for code, count in diagnostics.items()):
        problems.append(f"{prefix}: diagnosticCounts metric schema is invalid")
    return len(problems) == before


def check_source_binding(document: dict[str, Any], manifest: dict[str, Any] | None,
                         peers: list[dict[str, Any] | None], prefix: str, problems: list[str],
                         pdf: Path | None = None) -> None:
    """One binding contract for generation, replay, and independent verification.

    Explicitly declared source/image targets may be preserved private archives;
    symlinks to those targets are allowed. The cache itself must remain in-run.
    """
    expected_hash, expected_bytes = document.get("sha256"), document.get("byteLength")
    bound = [manifest, *peers]
    if (not valid_hash(expected_hash) or not nonnegative_integer(expected_bytes) or expected_bytes == 0
            or any(not peer or peer.get("basename") != document.get("basename")
                   or peer.get("sha256") != expected_hash or peer.get("byteLength") != expected_bytes for peer in bound)):
        problems.append(f"{prefix}: source hash or byteLength is missing or not bound across reports")
    raw = manifest.get("sourcePath") if manifest else None
    if not isinstance(raw, str) or not raw.strip():
        problems.append(f"{prefix}: sourcePath is missing or invalid")
        return
    for label, path in [("source PDF", Path(raw)), *([("current input PDF", pdf)] if pdf is not None else [])]:
        try:
            if not path.is_file() or path.stat().st_size != expected_bytes or sha256(path) != expected_hash:
                problems.append(f"{prefix}: {label} bytes do not match manifest binding")
        except OSError:
            problems.append(f"{prefix}: {label} cannot be read")


def iter_uris(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "uri":
                if not isinstance(item, str) or not item.strip():
                    raise ValueError("cache URI must be a nonempty string")
                yield item
            yield from iter_uris(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_uris(item)


def check_cache(root: Path, corpus: str, document: dict[str, Any], manifest: dict[str, Any] | None, problems: list[str]) -> dict[str, Any]:
    basename = document.get("basename", "?")
    stem = Path(basename).stem
    prefix = f"{corpus}/{stem}"
    if not manifest:
        problems.append(f"{prefix}: cache manifest entry is missing")
        return {"status": "missing"}
    cache_spec = manifest.get("cache")
    if not isinstance(cache_spec, dict) or not isinstance(cache_spec.get("path"), str):
        problems.append(f"{prefix}: cache manifest cache entry is missing")
        return {"status": "missing"}
    expected_path = f"{stem}/{stem}.docling.json"
    cache_path = root / cache_spec["path"]
    if (cache_spec["path"] != expected_path or Path(basename).name != basename
            or not cache_path.resolve().is_relative_to(root.resolve())):
        problems.append(f"{prefix}: cache path is not canonical or escapes run directory")
        return {"status": "invalid"}
    result: dict[str, Any] = {"path": str(cache_path), "assets": []}
    if not cache_path.is_file():
        problems.append(f"{prefix}: cache file is missing")
        return result
    cache_hash = sha256(cache_path)
    result["sha256"] = cache_hash
    if not valid_hash(cache_spec.get("relocatedSha256")) or cache_hash != cache_spec["relocatedSha256"]:
        problems.append(f"{prefix}: cache digest does not match manifest")
    cache_json = read_json(cache_path, problems, f"{prefix}: cache")
    declared_paths: set[Path] = set()
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        problems.append(f"{prefix}: cache asset manifest is missing")
        assets = []
    for asset in assets:
        raw_path = asset.get("path") if isinstance(asset, dict) else None
        asset_path = resolved_asset(raw_path, root) if isinstance(raw_path, str) and raw_path.strip() else root
        if not isinstance(raw_path, str) or not raw_path.strip() or not asset_path.is_file():
            problems.append(f"{prefix}: declared cache asset is missing")
        else:
            if asset_path in declared_paths:
                problems.append(f"{prefix}: duplicate declared cache asset")
            declared_paths.add(asset_path)
            if not valid_hash(asset.get("sha256")) or sha256(asset_path) != asset["sha256"]:
                problems.append(f"{prefix}: declared cache asset digest does not match manifest")
            if not image_is_readable(asset_path):
                problems.append(f"{prefix}: declared cache asset is not a readable image")
    if cache_json:
        seen: set[Path] = set()
        try:
            uris = list(iter_uris(cache_json))
        except ValueError as error:
            problems.append(f"{prefix}: {error}")
            uris = []
        for uri in uris:
            if uri.startswith("data:"):
                problems.append(f"{prefix}: cache URI uses unsupported data scheme")
                continue
            if uri.startswith("file://"):
                problems.append(f"{prefix}: cache URI uses unsupported file scheme: {uri}")
                continue
            target = Path(uri)
            if not target.is_absolute():
                target = cache_path.parent / target
            resolved = target.resolve()
            result["assets"].append({"uri": uri, "path": str(resolved), "exists": resolved.is_file()})
            if not resolved.is_file():
                problems.append(f"{prefix}: cache URI does not resolve: {uri}")
            else:
                seen.add(resolved)
                if resolved not in declared_paths:
                    problems.append(f"{prefix}: cache URI is not declared by manifest: {uri}")
                elif not image_is_readable(resolved):
                    problems.append(f"{prefix}: cache URI target is not a readable image: {uri}")
        if seen != declared_paths:
            problems.append(f"{prefix}: manifest assets and cache URIs differ")
    return result


def reuse_cache_problems(root: Path, pdf: Path, cache_path: Path) -> list[str]:
    """Return binding failures before the adapter reuses a Docling cache."""
    problems: list[str] = []
    source = document_index(read_json(root / "source-report.json", problems, "source report"), problems, "source report", "pdf-source-report-1")
    manifest = manifest_index(read_json(root / "cache-manifest.json", problems, "cache manifest"), problems, "cache manifest")
    document = source.get(pdf.name)
    cache = manifest.get(pdf.name)
    if document is None:
        problems.append(f"{pdf.name}: input is not bound to source report")
        return problems
    check_source_binding(document, cache, [], f"reuse/{pdf.stem}", problems, pdf)
    required_metrics(document, f"reuse/{pdf.stem}: source report", problems)
    canonical = root / pdf.stem / f"{pdf.stem}.docling.json"
    if cache_path.absolute() != canonical.absolute():
        problems.append(f"{pdf.name}: cache path is not canonical")
    check_cache(root, "reuse", document, cache, problems)
    return problems


def run_epubcheck(path: Path, command: str) -> dict[str, Any]:
    executable = shutil.which(command) if os.path.sep not in command else command
    if not executable:
        return {"file": str(path), "available": False, "returncode": None, "output": ""}
    try:
        result = subprocess.run([executable, str(path)], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"file": str(path), "available": True, "returncode": None, "output": type(error).__name__}
    return {"file": str(path), "available": True, "returncode": result.returncode, "output": (result.stdout + result.stderr)[-4000:]}


def adapter_code() -> list[Path]:
    """Every file that decides what the run produces.

    The rules live in a module each, so listing the entry points by hand would
    bind the manifest to a fraction of the code that wrote the output.
    """
    return sorted(p for p in HERE.glob("*.py") if p.name != "verify_outputs.py") + [HERE / "render.mjs", REPOSITORY / "package-lock.json"]


def file_manifest(paths: list[Path]) -> dict[str, dict[str, Any]]:
    return {str(path.relative_to(REPOSITORY)): {"sha256": sha256(path), "bytes": path.stat().st_size} for path in paths if path.is_file()}


def check_render(root: Path, corpus: str, document: dict[str, Any], problems: list[str]) -> tuple[dict[str, Any], list[Path]]:
    stem = Path(document["basename"]).stem
    prefix = f"{corpus}/{stem}"
    folder = root / stem
    render = read_json(folder / "render-report.json", problems, f"{prefix}: render report") or {}
    status = render.get("returncode")
    if status != 0:
        problems.append(f"{prefix}: renderer return code is missing or nonzero")
    if render.get("errors") != []:
        problems.append(f"{prefix}: renderer errors are present")
    profiles = render.get("profiles")
    if not isinstance(profiles, list):
        problems.append(f"{prefix}: renderer profiles are missing")
        return {"returncode": status, "profiles": []}, []
    ids = [profile.get("id") for profile in profiles if isinstance(profile, dict)]
    if len(ids) != len(set(ids)):
        problems.append(f"{prefix}: duplicate profile ids")
    if set(ids) != REQUIRED_PROFILES or len(profiles) != len(REQUIRED_PROFILES):
        problems.append(f"{prefix}: profiles are partial or unexpected")
    artifacts: dict[str, Any] = {}
    epubs: list[Path] = []
    for name in ("struct.json", "content.xhtml"):
        path = folder / name
        if not path.is_file():
            problems.append(f"{prefix}: required artifact is missing: {name}")
        else:
            artifacts[name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    for profile in profiles:
        if not isinstance(profile, dict) or not isinstance(profile.get("fileName"), str):
            problems.append(f"{prefix}: profile artifact metadata is invalid")
            continue
        expected_name = f"{stem}-{'paperpro' if profile.get('id') == 'paperPro' else 'papermove'}.epub"
        if profile.get("fileName") != expected_name:
            problems.append(f"{prefix}: profile filename is not canonical")
            continue
        path = folder / profile["fileName"]
        if path.parent != folder or path.resolve().parent != folder.resolve():
            problems.append(f"{prefix}: profile EPUB escapes its document directory")
            continue
        if not path.is_file():
            problems.append(f"{prefix}: profile EPUB is missing: {profile['fileName']}")
            continue
        actual_hash, actual_bytes = sha256(path), path.stat().st_size
        artifacts[profile["fileName"]] = {"sha256": actual_hash, "bytes": actual_bytes}
        if profile.get("sha256") != actual_hash or profile.get("bytes") != actual_bytes:
            problems.append(f"{prefix}: profile artifact hash or size mismatch")
        epubs.append(path.resolve())
    if len(set(epubs)) != len(epubs) or len({(path.stat().st_dev, path.stat().st_ino) for path in epubs}) != len(epubs):
        problems.append(f"{prefix}: profile EPUB paths or inodes are not distinct")
    return {"returncode": status, "profiles": ids, "artifacts": artifacts}, epubs


def verify(runs: dict[str, Path], baselines: dict[str, Path], output: Path, epubcheck_command: str) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    results: list[dict[str, Any]] = []
    validations: list[dict[str, Any]] = []
    if not runs or set(runs) != set(baselines):
        problems.append("run and baseline corpus labels must be non-empty and identical")
    for corpus, root in sorted(runs.items()):
        baseline_root = baselines.get(corpus)
        current = document_index(read_json(root / "corpus-report.json", problems, f"{corpus}: corpus report"), problems, f"{corpus}: corpus report", "docling-struct-report-1.0.0")
        source = document_index(read_json(root / "source-report.json", problems, f"{corpus}: source report"), problems, f"{corpus}: source report", "pdf-source-report-1")
        cache = manifest_index(read_json(root / "cache-manifest.json", problems, f"{corpus}: cache manifest"), problems, f"{corpus}: cache manifest")
        baseline_source = document_index(read_json(baseline_root / "source-report.json", problems, f"{corpus}: baseline source report") if baseline_root else None, problems, f"{corpus}: baseline source report", "pdf-source-report-1")
        baseline = document_index(read_json(baseline_root / "corpus-report.json", problems, f"{corpus}: baseline corpus report") if baseline_root else None, problems, f"{corpus}: baseline corpus report", "docling-struct-report-1.0.0")
        if set(current) != set(source) or set(current) != set(baseline_source) or set(current) != set(baseline) or set(current) != set(cache):
            problems.append(f"{corpus}: input basename set differs from trusted source report")
        stems = [Path(name).stem for name in current]
        if len(stems) != len(set(stems)):
            problems.append(f"{corpus}: duplicate PDF stems")
        for basename, document in sorted(current.items()):
            prefix = f"{corpus}/{Path(basename).stem}"
            trusted = source.get(basename)
            anchored = baseline_source.get(basename)
            historic = baseline.get(basename)
            check_source_binding(document, cache.get(basename), [trusted, anchored, historic], prefix, problems)
            validity = {}
            for label, report in [("current report", document), ("source report", trusted), ("baseline source report", anchored), ("baseline corpus report", historic)]:
                validity[label] = required_metrics(report or {}, f"{prefix}: {label}", problems)
            metric_diffs: dict[str, Any] = {}
            if validity["current report"] and validity["baseline corpus report"]:
                for metric in REQUIRED_METRICS:
                    metric_diffs[metric] = {"status": "equal" if document[metric] == historic[metric] else "changed", "current": document[metric], "baseline": historic[metric]}
            cache_record = check_cache(root, corpus, document, cache.get(basename), problems)
            render_record, epubs = check_render(root, corpus, document, problems)
            if not problems or not any(item.startswith(prefix + ":") for item in problems):
                for epub in epubs:
                    check = run_epubcheck(epub, epubcheck_command)
                    log_name = hashlib.sha256(str(epub).encode()).hexdigest() + ".epubcheck.txt"
                    log = output / log_name
                    log.write_text(check.pop("output", "") + "\n")
                    check["log"] = log_name
                    check["logSha256"] = sha256(log)
                    validations.append(check)
                    if not check["available"] or check["returncode"] != 0:
                        problems.append(f"{prefix}: EPUBCheck unavailable or failed: {epub.name}")
            results.append({"corpus": corpus, "basename": basename, "inputSha256": document.get("sha256"), "cache": cache_record, "render": render_record, "metricDiffs": metric_diffs})
    result = {"schemaVersion": "pdf-output-verification-1", "artifactValid": not problems, "baselineComparison": {"status": "recorded", "note": "Metric changes are recorded per paper and are not verification failures."}, "problems": problems, "documents": results, "epubcheck": validations,
              "manifests": {"code": file_manifest(adapter_code()),
                            "environment": {"python": sys.version, "epubcheck": shutil.which(epubcheck_command) if os.path.sep not in epubcheck_command else epubcheck_command}},
              "summary": {"documents": len(results), "epubs": len(validations), "problems": len(problems)}}
    (output / "output-verification.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def mappings(values: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        label, separator, path = value.partition("=")
        if not separator or not label or label in result:
            raise argparse.ArgumentTypeError("each corpus must be a unique LABEL=PATH mapping")
        result[label] = Path(path).resolve()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="append", required=True, metavar="LABEL=PATH")
    parser.add_argument("--baseline", action="append", required=True, metavar="LABEL=PATH")
    parser.add_argument("--out", required=True)
    parser.add_argument("--epubcheck", default="epubcheck")
    args = parser.parse_args()
    try:
        result = verify(mappings(args.run), mappings(args.baseline), Path(args.out).resolve(), args.epubcheck)
    except argparse.ArgumentTypeError as error:
        parser.error(str(error))
    print(json.dumps(result["summary"]), flush=True)
    if result["problems"]:
        print("\n".join(result["problems"][:20]), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
