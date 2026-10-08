# REPResenting Taste: Composable Design Decisions Across Alternatives and Revisions

**Status:** Revised research programme and product roadmap. Primary paper direction: interaction and empirical evidence about selected design commitments. Representation novelty and efficacy remain unproven.

**Date:** 8 October 2026.

**Primary artifact:** Baddie, a complete AI native magazine.

Baddie will test whether an explicit, inspectable workflow for selected design commitments reduces total capture, composition, verification and repair effort when content and reading formats change. The central task is to combine selected treatments from different alternatives, then revise the content while retaining applicable choices and allowing reconsideration. Typography, spatial hierarchy, image treatment, figure relationships and scoped formatting rules are instances of this question.

Aether will provide creative alternatives and decision operations; the publication workflow will retain canonical content, revisions and releases; Struct will supply portable document semantics and rendering capabilities within its existing ownership boundary. The bounded representation is presently a synthesis of established mechanisms. A representation contribution requires a demonstrated advantage in expressive economy, enforceability, tractability or authoring complexity; a new schema or a complete magazine does not establish it.

The [independent contribution critique](baddie-contribution-critique.md) supplies the detailed prior-art matrix, operational specification, counterexamples and experiment. The [reviewed baseline](baddie-research-plan-reviewed-baseline.md) preserves the preceding plan exactly, SHA256 `5eefc2ef6c5e18ac097cc053b223f6966a40eda8bd941e75a1a795e77167d2b7`. The revised direction prioritises the linked composition-and-revision workflow and comparative evidence, initially for DIS; UIST and DocEng depend on a substantive interaction or technical contribution emerging.

## Problem and job to be done

An editor or designer sees desirable choices distributed across alternatives: the type treatment in one, the balance and spacing in another, the image crop in a third. Combining them requires reconstructing the choices and inspecting their interactions. Later, a longer headline, rewritten explanation, replacement image or different reading format can make the combination fail. The production job is to reuse selected judgment, preserve deliberate exceptions, and reconsider only what the change actually affects.

The user's experience of the final portion of poster production motivates this work: small adjustments can qualitatively alter the whole composition. A font change affects line lengths, which affect whitespace, image balance and hierarchy. This establishes a reason to study interacting decisions; it does not establish that their benefits mathematically multiply, or that parallel generation will automatically improve quality.

The concrete job is:

> Keep the typography I accepted in alternative A and the spatial hierarchy I accepted in B. Combine them, then accommodate a longer headline, replacement artwork and a narrower format. Preserve applicable choices, show incompatible ones, and let me repair the result without reconstructing the design from scratch.

Baddie supplies a real production setting: a cover, contents, editor's letter, illustrated feature, interview, visual essay, short dispatches and credits. Multimedia features have authored static alternatives for EPUB and PDF. AI assistance operates through inspectable editorial or creative proposals; accepted content and design choices enter a pinned release.

The primary users are editors and designers exploring and maintaining illustrated issues and their related creative assets. Readers supply a separate acceptance criterion: hierarchy, argument, illustrations, tables and notes must remain understandable. A correct content inventory or executable decision record is insufficient if the reading experience fails.

The current PDF conversion work provides a useful warning. An earlier mobile browser preview retained the Attention paper's table but exposed an approximately 852 CSS pixel table within a 388 CSS pixel body at enlarged type. This is an observed reading failure, not a general comparison with other converters. The [figure and table readability requirements](figure-table-readability.md) also cover figure proportion, internal label legibility, accessible overflow and source table ruling fidelity.

## Research questions and scope

**Core question:** When designers select different treatments from alternatives and then change copy, artwork or output dimensions, does an explicit lifecycle for those commitments reduce total capture, composition, verification and repair effort and avoidable choice loss, relative to an equally informed native workflow, while maintaining publication quality, substantive completion and freedom to reconsider?

The core experiment has two linked stages: select and compose choices from alternatives, then revise the content or output context and adapt the result. It tests the incremental value of commitment maintenance and integrated review/repair over competent native facilities. If both conditions express the same semantics, the contrast concerns interaction and workflow rather than greater expressive power. The first study uses a bounded vocabulary across typography, spatial hierarchy, image treatment, editorial relationships and scoped exceptions. It does not claim to encode every aesthetic judgment.

Figure and caption ownership, preferred passage proximity, and typed numeric formatting are useful diagnostic cases. They test relational, geometric and deterministic decisions; none is the principal thesis by itself. Exact pixels need not persist when the accepted choice is a proportion, relationship or adaptive rule. Stable IDs and text anchors do not establish semantic continuity after an arbitrary rewrite.

Margin annotations are a required Baddie integration and a compatibility test of identity and revision handling. PDF recovery retains a separate import and evaluation track. Learning preferences from decision histories is a future research question. Social collection, translation, multi publication tenancy and print fulfilment do not belong on the core experiment's critical path.

## Literature review and positioning

The following work identifies the strongest overlaps. A capability not demonstrated in a cited publication is a boundary of that evidence, not proof that no other system provides it.

### Structured content and durable attachment

