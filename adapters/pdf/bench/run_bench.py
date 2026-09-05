#!/usr/bin/env python
"""Run the caption-to-region adjudication benchmark across Claude and OpenAI tiers.

Six models, three capability tiers per platform, one call per item. Every call
records accuracy, input/output/reasoning tokens, latency and dollar cost, so the
question "is a model adjudicator worth it, and which one" has numbers behind it.

The model never writes the EPUB. It answers one bounded question — which caption
belongs to which region — which is exactly what spec 046 permits.

Keys come from a dotenv-style file (default ~/code/erniesg/keys/.env) holding
CLAUDE_API_KEY and OPENAI_API_KEY. Keys are never printed or written to output.

Usage:
  python run_bench.py dataset.json --out results/ [--models all] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# USD per 1M tokens (input, output). Anthropic: docs.claude.com pricing, 2026-09.
# OpenAI: developers.openai.com/api/docs/pricing, 2026-09.
MODELS = {
    "claude-haiku-4-5": {"platform": "anthropic", "tier": "haiku", "in": 1.00, "out": 5.00, "effort": None},
    "claude-sonnet-5": {"platform": "anthropic", "tier": "sonnet", "in": 2.00, "out": 10.00, "effort": "medium"},
    "claude-opus-5": {"platform": "anthropic", "tier": "opus", "in": 5.00, "out": 25.00, "effort": "medium"},
    "gpt-5-nano": {"platform": "openai", "tier": "haiku", "in": 0.05, "out": 0.40, "effort": "medium"},
    "gpt-5-mini": {"platform": "openai", "tier": "sonnet", "in": 0.25, "out": 2.00, "effort": "medium"},
    "gpt-5": {"platform": "openai", "tier": "opus", "in": 1.25, "out": 10.00, "effort": "medium"},
}

SYSTEM = (
    "You adjudicate one bounded layout question for a PDF-to-EPUB pipeline. "
    "A page carries several figure regions and several figure captions. "
    "Decide which caption belongs to which region.\n"
    "Coordinates are PDF points with the origin at the bottom-left of the page, so a larger "
    "`top` value is higher up the page. Each box gives left, right, top, bottom.\n"
    "Papers place captions either below or above their figures, but consistently within one paper, "
    "and figure numbering ascends in reading order (in a two-column paper: left column top-to-bottom, "
    "then right column).\n"
    "Answer with JSON only, no prose, no code fence: "
    '{"assignments": {"C1": "R2", "C2": "R1"}}. '
    "Every caption id must appear exactly once and every region id must be used exactly once."
)


def prompt_for(item: dict) -> str:
    lines = [
        f"Page {item['page']} of {item['paper']}, "
        f"{item['pageSize']['width']} x {item['pageSize']['height']} points.",
        "",
        "Figure regions (the artwork):",
    ]
    for region in item["regions"]:
        b = region["bbox"]
        lines.append(f"  {region['id']}: left={b['left']} right={b['right']} top={b['top']} bottom={b['bottom']}")
    lines += ["", "Captions:"]
    for caption in item["captions"]:
        b = caption["bbox"]
        lines.append(f"  {caption['id']}: left={b['left']} right={b['right']} top={b['top']} bottom={b['bottom']}")
        lines.append(f"      text: {caption['text']}")
    lines += ["", "Return the caption-to-region assignment as JSON."]
    return "\n".join(lines)


def _as_assignments(parsed) -> dict[str, str] | None:
    if not isinstance(parsed, dict):
        return None
    body = parsed.get("assignments", parsed)
    if isinstance(body, dict) and body and all(isinstance(v, str) for v in body.values()):
        return {str(k): v for k, v in body.items()}
    if isinstance(body, list):
        pairs = {}
        for entry in body:
            if isinstance(entry, dict) and "caption" in entry and "region" in entry:
                pairs[str(entry["caption"])] = str(entry["region"])
        return pairs or None
    return None


def parse_assignments(text: str, item: dict | None = None) -> dict[str, str] | None:
    """Take the model's last stated answer.

    Models sometimes emit a first answer, notice a clash, and restate. Reading
    only the first object would score a self-correction as a failure, so every
    balanced JSON object in the reply is collected and the last one that is a
    clean bijection wins; failing that, the last one that parses at all.
    """
    if not text:
        return None
    body = text.replace("```json", "```").replace("```", "\n")
    found: list[dict[str, str]] = []
    for start, character in enumerate(body):
        if character != "{":
            continue
        depth = 0
        for end in range(start, len(body)):
            if body[end] == "{":
                depth += 1
            elif body[end] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(body[start : end + 1])
                    except json.JSONDecodeError:
                        break
                    assignments = _as_assignments(parsed)
                    if assignments:
                        found.append(assignments)
                    break
    if not found:
        return None
    if item:
        gold = item["gold"]
        bijective = [
            a for a in found
            if sorted(a.keys()) == sorted(gold.keys()) and sorted(a.values()) == sorted(gold.values())
        ]
        if bijective:
            return bijective[-1]
    return found[-1]


# --------------------------------------------------------------------------- calls


def call_anthropic(client, model: str, item: dict, spec: dict) -> dict:
    kwargs = dict(model=model, max_tokens=4096, system=SYSTEM,
                  messages=[{"role": "user", "content": prompt_for(item)}])
    if spec["effort"]:
        kwargs["thinking"] = {"type": "adaptive"}
        kwargs["output_config"] = {"effort": spec["effort"]}
    response = client.messages.create(**kwargs)
    text = "".join(block.text for block in response.content if block.type == "text")
    usage = response.usage
    return {
        "text": text,
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cachedInputTokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "reasoningTokens": None,  # Anthropic bills thinking inside output_tokens
        "stopReason": response.stop_reason,
    }


def call_openai(client, model: str, item: dict, spec: dict) -> dict:
    response = client.responses.create(
        model=model,
        instructions=SYSTEM,
        input=prompt_for(item),
        reasoning={"effort": spec["effort"]},
        max_output_tokens=4096,
    )
    usage = response.usage
    details = getattr(usage, "output_tokens_details", None)
    cached = getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", 0) or 0
    return {
        "text": response.output_text or "",
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cachedInputTokens": cached,
        "reasoningTokens": getattr(details, "reasoning_tokens", None),
        "stopReason": response.status,
    }


def score(item: dict, assignments: dict[str, str] | None) -> dict:
    gold = item["gold"]
    if not assignments:
        return {"parsed": False, "exact": False, "correctCaptions": 0, "captions": len(gold)}
    correct = sum(1 for caption, region in gold.items() if assignments.get(caption) == region)
    wellFormed = sorted(assignments.keys()) == sorted(gold.keys()) and sorted(assignments.values()) == sorted(gold.values())
    return {
        "parsed": True,
        "wellFormed": wellFormed,
        "exact": correct == len(gold),
        "correctCaptions": correct,
        "captions": len(gold),
    }


def run_one(clients, model: str, item: dict, attempts: int = 4) -> dict:
    spec = MODELS[model]
    started = time.time()
    error = None
    for attempt in range(attempts):
        try:
            caller = call_anthropic if spec["platform"] == "anthropic" else call_openai
            raw = caller(clients[spec["platform"]], model, item, spec)
            elapsed = time.time() - started
            assignments = parse_assignments(raw["text"], item)
            billed_input = max(raw["inputTokens"] - raw["cachedInputTokens"], 0)
            cost = (billed_input * spec["in"] + raw["outputTokens"] * spec["out"]) / 1_000_000
            cost += raw["cachedInputTokens"] * spec["in"] * 0.1 / 1_000_000
            return {
                "model": model, "platform": spec["platform"], "tier": spec["tier"],
                "item": item["id"], "figureCount": item["figureCount"],
                "seconds": round(elapsed, 2), "costUsd": cost,
                "inputTokens": raw["inputTokens"], "outputTokens": raw["outputTokens"],
                "cachedInputTokens": raw["cachedInputTokens"], "reasoningTokens": raw["reasoningTokens"],
                "stopReason": raw["stopReason"], "assignments": assignments,
                "responseHead": raw["text"][:200],
                **score(item, assignments),
            }
        except Exception as failure:  # rate limits, transient 5xx
            error = f"{type(failure).__name__}: {failure}"
            if attempt == attempts - 1:
                break
            time.sleep(2 ** attempt + 1)
    return {
        "model": model, "platform": spec["platform"], "tier": spec["tier"],
        "item": item["id"], "figureCount": item["figureCount"],
        "seconds": round(time.time() - started, 2), "costUsd": 0.0,
        "inputTokens": 0, "outputTokens": 0, "cachedInputTokens": 0, "reasoningTokens": None,
        "error": error, "parsed": False, "exact": False,
        "correctCaptions": 0, "captions": len(item["gold"]),
    }


def load_env(path: Path) -> None:
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def summarize(rows: list[dict]) -> list[dict]:
    summary = []
    for model, spec in MODELS.items():
        mine = [row for row in rows if row["model"] == model]
        if not mine:
            continue
        captions = sum(row["captions"] for row in mine)
        summary.append({
            "model": model, "platform": spec["platform"], "tier": spec["tier"],
            "items": len(mine),
            "pageAccuracy": round(sum(1 for r in mine if r["exact"]) / len(mine), 4),
            "captionAccuracy": round(sum(r["correctCaptions"] for r in mine) / captions, 4) if captions else None,
            "parseFailures": sum(1 for r in mine if not r["parsed"]),
            "errors": sum(1 for r in mine if r.get("error")),
            "inputTokens": sum(r["inputTokens"] for r in mine),
            "outputTokens": sum(r["outputTokens"] for r in mine),
            "reasoningTokens": sum(r["reasoningTokens"] or 0 for r in mine) or None,
            "totalCostUsd": round(sum(r["costUsd"] for r in mine), 6),
            "costPer100PagesUsd": round(sum(r["costUsd"] for r in mine) / len(mine) * 100, 4),
            "medianSeconds": round(statistics.median(r["seconds"] for r in mine), 2),
            "p90Seconds": round(sorted(r["seconds"] for r in mine)[int(len(mine) * 0.9) - 1], 2),
        })
    summary.sort(key=lambda s: (-s["pageAccuracy"], s["totalCostUsd"]))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset")
    parser.add_argument("--out", required=True)
    parser.add_argument("--env", default=str(Path.home() / "code/erniesg/keys/.env"))
    parser.add_argument("--models", default="all")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    load_env(Path(args.env))
    import anthropic
    import openai

    clients = {
        "anthropic": anthropic.Anthropic(api_key=os.environ["CLAUDE_API_KEY"], max_retries=3, timeout=300.0),
        "openai": openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=3, timeout=300.0),
    }
    wanted = list(MODELS) if args.models == "all" else [m.strip() for m in args.models.split(",") if m.strip()]
    unknown = [m for m in wanted if m not in MODELS]
    if unknown:
        parser.error(f"unknown model(s): {', '.join(unknown)}")

    dataset = json.loads(Path(args.dataset).read_text())
    items = dataset["items"][: args.limit] if args.limit else dataset["items"]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    jobs = [(model, item) for model in wanted for item in items]
    rows: list[dict] = []
    lock = threading.Lock()
    done = 0
    print(f"{len(jobs)} calls: {len(wanted)} models x {len(items)} items", file=sys.stderr, flush=True)

    def work(job):
        nonlocal done
        model, item = job
        row = run_one(clients, model, item)
        with lock:
            rows.append(row)
            done += 1
            if done % 20 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}", file=sys.stderr, flush=True)
        return row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, jobs))

    rows.sort(key=lambda r: (r["model"], r["item"]))
    with (out / "calls.jsonl").open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    summary = summarize(rows)
    (out / "summary.json").write_text(json.dumps(
        {"dataset": args.dataset, "items": len(items), "models": summary,
         "grandTotalUsd": round(sum(s["totalCostUsd"] for s in summary), 6)}, indent=1))

    width = max(len(s["model"]) for s in summary)
    print(f"\n{'model':{width}}  {'tier':7} {'page acc':>8} {'cap acc':>8} {'in tok':>9} {'out tok':>9} {'cost $':>9} {'med s':>6}")
    for s in summary:
        print(f"{s['model']:{width}}  {s['tier']:7} {s['pageAccuracy']:>8.3f} {s['captionAccuracy']:>8.3f} "
              f"{s['inputTokens']:>9} {s['outputTokens']:>9} {s['totalCostUsd']:>9.4f} {s['medianSeconds']:>6.1f}")
    print(f"\ntotal spend: ${sum(s['totalCostUsd'] for s in summary):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
