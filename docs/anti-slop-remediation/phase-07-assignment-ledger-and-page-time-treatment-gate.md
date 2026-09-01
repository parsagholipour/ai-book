# Phase 07 - Assignment Ledger And Page-Time Treatment Gate

## Objective

Stop same-chapter treatment repetition *before* a book is durable, instead of reporting it after
every page is written.

Phase 03 made `SAME_CHAPTER_TREATMENT_REPETITION` visible: a deterministic compile-time detector
scores named-entity overlap (subject) plus shared evidence, causal and conclusion terms between
pages of one chapter. Phase 04 corroborates the worst clusters with a bounded model call. Neither
moves a page: a book that finishes with "3 pages in the same chapter repeat the same subject,
evidence, and conclusion" is already written, and Phase 06 keeps automatic consolidation off until
live precision gates are measured.

The prevention chain in front of that detector missed the failure for three reasons this phase
closes:

1. **Assignment time was lexical only.** `findDuplicatePageBeats` compares short `purpose+beat`
   strings by trigram and keyword overlap. Three beats phrased differently about adjacent facets of
   one subject pass, and every drafter then reaches for the same canonical cases and the same
   conclusion. `PageProductionBeat` had no semantic field to audit.
2. **Page-time QA could not see treatment repetition.** The local repetition gate compared a draft
   to its last five pages at near-verbatim thresholds; the model reviewer saw a few hundred
   characters of prior prose. The rewrite loop and the brief-repair recovery never fired for this
   class, so the only reader of the treatment signal was the compile.
3. **Bulk drafters got one generic line.** The product's typical book (≤40 pages, factual) is
   drafted whole from the page map with "every page must add distinct progression" and nothing that
   says which evidence each page owns.

## Entry Gate

None beyond Phases 01–04 being in place. Nothing here rewrites published prose or changes the
publication policy; every new behaviour runs before a page is durable, inside budgets that already
exist.

## Workstream B - Page-Time Treatment Gate

One scorer, one set of thresholds, used at page time and at compile: what the page loop passes,
the manuscript audit passes.

- `scoreTreatmentPair` (`manuscriptTreatmentAudit.ts`) is exported and returns a `TreatmentMatch`
  naming the shared entities, evidence, causal and conclusion terms. The thresholds are unchanged
  and live only there.
- `pagesTreatmentQa.ts` scores a draft against the finished pages of its **own chapter** — the
  chapter range the caller was handed, or the audit's own `SAME_CHAPTER_FALLBACK_DISTANCE` when it
  has none — and `pagesLocalQa.ts` fails `repetitionOk` on a match. That reaches the existing page
  rewrite budget (`pageQaRewriteAttemptsFor`) and, at the recovery revision, the existing brief
  repair (`repairPageBrief`), which is told the named terms. Signatures of finished pages are
  memoized by object identity; the draft's is built once per call and only when there is a
  candidate to score against.
- The issue message spells the earlier page as `(from page N)`. `runLocalFinalQa` prefixes
  `Page N:` and the compile's repair pass harvests every other `page N` in a message as a page to
  redraft (`finalQaPageTargets.ts`); any other spelling redrafts the page that *established* the
  treatment beside the page that repeated it. Listed terms drop the edge words that pass reads as a
  complaint about the book's opening or ending.
- The draft-then-polish pass scores the whole bulk draft while every page of a chapter is in hand
  and hands each later page that re-treats an earlier one a `distinctnessGuidance` line for its
  first polish (`treatmentGuidanceForDraft`), so the first polish differentiates it rather than the
  QA loop paying a rewrite to find out.

## Workstream A - Evidence Ledger On The Production Map

