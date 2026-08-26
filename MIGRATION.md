# Source provenance

This bootstrap branch is locally prepared from `erniesg/erniesg` source SHA
`485edb69e83179d4a8b15dfbd324f4b5f89dda44`, the landed app default head.
The app `src/struct` tree at that revision is
`9adfe1bc352f31ddb40e34f6137d7157ed7e6ab7`.

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
