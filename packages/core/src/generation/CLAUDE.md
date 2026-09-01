# Book generation

The pipeline that turns a plan into a printed book: planner and pages, markdown assembly, the PDF
and EPUB renderers, covers, the browser pool, character reference sheets, and the export
provenance/temp-file machinery.

Most of this directory is only reachable from the worker, but it is *in core* because two processes
compile a book — the worker at the end of generation, and the API when it rebuilds a missing export
inline. Anything that decides how a book looks or what a file contains must live here, or the two
sides will disagree about the same book. That has happened: the citation map was duplicated once
and the same book's Sources list named Google or the publisher depending on which side rendered it.

## The invariants below are unusually load-bearing

This directory holds the code that produced most of this project's worst incidents — a password
file printed into a PDF, a Chromium leak that survived shutdown, a stylesheet bump that silently
re-typeset every book ever compiled. The rules are not style preferences; each one is an outage
that already happened.

Before changing anything that affects typesetting or page breaks, use the `verify-pdf-typography`
skill. Rendering the fixture corpus is the only way to see what a change does — `pdfDocument.test.ts`
asserting a sha256 is the alarm, not the check.

## Reading the source of a cover

Read the cover's source through `coverArtSourceFor` (`coverSource.ts`), never `includeCover`
directly. That resolver is what keeps the quote, the dispatch gate and the handler agreeing, and
what lets rows written before the field existed price identically.

## Tests

Colocated. `pdf.test.ts` skips six cases when poppler-utils (`pdftotext`, `pdfinfo`, `pdffonts`,
`pdftoppm`) are absent; `browserProcess.test.ts` skips on win32; `exportTempSweep.test.ts` skips as
root. Both render test files must call `closeSharedBrowser()` in `afterAll` — a live `Browser`
holds the event loop open and vitest will never exit.

## Index

