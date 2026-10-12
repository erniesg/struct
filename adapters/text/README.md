# Text ingestion reference adapter

Convert UTF-8 text to a validated Struct document and reflowable EPUB. This
repository tool lives beside the PDF adapter and consumes only Struct's built
public modules. It is not a published npm export or an acquisition service.

## Use

```sh
npm ci
npm run build
node adapters/text/text2epub.mjs article.txt --metadata metadata.json --out out/article
# Equivalent npm entry point:
npm run text:epub -- article.txt --metadata metadata.json --out out/article
```

The CLI requires Node 20+ and Python 3 on macOS or Linux, with filesystem
support for atomic no-replace rename. The ingestion API itself is Node-only.
The output directory must be new. Input is a regular UTF-8 file up to 1 MiB
and 10,000 nonblank physical lines. There is no automatic deletion or rewriting.
Each physical line becomes a paragraph, so use paragraph-per-line pasted text;
wrapped lines are preserved rather than silently joined. Inline emphasis and
images absent from plain text cannot be recovered. A BOM, indentation,
Unicode line separators and apparent paste errors are preserved.

Supply publication metadata explicitly:

```json
{
  "title": "Article title",
  "subtitle": "",
  "authors": ["Author name"],
  "abstract": "",
  "language": "en",
  "publicationDate": "2013-10-21",
  "publisher": "Publication name"
}
```

`publicationDate`, `publisher` and `language` are optional. The first four
fields follow the existing Struct metadata contract. Artifact modification time
defaults to the epoch; explicit metadata can override it. The same source,
metadata and plan produce the same EPUB bytes. Dates/publishers are emitted by
the core EPUB renderer; no ZIP patching is involved.

Successful output contains `source.txt`, `document.struct.json`,
`document.xhtml` (self-contained styles), `document.epub`, and
`ingestion-report.json`. An applied cleanup plan is also saved. The report hashes
all other artifacts; it does not contain a recursive hash of itself.

## Tracked cleanup and replay

First ingest without cleanup and inspect the report's line IDs, source digest
and offsets. Then supply a JSON cleanup ledger with:

- `schemaVersion`: `1.0.0`
- `sourceSha256`: the exact source SHA-256 from the report
- `actor`: `human`, `codex` or `claude`
- `decisions`: objects containing `blockId`, `action` and a nonblank `reason`
- `consultation`: `{promptSha256, model}`; required for model actors

Actions are `keep`, `remove` and `review`. Unmentioned lines remain kept in human
plans. A removal keeps the original line as furniture inside the Struct graph,
with an explicit-paratext evidence signal; it is hidden only in publication.
The report retains the decision, offsets and source text. No text replacement
or normalization operations exist in this version. Unknown fields, duplicate
or unknown IDs, stale source hashes and malformed decisions fail closed.

```sh
node adapters/text/text2epub.mjs article.txt --metadata metadata.json \
  --cleanup cleanup-plan.json --out out/article-clean
```

