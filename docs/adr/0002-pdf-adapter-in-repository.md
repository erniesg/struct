# ADR-0002: The reference PDF adapter lives in the Struct repository

- Status: accepted 2026-09-05
- Decision owner: repository owner
- Amends: [ADR-0001](https://github.com/erniesg/erniesg/blob/131560e07ef692c27f57acd40a89eaac1f975d62/docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md)
  ("PDF/DOCX acquisition and extraction | Ernie.SG" and the rejected
  alternative "move extraction into Struct")

## Context

The owner's direction on 2026-09-05 is that Struct is the place where "any
academic paper PDF becomes an EPUB", not only the renderer at the end of an
application-owned pipeline. The Docling-based extraction adapter that reached
the first measured result (erniesg/erniesg#297, 80-paper corpus scorecard)
was written under ADR-0001 as an app-owned tool in `tools/docling-struct/`
and imported this repository's build from a sibling checkout. Keeping it in
the application repository meant every adapter change, every renderer gap it
exposed, and every corpus measurement crossed a repository boundary, while the
package it depends on had no PDF input of its own to test against.

ADR-0001 rejected moving extraction into the *package* because a reusable
package must stay source-neutral and must not carry acquisition authority or
credentials. That reason still holds and is preserved below.

## Decision

1. The **repository** `erniesg/struct` hosts the reference PDF adapter under
   `adapters/pdf/`: Docling extraction (`pdf2struct.py`), source-signal
   readers (`pdf_links.py`, `pdf_text.py`), the seal-and-render tool
   (`render.mjs`), the source-derived evaluator (`evaluate.py`), the
   reader-criteria scorecard (`scorecard.mjs`), and the `pdf2epub.py` driver.
2. The **package** `@erniesg/struct` stays source-neutral. `adapters/**` is
   not in `package.json#files` or the export map; `src/**` never imports
   `adapters/**` (the source-boundary check covers `src/` only and
   `adapters/` is outside it by construction). The adapter consumes the
   package only through its public paths (`document`, `receipt`,
   `renderers/xhtml`, `renderers/epub`) from the built `dist/`.
3. The adapter owns no credentials, network access, or deployment authority.
   It runs locally against local files; source PDFs never leave the machine.
4. Renderer gaps found by the adapter are fixed in `src/**` with fixtures and
   tests here, in the same change set when the adapter needs them.
5. The application repository keeps application-specific acquisition (uploads,
   URLs, editorial state, publication routes). Its `tools/docling-struct/`
   copy is superseded by this directory and erniesg/erniesg#297 is closed in
   favour of the Struct pull request that lands this ADR.

## Consequences

- `pdf2epub.py <paper.pdf> --out <dir>` from this repository is the supported
  way to turn a scholarly PDF into a Paper Pro / Paper Pro Move EPUB.
- The corpus scorecard (spec 052 in the application repository) is computed
  by `adapters/pdf/scorecard.mjs` on `adapters/pdf/evaluate.py` output; the
  application's copy of the scorecard remains for its own deterministic path.
- ADR-0001's ownership table gains the row "Reference PDF extraction adapter |
  Struct repository (outside the package) | `adapters/pdf` | Struct package
  source". Its rejected alternative is narrowed from "move extraction into
  Struct" to "move extraction into the Struct package".
- Python is now a repository toolchain (`adapters/pdf/pyproject.toml`), not a
  package dependency.
