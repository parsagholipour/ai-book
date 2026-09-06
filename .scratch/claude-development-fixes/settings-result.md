# Settings task result — 2026-09-05

## Edits

- `packages/core/src/generation/qualityGates.ts`: compiled defaults for `bookDevelopment`,
  `caseEvidence`, `developmentalEdit` set to `[]` (off on every tier). Feature IDs, labels,
  pipelines and the opt-in merge in `parseQualityFeatureSettings` are unchanged. A two-line comment
  above the three entries says the September 5 live experiment regressed quality and runtime, that
  the stages require an explicit opt-in, and that older settings must not enable them. (My first
  wording of that comment carried the 5.90/7.82 numbers; a peer session reworded it on disk at
  12:21:40 local, after my edit and before this note. Defaults unchanged by that rewrite; kept
  as-is.) No other default touched.
- `packages/core/src/generation/qualityGates.test.ts`: new case
  "keeps the development pipeline off on every tier unless a row opts in" covering
  (a) no row → all three off on ultra/premium/balanced/fast, (b) an older row carrying none of the
  three keys → all three still off, sibling `chapterEditorPass` still on, (c) explicit
  `["balanced"]` opt-in per feature → on for balanced only, other three tiers off, the other two
  features untouched.

## Verification

```
pnpm -F @book-maker/core exec vitest run src/generation/qualityGates.test.ts
  Test Files  1 passed (1)   Tests  7 passed (7)
pnpm -F @book-maker/core typecheck        exit 0
oxlint on the two edited files            exit 0
```

Worker suites that name these features (`composedChaptersPass`, `composedPreparation`,
`composedDevelopmentalEdit`, `composedEvidence`) mock or supply their own `enabled` predicate, so
none read the compiled default. Full `pnpm check` left to the parent.

## Queue state before editing

No ACTIVE/QUEUED `GenerationJob` rows for `cmtnyg6ji0000seg0lrlewwb1` or
`cmtnzo7wf0000qwg0kwq6s3rk`; the latest GENERATE_BOOK for each is FAILED at 08:19 UTC (the parent's
stop). Nothing was stopped by this task. The Docker worker (nodemon watching `packages/core/src`)
will have restarted on the edit with no in-flight book.

## Not done (out of scope)

- No DB revision appended; the parent owns the live `GenerationQualityRevision` write.
- No books run, no paid API calls.