`review` keeps the text visible in the draft, adds diagnostics and sets recovery
to `review-required`. The CLI saves source/Struct/report/plan, omits XHTML/EPUB,
and exits **2**. Change those decisions to `keep` or `remove` and replay into a
new directory. Success exits **0**; other errors exit **1**. Files are completed in a private
staging directory and the folder is published with one OS atomic no-replace
operation (`renamex_np`/`RENAME_EXCL` on macOS, `renameat2`/`RENAME_NOREPLACE`
on Linux). An intervening destination, including an empty directory or symlink,
is preserved and causes failure. The Python helper uses only the standard
library, runs in isolated mode, and refuses unsupported platforms/filesystems;
there is no unsafe rename fallback. Public destinations are never deleted for
rollback. See the [Linux rename manual](https://man7.org/linux/man-pages/man2/rename.2.html).


Offsets are UTF-16 string indices into the decoded source, not byte offsets.
The graph's conservation counts cover exact nonblank line text; the report
separately accounts for blank lines and line terminators. Original bytes and
SHA-256 remain authoritative. Source format is `unknown` and page count is zero:
no text-specific core schema format or fabricated PDF page geometry is added.

## Optional Codex or Claude judgment, locally or on a VM

Run the same checkout/CLI on a Linux VM with Node 20+, Python 3, and an already authenticated
Codex or Claude Code installation:

```sh
node adapters/text/text2epub.mjs article.txt --metadata metadata.json \
  --judge codex --out out/article-codex
node adapters/text/text2epub.mjs article.txt --metadata metadata.json \
  --judge claude --out out/article-claude
# Optional controls for either engine:
# --model MODEL_NAME --timeout-ms 120000
```

This explicitly sends source text to the selected CLI/model service using its
existing authentication and usage allowance. No provider runs by default; no
VM, credentials or billable infrastructure is provisioned. The adapter never
prints authentication values. Replay with `--cleanup` makes no model call.

The model classifies every line with surrounding article context. Its prompt
permits removal of website chrome, orphan image placeholders and duplicate
standalone pull quotes; it preserves prose, dialogue, quoted labels and
intentional repetition, and requests `review` when uncertain. It cannot return
rewritten text. The transport derives inspection from the original bytes,
requires complete unique ID coverage and validates returned source/actor
bindings before applying anything. The receipt binds the actual model
classification decisions, actor and prompt hash. Integrity and provenance do
not establish whether an editorial judgment is correct or authenticate a
hand-edited plan as a genuine provider response; inspect the saved ledger.

Subprocesses run through argv (no shell) in temporary working directories,
with capped source/prompt/pipes/result files, a 120-second default deadline
(maximum 600 seconds), and process-group teardown on success and failure.
Codex runs ephemeral/read-only with user config/rules and shell/code-mode,
browser/computer/image/agent/hook, apps/plugins and web search capabilities
disabled. Its version and complete effective feature inventory are checked
before source text is sent; unknown enabled capabilities fail closed. Claude runs print/restricted/safe mode,
without tools, external MCP configuration or session persistence. Only common
runtime/certificate/proxy and selected-provider authentication environment
variables are forwarded. Bedrock/Foundry/custom-provider environment setup is
not supported by this initial transport. Isolation is defense in depth, not a
substitute for the VM's OS/account boundary; managed provider policy still applies.

The Codex capability inventory is pinned to **0.147.0**; another version fails
until its capabilities are reviewed. Claude flags were checked against
Claude Code **2.1.289**. Unsupported flags fail rather than silently grant more
capabilities.
See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude programmatic usage](https://code.claude.com/docs/en/headless).
No live provider calls are part of the test suite. Judgment transport currently
requires a POSIX host for process-group teardown; Windows is unsupported.

## APIs

```js
import { inspectText, ingestText } from './adapters/text/ingest.mjs'
import { judgeText } from './adapters/text/judge.mjs'

const inspection = inspectText(sourceBytes)
const plan = await judgeText(sourceBytes, { engine: 'codex' }) // explicit model call
const { document, report } = await ingestText(sourceBytes, {
  fileName: 'article.txt', metadata, cleanupPlan: plan,
})
```

`inspectText` supplies stable `line-N` IDs, exact text, offsets and whitespace
ranges. `validateCleanupPlan(plan, inspection)` validates a ledger independently.
The async `ingestText` seals the receipt and roundtrips the strict public codec.

## Regression examples and checks

`examples/total-eclipse/` and `examples/now-we-are-five/` contain metadata,
source hashes, reviewed line selections and cleanup ledgers for the supplied
Annie Dillard and David Sedaris articles. Full copyrighted text stays under
ignored `examples/private/`; the committed fixtures contain no article prose.
Copy the exact original files to:

```text
adapters/text/examples/private/total-eclipse.txt
adapters/text/examples/private/now-we-are-five.txt
```

Then run:

```sh
npm run text:examples -- --out out/article-regressions
npm run test:text
npm test
npm run typecheck
npm run test:source-boundary
npm run test:package
```

The example command fails if private inputs are absent or their hashes differ.
Synthetic tests always run; regular tests clearly skip private corpus execution
when the files are absent. Both local regression inputs were exercised during
implementation: **61 visible / 91 retained** lines for Total Eclipse and
**85 visible / 114 retained** for Now We Are Five. These include retained source
notes. Paste artifacts are deliberately preserved, unlike the initial one-off
EPUB conversion's `Istayed` correction. The regression checker verifies exact
selected prose, every omitted line accounted as furniture, source hashes and
semantic receipts before rendering.
