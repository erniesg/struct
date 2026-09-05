# bench: what a model adjudicator is worth

Spec 046 lets a model settle residual ambiguities and nothing else — it may
never write the EPUB, and every decision it makes becomes a fixture and then a
rule. Before wiring one in, it is worth knowing which model, at what accuracy,
and at what price. This is that measurement.

## The task

The residual behind most remaining figure failures is a page carrying several
figure regions and several `Figure N` captions where geometry alone does not
say which belongs to which. The benchmark poses exactly that: region boxes,
caption boxes and caption text for one page, and asks for the mapping. Nothing
else is asked of the model.

## Where the ground truth comes from

Not from our rules — scoring a model against the adapter would only measure
imitation. Gold comes from Docling's own picture→caption attachment, kept only
where a second, independent signal agrees: the caption labels, read in
two-column reading order of their regions, come out in ascending numeric order.
Pages where those two disagree are dropped rather than guessed at.

Regions and captions are relabelled `R1..Rn` / `C1..Cn` and shuffled with a
per-page seed, so a model cannot score by echoing input order.

```bash
python build_dataset.py <corpus run dir> --out dataset.json --limit 60
python run_bench.py dataset.json --out results/            # all six models
python run_bench.py dataset.json --out results/ --models claude-opus-5,gpt-5
```

Keys are read from `~/code/erniesg/keys/.env` (`CLAUDE_API_KEY`,
`OPENAI_API_KEY`); nothing about a key is printed or written to the output.

`results/calls.jsonl` holds one row per call — tokens, latency, cost, the
parsed answer and the head of the reply. `results/summary.json` aggregates it.

## Result, 60 pages from the 80-paper corpus, 2026-09-06

34 papers, 47 pages with two figures, 8 with three, 5 with four or more.
Reasoning effort `medium` everywhere it can be set; Claude Haiku 4.5 has no
effort control, so it ran without thinking. 360 calls, $0.95 all in.

```
model             tier    page acc  cap acc   out tok   cost $   med s  parse fails
gpt-5-mini        sonnet     1.000    1.000     33156   0.0727     6.4      0
claude-opus-5     opus       1.000    1.000      2663   0.2468     2.0      0
gpt-5             opus       1.000    1.000     36166   0.3936     7.0      0
claude-sonnet-5   sonnet     0.983    0.986      6045   0.1326     1.8      0
gpt-5-nano        haiku      0.933    0.899    140017   0.0573    10.7      4
claude-haiku-4-5  haiku      0.883    0.884      2775   0.0421     0.9      0
```

Reading it:

- **Three models are perfect on this task**, and the cheapest of them —
  `gpt-5-mini` at $0.12 per 100 pages — costs a third of `claude-opus-5` and a
  fifth of `gpt-5`. On this evidence the adjudicator should be a mid-tier model.
- **Claude is the latency answer, OpenAI the price answer.** `claude-opus-5`
  answers in 2.0 s median against 7.0 s for `gpt-5`, because it spends 2.7K
  output tokens where `gpt-5` spends 36K — almost all of it reasoning. Per
  correct answer, Claude is dearer per token and cheaper per second.
- **The bottom tier is not usable unattended.** `gpt-5-nano` burned 137K
  reasoning tokens over 60 pages and hit the 4096-token output cap four times,
  producing no answer at all; `claude-haiku-4-5` answers in under a second but
  gets one page in nine wrong. Either is fine as a first pass whose output a
  rule re-checks, neither as the last word.
- **Nothing failed to produce parseable JSON except by truncation.** Format
  compliance is not the differentiator any more; geometric reasoning is.

The honest caveat: these pages are the ones where the gold is *unambiguous*,
because that is the only place ground truth exists without hand labelling. The
pages the pipeline actually fails on are harder than these by construction, so
read the table as an upper bound on adjudicator accuracy, not an estimate of it.