- [Page 1's opening contract](#page-1s-opening-contract)
- [Style contract routing](#style-contract-routing)
- [Repetition gates and the evidence ledger](#repetition-gates-and-the-evidence-ledger)
- [Whole-set edit adherence](#whole-set-edit-adherence)
- [Best-of candidate sampling](#best-of-candidate-sampling)
- [Covers](#covers)
- [PDF typesetting and the render transport](#pdf-typesetting-and-the-render-transport)
- [Export provenance and scratch files](#export-provenance-and-scratch-files)
- [Chapter apparatus](#chapter-apparatus)
- [Library characters](#library-characters)
- [Character reference selection](#character-reference-selection)

## Style contract routing

- **Page prompts take local style rules; distribution rules reach manuscript review only.** Mixing
  manuscript-wide “ask the same questions throughout” lines into `antiAiRules` taught every page to
  perform the same analytical grid. `styleContract.localRules` (and `pagePromptBookStyle`) are what
  page drafts, page review, and the context-pack Avoid line see. `distributionRules` (and
  `manuscriptPromptStyleFields`) are what targeted manuscript structural review sees. After plan
  time that helper reads stored `distributionRules` instead of re-running the repetitive-guidance
  rewrite without the user prompt — otherwise a preserved parallel-structure line becomes the
  chapter-scoped house rewrite. `mergePlanCriticPatch` drops `styleGuidanceRewrites` whose `from` is
  a USER_PARALLEL_INTENT line when the user prompt matches; those replacements run before
  `applyPlanStyleContract`, so a preserve on the original wording never fires if the critic already
  replaced it. `critiquePlan` is told not to emit them when that intent is present; the critic stays
  on. Required factuality and prompt-leak ids merge by identity; a
  planner that already returned six anti-AI lines cannot suppress them. Page-local `antiAiRules` routinely differ from `localRules`; classified
  extras merge into the stored contract by id and do not drop planner `distributionRules`. A
  non-Latin anti-AI line whose ASCII slug is empty hashes `foldCharacterName` (the
  `characterSlug` fallback) rather than sharing `planner-rule`. One invalid `localRules` entry is
  dropped; it does not strip the contract. Instruction length is code points, matching `antiAiRules`.
  `QUALITY_FEATURE_IDS` never includes schema validation, page-map
  coverage, generic assignment rejection, collision handling, deterministic audits, or publication
  grading — those live on `MANDATORY_INTEGRITY_CHECKS` and still run when every polish checkbox is
  off. `BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow` is a rollout switch, not a quality revision.
  Phase 06 did **not** remove it: live precision gates are still unmeasured. Page-local overlap
  (`pageOverlap.ts`, used by `pagesLocalQa` and `pageBeatDedupDetect`) and Smart Unslop are still
  in use after the manuscript structural audit; they are not dead copies of
  `runDeterministicManuscriptChecks`. Detector versions stay on reports:
  `manuscript-structural-audit-v1`, `production-map-audit-v1`, `style-contract-v1`. Offline
  evaluation of the distilled corpus is `pnpm anti-slop:replay` (never `storage/` or live books).

## Repetition gates and the evidence ledger

- **A deterministic rule that can veto the model reviewer is measured against shipped pages before
  it ships, and one that fires on pages the reviewer approved is removed, not tuned.** Three such
  rules went on 2026-09-02, after a 120-page book spent 26 minutes in "Doing a final read-through"
  with 22 pages stuck in `FAILED_QA` (every other recent book compiled in 0-5 minutes): the
  reviewer's reserved-closing-beat guardrail in `pagesReview.ts` (three five-letter words shared
  with the next page's brief — "reach, ghetto, occupation, agency" on a Holocaust chapter — vetoing
  approvals scored 88-94), the page-time treatment gate in `pagesLocalQa.ts`, and the
  `SAME_CHAPTER_TREATMENT_REPETITION` audit plus the bulk-pass `distinctnessGuidance` that shared
  its `scoreTreatmentPair`. Replayed over 1,200 pages from ten shipped books, 1,177 of them
  model-approved: the guardrail fired on 76 approved pages, the treatment gate on 295, and the audit
  clustered whole chapters of distinct pages in every book. Its "subject" was named-entity overlap
  over an extractor that took every sentence-initial capitalised word as an entity ("their",
  "such", "once"), and its "causal chain" was two shared cue words ("because, therefore"). The
  near-verbatim gate (`pagesRepetitionQa.ts`) and `RECAP_BACKTRACKING` (`manuscriptRecapAudit.ts`)
  fired on none of those pages and stayed; the phrase-pattern detectors (`SYMMETRICAL_HEDGING`,
  `SENTENCE_OPENING_CADENCE`) count literal matches and were not in question. The replay is the
  standard for the next such rule: dump the pages of shipped books, run the rule, count hits on
  approved pages. `pnpm anti-slop:replay` covers the distilled fixtures, never live books.
- **A local QA message names an earlier page only after the word `from`, because the final-QA
  repair harvests every other `page N` as a page to redraft.** `runLocalFinalQa` prefixes
  `Page N:` and `extractRepairPageIndexesFromText` (`apps/worker/src/generation/finalQaPageTargets.ts`)
  collects every `page <digits>` in a message except a lone reference behind "from". Spelled
  "repeats page 7", the page that *established* a title or beat is redrafted beside the page that
  repeated it. The title rule and the near-verbatim rule both say `(from page N)`.
- **An analytical page owns its evidence anchors; a shared one is repaired like a near-duplicate
  beat and never blocks.** `claim` and `evidenceAnchors` on `PageProductionBeat` make the evidence
  a page argues from a property of the assignment (`evidenceLedger.ts`), asked of every brief
  producer and shown to every writer and the reviewer for `analytical-history` and `instructional`
  books only. Every explicit rebuild of a beat — `normalizeModelPageBeat`,
  `decodeGeneratedChapterBrief`, `pageMapForWholeBookDraft`, the whole-book citation sanitizer —
  carries them by name through `evidenceLedgerFields`, because zod strips what a projection forgets;
  `mergePageMapCriticPatch` drops them under a whole-assignment rewrite that names none, the
  `imageMoment` rule again. `productionMapAnchors.ts` compares anchors folded (`foldCharacterName`
  plus punctuation) on whole-phrase equality or ≥0.8 token containment with two tokens on the
  smaller side, and `SHARED_EVIDENCE_ANCHORS` is a *sparse* finding with its own `beatFinding` — so
  the bounded `dedupe-page-beats` rewrite is briefed against the owning sibling — that is never in
  `BLOCKING_CODES` and never counts toward a dense chapter. One the two repair cycles cannot clear
  drafts with its distinctness note (`advisory_unresolved`); a map that returned no ledger at all is
  `MISSING_EVIDENCE_ANCHORS`, diagnostic and one per chapter, and drafts as every book did before
  the field. The schema omits absent keys rather than writing `undefined`, so a brief stored before
  the field parses byte-for-byte as it did under the `Chapter.productionBrief` compare-and-swap.
- **A brief prompt names its JSON keys and shows the shape; prose alone has the model spelling
  them from the words.** The chapter-brief prompt used to say only "Return one beat per page. Each
  beat needs purpose, concrete action or explanation, required continuity, ending pressure, and
  optional image moment" — no key ever named, no example shown — and once the strict acceptance
  (`decodeGeneratedChapterBrief`) stopped inventing placeholders for what it could not read, every
  one of the fourteen briefs rejected across three 2026-09-01 runs was a key the model had coined
  from that sentence: `concreteActionOrExplanation`, `concreteAction`, `action_or_explanation`,
  `ending_pressure`, or a `beat` object holding `purpose` and `action`. Each rejection is a full
  re-ask at 0.2, so a sixteen-chapter book paid four extra calls. The prompt now carries the same
  two things the whole-book map prompt always had: a system rule naming the seven keys and saying
  they are top-level and never nested inside `beat`, and an `outputContract` in the payload
  showing one page object (with the evidence-ledger keys when that mode applies, via
  `evidenceLedgerOutputContract`). Widening the decoder's alias table was tried first and covered
  only the nested four; naming the keys covers all fourteen, which is why the aliases stayed as
  they were.

## Page 1's opening contract

- **Nothing states page 1's opening contract in its own words: a prompt names an audience and gets
  the ban, the import exemption that silences it, and the hook fused to its payload key — or gets
  nothing.** The contract is two halves gated on different facts. The **opening-quality** half —
  never open on throat-clearing, a welcome, a definition of the topic, or meta framing such as "In
  this book" — is what an imported manuscript is exempt from: page 1 of an import is the author's
  own first sentence, and every one of those rules is a licence to rewrite it
  (`isImportedManuscript`, `schemas/mediaSettings.ts`). The **hook-delivery** half is gated on the
  plan having committed to an `openingHook` **and on that same provenance**, because an import's
  plan is not a commitment its book was written to: `synthesizeImportedBookPlan`
  (`ingestion/manuscriptImport.ts`) builds it out of the finished manuscript and sets no
  `openingHook` at all, and one appears only when that plan is later *revised* —
  `revisePlanningPackage`'s "Preserve or improve openingHook" line is unconditional — so an import's
  hook is a sentence a model invented from a premise field, having never seen page 1. Leaving it
  ungated was justified as "a repair's replacement page is generated prose", which holds for the
  brief producers and fails for every prompt this contract feeds: `revisePageDraft` and
  `polishPageDraft` rewrite the page they are handed, in place, and a reader's own "make page 1
  sharper" reaches `revisePageDraft` through `rewritePageForUserRequest`
  (`apps/worker/src/generation/textEditRewrite.ts`). Which page is the author's cannot be asked — `Page`
  has no provenance column, so `isImportedManuscript` reads the *project's* mediaSettings and both
  halves are book-level. That over-applies to prose inserted at the head of an import
  (`resolveStructuralEdit` accepts `anchorPageIndex: 0`, so a generated page can sit at global index
  1) and is right anyway: the hook that page would deliver is the invented one, and hook-without-ban
  is the worst of the four combinations — a page told to make its opening striking with none of the
  rules that say what a striking opening is. Eight prompts say something about that page:
  the three bulk writers (`generateWholeBookDraft`, `generateChapterDraft`, `generateBatchDraft`),
  the single-page draft, `polishPageDraft`, `revisePageDraft`, `reviewPageDraft` and
  `runFinalBookQa`. Spelled per prompt, the halves came apart four times running, each one a
  different mismatch between the set of prompts *stating* a rule and the set applying its gate: the
  ban fused to the hook sentence in the bulk writers, so a plan with no hook — every `MOCK_AI` run,
  `makeFallbackPlan` itself, every plan stored before the field, any run where the model omits the
  optional key — drafted page 1 with no ban at all and was then failed by the deterministic checker,
  which is gated on provenance and never on the hook; the exemption reaching local QA and neither
  model reviewer, which is *worse* than no exemption, because the local gate's early return in
  `reviewPageDraft` was the only thing that had been keeping the model call off an import's page 1;
  the exemption never reaching `buildPageInstruction`, so a page-1 revision of an import was
  explicitly instructed to rewrite the author's opening after a failure with some unrelated cause;
  and local QA excusing categories the writer prompt banned outright; and the hook half left
  ungated after all four, so an import's page 1 — the author's own first sentence — was handed
  "deliver the plan's `openingHook` in the page's own prose" by the reviser, the polisher and the
  reviewer, after any QA failure with an unrelated cause and on any reader-requested rewrite of
  that page. Every one of those is a rule
  and its gate answered in different places, so the three questions are answered once —
  `openingContractForRange` (`pagesShared.ts`): does this call reach global page 1, may page 1's
  prose be held to the quality rules, did the plan commit to a hook. `openingContractFields` is the
  only way to the sentences. It picks them out of `OPENING_CONTRACT_RULES`, an **exhaustive
  `Record`** over `multiPageWriter`, `pageWriter` and `reviewer`, and returns them fused to the
  payload: spreading `payload` beside `rules` is the only way to use either, so a prompt cannot
  carry the ban without the exemption having been applied, nor name the hook without sending it. A
  ninth prompt names an audience or gets no text at all. The question is asked of a **range**, not
  an index, because a chapter-scoped call has to ask it of the absolute pages it was handed — a
  leading chapter that ended up with no pages hands page 1 to the next one.
  **The reviewer's two sentences are not the writers', and neither difference is cosmetic.**
  `statesCategoryOpening` is true only for the writer audiences, which choose the opening;
  `firstPageOpeningRule`'s category recipes inside a rejection prompt invite rejecting a legitimate
  opening for being the wrong shape. And because the writers are told to deliver the hook "without
  echoing its wording", the reviewer's hook sentence has to say so outright — an unlabelled
  `openingHook` beside `pageBrief` reads as "the page must match this", so a page that transformed
  the hook correctly could be rejected for not reproducing it. `runFinalBookQa` asks the same contract over the whole book and sends the opening
  pages only when `statesOpeningQuality` says it may judge them.
  **The deterministic twin is the same ban, gated on provenance alone.** `hasWeakFirstPageOpening`
  (`pagesLocalQa.ts`) fires on `pageIndex === 1` for every book the pipeline wrote, with no category
  exemption: `firstPageOpeningRule` grants the signposting categories exactly one concession — "you
  may signpost later on the page, never in the first paragraph" — and `FIRST_PAGE_OPENING_WINDOW`
  *is* that first paragraph, so an exemption there approved the one sentence the instruction never
  did. `isImportedManuscript` is therefore named in exactly two places in this pipeline, the prompts
  (`pagesShared.ts`) and the gate (`pagesLocalQa.ts`); `pagesReview.ts` names it nowhere and reads
  `statesOpeningQuality` off the contract instead.
  **The sweep measures both sets rather than listing them, which is why editing the test cannot keep
  it green.** `pagesShared.test.ts` runs all eight prompts against a generated book and an imported
  one, a plan with a hook and a plan without, on page 1 and on page 2, and asserts set identities:
  the prompts stating the ban are exactly the ones the import exemption silences, and the prompts
  naming the hook are exactly the ones a hookless plan silences **and** exactly the ones an import
  silences — three measured sets, so no gate can move on its own. A further case asserts the whole
  contract goes quiet on an import's page 1, both halves at once. Its handle on "does this prompt state
  the ban" is `OPENING_QUALITY_RULE_MARKER` — the word "throat-clearing", which all three sentences
  interpolate instead of each phrasing the ban — so a prompt wording it freshly measures as not
  stating it at all, which the "every site states it" assertion is what catches.
- **The page *brief* producers gate the hook and not the ban, and that split is the one deliberate
  asymmetry.** `firstPageBriefFieldsForRange` (`pageBriefContract.ts`) is the single entry point all
  five brief producers reach the contract through — the whole-book map, the per-chapter brief,
  `repairPageBrief`, `critiquePageMap`, and the deterministic `fallbackPageBeatFromChapter`, which
  takes only the condition because it writes no prompt and has no payload key to emit — and it reads
  its hook off the very same `openingContractForRange`, so an import's page 1 is never *assigned*
  the hook its prompts are no longer told to *deliver*. Leaving that half raw was the last door:
  `synthesizeImportedBookPlan` sets no `openingHook`, a `book_replan` invents one, and a later
  `GENERATE_BOOK` then briefed page 1 to deliver it while the writer prompt — gated — carried no
  `openingHook` key at all, which is the "told to deliver a hook it was never shown" failure the
  whole contract exists to prevent, arriving through the brief instead of the instruction.
  `FIRST_PAGE_IDENTITY_RULE`, the brief side's opening *ban*, stays ungated on purpose: the
  exemption protects an author's own sentence from being rejected and rewritten, and a brief is a
  production assignment for prose about to be generated — a repair's replacement page included — so
  the ban over-applies to an import's page 1 without ever reaching a sentence the author wrote. The
  halves part company because their over-application costs different things: a ban costs a
  regenerated page some freedom it was never going to use, a hook costs the author their opening.
  Two things keep that from drifting back. `PageBriefBookScope` **is** `OpeningContractSource` — an
  alias, not a twin — so a producer whose options satisfy one satisfies the other by construction;
  and the raw `(openingHook, lastPageIndex)` form is module-private, so no producer can answer the
  provenance question at its own call site. `critiquePageMap` was the one that did — the worker
  handed it `plan.openingHook` as a string — and it now takes the book like the other four, with
  `apps/worker/src/generation/bookState.ts` passing `input` and `plan` over whole and only
  `mergePageMapCriticPatch`, which states no rule, still taking a plain `lastPageIndex`.

## Whole-set edit adherence

- **One operation-level verdict does not mean one unbounded prompt.** `reviewAppliedBookEdit`
  sends a small candidate set jointly, but a larger manuscript is divided into stable UTF-8-safe
  page segments under `EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES`. Every leaf returns evidence and exact
  coverage, never a premature global missing verdict; bounded reducers preserve that evidence until
  one final call judges the complete coverage root. A missing segment id, a broken coverage range,
  an oversized call, malformed evidence, or a final verdict that does not accept the root digest
  fails closed. Do not truncate, sample, or independently approve pages to make the request fit.
  The exact-replacement path remains local and precedes this protocol.

  **Coverage is not evidence lineage.** A leaf has an explicit completeness bit, and its bounded
  lists hold one unadvertised slot past the capacity the prompt offers: a list that fills every
  advertised slot is accepted, one that spills into the spare is rejected. The rejection is what
  stops a provider filling the last slot it knows about and silently implying there was no next
  fact — the spare slot is what lets it say so instead of being refused for obeying. Code assigns stable ids to every accepted fact. Reducers may
  summarize positive evidence only by naming every immediate source fact exactly once and in order;
  the summary id hashes that lineage and the evidence digest binds it recursively. Possible
  omissions and contradictions never pass through a reducer at all: code carries their immutable
  facts to the final call, which must accept every id exactly and may resolve only ordered omission
  ids. Any contradiction, unresolved omission, id collision, lost lineage, overflowed output, or
  lossless negative set too large for the final budget fails closed rather than publishing. A fact
  repeated verbatim inside one list is collapsed instead: a repeat carries no information, and
  failing an edit over it refunds work the reader received. A leaf that honestly reports incomplete
  evidence is **backpressure, not failure**: the group is halved and re-asked, twice at most, and
  only then fails closed — the prompt and the guard now give the model the same advice, where the
  prompt used to ask for a flag the guard threw on. Each call's output budget is computed from what
  its own schema forces the model to echo, at one token per response character, because evidence is
  written in the book's language and Devanagari, Han, Kana and Hebrew all tokenise near 1 char/token
  rather than the ~4 an English estimate assumes; the fact id is 16 hex because its width *is* that
  budget, and the final negative ceiling is a bound on what fits, not a constant.

  **`satisfied` is the verdict; the other three fields are the repair order it carries when the
  answer is no.** Nothing distinguishes a suggestion from an unmet requirement in a `string[]`, so a
  list volunteered beside `satisfied: true` may not veto it — that is one model's remark overruling
  the same model's answer in the same response, and it cost the reader three redraft rounds and a
  refund of a correctly applied edit. Both prompts now say the repair order is empty when satisfied
  is true. What may still outrank the boolean is evidence *code* carries: an omission the final call
  declined to resolve by id, and a contradiction it was never offered a way to clear.

  **A verdict says on what basis it was reached, because a review that never ran refused nothing.**
  `basis: "reviewed" | "unverified"` is required on every verdict; `failClosedVerdict` is the only
  producer of `"unverified"` and `normalizeVerdict` the only producer of `"reviewed"`. Everything
  upstream returns `EditAdherenceFindings` — the same shape minus `basis` — and the response schema
  is `.strict()` without it, so no reviewer and no provider can claim one. Callers test the field
  and nothing else: they used to infer it from a five-field shape that only worked because
  `failClosedVerdict` bypasses `normalizeVerdict` and its flagged set happened to equal the caller's
  candidate set. One transient provider error otherwise read as "nothing was applied" and flagged
  every page — two full redraft rounds on a whole-book replan, and on a structural insert a rollback
  that discarded the drafted set and refunded. The basis rides into the stored `adherenceAudit`, so
  `publishedPagesMaySettle` can tell a refusal from an absence months later; a computed exact
  replacement reports `"reviewed"`, because it is the most certain verification here, not the least.

  **The undivided whole-set review is budgeted by the same measurement as every hierarchical call**,
  because it is the common case — everything under `EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES` takes it,
  and most edits are one to three pages. Its schema forces up to 31,380 response characters and an
  ordinary verbose verdict measures 1,579; the flat 1,200 truncated both.

  **The overflow slot is the second spelling of "give me less to read".** A leaf list past the
  advertised capacity is halved and re-asked exactly as `evidenceComplete: false` is. A reducer's
  overflow stays fatal — it has no smaller slice to be given, and its merge must be lossless.

  **`MOCK_AI` can reach the expensive half of this protocol.** A marker in the edit instruction —
  `[mock-adherence:unsatisfied|incomplete|truncated|failed]` — drives the fake adapter down the
  unsatisfied, backpressure, truncation and provider-error paths. Without it the fake always said
  satisfied, so every failure path this protocol has was invisible in the repo's default way of
  working.

## Best-of candidate sampling

- **No best-of candidate samples hotter than the pass would have run at without candidates, and a
  band too narrow for the ladder compresses the step rather than widening the band.**
  `bestOfCandidateTemperatures(top, count)` (`bestOf.ts`) is the only place a candidate temperature
  is computed, and its ladder **descends**: candidate 0 sits exactly on `top`, each later one a
  `CANDIDATE_TEMPERATURE_STEP` below. `top` is what the pass runs at with no candidates at all —
  the book's own `input.temperature` on the draft path, `polishPageTemperature(input)` on the
  polish path, which is the `REWRITE_TEMPERATURE_CEILING` clamp `polishPageDraft` already applies
  to itself. Climbing from a base is what this replaced, and both paths were wrong in opposite
  directions once `firstPageCandidateCount` made best-of the default for page 1 of every
  balanced-and-up book rather than an ultra-only operator opt-in. On the draft path the ladder had
  no ceiling: at the default 0.8 page 1 was sampled at 0.8, 0.95 and **1.1**, and page 1 is the
  style lock `loadStyleLockPages` pins into every later page's draft prompt *and* into the review
  that scores it — so the hottest sample, if the judge liked it, became the voice the whole book
  was written and audited against. On the polish path the clamp flattened it instead: every
  candidate landed on exactly 0.65, so the extra call and its judge bought sampling noise rather
  than a spread. Lowering the base to fit fixed that and opened the mirror hole — a floor at zero
  widened the band *above* the book's own temperature, so a project created at 0.2 sampled at 0.0,
  0.15 and 0.30 with nothing to catch it, since 0.30 is under the ceiling. Descending closes both
  and pays twice over: a book that never best-ofs is byte-identical, because the top rung *is* the
  candidate-free temperature and `draftPage` receives that very `baseOptions` object; and the
  judge's fallback (`drafts[0]`) is the draft the book would have got anyway rather than the
  coldest sample. A book that asked for `temperature: 0` has no band, so its candidates would be
  copies and the judge would be choosing between duplicates — `generateBestOfPageDrafts` refuses
  that spend outright and makes one untouched call. A non-finite temperature reaches the same
  guard and reads as that book, so an input that skipped the schema's `.default(0.8)` silently
  loses best-of rather than failing.

## Covers

- **Declining the cover buys a designed one, it does not remove the cover.** `includeCover` only
  ever answered "did a model draw this", so `coverArtSourceFor` (`packages/core/src/generation/
  coverSource.ts`) resolves `false` to `"design"`: the book gets a cover from the 50-entry catalog
  in `coverDesigns.ts` for free, picked by `selectCoverDesign` from the title, premise, audience
  and category. **Read the source through that resolver, never `includeCover` directly** — it is
  what keeps the quote, the dispatch gate and the handler agreeing, and what lets rows written
  before the field existed price identically. Only `"none"` means no cover, and only the operator
  console sets it. A design supplies just the *artwork layer*: `renderCoverPng` still typesets the
  real title with the OFL fonts, which is why nothing downstream — the `cover.jpg` path, the PDF
  cover page, the EPUB `cover-image`, the app's `coverImage` — needed a single change. The design's
  own `template` wins over the book type's `coverTemplate`, because a design was authored as a
  whole. `shouldGenerateCharacterReferences` gates on `=== "ai"` for the same reason a designed
  cover writes `costUsd: 0`: neither may spend on a cover nobody was charged for, and a bundled
  cover left unpriced would land in the Costs tab's `unratedCalls` bucket, which means *understated*
  spend.
- **Two things decide whether a cover design reads, and neither is visible in the code.** Each
  template darkens the half its text panel sits in — science and business blacken the *top*,
  kids/fiction/romance the *bottom* — so a motif that centres its subject where the type goes is
  simply invisible; that is what `FOCUS_BY_TEMPLATE` in `coverDesignArtwork.ts` exists for. And
  every mark is seen through that scrim, so painting in `ground` at low opacity disappears. Render
  the catalog with `pnpm covers:preview` and look at the contact sheet before trusting a palette or
  a motif change. Seeding is off the design id, not the project, so re-rendering a book keeps its
  cover.

## PDF typesetting and the render transport

- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.**
  `generateBookPdf` no longer calls `mdToPdf()`. `pdfDocument.ts` deep-imports its `getHtml` and
  `defaultConfig` (the package has no `exports` map) so the markdown still goes through
  **marked@4.3.0** with `langPrefix: 'hljs '` — rendering it with this repo's own marked@18 instead
  changes heading ids, email mangling and loose/tight list `<p>` wrapping, which moves every page
  break in every book ever compiled. Everything md-to-pdf used to supply by *default* is now pinned
  by hand in `BOOK_PDF_OPTIONS` and `buildBookPdfDocument`: the `30/40/30/20mm` margins,
  `page_media_type: 'screen'`, and the cascade markdown.css → github.css → ours, which
  `RTL_OVERRIDES` in `pdfCss.ts` exists to undo the first sheet of. **The text block is set by
  `pdfCss.ts`, not by those margins** — `bookPdfCss` writes `@page { margin: 20mm 18mm 22mm }`, and
  Chrome honours that over the CDP parameters, so `BOOK_PDF_OPTIONS.margin` is measurably inert
  (identical page count and line width at 30/40/30/20mm, at 1 cm, and omitted). It is pinned for the
  day that `@page` rule is removed, and asserted by equality rather than through a render, because no
  render can see it. The dependency is pinned to an **exact** version and `pdfDocument.test.ts`
  asserts both stylesheets' sha256, because a bump is otherwise a silent re-typeset. When a digest
  fires, render the fixture corpus with `pnpm render:fixtures` (`scripts/render-book-fixtures.ts`,
  eight books covering both directions, CJK, illustrations, a cover, the coverless title sheet and
  the dense Contents) on each
  side and diff them with `--compare`, which checks `Pages` first;
  byte-comparing PDFs proves nothing, since `/CreationDate`, `/ID` and font-subset ordering differ
  run to run. The old side is rendered by `--baseline <ref>`, never by stashing: it plants a
  throwaway worktree at that ref and copies the *current* harness in, because the change under test
  is routinely the one that adds the corpus, the `render:fixtures` script and the `packages/core`
  exports the harness imports — and because the fixtures are the control, a ref carrying its own
  copy of them would report its text as layout drift. Borrowed `node_modules` are this tree's, so a
  digest that fired *because* the `md-to-pdf` pin moved needs `--install` for the baseline to be
  rendered by the version it is being compared against. A page-count guard only works on **continuous prose**: a fixture with forced
  `page-break` divs pins its own count and reports the same number whatever the stylesheet says.
  **Those two digests pin md-to-pdf's sheets, not ours**, so `bookPdfCss` had no alarm at all: the
  `@page` margins, the counter resets and the title sheet's height could all move every book ever
  compiled with nothing firing. `PAGE_GEOMETRY_SHA256` in `pdfCss.test.ts` is that alarm — a sha256
  over `BOOK_PDF_CSS` with its comments, indentation and colour *values* stripped, so a recolour is
  silent and anything that sizes a box, names a page or decides a line break is not. Subtractive on
  purpose: a property nobody thought of is in scope by default, which is the only way round a
  tripwire fails safe. It is the alarm, not the check — the corpus render is the check.
- **The coverless title sheet is capped at exactly one page, and it clips from the tail.**
  `@page pdf-title` carries `counter-reset: page 0` like the cover, and it resets on *every* sheet it
  names — so a title page that fragmented left two unnumbered sheets where `printedPageOffset`
  (`pdfPageMap.ts`) counts one, and every number the map, the printed Contents column and the chat
  speak came out one ahead of the footer. Nothing caps a plan's title (a bare `z.string()`), and a
  409-character one fragments measurably, so `.book-title-page` is `height: 245mm; overflow: hidden`
  rather than `min-height`. **The clip is only survivable because the stack is centred by auto
  margins on its first and last child, not by `justify-content: center`**: a centred flex column
  overflows *both* ends, so the first version of this printed a title sheet that began mid-title at
  clause 10 of 30 and lost the book's own name off the top. Auto margins collapse to zero once free
  space is negative, which pins the stack to the top and clips only what runs off the bottom —
  verified pixel-identical to the centred layout for every title that fits. The corpus renders one
  (`title-page-en`), and `pdf.test.ts` renders the absurd one and reads the opening clause back out.
- **Chrome reads the book off disk; nothing crosses CDP.** The assembled HTML is written to
  `.book-render-<uuid>.html` inside `IMAGE_STORAGE_DIR` and opened with `page.goto('file://…')`, so
  the book's relative asset paths (`projectId/filename`) resolve to the real illustrations exactly as
  they did against md-to-pdf's static server. That is what killed the 174 s and 382 s exports: they
  lived in `addStyleTag`/`addScriptTag`, which take **no timeout**, and a legacy illustrated book
  shipped a ~27 MB `JSON.stringify`'d image map through one. Fonts must stay `data:` URIs — a
  `file://` `@font-face` src from a `file://` document is blocked by Chrome's opaque-origin rules.
  The temp file is not web-reachable: `/assets/images/:projectId/:filename` is a two-segment param
  route, not a static mount.
  **What that transport costs is the origin's protection, so the renderer carries an allowlist.**
  A page opened from `file://` may load `file://` subresources, and a manuscript is user text —
  imports arrive as raw prose, an exact-replacement edit writes literal text into a page, and
  markdown passes raw HTML through. `<iframe src="file:///etc/passwd">` in chapter one printed the
  server's password file into the exported PDF, reproducibly, and `/proc/self/environ` would have
  printed its provider keys; the HTTP-origin renderer this replaced refused that for free.
  `renderResourcePolicy.ts` intercepts every request the render makes and permits four things: the
  document this render wrote, `data:` (the fonts), `about:blank`, and non-dot files under the
  compiled project's own image directory — which is why `generateBookPdf` now takes a `projectId`,
  standing in for the `sendOwnedProjectAsset` check the file transport dropped. Everything else is
  aborted, **including `http(s)`**: an iframe of `169.254.169.254` prints the instance's cloud
  credentials the same way, and no legitimate book resource is remote. Interception covers
  navigations, frames, images, CSS `url()` and anything a script starts later, which is why it is
  the control and `stripEmbeddedDocuments` (`pdfDocument.ts`, which deletes
  `iframe`/`object`/`embed`/`frame`/`script`/`link`/`base`/`meta http-equiv` from the assembled
  HTML) is only the second lock. That strip runs on the *rendered* HTML, never the markdown, so a
  book about HTML keeps its `<iframe>` examples — marked has already escaped everything in a code
  fence by then. It is verified by rendering the fixture corpus with the policy off and
  on and diffing: pixel-identical, so the allowlist refuses nothing a real book asks for.
  **The same disclosure had a second door in the EPUB.** Both exports turn
  `/assets/images/<projectId>/<filename>` into a path on disk, and they did it with a copy of the
  resolver each; the filename group matches slashes, and only the PDF's copy checked containment, so
  `![x](/assets/images/p/../../../../etc/passwd)` packaged a server file into the reader's download.
  There is now one `resolveBookImageAsset` (`bookImageAssets.ts`), which decodes before it resolves
  (`%2F..%2F` is a separator) and returns null unless the result is exactly
  `<IMAGE_STORAGE_DIR>/<projectId>/<filename>` — the shape the HTTP route serves.
  **`<projectId>` there means *this* book's, which is a second option and not a wildcard.** Storage
  is shared, so containment only ever said "some project's illustration": a manuscript naming
  `/assets/images/<another-project>/page-3.png` — and manuscripts are user text — read another
  reader's artwork out of it. The PDF survived that by accident, because the renderer's
  `assetRoot` allowlist is already scoped to the compiled project; the EPUB reads the file itself
  and packaged it into the download, with no renderer anywhere to refuse it. So the resolver takes
  an optional `projectId` and compares it against the *resolved* first segment (after decoding, so
  `proj-1/..%2Fproj-2` is `proj-2`), `generateBookEpub` and `generateBookPdf` both pass theirs, and
  the PDF's markdown rewrite refuses what its renderer would have aborted anyway. Omitting it keeps
  the whole storage directory in scope, which is only right for a book belonging to no project —
  `scripts/render-book-fixtures.ts`.
- **One Chromium, many pages — and the reset paths are the point.** `browserPool.ts` is the only
  place that launches a browser (`generateBookPdf` and `renderCoverPng` both go through
  `withRenderPage`). It holds a `Promise<Browser>`, not a `Browser`, and clears it on `disconnected`
  *and* on launch rejection under a **generation counter**, so a stale event cannot evict a newer
  browser. The semaphore is **2**, deliberately below worker concurrency
  (`max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)`, 4 by default, env-tunable to 32, with no
  separate compile lane) — four large books in one Chromium is an OOM that takes all four down.
  Recycling after 50 renders **retires** the browser rather than closing it: it stops handing out
  pages and closes once its own last page comes back. Closing inline is only possible when no other
  render is in flight, and with the semaphore at 2 a busy worker always has one — so a close-now rule
  fires only when the pool is idle, which is exactly when recycling does not matter. That is why the
  count lives on the lease and not in a global.
  A disconnect is retried **once, inside `withRenderPage`**, so both callers get it: sharing a
  browser is what turned one crash from "fails the job that owned it" into "fails every render in
  flight", and the cover is where that bites hardest — `renderCoverPng` runs *outside*
  `generateCover`'s artwork fallback, and `GENERATE_COVER` is not in `DERIVATIVE_GENERATION_JOBS`, so
  an unretried disconnect there marks a finished, fully paid book FAILED and refunds
  `FULL_BOOK_GENERATION` because some unrelated compile crashed Chromium. One retry is the whole
  budget — `compile-export` gets no BullMQ-level retry, which would re-run final QA and re-spend real
  credits — and it is skipped when `closeSharedBrowser()` was what took the browser away, or a
  shutdown would launch a replacement and hold the process open. A watchdog timeout is not
  disconnect-shaped and is never retried. Anything passed to `withRenderPage` must therefore be safe
  to run twice. "Disconnect-shaped" means **`TargetCloseError` and nothing else**: puppeteer throws
  that from every path where the far end went away, and its parent `ProtocolError` is the generic CDP
  failure — including the protocol *timeout*, which would pay its whole budget twice. Matching the
  parent covered no case the child did not.
  **A render is leased a browser context, not a page, because the page is not what the manuscript
  is confined to.** `stripEmbeddedDocuments` deletes `<script>` but not the `onerror` on an `<img>`
  whose source `renderResourcePolicy` just refused — that handler is script a manuscript gets to
  run, and one `window.open` from it was a page the pool never leased, never counted against the
  semaphore and never closed. Verified surviving into later renders, still fetching, with no
  interception on it: interception is installed per page, so a page the document opened for itself
  has none. `renderOnce` therefore closes the whole `BrowserContext`, which takes the popups, the
  workers and the storage with it, and `discardStrayTargets` closes any target the content opens on
  sight — watching the *context*, so a popup opened by a popup is caught too, and so a
  `setInterval(window.open)` cannot pile up tabs for the watchdog's whole 90 seconds. What neither
  can stop is the *first* request of each opened window: Chrome reports a target once it exists, by
  which time its navigation is on the wire (`--block-new-web-contents` does not refuse it —
  measured). Closing that needs the document unable to run script at all, i.e. stripping inline
  `on*` handlers in `pdfDocument.ts`.
  Every close is **once and bounded**: a wedged renderer's `close()` never settles, so a
  second attempt would hang the exact case the watchdog exists to unstick. The outcome is acted on
  rather than discarded, and `"failed"` is not `"timeout"` — a rejected close means the target was
  already gone, while one that never settles is a renderer still holding a process. The latter
  **retires** the browser on *every* path, success included: ignoring it on the success path leaked
  pages into a long-lived Chromium (the pool's own accounting said they were gone) for up to fifty
  renders. Retiring rather than closing outright is what reclaims them without failing every render
  sharing that browser.
  **Retiring is a promise to reclaim, so a lease outlives every close it is waiting on.** The
  browser's own `close()` is no more bounded than the context's — puppeteer's CDP path sends
  `Browser.close` and then awaits the process's `exit` event with no deadline of its own — so
  dropping the lease and fire-and-forgetting that promise left a Chromium nothing in the process
  had a handle on: invisible to the idle sweep, to `closeSharedBrowser()`, and to anyone reading
  the code, but not to the container's memory. A lease is now `live`, `retired` or `closing` and
  leaves `leases` only when its reclaim settles, which is bounded end to end: five seconds for
  `close()`, then `terminateBrowserProcess` (`browserProcess.ts`) SIGKILLs the process *group*,
  then two seconds for the exit. The group — the negative pid — is what takes the renderers and
  the zygote with it, and it cannot name this process's own group by accident, because a group id
  is always its leader's pid and that pid belongs to our child. The exit check before it is the
  safety property, not an optimisation: a pid is ours only until Node reaps it, which is exactly
  when `exitCode`/`signalCode` stop being null. What survives even that is recorded rather than
  forgotten — `browserPoolStatus().abandonedProcesses`, which both `shutdown()`s log, and which a
  process that finally dies drops off. `closeSharedBrowser()`
  is wired into both apps' `shutdown()`, both render test files' `afterAll`, and `pnpm covers:preview`
  — a live `Browser` holds the event loop open, so without it vitest never exits. It is bounded for
  the same reason it is awaited in a signal handler: one wedged renderer used to hang the shutdown
  that was supposed to release it, until the supervisor's own SIGKILL left that Chromium reparented
  to init. Never `browser.process()?.unref()`; that orphans Chromium — killing it is the opposite,
  and the only thing that reclaims one. Production reaps it with tini
  (`ENTRYPOINT`), dev with compose `init: true`, because PID 1 is a shell that does not reap — and
  budget **two** pooled browsers in production, one per process.
  **Trapping SIGHUP is part of that wiring, not housekeeping.** Puppeteer's own handlers are off,
  so its only remaining net is an unconditional `process.on("exit")` — which a signal Node does not
  handle never reaches. A hangup (a closed terminal, an `ssh` drop, systemd reload) used to kill the
  API or worker mid-flight and leave Chromium alive, reparented to init and reaped by nobody, so
  both entry points and `scripts/start-production.sh` trap `HUP` alongside `INT`/`TERM`. Registering
  a third signal is also why the two `shutdown()`s are now once-only: a hangup is routinely followed
  by a TERM from the same supervisor. `scripts/tsx-dev.mjs` forwards a hangup as **SIGTERM**,
  because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans the app holding
  the browser.

- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.**
  The numbers a reader can see — the printed footer, the Contents column, the pdfrx chrome — skip
  the cover sheet (`counter-reset: page 0` on `@page pdf-cover` / `@page pdf-title`). Stored map
  ranges stay physical: PDF page 1 is the cover when `hasCoverPage` is set. `printedPageForPdfPage`
  and `pdfPageForPrintedPage` convert — but only version-2 maps (what `buildBookPdfPageMap` writes)
  apply that offset. Version-1 maps were measured against PDFs that counted the cover and stay
  on physical numbering, matching the files they describe. Nothing about a model page says where
  it lands: pages join
  on a single newline, so adjacent pages routinely share one paragraph. `compileBookMarkdownWithPageAnchors`
  therefore returns, beside the byte-identical `book.md`, one destination name per model page — the
  existing `chapter-N` for a chapter opener, `bp-N` plus a markdown offset otherwise — and the PDF
  render injects markers into **its own copy only** (`pdfPageAnchors.ts`): an empty inline
  `<span id>` glued to plain content, an HTML comment line before block syntax, a span *inside* a
  quote or list line when one container straddles the boundary — and no marker at all inside a
  straddling table, where a comment ejects the following rows as pipe text and a span shifts the
  cells, so that page stays unanchored and the whole map fails soft instead. Each shape is measured
  against marked@4.3.0 to leave the rendered blocks identical, and manuscript-authored `bp-*` ids
  are renamed at equal byte length so user text cannot point a destination somewhere else.
  **`chapter-*` needs the same guard and cannot take the same shortcut, because the compiler writes
  those ids itself.** Chrome resolves a link against the first element wearing a name, so a page that
  merely *reads* like a chapter opener outranks the real one — and that misplaces the Contents link,
  the number rewritten into its row and the reader's fallback outline as well as the map, since
  `buildBookPdfPageMap` only refuses a *decreasing* run of anchors and a stolen destination landing
  in order still yields a full map of the wrong pages. A manuscript reaches the name two ways, so
  there are two renames. In the markdown, `<a id="chapter-2"></a>` is what an author writes for a
  chapter of their own — markdown has no attribute syntax and it is the name anyone would pick, which
  is why the compiler picked it too; nothing in the bytes tells the two apart, so
  `compileBookMarkdownWithPageAnchors` records `existingIdOffset` for each anchor it writes,
  `chapterAnchorMarkup` is the shape both sides agree on, and every *other* tag holding the name is
  renamed — never one inside a fenced block, where it is printed as code rather than rendered. If a
  single recorded offset does not hold its anchor, **nothing** is renamed: a chapter that lost its id
  takes its Contents link with it, which is worse than a stolen destination. After the render,
  `neutralizeRenderedReservedIds` catches what no offset could — `## Chapter 2` is handed
  `id="chapter-2"` by marked's own slugger, an id that exists on neither side of the markdown — and
  renames every reserved id except the renderer's own two marks, the compiled `<a id="chapter-N"></a>`
  (recognised by the heading that must follow it) and the injected empty `<span>`. Names match
  *whole*, so a heading slugging to `chapter-2-the-return` keeps its id and the links to it.
  `placeBookPageAnchorIds` then moves
  every marker onto a box with extent (the following block, the following inline element, the first word), because a
  zero-height marker at a fragmentation boundary lands its destination a page early — the same
  incident `liftChapterAnchorsOntoHeadings` exists for. A `display:none` nav of internal links
  makes Skia emit `/Dests` at all (ids alone emit nothing; hidden links add no annotations, no
  layout — measured). `extractPdfNamedDestinations` (`pdfNamedDestinations.ts`, the dependency-free
  byte parser `pdfPageMap.ts` is the model on top of) reads the names back out of
  the rendered bytes through the classic xref, and `buildBookPdfPageMap` turns starts into
  inclusive ranges, deciding shared boundary pages by the anchor's y against the top-margin band.
  **Failure anywhere returns `undefined`, and no compile may fail, publish differently, or retry
  over the map** — chat without a translatable map keeps the old model-index behaviour. New PDFs
  still skip the cover in CSS, so a failed measurement still records cover-skip numbering
  (`bookPdfCoverNumbering`) for chrome. **That stub says what it is** — `kind: "cover-numbering"` —
  and the marker, not its empty `pages`, is what `parseStoredBookPdfPageMap` refuses it by, because
  "carries no ranges" and "was never a measurement" are different rows and only the second may
  never reach chat. Reading the refusal off `pages` retired a measured map that came back
  rangeless along with the stubs, losing the cover flag and the furniture starts that were still
  true of its file; a row predating the marker is refused anyway, since a stub describes no file
  and so carries no `totalPdfPages`. `parseStoredBookPdfNumbering` ignores the marker — the
  cover-skip fact under it is the whole point of the stub.
  When the
  book prints a Contents, its rows' numbers — which the markdown could only write as model indexes
  — are rewritten to the printed chapter numbers (the cover sheet is not numbered) and the document
  rendered once more, re-measured, and re-checked once: the printed column and the footer now count
  the same pages. That column is rewritten **whole or not at all** — a chapter whose anchor measured
  onto the unnumbered cover has no printed number, and `contentsChapterPrintedPages` refuses the
  whole set rather than letting that one row fall back to its physical sheet, which would print one
  number from the other system in the one column a reader checks against the footer. The rows keep
  their model indexes instead, and the map — physical throughout — is kept either way.   **Replacing
  `book.pdf` without that measured pass must replace the translatable ranges.** A detached repair whose
  recompile does not byte-match the published `book.md` renders those published bytes with no
  plan — no markers, no Contents reprint — and the reprint exists because digit width moves
  breaks, so "same manuscript" is not the same pagination. A stale map mistranslates chat
  targets onto the unreprinted file; a cover-numbering stub is the graceful path — chrome
  still matches the footer, chat stays on model indexes. Keep anchor ids
  ASCII `[a-z0-9-]` (PDF name escaping never applies) and keep the injection out of `book.md`,
  whose bytes are the provenance sha, the EPUB input and the reader-chapter fingerprint.

## Export provenance and scratch files

- **A download says which compile answered it, because the URL cannot.** Every compile of a book is
  published over `book.pdf`, so the availability descriptor the app fetched with is a claim about
  what that URL held when the status was read — and the download most likely to be answered by a
  *newer* compile is the retry after an `EXPORT_NOT_READY`, which is the app being told a compile is
  landing. The app files those bytes under a `contentRevision` three times over (the reader cache,
  the "your edits are in" banner, every highlight and bookmark it stamps), so a stale descriptor made
  all three agree on the wrong book. Sizes cannot separate them: a presentation reprint, a re-applied
  edit and an undo all produce a book of exactly the same length. So every publication records the
  sha256 of what it installed beside it (`book.pdf.provenance.json`), under the revision it claimed
  — `publishCompiledExports` in the worker and `publishRebuiltExport` in the API, both inside the
  transaction that already holds the row lock, after the renames, and never fatally: a book on disk
  must not be failed and refunded because a hundred bytes of metadata could not be written.
  `readPublishedExport` (`packages/core/src/generation/exportProvenance.ts`) then resolves the bytes
  it read against that record and the mobile route answers with `X-Export-Provenance` and
  `X-Export-Content-Revision`. **The record is read on both sides of the file read**, because a
  publication landing in between moves the file and the record independently as far as the reader is
  concerned; a digest identifies one file, so either read may confirm, and only when neither does is
  the read tried again. **Nothing consults the project row to label bytes** — a row read after a file
  read describes whatever compile is current now, which is the same mistake one layer down, and an
  edit moves the row minutes before the compile that publishes for it.
**Every scratch name in that scheme is built in one module, and swept by age from the same one.**
A publication renders to `.book-<uuid>.{md,pdf,epub}`, parks each predecessor at
`.book-superseded-<uuid>.<ext>` while it moves in, and a PDF render writes `.book-render-<uuid>.html`
into the image store; every one of them is removed by a `finally`, which covers a thrown render, a
lost claim and a failed publication — and covers nothing at all when the process does not get to
run it. A SIGKILL, an OOM kill or an evicted container leaves the file for as long as the volume
lives, invisible until storage fills. `exportTempSweep.ts` (`packages/core`) both *names* them —
`pendingExportTempPath`, `supersededExportToken`, `renderDocumentTempPath`, used by
`exportPublication.ts`, `pdf.ts` and the API's inline rebuild — and collects them, because a writer
whose name drifts out of the sweep's pattern strands files nothing recognises and nothing fails.
The collection is **age-based only, never a startup wipe**: a rolling deploy runs two workers, the
API renders into the same project directories, and `make up` and `pnpm dev` share one storage
directory, so "this process just started, therefore nothing here is live" is false in every
deployment here. Quiet time is the only signal, which is why the minimum age is clamped up to
`EXPORT_TEMP_MIN_AGE_FLOOR_MS` whatever the config says and defaults to six hours against a window
that is really seconds — the file is written and published back to back. Nothing else is a
candidate: the patterns demand the prefix, the literal `randomUUID()` token shape and the writer's
extension, and the scan requires a regular file at both the dirent and an `lstat` and removes it
with `unlink`, so a symlink wearing a scratch name is skipped rather than followed. The timestamp
is read **twice**, on either side of a decision the whole directory scan could otherwise sit in,
and `ctime` counts alongside `mtime` because a writer can backdate one and not the other; ENOENT is
not an error but the other end of the race working. `startExportTempCleanup`
(`apps/worker/src/runtime/`) is the only thing that runs it — one collector reaches every orphan
because the volume is shared, and the sweep is age-based rather than ownership-based precisely so
it can clean up after the *other* process. It is bounded (an entry budget, a per-root cap and a
resume cursor) and single-flight, and `shutdown()` stops it **before** `worker.close()`: a scan
holds an open directory handle and has no job to finish, so it is cancelled through the signal it
checks between entries and awaited, rather than left running into `prisma.$disconnect()`.

## Chapter apparatus

- **A book only earns the word "Chapter" by being long enough to need it.** The planner is told to
  make its chapter targets sum to exactly `targetPages`, so a three-page book gets three one-page
  chapters — a good *writing* scaffold, three distinct beats, and an absurd thing to print as
  "Chapter 1" over three paragraphs plus a Contents page costing a quarter of the PDF.
  `chapterPresentationFor` (`packages/core/src/generation/markdown.ts`) sizes the apparatus to the
  finished book instead: `chapters` (numbered headings + Contents), `sections` (the titles alone,
  no Contents — the default style becomes `title_only`), or `none`. Read it off the partition that
  is *about to be printed*, never off `plan.chapters`, which is why one test now covers both the
  plan's chapters and model-written reader chapters — the plan-side guard it replaced had a floor
  of four chapters, so a three-page book cut into three could never trip it. An explicit
  `mediaSettings.chapterHeadingStyle` still outranks all of this; only the default is sized.
  The narrator asks the same question through `narratedChapterLabel`
  (`apps/worker/src/handlers/generateAudiobookSupport.ts`) and drops the spoken label — but it must
  never re-partition, because `chapter-<n>.mp3` and the READY-skip that resumes a failed narration
  are keyed on chapter index.

## Library characters

- **A library character reaches a book by copy and by name, never by foreign key.** The
  account-wide `LibraryCharacter` table is the user's; at build time the active branch's
  @-mentions are snapshotted into `mediaSettings.mobile.characters`
  (`libraryCharacterSnapshotsForBuild` in `apps/api/src/mobile/creationBuild.ts`), and everything
  downstream — the planner guidance in `planner.ts`, the prompt block in
  `composeMobileProjectPrompt`, the reference-sheet seeding — reads that copy off the input
  snapshot. The plan schema strips unknown keys, so the **verbatim name** is the only link from a
  plan character back to its portrait: `matchLibraryCharacter`
  (`packages/core/src/generation/libraryCharacters.ts`) tries folded exact equality then
  **whole-token** containment, and a rename by the planner degrades to an unseeded sheet, never an
  error. Both halves of that are scars. Everything is compared through `foldCharacterName` (NFD,
  drop the *optional* marks listed in `OPTIONAL_SPELLING_MARKS`, drop ZWNJ/ZWJ/bidi, fold Arabic
  kaf/yeh onto Persian, fold Arabic-Indic digits) because a Persian name saved from one keyboard
  and echoed by a model trained on the other was two different names. That mark list is an
  **allowlist** — Latin/Greek/Cyrillic accents, Hebrew niqqud and the Arabic marks, all things a
  spelling carries or does not — and never `\p{M}`, which it was: Devanagari matras are `Mn`/`Mc`,
  so "मीरा" and "मारा" both folded to "मर" and the matcher seeded one saved character's face onto
  the other. Thai sara and (after the NFD) the Japanese dakuten were the same collision. A script
  nobody enumerated keeps its marks, because a missed match is a character drawn from prose and a
  merged one is the unrecoverable half of the very rule below.   **The mention scanner's rule about
  marks runs the other way, and both are right.** `isLibraryMentionNameCharacterAt`
  (`libraryMentions.ts`), the word-boundary test deciding where a typed `@name`
  ends, matches `\p{M}` on purpose: a combining mark belongs to the letter before it, so with marks
  outside the boundary class `@मीर` ends cleanly in front of the "ा" of `@मीरा` and binds a saved
  character the reader never named — `Luna` seeding `Luna-Bear` again, in a script where the
  sub-token is invisible. One rule says a mark is not part of the *spelling*; the other says it is
  part of the *word*. Neither may be narrowed to agree with the other, because each is closing a
  collision the other cannot see. The boundary class is one rule spelled twice —
  `isLibraryMentionNameCharacterAt` + `libraryMentionTokenEndsAt` in
  `libraryMentions.ts` (the description scanner and the build sweep in
  `apps/api/src/mobile/creationBuild.ts` both call these), and `_nameCharacter` +
  `_endsMentionToken` in the Dart twin (`apps/mobile/lib/features/characters/domain/library_mentions.dart`)
  — and the two only move together:
  the composer and the build sweep disagreeing is how the server silently bound the `Luna` the
  composer had just refused to show inside a typed `@Luna-Bear`. The class carries ZWNJ/ZWJ, so the
  scanner itself no longer reads `علی‌رضا` as ending after `علی`; the trailing rule is that an
  apostrophe after a complete name ends the token (`@Luna's` still binds Luna) while a hyphen
  joining the next word does not (`@Luna-Bear` binds nobody unless `Luna-Bear` is itself saved).
  And containment is whole-token because sub-token matching put one
  reader's saved face on a character they never saved — `Sam` seeded `Sam's Mother`, `Luna` seeded
  `Luna-Bear`, and ZWNJ is category `Cf`, so the old `[^\p{L}\p{N}]` boundary read `علی‌رضا` as a
  word break and matched a library `علی`. An **ambiguous** containment resolves to null: a missing
  seed is a character drawn from prose, a wrong one is a stranger wearing the reader's face, and
  only one of those is recoverable by reading the book. Deleting
  a character deletes rows and files but no book state; a seeding pass that finds the portrait
  file gone skips it silently, which is the deletion-safety valve. Character files live at
  `IMAGE_STORAGE_DIR/characters/<userId>/` — never swept, unreachable from the project asset
  route and the render allowlist — and every path to them resolves through
  `libraryCharacterDiskPath`, which returns null for anything but exactly `<userId>/<fileName>`.
- **Naming every row is not the same as claiming every marker, and a tie is settled rather than
  left standing.** `claimAt` (`libraryMentions.ts`) refuses a span two candidate names tie over —
  "Bram" and "bram" are two legal rows, since `[userId, name]` is case-sensitive, and neither is
  spelled the way `@BRAM` is — because a wrong owner is the unrecoverable half, exactly as it is
  for a typed mention. That refusal is right for a *rewrite*, which needs an owner, and wrong for a
  *strip*, which only ever deletes the `@`: every tied candidate agrees on that edit. Folded into
  one "nobody claimed it", the tie read as the reader's own prose and the marker went into the
  planner brief and `buildLibraryCharacterPortraitPrompt`. So the scan reports ties separately and
  `stripBoundLibraryMentionMarkers` takes them, for a caller whose list is the whole of what the
  prose is bound to. `stripLibraryMentionMarkers` may not: it takes `siblings` whose tokens must
  survive, so a tie there may belong to one of them, and dropping that `@` would leave a stored row
  pointing at a token the prose no longer carries.

- **A character's look lives in pixels, so it has to be written down or the planner invents one.**
  `LibraryCharacter.description` is who the character is — free text the reader writes, routinely
  carrying no appearance at all ("she's a great wife and future mother") — while what they *look
  like* existed only in the portrait, which the planner is a text model and never sees. Told to
  reuse a character it could not picture, it invented a look, wrote it into
  `illustrationPlan.characterReferencePrompts` and every page prompt, and **that text beat the
  reference images attached beside it**: a woman in a black hijab was rendered as a bare-headed
  child in a ponytail, on a page whose prompt did not even use her name. So there is an
  `appearance` column, read off the picture by the same bounded vision call the photo upload
  already makes, snapshotted beside the name, and printed by `libraryCharacterPromptBlock` as its
  own labelled line under its own budget — truncating a look is not a shorter sentence, it is a
  licence to finish the outfit. `libraryCharacterAppearanceRule` then says the only two honest
  things: with an appearance recorded, reuse it word for word; **without** one, write no hair,
  age, build, headwear or clothing anywhere and refer to the character by name only, because the
  picture is attached to the image calls and invisible to the writer. "Invent something
  consistent" is the instruction that caused this.
- **Nothing used to check that the planner obeyed, and now one pass does.**
  `reconcilePlanLibraryCharacters` (`packages/core/src/generation/planLibraryCharacters.ts`) runs
  after **every** plan parse — `createPlanningPackage` and `revisePlanningPackage` both — and
  renames a matched character back to the verbatim name, restores the library's own description
  over the schema placeholder (`"Recurring character in the plan."`, `schemas/plan.ts`), sets
  `visualRules` from the recorded appearance or leaves them empty, re-appends a snapshot character
  the plan dropped, and collapses two entries that resolve to one snapshot. It is what turns
  translation, rename, near-duplicate and invented-twin from silent wrong output into a no-op.
  Revision needed it most: `planLibraryCharacterGuidance` was called from the initial planner
  **only**, and `revisePlanningPackage` serialized no `userInput` and no `mediaSettings` at all, so
  any "make it shorter" after approval re-decided the saved character against nothing. Arrays merge
  as atomic replacements, so whatever came back won.

## Character reference selection

- **One sheet per character reaches the model, because a superseded cast is still the same cast.**
  `selectCharacterReferenceAssets` (`characterReferences.ts`) scores an asset by whether the
  context names the character its `metadata.characterName` resolves to — a function of the name and
  the prose, never of the file — so several sheets of one character score identically and the sort
  is a tie each of them wins. That was harmless while a book's sheets were one plan version's: the
  worker's render pass used to delete every `CHARACTER_REFERENCE` row on the project before writing
  its own. It no longer may (→ apps/worker/src/generation/CLAUDE.md), so a replan or a continuation
  leaves a whole cast behind permanently, and the one reader that ranges across plan versions —
  `insertionReferenceSelection` in `apps/worker/src/handlers/applyImageInsertion.ts`, which falls
  back to *all* of a project's sheets when the current plan has none — handed this function three
  drawings of Ada beside three of Beatrice. On a book replanned twice, a chat `add_image` then spent
  its entire 3-to-5 reference budget on one character while the rest of the cast was attached to
  nothing and drawn from prose alone, which is the exact failure the sheets exist to prevent. The
  `ordered.length === 1` fallback — the rule that a book with a single character attaches them even
  when the subject does not name them — missed for the same reason, since three copies counted as
  three characters and it returned nothing at all. `oneSheetPerCharacter` collapses by plan-character
  index before any of that, and it keeps the **last** copy: every caller reads the rows
  `orderBy: { createdAt: "asc" }`, so the last sheet for a character is the newest, drawn against
  the most recent plan's description of them. A caller whose sheets are already one plan's is
  unchanged by construction, which is why this is the fix rather than a second plan filter at the
  one call site that has no plan to filter by.
