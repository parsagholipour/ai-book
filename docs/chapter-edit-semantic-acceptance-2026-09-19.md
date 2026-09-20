# Chapter edit semantic acceptance

> **Partly superseded (2026-09-19).** The gate still exists and is still `chapterEditAcceptance`
> in the Quality settings, but the decision-model (Jev) questions this document describes were
> removed after four Balanced evaluations: 168 attempts on 69 comparisons, 87 failed (81 gateway 503s),
> one review saved, every reviewer-confirmed regression passed, both vetoes wrong. Every changed
> candidate now goes straight to the one contextual JSON review (`review-chapter-edit-acceptance`),
> which reads the whole comparison, judges a cut span by span, and is handed a factual
> correction's evidence. Cut reviews carry only the chapters the cut's notes cite. The evidence
> is in [jev-balanced-100-evaluation-2026-09-19.md](jev-balanced-100-evaluation-2026-09-19.md);
> the current invariant is in `packages/core/src/generation/CLAUDE.md`. The paragraphs about
> "clear Jev passes" and the two decision purposes below are historical.

The `chapterEditAcceptance` quality gate covers `editChapter` and `cutChapter`,
including evidence repairs and manuscript-read cuts in the composed worker.
It is enabled by default on all effort tiers. Operators can disable it, or select
individual tiers, under **Chapter edit semantic acceptance** in the Quality settings.
Missing keys in older revisions inherit the default; an empty tier list disables it.
Direct core callers can set `semanticAcceptance: false`.

A changed candidate must first pass the existing deterministic acceptance checks.
The semantic gate uses its own preservation rubric, independent of the best-of
chapter rubric. It asks two separate questions:

- Does the candidate preserve substantive meaning: claims, polarity, causality,
  scope, uncertainty, attribution, quotations and essential qualifications?
- Does it fulfill the intended edit or cut, with a concrete improvement or a
  retained passage that makes the deleted material redundant?

Both judgments receive the complete original and candidate, chapter assignment,
reader notes, available evidence and surrounding context. Manuscript cuts receive
other chapters' current prose so a claim of cross-chapter redundancy can be checked.
Tail-only cuts include the unchanged chapter head in acceptance context.

The decision route is resolved once for the pair. Clear Jev passes on both questions
accept the candidate; a clear failure on either retains the original. Missing,
invalid, low-probability or uncertain judgments go to one contextual JSON review
through the existing text adapter, without a generic choice fallback or JSON repair
loop. That review must pass both dimensions. A failed, malformed or still uncertain
review retains the original. Unchanged candidates make no semantic calls.

Evidence repairs supply explicit correction instructions and their evidence packets.
These authorize correcting, narrowing or deleting the unsupported claim while
preserving unrelated meaning. They do not require the original error to survive.
Empty or missing usable evidence, or empty or whitespace-only instructions, retain
the original without semantic calls; notes alone do not authorize a factual change.
An unchanged or rejected repair cannot clear existing evidence findings by rerunning
the evidence reviewer on the same text; those findings still reach publication grading.
Manuscript-read notes likewise remain recorded when a cut is rejected.

Disabling this gate skips only semantic acceptance. Word budgets, deletion-only
validation, corruption checks, figure handling and quotation/code protections remain.
Cancellation propagates. Logged decision and text adapters retain physical-call
accounting; gate costs attribute `accept-chapter-edit-meaning`,
`accept-chapter-edit-intent` and `review-chapter-edit-acceptance` to this feature.

The regression suite scripts model judgments to verify prompts, context, acceptance,
uncertainty handling, cancellation, retained findings and worker gate wiring. It does
not measure live Jev accuracy; that requires the saved-draft comparison proposed in
the [Jev audit](quality-gates-jev-audit-2026-09-18.md).
