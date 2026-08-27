# @erniesg/struct

`@erniesg/struct` is the source-neutral semantic-document and deterministic
reflowable-publication package. It owns `StructDocument` codecs, stable IDs and
relationships, reading order, source-neutral diagnostics/recovery facts,
semantic receipts, and deterministic XHTML/reflowable EPUB output. It does not
own acquisition, PDF/DOCX/URL extraction, private reconstruction,
source-specific recovery wording, editorial decisions, approvals, release
records, application UI, providers, or public routes. Ernie.SG owns its
source-specific acquisition, reconstruction, editorial, and public-delivery
responsibilities. Credentials and deployment authority stay at each owning
application/adapter boundary; Struct never receives them. Aether may consume a
verified, pinned bundle but owns visual composition and derivatives. Rucksack
remains generic orchestration and owns none of these domain models.

## State and evidence

**Current** at base `6ecb78d1753b847ec7295bf45f43237225663728`: this is a
private `0.0.0` package with source-neutral document/codecs/IDs/recovery/XHTML/
EPUB code. It has no runtime `StructBundle`, bundle decoder or verifier,
exact-pinned external consumer, registry release, or publish workflow.

**Documented target** is the ADR-0001 contract in [CONTRACT.md](./CONTRACT.md):
a source-neutral package with a fail-closed verified `StructBundle` boundary.
The Bundle facade is planned for S-03 and is not a current export.

**Implemented, unreleased** means exact code and local evidence exist, but not
a package or application release. **Released** requires an exact registry
version, immutable artifact digest, install proof, and release record. A
configuration change, branch, documentation change, or passing local test is
not release evidence.

## Current usage

Use only the currently exported API paths recorded in [API.md](./API.md). The
EPUB builder is asynchronous and must be awaited:

```ts
import {
  decodeStructDocument,
  encodeStructDocument,
  renderPublicationXhtml,
  buildStructEpub,
} from '@erniesg/struct'

const document = decodeStructDocument(input)
const canonicalJson = encodeStructDocument(document)
const xhtml = renderPublicationXhtml(document)
const epub = await buildStructEpub(document)
```

The current root facade is a prerelease convenience surface. Do not import
private `src/**` files in consumers; see [API.md](./API.md) for the intended
first-release root and subpath surfaces and the alias-removal window.

## Package contract and migration

[CONTRACT.md](./CONTRACT.md) is the normative package contract; it links to
ADR-0001 for the complete planned Bundle protocol. [MIGRATION.md](./MIGRATION.md)
records source provenance and the staged consumer migration. This bootstrap
package remains private and has no publishing workflow.
