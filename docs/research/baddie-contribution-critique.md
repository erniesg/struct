# Baddie contribution critique and formalised research direction

**Verdict:** The problem is credible, but a novel representation of taste is not established. The strongest surviving direction is an interaction and empirical contribution: test whether explicit maintenance and review of selected design commitments improves **composition across alternatives followed by editorial revision**, compared with an equally informed components, constraints and history workflow. The proposed representation is presently a useful synthesis of established mechanisms. Its scientific value depends on a demonstrated semantic, authoring or repair advantage; a magazine implementing the mechanisms does not establish that advantage.

**Assessment date:** 8 October 2026. **Confidence:** high that the individual mechanisms and broad recombination/adaptation claims overlap prior work; moderate that the linked workflow is worth testing; low that its efficacy or distinctive representation semantics have been demonstrated. These are judgments about the available evidence, not numerical probabilities of acceptance.

**Baseline assessed:** [Preserved reviewed Baddie research plan](baddie-research-plan-reviewed-baseline.md), working title *REPResenting Taste: Composable Design Decisions Across Alternatives and Revisions*. Its actual SHA256 at assessment was `5eefc2ef6c5e18ac097cc053b223f6966a40eda8bd941e75a1a795e77167d2b7`, exactly matching the supplied reviewed version. No intervening change was found at assessment. Following the user's update request, the [current plan](baddie-research-plan.md) incorporates this critique; the linked baseline remains byte-for-byte unchanged. References to the baseline's claims and venue recommendation below concern that preserved version. [Figure and table readability requirements](figure-table-readability.md) constrain acceptable output; they are not evidence of novelty or an implemented solution.

## What is defensible now

There is a coherent production problem: desirable treatments can be distributed across alternatives, their combination can interact, and later copy, artwork or format changes can make selected treatments inappropriate. The plan correctly treats composition and revision as linked, preserves legitimate exceptions, distinguishes replay from regeneration, and proposes unusually strong baseline parity. Its caution about semantic identity is justified.

Three claims must be separated:

| Claim | Current judgment | Evidence needed to strengthen it |
|---|---|---|
| A bounded record of selected commitments can specify what to carry forward and what requires review. | Defensible as an operational specification, provided ambiguous judgment remains explicit. | Executable examples, complete outcomes and an account of capture ambiguity. |
| This record is a substantively new representation with distinctive semantics. | Novelty hypothesis, currently weak. Components, rules, constraints, programs and history can plausibly encode the same information and transitions. | A precise comparison showing a useful difference in expressiveness, enforceability, tractability or authoring complexity; new field names do not suffice. |
| An integrated commitment workflow reduces effort and unintended changes at matched quality and completion. | Plausible, untested hypothesis. | Controlled comparative evidence including capture, selection, failure and repair costs. |
| It learns or faithfully represents a person's taste. | Unsupported by this study. | A separate preference/inference study with equal evidence and appropriate held-out data. |

Acceptance is evidence of a situated choice, possibly made under time pressure or compromise. It is not proof of a stable aesthetic preference, an exhaustive rationale, or continued acceptance after revision. A designer must be able to reconsider an applicable choice. Over-preservation can damage quality and agency just as avoidable loss can.

## Prior art overlap and differentiation

The matrix reports demonstrated capabilities and the remaining burden on this proposal. “Not demonstrated” means the inspected publication does not supply that evidence; it never means the capability is impossible or absent from all implementations. Primary papers were inspected for the central comparisons. Source-record-only checks are marked. The proposed difference in the last column is a **hypothesis to test**, rather than an established gap.

