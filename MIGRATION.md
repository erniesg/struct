# Source provenance

This bootstrap branch is locally prepared from `erniesg/erniesg` source SHA
`90b0623f933c4f2915cc22f2eed0068c63066971`. Promotion remains conditional on
that hardening commit landing and the coordinator reconfirming the exact SHA.

| App source | Package destination |
| --- | --- |
| `src/struct/types.ts` | `src/core/types.ts` |
| `src/struct/{sha256,ids,reading-order,recovery}.ts` | `src/core/` |
| `src/struct/{consultation-receipt,emitted-ids}.ts` | `src/core/` |
| `src/struct/codec/**` | `src/core/codec/**` |
| `src/struct/xhtml.ts` | `src/renderers/xhtml.ts` |
| `src/struct/epub.ts` | `src/renderers/epub.ts` |

No app adapter, PDF/DOCX implementation, UI, provider, deployment code, or
`model-consultation-receipt.ts` is included. The package begins as private and
has no publish workflow.