| Prior work | Established capability | Consequence for this research |
|---|---|---|
| [Pandoc filters](https://pandoc.org/filters.html) | Document ASTs and programmable transformations between readers and writers. | A document intermediate representation and reusable transformations are established infrastructure. |
| [JATS figures](https://jats.nlm.nih.gov/publishing/tag-library/1.4/element/fig.html) | Figure IDs, captions, graphics and alternative representations. | Figure ownership and structured publication semantics are established. |
| [InDesign anchored objects](https://helpx.adobe.com/indesign/desktop/add-graphics-and-media/transform-and-arrange-objects/about-anchored-objects.html) | Objects follow a text anchor through edits and page or column reflow. | Ordinary text linked figure reflow is a strong existing baseline. |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/) and [Yjs relative positions](https://docs.yjs.dev/api/relative-positions) | Resource selectors, representation states and sequence relative anchors. | Robust positional attachment is established; continuing conceptual identity after replacement needs an editorial decision. |

### Constraints and adaptive composition

| Prior work | Established capability | Consequence for this research |
|---|---|---|
| [Cassowary](https://badros.com/greg/papers/cassowary-tochi.pdf) | Incremental geometric solving with required constraints and ranked preferences. | Hard and soft constraints, dependencies and incremental solving cannot carry novelty alone. |
| [Rutledge and colleagues](https://ir.cwi.nl/pub/11350/11350B.pdf) | Author intent expressed through rhetorical relations and translated into adaptive presentation constraints. | Preserving author intent through adaptation has a long research lineage. |
| [Penrose](https://penrose.cs.cmu.edu/siggraph20) | Semantic relationships separated from reusable visual styles and constrained rendering. | Relational graphics and alternative representations of the same meaning are established. |
| [CSS Fragmentation](https://www.w3.org/TR/css-break-3/#breaking-controls) | Break controls, widows and orphans support grouping and pagination. | Keep rules are useful primitives. Avoidance may be relaxed, so a CSS declaration alone is not a hard caption grouping guarantee. |
| [Effective Floating Strategies](https://www.latex-project.org/news/2017/09/18/DocEng-paper/) | Globally optimized pagination with float placement, absolute rules and preferences. | Figure placement and typographic trade offs are direct prior art. |
| [Constraint Based Breakpoints](https://arxiv.org/html/2409.01339v1) | Constraints and preferred visualization alternatives reevaluated as data or display dimensions change. | Readability triggered fallback and response to changing data are established. |
| [LayoutShop](https://arxiv.org/html/2609.05098v1), [Pacific Graphics 2026 proceedings](https://diglib.eg.org/items/d28ac277-1f91-4d32-9df7-c43eb87cd104) | Blends multiple user templates into a layout tree, fits article content, and requires illustrations on the same page as reference text. | Template recombination and content fitting are close overlaps. The inspected workflow does not demonstrate later accepted-choice applicability and repair. |

### Executable design edits and verification

| Prior work | Established capability | Consequence for this research |
|---|---|---|
| [Sketch n Sketch](https://arxiv.org/abs/1809.04209) | Direct output edits reconciled with an underlying program through bidirectional evaluation. | Editable design programs and source reconciliation are established. |
| [DesignAsCode v3](https://arxiv.org/html/2602.17690v3), accepted ACM Multimedia 2026 | Editable HTML/CSS, rendered feedback, aspect-ratio retargeting and evaluated text replacement, color and font-size edits (§5, Appendix B.3). | Code based generation and subsequent copy/style revision are established; the earlier v1 summary understated this overlap. |
| [StructuredEdit](https://arxiv.org/html/2607.04612v1), July 2026 preprint | Typed parameter edits and deterministic constraint checks. Its fallback returns an identity edit after bounded resampling. | Valid output must be measured separately from successful fulfilment of the requested edit. Its [record](https://arxiv.org/abs/2607.04612) describes a planned SIGGRAPH Asia submission, not verified acceptance. |
| [ReLayout](https://arxiv.org/html/2602.01046), February 2026 preprint | Typed layout edits and a relation graph preserve size/position hierarchy among unedited elements; composite operations are demonstrated. | Relation-preserving revision is established. Its scope excludes content replacement, and its reported failures limit guarantees. |
| [Typst styling](https://www.typst.app/docs/reference/styling/) and [XPath numeric formatting](https://www.w3.org/TR/xpath-functions-31/#func-format-number) | Scoped rendering rules and deterministic presentation of typed values. | Persistent typography or number formatting is useful functionality, not a new research contribution. |

### Alternatives and selective recombination

| Prior work | Established capability | Consequence for this research |
|---|---|---|
| [RevG](https://www.microsoft.com/en-us/research/publication/nonlinear-revision-control-for-images-2/), SIGGRAPH 2011 | Operation graphs with spatial, temporal and semantic dependencies, replay, branching, merging and conflict resolution. | Neither dependencies nor a Git-like design history is new. Compare what decisions are represented and how composition behaves after content changes. |
| [GEM-NI](https://vvise.iat.sfu.ca/user/data/papers/gem-ni.pdf), CHI 2015 | Selective post-hoc node/connection merge, parameter overwrite and later repair, linked edits, and Cartesian structural/parameter alternatives. | Selected merge plus subsequent parameter change is established. The proposed benefit must exceed competent reuse of these facilities. |
| [VST](https://arxiv.org/html/2309.11628v1), UIST 2023, and [VLT](https://arxiv.org/html/2309.11635v1), ICML AI-HCI Workshop 2023 | Selective style attribute transfer and selected containment, order, alignment, overlap, offset and dimension rules using editable correspondences. | VST holds layout/structure constant and acknowledges an operator experience confound. VLT is workshop work; its future optimizer/locking proposals must not be treated as implemented. |
| [MIMO](https://arxiv.org/html/2507.03326) | Parallel agent style exploration, critique and selection of a winning banner. | Agent fan out is established. Whole candidate selection differs from maintaining selected operations after editorial revisions. |
| [Parallel Prototyping](https://hci.stanford.edu/publications/2010/parallel-prototyping/ParallelPrototyping2010-final.pdf) | A controlled banner design study found benefits from parallel alternatives at matched prototype count and time. | Parallel exploration is a supported motivation, not evidence for our proposed recombination or magazine maintenance mechanism. |

### Learning preferences from design histories

| Prior work | Established capability | Consequence for this research |
|---|---|---|
| [PseudoClient](https://dlin.org/pseudoclient), DIS 2021 | A learned preference metric from examples of liked and disliked designs. | Encoding preferences in a learned representation is established. |
| [DesignPref](https://arxiv.org/abs/2511.20513), November 2025 preprint and CVPR 2026 P13N short non-proceedings workshop paper | Designer-specific preference data, rationales and preference-aware design support. | The [official workshop listing](https://p13n-workshop.github.io/) is not CVPR main-track acceptance. A later learning claim needs an advantage from revision histories over equally informative alternatives. |

### Closest additional comparators from the critique

| Prior work | Established overlap | Consequence for this research |
|---|---|---|
| [Mix’n’Match](https://ir.cwi.nl/pub/11338/11338B.pdf), Hypertext 1999 | Exchangeable appearance, layout, media, timeline and navigation modules compose into styles; the paper raises possible interference between aesthetic intentions. | Modular style recombination and its interactions are direct antecedents. |
| [Adaptive Grid-Based Document Layout](https://grail.cs.washington.edu/wp-content/uploads/2015/08/Jacobs2003.pdf), ACM TOG / SIGGRAPH 2003 | Magazine/newspaper templates adapt to content geometry and viewing conditions through constraints and pagination. | Responsive magazine layout and artwork-size adaptation are established. |
| [Adaptive diagrams](https://research.monash.edu/en/publications/authoring-diagrams-that-adapt-to-their-viewing-context/), JVLC 2018 — primary record/abstract checked | Cross-product alternatives in layout, object representation, style and text are selected by context and author preference. | Alternative composition and adaptation overlap strongly; inspect full implementation before making exclusive claims. |
| [Bricolage](https://hci.stanford.edu/publications/2011/Bricolage/Bricolage-CHI2011.pdf), CHI 2011, and [Interactive Layout Transfer](https://kashyaptodi.com/data/LayoutTransfer-IUI2021.pdf), IUI 2021 | Correspondence-based retargeting; guideline violations in outdated designs are visualized and minimally changed repairs proposed. | Transfer, conflict inspection and repair are not new in isolation. |
| [Scout](https://arxiv.org/abs/2001.05424), CHI 2020, and [Cicero](https://arxiv.org/html/2203.08314), CHI 2022 | High-level design constraints; reusable selector-targeted responsive transformations and conflict-management principles. | Semantic scopes and reusable adaptive rules are established. |
| [Flexible Responsive Visualization Design](https://idl.uw.edu/papers/responsive-vis), CHI 2020 | Global edits, device-specific customizations, differences and selective propagation. | Cross-format revision and scoped exceptions already have interaction prior art. |
| [DesignTrace](https://xiaohanp.github.io/pdf/CHI_26_DesignTrace.pdf), CHI 2026 | Semantic Palette attributes, local/global reuse, branches, history and rationale. Node merging/cascading edits were considered but withheld after expert feedback about control and provenance. | This is a close interaction comparator and a warning about composition/revision overhead, not proof that a merge feature must help. |
| [Brickify](https://www.jeffjianzhao.com/papers/brickify.pdf) and [IntentTagger](https://arxiv.org/html/2502.18737v1), CHI 2025 | Persistent reusable visual tokens and granular intent tags. IntentTagger participants requested locking of accepted design elements. | Reifying intent and the need for preservation are established. |
| [IdeaBlocks v4](https://arxiv.org/html/2507.22163v4), DIS 2026 | Reusable property/direction/range blocks, paths and projects support literal and context-adaptive reuse. | The present study concerns accepted publication commitments rather than divergent exploration, but intent reuse itself is not the gap. |
| [ReSlide](https://arxiv.org/html/2604.21205), [DIS 2026 proceedings](https://dis.acm.org/2026/proceedings/) | Contextual constraints, narrative revision intent, lineage, content reuse and version synchronization. | Multi-session revision intent and maintenance are established adjacent work. |

The complete selected-choice lifecycle remains worth investigating: scope and correspondence, cross-alternative interactions, and applicability or repair after content change. No inspected paper demonstrates every stage of the exact task, but this is a boundary of the evidence, not an absence proof. Components, constraints, expressive programs and operation history can plausibly encode every proposed field. The primary contribution therefore concerns useful interaction and empirical evidence; representation novelty requires a separate technical comparison. The [critique](baddie-contribution-critique.md) records fuller overlap and unresolved checks.

## Proposed contribution and falsifiable hypothesis

The research bet is that **explicit maintenance and integrated review of selected commitments can reduce total production work and avoidable choice loss across composition and revision**. A decision identifies its targets, observable satisfaction, property scope, exceptions, authorized adaptations and dependencies. Composition establishes what is imported and how interactions are resolved; revision establishes applicability, realization and review separately.

The proposed contributions are ordered by their present defensibility:

1. **An empirical account and reusable evaluation protocol.** Versioned tasks and adjudicated allowed outcomes measure capture, selection, composition and subsequent revision against competent alternatives, including failure, unwanted persistence and quality.
2. **An inspectable authoring interaction.** Designers select aspects of alternatives, inspect the joint result, review applicability and realization, and accept repairs. Its distinctive value must exceed equally informative native history and diagnostics.
3. **A bounded operational specification supporting the experiment.** Define targets, observable satisfaction, scopes, exceptions, dependencies and authorized adaptations through composition and rewrite, split, merge, move, replacement and deletion. Promote this synthesis to a representation contribution only after showing a precise technical advantage.

These are proposed contributions to be built and evaluated. Neither positive outcomes nor novelty are established by document review. If native facilities express the same protocol, evaluate the integrated interaction without attributing the result to greater expressive power. Preference learning is deferred.

The main hypothesis is a reduction in total active human effort across composition and subsequent revisions, with fewer unintended changes and noninferior publication quality and acceptable completion. Measure freedom to reconsider and unwanted persistence as well as loss. An equally informed baseline achieving comparable outcomes leaves the advantage unsupported. Bookkeeping that costs more than it saves, pervasive retrospective relabeling, unnecessary invalidation, or apparent safety obtained by rejecting difficult edits counts against the approach.

## Representation and revision behaviour

### What is represented

Here, **taste** means situated judgment expressed through accepted choices. **Style** is an observable treatment; **editorial intent** concerns what an artifact should communicate; a **decision** records a bounded, actionable commitment. The realizing operation and the commitment are distinct: replaying parameters does not establish that the selected relationship still holds. Acceptance may reflect compromise, fatigue or a deadline; it does not prove stable preference or continued acceptance after revision. A free text rationale is an explanation rather than executable semantics.

| Decision field | Purpose |
|---|---|
| Observable satisfaction and realizing operation | Specify the selected treatment or relationship as an allowed outcome set, and separately record the operation used to realize it. Vague aesthetic descriptions remain subject to human review. |
| Target entities, semantic roles and correspondences | Specify which content the choice applies to across alternatives and declared successor revisions. |
| Property scope and intentional exceptions | Identify what is imported, what remains independently editable, and where the rule deliberately does not apply. |
| Source alternative and accepted state | Preserve provenance and the content, assets and output context in which the designer accepted the choice. |
| Preconditions and permitted adaptations | Resolve applicability as true, false or unknown; define the authorized parameter/relationship domain and responsive alternatives before observing evaluation outcomes. |
| Read/write dependencies and interactions | Identify affected properties and recomputation needs, including conflicts between otherwise valid decisions. |
| Resolution and acceptance | Track applicability, realization and review separately; record joint conflicts and the state/scope of an accepted repair. |

For example, importing A's font changes glyph metrics and therefore B's headline wrapping, whitespace and image alignment. Copying independent scalar values is insufficient. A chosen heading-to-body hierarchy may survive longer wording while its exact line breaks do not; an explicitly accepted line break may instead require reconsideration. A deliberate exception to alignment must survive within its declared scope, rather than disappear during global restyling.

Composition must expose overlapping writes, missing targets and joint infeasibility. Compatible operations can be combined and their dependent geometry recomputed; incompatible ones require an explicit choice, scoped override or repair. Neither a universal last-write-wins rule nor replaying a saved screenshot establishes that the intended combination succeeded. The initial vocabulary is typography and hierarchy, spacing and alignment, crop and focal treatment, authored sequence, passage/figure/caption relations, and scoped formatting. General aesthetic inference remains outside this contract.

### Composition and revision contract

The detailed [operational specification and worked counterexamples](baddie-contribution-critique.md#operational-specification) define versioned entities/content, semantic relations, authored properties, rendering context, commitments and history. Composition requires available source states, typed mappings, selected scopes/exceptions and operation inputs. It returns a candidate with evidence and unresolved conflicts before acceptance. Necessary upstream imports are disclosed rather than silently expanding the selection. A dynamic selector must declare whether new matching entities join its scope; a captured exception follows only declared successors.

| Dimension | States |
|---|---|
| Applicability | Applicable, inapplicable, unknown. Missing or uncertain semantic continuity does not become true merely because an ID resolves. |
| Realization | Satisfied without adaptation, satisfied within authorized adaptation, violated, unevaluable. |
| Review | Accepted, pending, rejected, tied to the actual state and scope. |

Two individually applicable commitments can be jointly infeasible even when they write different fields. For example, A's permitted font sizes and B's fixed box/image requirements may cease to fit a longer headline. Shrinking below the accepted type or image bounds is not authorized adaptation. If box expansion is an explicitly allowed fallback, use it and report any relaxed preference; otherwise propose a new accepted repair. A solver timeout means no solution found within budget, not certified infeasibility.

Revision applies the content/context change and declared continuity mapping, rechecks changed reads and the dependency closure, then checks joint realization and output requirements. Authorized adaptation remains inside the original allowed set and declared authored effects. Retargeting, semantic assertions, scope expansion and relaxation outside that set require a new acceptance event. Keep failed/no-op repairs and unresolved review visible. Accepted withdrawal after genuine invalidation is reconsideration, not preservation.

This protocol cannot recover missing judgment from pixels. Identical accepted covers can imply either flexible headline wrapping or a mandatory two-line break; capture the difference or adjudicate later in both conditions. Replacement portraits can preserve focal coordinates while reversing gaze relative to text. A passage can retain its ID while changing from correlation to causation, making its illustration misleading. Geometric and identity checks cannot certify those semantic choices.

Any technical properties are conditional: replay needs pinned deterministic execution or stored generated outputs; independent composition needs independence of effects, target resolution and joint constraints; authored frame guarantees need complete effect declarations. None guarantees unchanged rendered coordinates, arbitrary semantic continuity, subjective satisfaction or complete conflict detection by an approximate solver. The critique gives the assumptions and failure cases; no unproved general guarantee is claimed.

### Identity and editorial relationships

Use separate identifiers for the authored entity, revision event, content digest, asset rendition and release. Different revision events can contain identical content and therefore share a digest. A continuing figure may use new artwork; a continuing passage may have new wording.

```text
Passage P17 has text revision R2
Figure F3 uses artwork revision A2
Caption C3 belongs to F3
F3 illustrates P17
F3 preferably appears after or with P17
```

Caption ownership, the passage a figure illustrates, individual cross references, and reading order are separate relations. An editor chooses the main passage or span rather than assuming that every mention is an equally important placement anchor. A passage may contain several blocks or spans; it is not necessarily identical to one paragraph.

| Revision | Required behaviour |
|---|---|
| Insert preceding text or move a passage | Retain declared entity continuity and recompute layout. |
| Rewrite the same explanation | Retain the passage identity when continuity is declared; use the new content state. |
| Replace artwork with a wider or taller version | Retain figure identity and caption ownership; measure the new asset and reconsider placement. |
| Split or merge paragraphs | Retain an appropriate passage group or record an explicit successor mapping. |
| Replace the underlying concept | Request or record an editorial decision about whether the association still applies. |
| Delete a passage or figure | Mark dependent bindings unresolved; resolve through explicit retargeting or removal. |
| Combine decisions from alternatives | Retain operation sources and dependencies; inspect the joint rendered result. |

For declared semantic changes, both experimental systems receive the same declaration. For unlabelled rewrites, detecting a possible meaning change is a separate inference task; uncertainty and editorial adjudication must be recorded. Stable IDs and text cursor anchors cannot prove that meaning survived.

### Constraints and placement

Caption ownership and locked content are release requirements. Caption and figure form one presentation unit in a paginated target when feasible. Proximity, after or before placement, same page or spread, and whitespace are separately scoped preferences unless an editor explicitly makes one binding.

The renderer measures the current passage fragments, artwork, caption and available content area, including reader typography, margins and annotation rail occupancy. It chooses among permitted placements and reports which preferences were satisfied or relaxed. If the unit exceeds a whole usable page at its minimum readable size, it needs an approved alternative or an explicit infeasibility result. Silent caption separation, clipping or unreadable shrinking cannot count as successful repair.

Continuous reading preserves association and reading order without requiring the entire figure and caption to fit one screen. EPUB tests must account for supported reader overrides; identical final font pixels across arbitrary readers are not promised. [EPUB author styling overrides](https://www.w3.org/TR/epub-rs-34/#sec-author-styling-overrides)

Adaptive sizing and table behaviour follow the [existing readability requirements](figure-table-readability.md): distinguish raster resolution, rendered dimensions and proportions; preserve figure detail and aspect ratio; provide accessible wide table access; and distinguish known borderless tables from unknown appearance. Automatic inventories or schema checks do not establish human legibility.

### Replay, exploration and annotations

**REPR — Replay, Explore, Parallelise, Remix** is a possible mnemonic for the workflow. Explore includes forking alternatives; Remix means selecting decisions rather than only choosing a whole winner. These are product capabilities enabled by the representation, not four independent novelty claims.

Replay uses stored operations and generated outputs with pinned assets, fonts and toolchain. Repeating a prompt is fresh generation. Reapplying decisions to changed content is a new revision operation that may produce invalidations and repairs; it is not exact replay.

Margin's web integration binds annotations to a work and release, authored entity, content digest and exact quote or span. Reflow should preserve the mapping to rendered fragments. A content change must produce a recorded resolution or a visible orphan requiring reattachment. Durable revision history and this integration bridge remain to build; generic EPUB reader annotation synchronisation is outside the first milestone.

## Current capabilities and ownership

The following are inspected code capabilities as of 8 October 2026, not a claim that Baddie is deployed. Several application checkouts contain concurrent local work.

| Component | Existing capability | Required extension |
|---|---|---|
| Struct | [Semantic blocks, assets and relationships](../../src/document/types.ts), [content addressed identity helper](../../src/identity.ts), XHTML and EPUB output, PDF recovery adapter. | Portable passage association where appropriate, explicit authoring continuity at the consumer boundary, and relevant rendition diagnostics. The planned Bundle facade is not a current runtime API. |
| Ernie.SG publication workflow | [Local Payload Lexical adapter](/Users/erniesg/code/erniesg/erniesg/src/publication/adapters/payload-lexical.ts:1673), [figure and caption ownership](/Users/erniesg/code/erniesg/erniesg/src/publication/schema.ts:236), reviewed profile asset selection, and [web, EPUB and A4/A5 PDF renderer](/Users/erniesg/code/erniesg/erniesg/src/publication/renderers/vivliostyle.ts:1081). | Whole issue assembly, authoring revision bindings, passage association, repair workflow and live CMS handoff. Profile variants are not an editorial revision history. |
| Berlayar and Payload | [Lexical, D1, R2 and existing collections](/Users/erniesg/code/erniesg/berlayar/src/payload.config.ts). | Articles, issues, contributors, richer media metadata, canonical source IDs, immutable releases and export jobs. |
| Aether | [Semantic creative component](/Users/erniesg/code/erniesg/aether/lib/types/semantic-component.ts), canvas, crop and format operations, PNG export packs. | Content bound operations, retained alternatives, selective composition, revision preconditions and inspectable repair provenance. |
| Margin | [Anchor resolution](/Users/erniesg/code/erniesg/erniesg-preview/packages/margin/src/anchor.ts), annotation UI and service code. | Release and entity bridge, fragment mappings, durable revision lookup and conservative migration. [Document history](/Users/erniesg/code/erniesg/erniesg-preview/src/worker/margin/routes.ts:60) remains unimplemented. |

Payload owns approved text and media, editorial status and releases. Aether owns creative projects and proposed design operations. The current Ernie.SG compiler produces native renditions. Struct owns source neutral semantics, diagnostics and rendering within [its package contract](../../CONTRACT.md); editorial approvals, release records, application UI and creative policy remain in their owning applications. Margin owns annotation records and interaction.

Use the existing native compiler for Issue 0. Struct and the native PublicationGraph are separate contracts today. A local source and binding sidecar can establish the pilot before deciding which portable additions belong in Struct. Do not make a universal representation migration a prerequisite for the research experiment, or create two competing canonical editorial sources.

## Benchmark and experiments

### Pilot and evaluation corpus

Start with five complete publication packets, each containing coherent alternatives, selected choices, a composition task and a subsequent revision. Include feasible combinations, interacting choices, intentional exceptions and genuine invalidation. The deterministic formatting packet is a negative control where competent native rules should be competitive. Run 3 to 5 representative packets and inspect failures before expanding. This is a feasibility and falsification pilot; it does not establish general productivity or quality/completion noninferiority.

| Packet | Stage A: select and compose | Stage B: revise and adapt |
|---|---|---|
| Feature opener and complete illustrated article | Typography and hierarchy from A; spacing and arrangement from B. | Lengthen the headline and standfirst; narrow the reading width. |
| Visual essay with cover or promotional treatment | Type treatment from A; crop, focal position and image/text balance from B. | Replace artwork with a different aspect ratio and focal location; change the copy. |
| Explanatory illustrated feature | Combine type/layout choices and the intended passage/figure/caption relationship. | Rewrite or split the explanation; replace artwork; include a declared conceptual replacement. |
| Interview with a deliberate exception | Combine heading/quote treatment and arrangement; retain an exceptional opening or display heading. | Insert or reorder content, revise the exceptional passage, and change format. |
| Data-led dispatch with a table | Combine hierarchy and spatial choices with scoped numeric formatting as a deterministic control. | Update values and labels, including formatting boundaries; change available width. |

For the controlled comparison, supply the same pinned alternatives, choice descriptions and revision sequence to both conditions. Assigned selections initially isolate composition and adaptation; a later free-choice condition measures selection burden. Each packet runs through authoring, rendering, inspection and repair. Outcomes may require retaining a choice, adapting within its accepted scope, resolving an interaction, or explicitly reconsidering it.

After the pilot, freeze the protocol and implementations. Build a held out, rights cleared corpus of complete articles and issues with revision sequences. Split by article or issue, keeping near identical versions together. Determine corpus and participant counts using pilot variability, clustering and an editorially meaningful effect. One Baddie issue supports a case study; claims about other publications require additional settings.

Prefer natural editorial histories and accepted alternatives. When unavailable, editors propose plausible tasks and record their origin. Report constructed stress tests separately. Include rewrite, move, split or merge, artwork and focal changes, caption change, conceptual replacement, deletion, conflicting combinations and infeasibility across desktop web, narrow mobile and paginated output. Test the native EPUB route separately in representative reading systems.

Each packet contains source revisions, alternatives, declared correspondences, choices and scopes, intentional exceptions, change declarations, assets, minimum readability and release criteria, final artifacts and operation/repair logs. Both systems receive the same authoring information. Independent editors freeze allowed outcome sets and adjudication rules before seeing condition outputs; hidden evaluation labels describe eligible targets, applicable states, permitted adaptations, acceptable successor mappings and conflicts. Do not relabel loss as authorized adaptation retrospectively. Ground truth is an allowed set of treatments and relationships, not a single reference screenshot; disputed semantic judgments remain explicit.

### Comparators and ablations

**Primary comparator:** a competent component or editable-code publishing workflow with stable IDs, reusable settings, saved source/target correspondences, selective style or layout transfer, revision history, ranked constraints, ordinary dependency recomputation and validation. Match content, choice descriptions, scopes and exceptions, alternatives and provenance, assets, fonts, renderer, model access and generation budget. Include the effort of creating correspondences in both conditions. Intent recorded only in inaccessible notes would make the comparison unfair; provide it through usable native facilities. Gold evaluation labels remain hidden.

Use one shared runtime and renderer with native and commitment-interaction modes for the smallest controlled prototype. A practising expert configures and uses the native baseline; give agents equal machine access to authoring facts, mappings, allowed adaptations and history. Retain equivalent native lifecycle facilities when they exist. If semantics are equivalent, isolate integrated inspection/repair or expressive economy rather than claim a representation advantage. Record baseline configuration and task setup costs as well as treatment capture costs.

The controlled comparison varies how decisions are maintained and reviewed:

| Capability | Native baseline | Proposed workflow |
|---|---|---|
| Alternatives, correspondences, source identities, revisions and choice descriptions | Same available information and history. | Same available information and history. |
| Components, reusable settings, ordinary dependency recomputation and release checks | Available through native facilities. | Available through the same underlying facilities. |
| Selective composition | Native component/style editing and saved correspondence-based transfer. | Typed decisions with explicit property scopes, interactions and conflict handling. |
| Applicability after a content change | Native rules, equivalent declarations, constraints, diagnostics and inspection of recomputed output; retain existing lifecycle facilities. | Integrated, separate applicability, realization and review states, plus joint-conflict evidence. |
| Repair and acceptance | Competent native editing and review controls. | Integrated evidence, retargeting and recorded repair acceptance. |

Use the same native renderer for the controlled mechanism comparison. If rendering cannot be matched, report a whole workflow comparison without attributing its difference solely to the protocol. If a comparator already offers a proposed capability, retain it and record the overlap; do not disable it to manufacture a treatment advantage.

**Ecological references:** an anchored object publishing workflow and a strong float placement workflow. Report these separately when different renderers or interactions prevent a controlled mechanism comparison. Label comparators as original tools, reproductions or adapted implementations. A weak prompt only generator may illustrate a failure, but cannot substantiate the core contribution.

**Ablations:** separately remove decision-specific composition dependency/conflict handling, or revision applicability/status handling, while retaining ordinary native recomputation and the same authoring information and stored outputs. Compare integrated repair presentation with equally informative native history/diagnostics if isolating interaction effects. Removing provenance or correspondences changes the information available: such an ablation is explanatory, not the principal causal comparison.

### Outcomes and evidence

| Outcome | Measurement |
|---|---|
| Primary human effort | Active minutes to an acceptable composed and revised publication, including initial capture, correspondences, setup, inspection, selection, composition, conflict resolution, verification and repair. Report stages A/B, initial/recurring costs and total. |
| Useful completion | Requested substantive change present and release criteria met. Separate completed, blocked, rejected, no operation and undetected failure outcomes. |
| Selected choice adherence and agency | Coverage over all eligible choices, including required uncaptured choices; preserved applicable choices, authorized adaptations, legitimate reconsideration, avoidable loss, needless invalidation, unwanted persistence and unresolved outcomes. |
| Binding correctness | Precision, recall and coverage over eligible relationships; retained applicable bindings and accepted successor/retarget mappings. |
| Content integrity | Missing or duplicated content, locked text changes, caption ownership, reading order and association defects. |
| Placement and readability | Caption orphans, callout order violations, clipping, label and cell legibility, permitted fallback use and policy violations. Use page separation for pagination and suitable reading area relative distances for continuous output. |
| Publication quality | Independent blinded assessment of hierarchy, coherence, readability and relationship clarity using a calibrated rubric. Internal validator scores are supporting evidence. |
| Cost and latency | Rendering time, wall time, model calls, tokens and actual configured compute cost. Log actual expenditure; equal caps do not imply equal consumption. |

Independent adjudicators use choice-level targets, scopes, dependencies and allowed adaptations, with condition identity hidden where feasible. New line breaks or repagination can legitimately follow a longer headline or taller illustration. Conversely, identical pixels that make changed content unreadable do not establish successful preservation. Assess required consequences separately from avoidable loss and do not score invalidating every choice or rejecting every edit as success.

Measure unintended authored property/relation changes outside selected scopes and avoidable decision loss, rather than treating every rendered pixel change as an error. Report unnecessary review/relaxation and unwanted retained choices separately. Adjudication disagreement and uncertainty remain visible. Count cold capture, free selection, retrieval and recurring work, with training reported separately and amortization based on observed revision counts.

Predeclare success criteria before held out evaluation. A possible adoption target is a 20 percent reduction in total active effort with preregistered noninferiority margins for quality and acceptable completion, agreed with editors. Calibrate margins and study size from the pilot. This threshold is proposed, not observed. If benefits depend on amortising capture over repeated revisions, report the revision count and assumptions rather than excluding setup. Retain caption ownership and locked content as release requirements in the evaluated suite; zero observed failures does not prove universal correctness.

### Editor and reader studies

The editor/designer study tests composition and subsequent maintenance as a linked task. Use counterbalanced conditions, matched but distinct packets, standard training and a proficiency check. Avoid repeating the identical composition/revision in each tool. Analyse participant and article or issue clustering; preregister the analysis and account for unsuccessful tasks rather than silently dropping them. Obtain applicable human research ethics review and informed consent before recruitment or data collection.

Predeclare task limits, failure handling and the effort estimand. Report acceptable completion rate alongside effort; failed or abandoned tasks cannot count as cheap successful revisions. An effort advantage requires noninferior acceptable completion as well as quality. Include unsuccessful tasks in a preregistered analysis and sensitivity checks, with their actual inspection and repair time recorded.

Time to acceptable completion is unobserved after abandonment; report observed unsuccessful-task effort and completion separately. Do not silently impute a successful completion at the time cap. Use predeclared failure-penalty sensitivity analyses where appropriate, and do not compare effort only among survivors. Both quality and completion margins must be editorially justified before held-out evaluation.

A separate reader study tests completed outputs: identify hierarchy and navigate the article, locate an illustration's explanation, interpret it, follow a caption or note and return, and read under narrow or enlarged text conditions. Readers receive anonymised outputs. Predeclare sampling: compare matched completed tasks and report exclusions and completion differences, so output selection cannot conceal failures. These results assess reading consequences, not editor productivity or universal aesthetic superiority.

### Parallel exploration and free selection

After the controlled pilot, allow designers to choose which aspects to combine from coherent alternatives sharing a pinned hero, brand, copy and asset set. This extends the core composition/revision sequence to exploratory practice and measures whether selection and bookkeeping outweigh reuse. Record accepted, rejected and abandoned combinations, exceptions and repairs.

Provide the same candidates when isolating representation effects. A separate generation comparison can test parallel versus sequential exploration at matched candidate count, model calls, critique, integration and human time budgets. Ten agents are an eventual capacity option; agent count is neither the novelty nor a promised quality multiplier.

## Demonstration and reproducibility

Publish a complete Baddie Issue 0 with responsive web reading, EPUB and the existing A4/A5 PDF outputs from one release. The central walkthrough selects typography from A and spatial hierarchy/image treatment from B, inspects their composition, then lengthens a headline and replaces artwork. Show retained and adapted decisions, a deliberate exception, a conflict requiring repair, and the resulting renditions. Additional cases cover passage rewrites, splits/moves, semantic replacement, deletion and infeasibility. Margin demonstrates annotation persistence through reflow and recorded migration or a visible orphan after revision.

Pin source and release IDs, relation records, policies, licensed assets, fonts, toolchain and renderer versions, model configuration, stored model outputs and accepted operations. Store the checked artifacts and sufficient evidence to connect a revision to its outputs. Define the replay guarantee per artifact: semantic equivalence, measured layout equivalence or byte identity. Only claim byte identity where repeated execution in the specified environment demonstrates it.

The research page presents the representation and composition/revision experiment, Baddie as the native publication artifact, and the current converter as a separate PDF import demonstration. Include curated persistent samples, selectable operation records, branch comparisons, a revision walkthrough, downloads, source/version records, protocol, results and known failures. Mark proposed capabilities distinctly from running demonstrations. An inspectable demonstration establishes behaviour; held out comparisons and human studies establish comparative value.

## Roadmap and features

| Milestone | Scope and ownership | Dependencies and acceptance gate |
|---|---|---|
| 1 Establish the source and decision contract | Publishing application owns entity continuity, revisions and releases; Aether owns typed creative decisions and alternatives. Define targets, correspondences, scopes, exceptions, dependencies, applicability and conflict/repair states in an application-owned pilot sidecar. | Cover the bounded vocabulary and rewrite, split, merge, move, replacement and deletion fixtures. Distinguish IDs, revision events and digests; avoid a universal schema migration. |
| 2 Build the strong baseline and minimal composition/revision workflow | Ernie.SG connects the fixture to the native compiler; Aether retains alternatives and supports selection, scoped composition, dependency inspection, stored replay and repair. Instrument both conditions with equivalent information and native facilities. | Combine A's typography and B's spatial treatment, then change copy/artwork. Inspect accepted choices, interactions and repairs. This Aether seam is on the core path. |
| 3 Run the five-packet pilot | Research workflow exercises composition plus adaptation across hierarchy, spatial treatment, crops, relations and exceptions; refine the vocabulary and labels from actual failures. | Measure total setup/composition/revision effort and completion; establish usable baseline parity and quality criteria before freezing the study. Proceed on evidence, not an assumed novelty. |
| 4 Complete Baddie Issue 0, reader, CMS and Margin | Baddie owns issue navigation and reading controls. Renderers address proportions, legibility, table access and ruling fidelity. Berlayar owns authoring/releases/export jobs; Margin owns the release/entity/span bridge, persistence and migration. | One pinned complete issue renders web, EPUB and A4/A5. Readability receives independent review. Annotations persist after reload/reflow; changed targets resolve with evidence or show an orphan. CMS and fixture adapters produce equivalent content. |
| 5 Extend the bounded creative workflow | Aether applies the tested operations to feature openers, cover, interview modules and visual essays; add free selection and parallel exploration with counted selection burden. | Exceptions and selected choices remain inspectable through revision, conflicts are resolved, and rejected/no-op tasks remain in outcome records. Broader generation does not replace the controlled mechanism comparison. |
| 6 Freeze and evaluate | Research workflow freezes implementations and protocols, runs the held out benchmark and editor study, then the separate reader study. | Publish complete outcomes, uncertainty, failures, setup costs and comparative quality. Revise or reject the mechanism claim if the strong baseline performs comparably. |
| 7 Publish the research artifact and extend selectively | Baddie and research site publish the complete issue, source records, demonstrations and evidence. Struct receives portable extensions through its contract; Aether and CMS retain domain responsibilities. | Broader publication support, Vibes commissioning, translation, compiler convergence and print production proceed only with their own requirements and validation. |

Resolve the shared source, identity and decision contract first. The baseline and minimal Aether composition/revision seam form the experiment's critical path. Reader quality, CMS and Margin can then proceed in independent lanes against the contract; live CMS and annotation services are not prerequisites for the five-packet pilot. Keep schema changes and compiler integration under one owner at a time. Each coherent implementation unit receives independent review and relevant checks; the final integrated revision needs fresh validation.

The first implementation deliverable is one native Baddie feature with two coherent alternatives. Select typography from A and spatial hierarchy/image treatment from B, compose them, then use a longer headline and replacement artwork. Show applicable choices retained or acceptably adapted, interactions that need reconsideration, preserved passage/figure/caption ownership and an inspectable repair log. Expand into Issue 0 while the pilot determines whether the representation earns its complexity.

## Separate PDF recovery track

The existing adapter remains useful for import and backlists. Its distinct question is whether source grounded reconstruction reduces correction effort required to obtain publishable reflow, compared with the same extraction without reconstruction and strong external conversion workflows. [Docling](https://docling-project.github.io/docling/) supplies extraction; [DAISY's conversion comparison](https://daisy.org/activities/projects/ai-special-interest-group/pdf-conversions-put-to-the-test/) illustrates why reader criteria and capable competitors matter.

Use separate extraction, reconstruction, production effort and reading evaluations. Match final quality, record errors and human correction time, and preserve tuned versus held out corpus boundaries. Receipts establish specified consistency and integrity; they do not prove extraction correctness or readability. PDF reconstruction failures and successes must not be attributed to the native authoring revision mechanism.

When structured source is available, include source-based conversion as a reference: [LaTeXML](https://math.nist.gov/~BMiller/LaTeXML/manual/usage/) already supports XML/HTML/MathML and EPUB production from LaTeX. PDF-only recovery is a different input problem; semantic output alone is not novel. The [arXiv HTML feedback reports](https://github.com/arXiv/html_feedback/issues), including [issue 7080](https://github.com/arXiv/html_feedback/issues/7080), motivate concrete readability cases. Report volume does not establish unique affected users, confirmed defects or demand for our proposed representation. Deduplicate and adjudicate cases, keep version references, and separate regression discovery from held out evaluation.

## Future learning from decision histories

A useful future corpus records decision episodes: content and context, alternatives actually shown, selected aspects, explicit rejections, exceptions, subsequent revisions, conflicts and accepted repairs. An unseen alternative is not a negative preference label; an acceptance or written rationale does not prove a universal preference or causal explanation.

Such data could support context-conditioned preference prediction, applicability suggestions or repair proposals. Graphs, symbolic rules and learned embeddings can coexist. A single fixed taste vector is not the necessary endpoint, and the representation study does not depend on proving that taste is learnable.

The later question is whether relational and revision histories improve prediction or reduce human repair work beyond equally informative flattened histories or preference examples. Compare equal evidence, retrieval access, models and budgets; hold out stories and later time periods; measure accepted recommendations and human effort alongside prediction accuracy. PseudoClient and DesignPref are mandatory comparators for a personalised preference claim. Begin this track after the core workflow yields a consented, rights-cleared corpus with reliable choice and repair labels.

## Paper claims and decision gates

A successful core study could support a claim of the following form:

> We specify and evaluate an integrated workflow for selected design commitments through cross-alternative composition and subsequent editorial revision. Across the evaluated tasks, it reduces total capture, production and repair effort and avoidable choice loss relative to an equally informed native workflow, while maintaining publication quality, substantive completion and freedom to reconsider.

The actual result supplies the effect, uncertainty, corpus and limitations; each claimed improvement and noninferiority condition needs evidence. Composition and subsequent adaptation are both core. Baddie supplies the complete artifact, but does not establish novelty. Equivalent native semantics support an interaction/empirical framing; a separate representation claim requires a precise, demonstrated technical advantage. Review of these documents validates the specification, not scientific novelty or efficacy.

| Decision after the pilot | Evidence and action |
|---|---|
| Proceed with the interaction/empirical study | Selections are operationalizable without pervasive ambiguity, baseline parity/completion are credible, and multiple interacting composition-plus-revision packets show promising net benefit after capture costs. |
| Reframe as an interaction comparison | Native records express the same protocol; compare detection, navigation and repair against equally informative native diagnostics rather than greater expressive power. |
| Pursue representation/system novelty | Executable counterexamples and technical comparison show a useful economy, enforcement, tractability or authoring advantage. A new vocabulary alone is insufficient. |
| Stop the mechanism-superiority claim | A tuned equally informed baseline matches outcomes, realistic capture costs dominate, labels require retrospective revision, or gains depend on extra information, superior rendering, extra budget or lower quality/completion/agency. Use the simpler mechanism. |

A benchmark or negative-result paper still needs reusable tasks, credible baselines and informative findings; failure alone is insufficient. Positive evidence must extend beyond caption grouping or deterministic formatting, or the claim must narrow to the demonstrated cases.

## Paper framing and publication options

**Working title:** REPResenting Taste: Composable Design Decisions Across Alternatives and Revisions.

**Keywords:** design representation; accepted design decisions; selective composition; content binding; dependency tracking; revision semantics; mixed-initiative authoring; creative alternatives; adaptive publishing; human-AI collaboration. Use taste as a motivating term with the operational definition above, rather than promising a complete model of aesthetic preference.

Venue fit below is a recommendation based on the proposed contribution. Calls and dates were checked on 8 October 2026; later cycles require a fresh check.

| Venue | Fit and evidence needed | Submission planning |
|---|---|---|
| [ACM DIS](https://dis.acm.org/2027/call-for-papers/) | Recommended initial focus for the surviving situated interaction/empirical contribution: commitment articulation, cross-alternative composition and subsequent production repair. A pictorial needs a visual research argument, not a polished magazine alone. | DIS 2027 title/abstract: 11 January 2027; papers/pictorials: 18 January 2027, Anywhere on Earth. Target only if the contribution and evidence are ready. |
| [ACM UIST](https://uist.acm.org/2026/author-guide/) | Strong fit if the technical interaction for selecting, composing and repairing decisions is itself substantial and generalisable beyond the magazine. | Target a future cycle once the working system, mechanism comparison and proportionate evaluation are ready; the linked guide is for 2026. |
| [ACM Document Engineering](https://www.documentengineering.org/doceng2026) | Conditional focus if a substantive document representation/system advantage emerges, with multiple renditions and production evidence. Struct ownership alone does not determine venue fit. | Plan around the next published call. DocEng 2027 is announced, but its paper deadline is not yet stated on the linked site. |
| [ACM CHI](https://chi2027.acm.org/contributions-to-chi/) | Fit for broader human-AI workflow, agency and reuse findings demonstrated with designers and editors across settings. | [CHI 2027 papers](https://chi2027.acm.org/authors/papers/) closed on 10 September 2026. Plan for a later cycle; do not infer an unannounced deadline. |
| [ACM IUI](https://iui.acm.org/2027/call-for-papers/) | Later option if context-conditioned preference/applicability inference becomes a substantive computational contribution with human validation. | IUI 2027 full papers closed on 20 August 2026. Explicit symbolic rules alone do not establish the proposed learning contribution. |
| [ACM TOCHI](https://dl.acm.org/journal/tochi) or [International Journal of Human-Computer Studies](https://shop.elsevier.com/journals/international-journal-of-human-computer-studies/1071-5819) | Journal options for a mature account integrating the representation, interaction and sustained empirical workflow findings. | Consider after a substantial body of evidence; any extension of conference work must meet the selected journal's current originality policy. |

Prioritize the selected-commitment lifecycle and its interaction/empirical evidence for DIS, then broaden to CHI if findings generalize across users/settings. UIST requires a distinctive technical interaction; DocEng requires a substantive document/system advantage. A reusable benchmark is a supporting or alternative story only with informative comparative findings. Defer preference learning. Confirm the principal story after the pilot, and do not make a calendar deadline substitute for evidence.

## Potential collaborators and informal reviewers

These are candidates for collaboration or informal pre-submission critique based on relevant work, not confirmed participants. Availability and interest are unknown. Formal conference reviewers are assigned through the venue's process; collaboration and substantive involvement must be handled under its conflict policy.

| Candidate | Relevant expertise | Question to bring them |
|---|---|---|
| [Ravi Chugh, University of Chicago](https://people.cs.uchicago.edu/~rchugh/) | Programming systems, direct manipulation and Sketch n Sketch. | Does the bounded decision model add useful composition/revision semantics beyond editable programs and bidirectional updates? |
| [Jun Kato, AIST](https://staff.aist.go.jp/jun.kato/) | Creativity support, production tools and representations connecting code and creative artifacts. | Does the interaction fit real professional production, and which decision granularity makes replay and remix usable? |
| [Frank Mittelbach, LaTeX Project](https://www.latex-project.org/about/team/) | Typesetting, float placement and document engineering. | Are the pagination and constraint baselines competent, and do claimed intent-preservation cases exceed existing practice? |
| [Nikolas Martelaro, Carnegie Mellon University](https://www.hcii.cmu.edu/people/nikolas-martelaro) | Human-AI design tools and PseudoClient. | How should we distinguish accepted decisions from learned personal preferences and test any later inference benefit? |
| [Yuki Koyama, University of Tokyo](https://koyama.xyz/) | Preference-based optimisation and interactive design exploration. | How should selection burden, interacting parameters and context-conditioned preferences be evaluated? |
| [Arvind Satyanarayan, MIT](https://www.eecs.mit.edu/people/arvind-satyanarayan/) | Declarative representations, expressive authoring and human-data interaction. | Which bindings and interaction semantics generalise beyond the initial publication tasks? |

For the first study, prioritise a representation/HCI collaborator, a practising editorial designer who can challenge the task realism, and a publishing/typography expert who can scrutinise the baseline and output quality. Add preference-learning expertise when that track becomes active. A useful discussion packet contains the bounded schema, a working composition-plus-revision example, the closest prior-art comparison, baseline parity and pilot failures. Collaborators who design the method should not serve as the supposedly independent blinded assessors of its outcomes.