| Primary work and publication status | Established overlap | Remaining distinction or burden |
|---|---|---|
| [RevG, Chen et al., ACM TOG / SIGGRAPH 2011](https://www.microsoft.com/en-us/research/wp-content/uploads/2011/08/c96-f96_299-a47-paperfinal-v3.pdf), especially §§5–6 | Image operation DAG, spatial/semantic dependencies, branching, selective replay/undo, merging and explicit conflict choices. | Editorial target continuity and applicability after copy/artwork replacement are not demonstrated. Operation graphs, provenance, replay and conflict surfacing cannot be claimed new. |
| [GEM-NI, Zaman et al., CHI 2015](https://vvise.iat.sfu.ca/user/data/papers/gem-ni.pdf) | Selected generative nodes/connections merge into alternatives; matching parameters are overwritten and conflicts can require later repair. Linked edits and Cartesian structural/parameter variants support subsequent change. | The proposed lifecycle must exceed selected graph merge plus parameter updates. Little observed post-hoc merging in its study leaves usefulness unsettled, not capability absent. |
| [VST, Warner et al., UIST 2023](https://arxiv.org/html/2309.11628v1), §§3, 6 | Editable correspondences and selective vector style attributes, including fonts. It exposes a copied font-size fit problem; target layout/structure are held constant. | Spatial transfer and later editorial applicability are not demonstrated. Its preliminary effort comparison has an operator experience confound; it cannot establish the present hypothesis. |
| [VLT, Warner et al., ICML AI-HCI workshop 2023](https://arxiv.org/html/2309.11635v1), §§3–6 | Selective transfer of element layout and individual containment, order, alignment, overlap, offset and dimension rules; handles differing canvases/elements. | A close composition comparator. Do not present its future optimizer/locking proposals as implemented or label it ICML main-track work. It does not demonstrate the full editorial repair lifecycle. |
| [Sketch-n-Sketch, Mayer et al., PACMPL / OOPSLA 2018](https://arxiv.org/abs/1809.04209) | Output edits update an underlying program; ambiguous repairs can be selected, and custom update lenses guide reconciliation. | Editable programs and ambiguity-aware repair are established. A commitment layer must explain what it adds beyond a program with equivalent declarations. |
| [Penrose, Ye et al., ACM TOG / SIGGRAPH 2020](https://penrose.cs.cmu.edu/siggraph20) | Semantic objects/relations, reusable visual styles, hard/soft optimization and multiple renderings. | Relational, semantic styling is established. Solver feasibility does not establish aesthetic acceptance or editorial truth. |
| [Mix’n’Match, Rutledge et al., Hypertext 1999](https://ir.cwi.nl/pub/11338/11338B.pdf), especially pp.1, 5, 9 | Exchangeable modules for appearance, layout, media, timeline and navigation combine into styles over semantic hypermedia. Its conclusion raises whether one module overrides another's aesthetic intentions. | Direct antecedent for both modular recombination and interacting intentions. Fine selected commitments plus later editorial review may differ in granularity and interaction, not underlying possibility. |
| [Rutledge et al., Hypertext 2000, author-intent adaptation](https://ir.cwi.nl/pub/11350/11350B.pdf) and [Cuypers, Geurts et al., MMM 2001](https://ir.cwi.nl/pub/4340/04340D.pdf) | Rhetorical/communicative structures become presentation constraints; alternatives and backtracking address overflow/infeasibility. | Author intent, adaptive constraint translation and fallback are established. Explicit post-acceptance review may still be a useful interface question. |
| [Adaptive Grid-Based Document Layout, Jacobs et al., ACM TOG / SIGGRAPH 2003](https://grail.cs.washington.edu/wp-content/uploads/2015/08/Jacobs2003.pdf) | Newspaper/magazine templates adapt to content geometry and viewing conditions, with constraints, pagination and template authoring. | This is mandatory document-specific prior art for copy/artwork/format adaptation. Responsive magazine layout is not the gap. |
| [Authoring Diagrams That Adapt to Their Viewing Context, McCormack et al., JVLC 2018](https://research.monash.edu/en/publications/authoring-diagrams-that-adapt-to-their-viewing-context/) — primary record/abstract checked | Orthogonal layout, object, style and text alternatives form a cross product selected by context and author preference, with an authoring tool and evaluation. | Strong overlap with alternative composition and adaptation. Detailed implementation comparison remains unresolved because this check used the primary record, not full text. |
| [Bricolage, Kumar et al., CHI 2011](https://hci.stanford.edu/publications/2011/Bricolage/Bricolage-CHI2011.pdf) and [Interactive Layout Transfer, Dayama et al., IUI 2021](https://kashyaptodi.com/data/LayoutTransfer-IUI2021.pdf) | Correspondence-based content retargeting into another design; template transfer under guidelines. The latter visualizes violations in outdated designs and proposes repairs with minimal layout change. | Transfer, violation inspection and repair are established. Typed GUI elements differ from arbitrary editorial meaning, but that alone does not establish a new abstraction. |
| [Scout, Swearngin et al., CHI 2020](https://arxiv.org/abs/2001.05424) | High-level structure, emphasis and order constraints generate alternative layouts. | “Design judgment” is not new merely because constraints are expressed at a higher level than coordinates. |
| [Cascading Tree Sheets, Benson and Karger, WWW 2013](https://archives.iw3c2.org/www2013/proceedings/p107.pdf) | Selector-based content/template correspondence, reusable design fragments and separation permitting content edits without rebuilding presentation. | Content binding and reusable presentation surviving edits are established. The open issue is the cost and quality of reviewing selected commitments. |
| [Cicero, Kim et al., CHI 2022](https://arxiv.org/html/2203.08314), §§4–5 | Reusable selector-targeted transformations, associated-element handling and conflict-management principles. | Scopes, semantic selectors, responsive transformations and generic conflict rules are prior art; a proposed contract must exceed or improve their use. |
| [Flexible Responsive Visualization Design, Hoffswell et al., CHI 2020](https://idl.uw.edu/papers/responsive-vis) and [Dupo, TVCG / VIS 2023](https://content.ieeevis.org/year/2023/paper_v-full-1020.html) | Global edits, device-specific customizations and differences; selective propagation and mixed-initiative responsive authoring. | Cross-format revision with scoped exceptions is already an interaction topic. Selected choices after changed editorial meaning remain a narrower question. |
| [DesignTrace, Peng et al., CHI 2026](https://xiaohanp.github.io/pdf/CHI_26_DesignTrace.pdf), §5.2 | Semantic Palette attributes combine and apply globally/locally; branches, histories and rationale support reuse. Authors considered node merging and cascading edits but withheld them after expert feedback about control and provenance. | A particularly close interaction comparator and warning. Its canvas-object Merge is not decision-branch merge. Test whether proposed composition/revision avoids the problems that motivated its omission. |
| [Brickify, Shi et al., CHI 2025](https://www.jeffjianzhao.com/papers/brickify.pdf), §§4, 8 | Persistent subject/style/color tokens, local/global links, grouping, spatial relationships and recorded configurations support selective reuse and refinement. | Reifying visual intent into reusable units is established. A bounded editorial protocol may add review precision; tokens alone are not distinctive. |
| [IntentTagger, Gmeiner et al., CHI 2025](https://arxiv.org/html/2502.18737v1), §§6.5, 7 | Atomic intent tags steer slide/deck creation. Participants wanted to pin accepted fonts/colors against later unintended change. | The need and granular intent unit are established. The paper identifies locking as an unresolved interaction direction; that is motivation, not exclusivity. |
| [IdeaBlocks, Choi et al., DIS 2026, arXiv v4](https://arxiv.org/html/2507.22163v4), §4.1.4 | Reusable property/direction/range blocks, paths and projects; literal and context-adaptive reuse across branches. | Intent reuse/adaptation already has a published interaction contribution. Its divergent exploration differs from validating accepted publication commitments after editorial changes. |
| [LayoutShop, Pacific Graphics 2026](https://arxiv.org/html/2609.05098v1), §§4.1–4.2; [proceedings record](https://diglib.eg.org/items/d28ac277-1f91-4d32-9df7-c43eb87cd104) | Multiple user templates blend into a layout tree, refitted to article content; illustrations share pages with their reference text. | Stronger overlap than figure placement alone. Subsequent accepted-choice applicability/repair is not demonstrated. Calling it simply an unaccepted preprint is outdated. |
| [StructuredEdit, July 2026 preprint](https://arxiv.org/html/2607.04612v1); [status record](https://arxiv.org/abs/2607.04612) | Typed patches and deterministic constraints; bounded resampling can end in an identity edit. | Safe validity must be separated from successful editing. The record describes a planned SIGGRAPH Asia submission, not verified acceptance. |
| [DesignAsCode, v3, accepted ACM Multimedia 2026](https://arxiv.org/html/2602.17690v3), §5 and Appendix B.3 | Editable design code, aspect-ratio retargeting, and evaluated text replacement, color and font-size edits. | The plan's v1-based summary understates revision overlap. Cross-alternative commitments and explicit applicability review remain unverified. |
| [ReLayout, February 2026 preprint](https://arxiv.org/html/2602.01046), §§3–6 | Typed add/delete/move/resize edits and a relation graph protect hierarchy among unedited elements; composite edits are demonstrated. | Relation-preserving revision is established. Content replacement is excluded and relation/overlap failures remain, so it is a partial comparator. |
| [ReSlide](https://arxiv.org/html/2604.21205), §§4–5; [DIS 2026 proceedings](https://dis.acm.org/2026/proceedings/) | Contextual constraints, narrative revision intent, lineage, reuse and synchronization across presentation versions. | Revision intent and multi-session maintenance are not unique to Baddie. Compare the actual commitment interaction, not domain names. The proceedings confirm its venue despite a stale template header in the arXiv HTML. |
| [PseudoClient, DIS 2021](https://dlin.org/papers/pseudoclient-dis2021.pdf) and [DesignPref, November 2025 preprint](https://arxiv.org/html/2511.20513v1) | Preferences learned from design examples; designer-specific pairwise judgments and rationales. | They target prediction rather than this executable lifecycle. DesignPref is listed as a short **non-proceedings** CVPR 2026 P13N workshop paper on the [official workshop site](https://p13n-workshop.github.io/), not CVPR main track. |

History and merge also have ordinary software analogues: patches with preconditions, semantic/AST merges, assertions, dependency invalidation and event logs. [Git's three-way merge documentation](https://git-scm.com/docs/git-merge) supports the ordinary merge comparison; a textual merge cannot establish visual or editorial validity. [Cassowary](https://badros.com/greg/papers/cassowary-tochi.pdf) establishes incremental required/preferred geometric constraints. Neither incremental recomputation nor ranked constraints carries novelty here. [Design rationale, MacLean et al., CHI 1989](https://doi.org/10.1145/67450.67497) already treats alternatives and reasons as part of the design artifact; this record/abstract check supports that limited historical point, not a detailed executable comparison.

The closest **combination** is modular style mixing + adaptive document templates + selected graph/rule transfer + operation history + granular intent interaction. A competent workflow can plausibly express the complete job using these facilities. A missing single paper demonstrating every stage is not a sufficient novelty argument. Smaller grammars can still be contributions through expressive economy or enforceable behavior, as Cicero illustrates, but that advantage must be shown rather than asserted.

## Strongest objections and what survives them

1. **“This is a constraint/program/history wrapper.”** This is substantially correct today. Constructively, targets become selectors, exceptions become guarded branches, accepted relations become predicates, adaptations become parameter domains, dependencies become a graph, and repairs become versioned transactions. An expressive existing program can encode the record. The surviving claim concerns the cost and reliability of maintaining this information, or a demonstrably simpler bounded abstraction—not representational impossibility in the baseline.

2. **“Accepted taste is underdetermined.”** Two identical accepted covers can encode different commitments: preserve the typeface/hierarchy while allowing wrapping, or preserve the exact two-line break. A screenshot and identical prior edits cannot distinguish these intentions. Capture an explicit commitment or request later adjudication, and count its cost. Neither source inference nor the proposed schema can manufacture the missing information.

3. **“The lifecycle boundary is an arbitrary literature gap.”** This objection survives. The review found no inspected paper demonstrating the entire selected-A-plus-B-to-editorial-revision protocol, but the matrix shows strong adjacent and overlapping systems. Frame novelty as a hypothesis about a useful combined interaction and resulting evidence. Do not claim “first” from this search.

4. **“You win by giving your system an oracle.”** The proposal fails if only the treatment gets mappings, intended exceptions, permissible adaptations or conceptual-change declarations. Both conditions receive equally accessible, machine-readable facts and history when agents are used. Gold adjudication labels remain hidden from both.

5. **“Your safety metric rewards refusing to edit.”** A no-op, endless review queue or early abandonment is not successful preservation. Report substantive completion and unresolved outcomes over every assigned task. A valid but unchanged output fails a requested copy/artwork edit.

6. **“Applicable means whatever you decide after seeing the result.”** Pre-register allowed sets and adjudication rules. Keep ambiguity visible; separately report unnecessary invalidation and unwanted persistence. An editor's legitimate change of mind is a new judgment, not evidence that an old predicate was preserved.

7. **“Recording everything will cost more than it saves.”** This is the central empirical risk. Record only selectable commitments with an operational purpose; do not demand an exhaustive rationale ontology. Compare cold capture and recurring revisions separately, including free selection and retrieval burden. DesignTrace's rejection of cascade/merge features is a concrete reason to test cognitive overhead.

8. **“The product stack hides the research question.”** Baddie, Aether, Struct, CMS/release workflow and Margin are legitimate product integration, but integrating them is not the experiment. A complete issue provides ecological evidence; the minimal mechanism comparison must run without a universal schema migration, live CMS dependency or preference learner.

## Precise surviving question and contribution

**Core question:** When designers select different treatments from alternatives and then change copy, artwork or output dimensions, does an explicit, inspectable lifecycle for those selected commitments reduce total capture, composition, verification and repair effort—and avoidable decision loss—relative to an equally informed native workflow, while maintaining publication quality, substantive completion and freedom to reconsider?

**Contribution statement now:** We propose a bounded operational protocol for recording selected commitments, composing their treatments, and reviewing their applicability and realization after editorial changes. We specify counterexamples and a comparative protocol that can determine whether this synthesis provides useful interaction benefits or merely duplicates existing facilities.

**Contribution statement permitted after positive evidence:** In the evaluated tasks, an integrated commitment-maintenance interface improved specified production outcomes over a competent workflow with equivalent content, correspondences, history, assets, rules and rendering. State the measured effects and uncertainty. Claim representation novelty only if a separate technical comparison demonstrates it. Composition and subsequent revision must both be included; caption placement and deterministic formatting are diagnostic cases, not the thesis.

## Operational specification

This is a proposed bounded specification, not an implemented API or a claim that the following mechanisms are new. The useful unit is a **recorded commitment**: what observable aspect was selected, where it applies and what changes were authorized. An operation is one way to realize it. Keeping the operation and the judgment distinct avoids mistaking replayed parameter values for preservation.

### State, entities and correspondence

Let a state be `S = (E, V, L, P, K, D, H)`:

- `E` contains authored entity IDs and types: headline, passage group/span, figure, caption, table, asset and so on.
- `V` assigns current content/asset versions, digests and measurable properties. A version/event ID and a content digest are different: two events may have identical bytes.
- `L` records semantic/editorial relations such as caption ownership and “illustrates”; these are distinct from geometric proximity and reading order.
- `P` contains authored presentation properties. `K` is the output context, including actual content area, reader type settings, fonts, renderer/tool versions and permitted alternatives.
- `D` contains commitments and their current evidence. `H` records alternatives, operations, acceptance, repairs and releases.

Rendering `R(S)` produces fragments and measured output. Derived geometry is not an authored entity or proof of its semantic identity. A figure's logical ID may persist while its asset changes. A continuing passage may be rewritten while its explanatory purpose changes.

A source-to-target correspondence `m` is typed and scoped, with versioned evidence. Composition requires a mapping for the selected target; a one-to-many split or many-to-one merge requires a declared interpretation. Neither matching labels nor shared IDs authorizes duplication of every associated relation. Dynamic role selectors must declare whether new matching entities join the scope; otherwise scope is the captured target set.

### Commitment record and explicit preconditions

Use `d = (id, source, T, Q, X, p, A, o, Read, Write, Deps, priority, acceptance)`:

| Field | Observable meaning |
|---|---|
| `source`, `acceptance` | Accepted alternative/content/context and event; acceptance may be provisional or a documented compromise. |
| `T`, `Q`, `X` | Target resolution, owned property/relation scope, and explicit exceptions. Exception IDs travel only through declared successor mappings; an exception does not spread to all headings accidentally. |
| `p(S,m)` | Applicability precondition with true/false/unknown outcome. Requirements include target/type availability, continuity declarations, required asset measurements and context compatibility. Unknown evidence remains unknown. |
| `A(S,m)` | Allowed set of observable realizations/parameter assignments, including exact settings, tolerances, relations and permitted adaptations. A free-text rationale is not an executable set. |
| `o` | Typed realizing operation(s), with operation version, preconditions, declared effects and output evidence. It may fail even when a feasible realization exists. |
| `Read`, `Write`, `Deps` | Inputs, direct authored effects and dependency/constraint interactions. Font metrics, text length, focal metadata and global pagination may belong here. |
| `priority` | Explicit hard/soft treatment and accepted relaxation policy. A soft preference may lose to another; the loss is reported. A hard commitment cannot be silently weakened. |

For example, “font family F, display/body size ratio 3, heading size 44–48 CSS px, natural wrapping permitted” defines a bounded admissible treatment. “Keep the elegance” does not; it requires human judgment rather than a fabricated predicate. A numerical domain is illustrative and must be accepted for the actual output profile.

Track three dimensions separately:

| Dimension | Values and interpretation |
|---|---|
| Applicability | Applicable / inapplicable / unknown. Inapplicability is about whether the commitment fits the declared target/context, not whether the solver found a layout. |
| Realization | Satisfied without adaptation / satisfied within authorized adaptation / violated / unevaluable. Record actual measurements and changes. |
| Review | Accepted / pending / rejected, tied to a state and scope. Previously accepted content is not automatically accepted after a material repair. |

Joint conflicts and feasibility diagnostics supplement these dimensions. Two individually applicable commitments can be jointly impossible. A satisfied preference can also remain pending subjective review. “Taste preserved” is therefore too strong a label for a predicate pass.

### Selective composition

`Compose(S, selections, mappings)` returns a candidate, evidence and unresolved conflicts; it commits only an accepted transaction. Preconditions are available source versions, typed resolved mappings, declared scopes/exceptions, operation inputs, and a shared rendering context or explicit retargeting policy.

1. Resolve only selected scopes. Import an upstream dependency only when necessary and disclosed. If selecting B's “layout” also requires B's font metrics or omitted image, surface that dependence instead of quietly importing unrelated choices.
2. Instantiate commitments and realizing operations on mapped targets. Keep provenance. Identical compatible writes can coalesce; incompatible writes need an explicit precedence, override or repair.
3. Check read/write interference and joint constraints. Disjoint writes are insufficient: a font and a box size can make a headline impossible to fit together.
4. Recompute the affected geometry and evaluate applicable commitments and release constraints. Show unknown targets, relaxed preferences and unfulfilled selections.
5. Accept the candidate and resolved choices, or retain the prior accepted state with an unsuccessful composition record. A draft may display unresolved content, but cannot count as a successfully released composition.

Last-write-wins is one explicit policy, not a neutral definition of successful composition. If it discards A's selected typography, the task has lost that choice even when all code runs. A solver timeout is “no solution found within budget”; call it infeasible only with a complete decision procedure or a certificate for the modeled domain.

### Revision, adaptation and repair

`Revise(S, delta, continuity)` applies a content/context change, updates declared mappings and reassesses commitments. A move with declared continuity can preserve a target. A split may create a group or a selected successor. Deletion makes affected target resolution fail. Concept replacement can invalidate an editorial association even if IDs remain unchanged.

Reevaluate changed reads and their dependency closure; global pagination may force a global check. **Valid adaptation** means a new realization remains in the originally authorized `A`, passes current applicable predicates and output requirements, and changes only declared authored effects. It does not mean the final pixels are identical. An explicit permitted responsive alternate is valid; silently shrinking a dense diagram into illegibility is not.

**Invalidation** records that a precondition is false or that a target cannot be resolved under the mapping. Unknown continuity produces pending review rather than invented truth. **Conflict** records incompatible applicable commitments. **Repair** may adjust parameters inside `A`, propose retargeting, change scope, relax a commitment, replace a relationship, or withdraw it. Crossing `A`, changing a hard rule or asserting new semantic continuity requires a new acceptance event. These are editorial boundaries within the product workflow, not extra permission prompts imposed on this research task.

Store the before/after state, reason, affected commitment and acceptance. Never repair a conceptual relation by keeping the old caption beside a new image without checking its meaning. Keep failed, rejected and no-op repairs in the outcome record. A release requires fulfilled content edits and acceptance criteria; accepted withdrawal of a legitimate invalidated commitment is reported as reconsideration, not preservation.

### Interacting typography and layout counterexample

Consider an illustrative feature-opener fixture. A's selected display face uses 48 px type, 1.1 line height and a 3:1 display/body ratio. B supplies a vertical composition with a 240 px usable box, a 24 px gap and an image that must remain at least 96 px high. These are authored choices in this synthetic example, not measured results from Baddie.

At the wider original width, a two-line headline requires `2 × 48 × 1.1 + 24 + 96 = 225.6 px`, so the combination fits. After a longer headline or narrower width, suppose the pinned renderer requires at least three lines throughout the permitted 44–48 px font-size domain. Even the smallest allowed type requires `3 × 44 × 1.1 + 24 + 96 = 265.2 px`. No assignment within this specified domain fits 240 px.

A writes type properties; B writes arrangement and dimensions. Each was acceptable in its own source, yet the combination fails jointly. The expected output is a conflict over type metrics, available width and box/image requirements. It must not silently shrink type below 44 px, clip copy, shrink the image below 96 px or call reflow a preservation success.

If B's 240 px was only a soft preference and expansion was explicitly allowed, expanding the box is an authorized adaptation with a reported preference relaxation. If it was hard, changing it requires accepted repair. If the editor separately accepted an exact two-line break, even the wider longer-copy version may require reconsideration. Identical original pixels cannot reveal whether wrapping or the break was the selected commitment.

A protected quotation may be intentionally offset while all other headings align. Its exception applies to that entity and declared successors. A broad alignment restyle must preserve that exception; a split into quotation and commentary must not propagate it to both by default. Font changes can also alter unrelated page positions through pagination: preserve untouched authored properties, not every rendered coordinate.

### Image and semantic replacement counterexamples

An accepted cover places a portrait on the left so the subject looks toward right-hand text. A replacement has the same dimensions and normalized focal location but the subject looks left. Reusing crop coordinates satisfies geometry and violates the directional composition. If gaze was modeled and new evidence is reliable, the predicate fails. If it was never captured or the image is ambiguous, the system cannot infer the commitment with certainty; it must show the asset change and request editorial review. Mirroring the new image is not an automatically legitimate repair, especially where signs, identities or documentary meaning would change.

Separately, `C3 belongsTo F3`, `F3 illustrates P17`, and `F3 preferably follows P17` are different claims. P17 can retain its ID while changing from an explanation of correlation to an assertion of causation. Caption ownership and proximity can remain correct while the illustration becomes misleading. A declared concept replacement invalidates or reopens the “illustrates” relation; an unlabeled rewrite leaves semantic applicability unknown unless adjudicated. Moving F3 cannot fix that semantic defect.

If P17 splits into an explanation and a rebuttal, mapping F3 to both preserves coverage but can change its role. Supply the same successor declaration to both experimental conditions. If no declaration exists, neither condition receives an oracle. A dense diagram's preferred 50% width can likewise yield to legibility or an authorized expanded rendition, while keeping aspect ratio, panels, caption and return path. Asset resolution alone cannot prove internal label readability. Wide-table access and meaningful ruling treatments follow the existing readability requirements.

### Limited formal properties and non-guarantees

The following are conditional proof obligations for a prototype, not established theorems about arbitrary design:

- **Authored frame property:** If realizing operations obey complete effect declarations, properties outside their effect/dependency closure remain unchanged. This follows from restricting writes; it does not protect rendered positions or unmodeled aesthetic interactions.
- **Independent composition:** Two operations commute only if read/write effects, target resolution, constraint objectives and derived dependencies are independent, and rendering/normalization is deterministic. Disjoint property writes alone do not satisfy these assumptions.
- **Replay:** Pinned state, fonts, assets, operation versions and deterministic execution—or stored generation outputs—can reproduce specified semantic/layout output. Byte-identical exports additionally require deterministic serialization and metadata. Repeating a prompt gives no such guarantee.
- **Bounded validity:** Under correct predicates and complete checking of a finite adaptation domain, a candidate accepted by the checker satisfies those modeled predicates. This is soundness relative to the specification, not proof of publication quality, semantic truth or user satisfaction.
- **Conflict completeness:** Requires complete dependencies, constraints and a complete decision method in the chosen domain. A practical approximate solver can report detected conflicts and unknowns; it cannot promise detection of every conflict.

There is no general confluence or optimal repair guarantee. For example, reducing type after narrowing the page and then widening it can leave smaller type than directly rendering at the final width, if repair uses the last accepted setting. Recomputing from the original commitment with a deterministic objective might avoid that case, but a human acceptance of the reduced type creates a new commitment and intentionally changes the result. History and policy matter.

Arbitrary rewriting cannot reliably preserve inferred rhetorical role, conceptual continuity, intended hierarchy, irony, figure relevance, emotional balance or the reasons an editor accepted an artifact. Accurate entity tracking does not solve those questions. The strongest enforceable guarantee is transparent behavior against declared, bounded commitments, plus visible uncertainty and editorial reconsideration.

## Smallest decisive prototype and experiment

The first prototype should be one shared component/code publishing runtime with two interaction modes. It needs two or three alternatives, stable target mappings, selected scopes/exceptions, render inspection and the above status/repair record. Implement typography/hierarchy, arrangement and image treatment; add semantic associations as an interacting case. The first slice must demonstrate **A-type plus B-layout/image composition followed by longer copy, replacement artwork and changed width**, including a genuine unresolved case. An animated magazine demo or successful caption binding alone is inadequate.

The native mode has competent styles/components, responsive templates, stable identities, saved correspondences, selective attribute/rule transfer, history/branching, ranked constraints, validation, undo and usable repair diagnostics. The treatment adds only the claimed commitment lifecycle/interaction. Allow a practising expert to configure and improve the native baseline within the same rules. Native capabilities cannot be disabled to create the contrast.

If native facilities express the same lifecycle, retain them. Then compare integration and inspection interactions, or measure expressive economy rather than claim greater expressive power. If parity requires different renderers, distinguish a whole-workflow comparison from a causal mechanism test. An impossibly elaborate bespoke baseline can also mislead: document configuration effort and add an ecological expert-tool reference.

### Five-packet falsification pilot

| Packet | Composition and subsequent revision | Decisive observation |
|---|---|---|
| Feature opener and article | A typography/hierarchy + B spacing/arrangement; lengthen headline and narrow width. | Detect joint infeasibility without losing type, readability or selected layout silently. |
| Visual essay/cover | A type + B focal crop and image/text balance; replace art and copy. | Distinguish geometric reuse from lost directional/semantic relation. |
| Explanatory feature | Compose type/layout and editorial associations; rewrite/split, then concept-replace the explanation. | Handle declared successor mappings and unknown meaning without false preservation. |
| Interview | Combine treatments with an intentional quotation exception; insert/reorder and change format. | Preserve scoped exception without unnecessary review or accidental spread. |
| Data dispatch | Ordinary hierarchy/layout and scoped numeric formatting; update values/labels and width. | Negative control: familiar style rules should be competitive. No broad claim from this case alone. |

Run 3–5 representative packets first, inspect failures, refine the method, then freeze it before held-out evaluation. Each packet includes benign change, interacting change or genuine invalidation across the suite, with complete content and release criteria. Five packets can falsify feasibility or reveal overhead; they cannot prove general superiority or quality noninferiority.

Begin with assigned selections to isolate composition/revision. Add a small free-selection condition starting from identical alternatives to count browsing, articulation and recording burden. Use matched but distinct tasks and counterbalanced conditions; avoid having a participant solve the same packet twice from memory. A pilot with expert operators is a configuration/feasibility check, not a representative designer study.

### Parity and outcome rules

Freeze equal correspondences and continuity evidence, source histories, selected-choice descriptions, scopes, exceptions, revision declarations, content, assets, fonts, renderer, validators, model/tool access, candidate counts and budgets. If both modes use an agent, give its tools equal access to the facts. Record actual computation and waiting as well as equal caps. Count human effort **before** initial capture and correspondence creation; include selection, setup, retrieval, inspection, correction, conflict resolution, verification, retries and abandonment. Report training separately, cold and recurring costs, and amortization over the observed number of revisions rather than an imagined infinite future.

Independent editors define allowed outcome sets before viewing condition outputs. Distinguish retained, authorized adaptation, accepted necessary reconsideration, avoidable loss, needless invalidation, unwanted persistence, unresolved ambiguity and failed realization. Eligible uncaptured choices remain in the denominator. Report decision-level results clustered by participant/article; many commitments from one article are not independent trials. Use blinded condition labels for render quality/adjudication where feasible, report disagreements and do not turn uncertain labels into gold facts by majority convenience.

Measure:

- Total active effort and time to acceptable composition **and** subsequent revision, with stage breakdown; elapsed waiting and computation separately.
- Completion by budget, substantive requested edits, failure/no-op/rejection/abandonment and unresolved review. Report every assigned task.
- Unintended authored property/relation changes outside selected scopes, avoidable loss of applicable choices, unnecessary review/relaxation, and unwanted retained choices. Pixel differences are supplemental because legitimate reflow changes geometry.
- Publication quality using blinded editorial/design assessment and explicit readability/access checks. Semantic completeness, internal figure labels, captions, tables and exceptions must remain usable. Predicate validity alone is insufficient.

Do not compare only successful outputs or treat early abandonment as fast completion. Report observed effort on unsuccessful tasks and completion separately; time-to-completion remains unobserved after abandonment. Provide sensitivity analyses with predeclared failure penalties rather than one hidden imputation. The proposed superiority claim needs quality and completion noninferiority under editorially set margins; the pilot establishes neither. Determine full-study size from pilot variance, clustering and meaningful effect, and freeze tests/margins before held-out data.

After baseline tuning, the useful ablations are lifecycle/status maintenance and integrated review/repair, keeping underlying recomputation and authoring information constant. Removing history, correspondences or semantic declarations changes information, so that is an explanatory ablation rather than the principal comparison. A representation-only contrast must hold interaction affordances reasonably constant; an interface-only contrast must expose equally informative native diagnostics. Publish uncertainty and negative cases rather than pooling away hard revisions.

### Go and no-go criteria

**Proceed to a larger study** if editors can articulate bounded selections with manageable ambiguity, the baseline can complete realistic packets, mappings/history are genuinely equal, and the treatment shows promising net benefit on multiple interacting composition-plus-revision packets after capture costs. Benefits must not come solely from better rendering, extra model calls, oracle correspondence, formatting controls or rejection of difficult edits.

**Reframe as interaction/empirical work** if equivalent native records express all semantics but the integrated interface measurably improves detection, navigation or repair. This is a valid outcome and the recommended default story.

**Stop the mechanism-superiority claim** if a tuned equally informed baseline matches outcomes, recording costs dominate within realistic revision counts, most selections require retrospective relabeling, or apparent preservation is bought with lower completion, quality or agency. Use the simpler product mechanism. A benchmark/negative-result paper still needs a reusable corpus, credible baseline and informative evidence; failure alone is not a contribution.

**Pursue a representation claim** only if comparison identifies a precise, useful technical advantage and executable counterexamples support it. Inability of a finite vocabulary to model some aesthetic judgment is not evidence of a new solution. A hard domain restriction or human declaration must be identical in the comparator.

## Ranked paper stories and conference fit

| Rank and story | Required evidence | Fit after this critique |
|---|---|---|
| 1. Selected-commitment lifecycle, interaction and production evidence | Bounded semantics, credible parity, capture-to-repair comparative results, agency/quality/failure analysis, plus situated usage. | **Recommended focus.** DIS is the strongest initial fit for situated design practice; CHI fits broader findings across users/settings. |
| 2. Technical interaction for selecting, inspecting and repairing interacting choices | A distinctive interaction beyond reusable tags/blocks/history, executable demonstrations and evidence matching its claims. | UIST if the technique materially advances interaction. A positive time study alone does not establish a technical interaction contribution. |
| 3. Document representation/system | A precise economy/enforcement/tractability advantage, multiple representative document cases and evidence beyond schema completeness. | DocEng if this technical advantage emerges. The full magazine is valuable ecological evidence but insufficient novelty. |
| 4. Benchmark and comparative account, including a credible negative result | Reusable rights-cleared tasks, reliable labels, strong baselines and non-obvious findings that explain when reuse helps or fails. | DocEng or DIS/CHI depending on technical versus practice contribution; an artifact inventory alone is insufficient. |
| 5. Preference learning from histories | Predictive or repair advantage over equal-information examples/flattened histories, temporal/story holdouts and human validation. | Defer; IUI or related venues only after a computational contribution exists. |

The baseline's automatic DocEng-first recommendation should therefore be conditional, not retained merely because Struct is a document library. For the surviving empirical/interaction story, **prioritize DIS**, with UIST or DocEng contingent on what the prototype actually establishes. A pictorial needs a visual research argument and analysis, not a polished magazine alone.

The [UIST 2026 author guide](https://uist.acm.org/2026/author-guide/) explicitly asks for evidence appropriate to stated claims and holistic system evaluation; it does not mandate a user study for every contribution. Here an effort/agency claim does require human evidence. The [DIS 2027 call](https://dis.acm.org/2027/call-for-papers/) lists title/abstract on 11 January 2027 and paper/pictorial submission on 18 January 2027, Anywhere on Earth. Those dates are planning information, not a reason to accelerate an unsupported paper. [DocEng's official site](https://www.documentengineering.org/doceng2026) announces Calgary for 2027 and invites updates when the call appears; the inspected page does not state its paper deadline. Later-cycle deadlines should be checked when planning submission rather than extrapolated.

## Product boundaries and unresolved evidence

Baddie remains the complete magazine artifact. Aether supplies creative editing; Struct supplies portable semantics and PDF import within its contract; the publication application owns canonical authoring/releases; Margin annotation integration remains required product work. The mechanism pilot can use a local sidecar and shared runtime. Do not make those product dependencies scientific contributions by association. PDF recovery has different inputs and causal questions; keep its evaluation separate. Learning from histories remains future work.

Before claiming novelty, close the remaining evidence gaps: inspect the full adaptive-diagram implementation; run or reconstruct the closest selected-transfer/history facilities; ask a competent baseline practitioner to express the worked counterexamples; test ordinary modern component/constraint publishing tools; and refresh 2026 literature before submission. This review covers named central papers and additional close work, not an exhaustive absence proof. Source-record-only historical points should not bear an exclusive capability claim. No baseline execution, prototype, designer experiment or publication-quality comparison was performed for this critique.

The decision is to **continue with a small, adversarial lifecycle experiment, while withholding a novel-taste-representation claim**. The hypothesis earns further work because the job is concrete and falsifiable, not because document review, product integration or a missing demonstration in another paper has established scientific novelty.