For books whose writing mode is `analytical-history` or `instructional` (`evidenceLedger.ts`;
the plan's own mode wins over the inference from category and prompt), every page assignment
carries two optional fields beside its beat:

- `claim` — the one bounded claim the page establishes, in one sentence.
- `evidenceAnchors` — two to four specific cases, sources, dates, artefacts or figures the page
  argues from.

They are exactly the signal the compile detector measures, made a property of the assignment.

- **Schema.** `pageProductionBeatSchema` reads both under their aliases (`thesis`, `anchors`, …)
  and omits the keys when absent, so a stored brief from before the field parses as it did and the
  `Chapter.productionBrief` compare-and-swap keeps parse ≡ document.
- **Producers.** The whole-book map, the per-chapter brief, the brief repair, the page-map critic
  and the beat-dedup rewrite each get the ledger rule for their audience; every explicit rebuild of
  a beat (`normalizeModelPageBeat`, `decodeGeneratedChapterBrief`, `pageMapForWholeBookDraft`,
  the whole-book citation sanitizer) carries the fields by name through `evidenceLedgerFields`.
  `mergePageMapCriticPatch` drops a page's claim and anchors under a whole-assignment rewrite that
  names none, the `imageMoment` rule applied to the ledger.
- **Audit.** `productionMapAnchors.ts` folds anchors (`foldCharacterName` plus punctuation) and
  matches on whole-phrase equality or ≥0.8 token containment with at least two tokens on the
  smaller side. Two pages of a chapter collide on two shared anchors, or one when either page
  argues from two or fewer. `SHARED_EVIDENCE_ANCHORS` is an assignment finding routed to the same
  bounded `dedupe-page-beats` rewrite as a near-duplicate beat, briefed against the colliding
  sibling; it is **never blocking and never densifies a chapter**, and one that survives the two
  repair cycles drafts with its distinctness note (`advisory_unresolved`) rather than failing the
  book. `MISSING_EVIDENCE_ANCHORS` is diagnostic only, one finding per chapter.
- **Drafters and reviewer.** Sibling briefs in `pageScope` carry claim and anchors; the single-page
  draft, the three bulk writers and the polish prompt are told a page's anchors are its own
  evidence, sibling anchors are reserved, and its claim must differ from every sibling claim. The
  reviewer rejects a page that argues from a sibling's reserved anchors or restates a sibling
  claim. A narrative or children's book sees none of it.
- **MOCK_AI.** `dryRunPageBeat` carries a claim and two anchors built from coprime table periods, so
  a dry run exercises the ledger without colliding; the `dedupe-page-beats` branch returns fresh
  ones only for a page that carried them.

## Out Of Scope

- Automatic redraft of corroborated clusters at compile time (Phase 06 entry gate).
- Widening the model reviewer's prose window; the deterministic gate covers this class.
- Embedding-based similarity; the ledger targets the measured signal deterministically.

## Required Tests

- Parity: the paraphrased Indus fixtures fail the page-time gate and the distinct-evidence fixtures
  pass it, with the same scorer the audit uses.
- The issue message harvests to the current page only (`finalQaPageTargets.test.ts`).
- Finished-page signatures tokenize once per object.
- Anchor folding, containment, the two-token floor and the ≤2-anchor rule.
- A shared anchor is sparse, non-blocking, non-dense, and briefed against the owning sibling.
- A missing ledger is reported only in ledger modes and never blocks.
- The critic merge keeps, drops and applies the ledger under note-only and whole-assignment patches.
- Every explicit rebuild carries the fields; aliases survive decode and the schema.
- Ledger prompt lines appear for an analytical book and not for a story.
- The worker repairs a shared anchor through the sparse rewrite and drafts past an unresolved one.
- `pnpm anti-slop:replay` carries a `boundary:shared-evidence-anchors` fixture.

## Acceptance Criteria

- A draft that re-treats a same-chapter page is rewritten inside the page's own budget before it is
  durable, with an instruction naming what it shared.
- Analytical and instructional books draft from a map whose pages own distinct evidence, and a
  shared anchor is repaired through the existing bounded rewrite without a new provider purpose.
- Clean books incur no new model call; no publication policy changes.
