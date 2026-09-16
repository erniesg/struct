# Public API and export manifest

`API_MANIFEST.json` is the deterministic, machine-checked manifest. The package
export map and packed-consumer test enforce these accepted paths:

| Path | Ownership |
| --- | --- |
| `@erniesg/struct` | Slim document types and core codec operations. |
| `@erniesg/struct/document` | Source-neutral document contract, versions, types, and codecs. |
| `@erniesg/struct/identity` | Stable identifiers and semantic digest primitives. |
| `@erniesg/struct/ordering` | Reading-order helpers. |
| `@erniesg/struct/receipt` | Consultation-receipt validation and authoritative semantic receipt digest/verification. |
| `@erniesg/struct/recovery` | Source-neutral recovery facts and summaries without application copy. |
| `@erniesg/struct/renderers/xhtml` | Deterministic XHTML rendering. |
| `@erniesg/struct/renderers/epub` | Deterministic EPUB construction and archive bounds. |

The prerelease thin paths `./core`, `./schema`, and `./ids` are removed. The
`./bundle` path remains unavailable until S-03 is complete. Private `src/**`
modules are not consumer APIs.

## Decode compatibility and deprecated alias

`decodeCompatibleStructDocument(input)` is the truthful public compatibility
operation. It strictly decodes supported `0.1.0` and `0.2.0` documents at their
declared versions; it does not transform or migrate either version.

`migrateStructDocument(input)` remains a deprecated prerelease alias with the
same decode-compatibility behavior for unindexed prerelease consumers. Use
`decodeCompatibleStructDocument` instead. The alias will be removed after
**2026-11-30**. The replacement, removal date, and behavior are machine-checked
in `API_MANIFEST.json` and the packed public-consumer test.

Renderer exports are intentionally absent from the root facade. Import them
from their explicit renderer paths. Public-consumer validation installs the
packed tarball, imports only through the package export map, typechecks those
imports, and proves the removed and not-yet-available paths fail closed.

## Portable native MathML fonts

`renderPublicationXhtml` embeds an unmodified, pinned STIX Two Math WOFF2 font
when its output contains MathML. Its optional `mathFont` setting is `embedded`
(default) or `external`. External mode references `struct-math.css`; callers
selecting it must supply that stylesheet and its referenced font. `buildStructEpub`
selects external mode and packages both resources automatically, independently
of caller profile CSS. Publications without MathML gain no font resources.

The font is a renderer resource, so document assets and semantic receipts are
unchanged. The caller's profile CSS and its recorded hash remain unchanged;
the complete EPUB digest binds the additional stylesheet and font bytes.
`NOTICE` contains the font's license, upstream revision and digest. The original
license and provenance are also retained in the generated math stylesheet.
