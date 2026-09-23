# Chapter research context — P2-03 fix, 23 September 2026

Chapter compose, edit and edit-acceptance calls now use the same bounded research-summary context. Previously, compose/edit took the first 18 notes without limiting their length, and the acceptance reviewer received the entire list. Repeated entries could also consume every available slot before a different source was reached.

The new `chapterResearchNotesForPrompt` helper:

- Removes exact duplicates after whitespace normalization, before selecting the first 18 unique notes in the existing chapter-retrieval order. Different source labels remain distinct.
- Caps each note at 2,000 serialized characters and the compact JSON summary list at 12,000 characters, including escaping. Short notes release unused space to longer ones; one large summary cannot consume every source's allowance.
- Preserves complete sentences and source labels where they fit. A sentence too large to fit is omitted with an explicit marker instead of being cut into a partial assertion. Original research records remain unchanged.
- Applies only to background summaries. Dossier passages, reviewed case evidence, factual-correction passages, exact computations, and unsupported-claim instructions keep their independent existing handling and are never charged against the summary allowance.

All three prompts identify summaries as bounded background rather than verbatim proof. The line editor is explicitly directed to make the smallest necessary change and preserve unaffected paragraphs verbatim. The contextual acceptance reviewer still reads the entire original and candidate, with the existing surrounding context, cut-span checks, uncertainty handling, and fail-closed behavior. Its prompt version is now `chapter-edit-acceptance-v4`.

## Saved-trace replay

The following are **reductions in user-payload characters**, computed by applying the helper to each relevant saved request from the 22 September audit. JSON formatting is held constant per purpose; new system-rule overhead is not included. These are input-size projections, not measured provider token/cost savings or claims about improved editorial acceptance rates. No paid model call is required for this replay.

| Tier | Composition | Editing | Edit acceptance |
| --- | ---: | ---: | ---: |
| Quick | 74.6% (6 calls) | 65.5% (4 calls) | 55.8% (1 call) |
| Balanced | 20.8% (5 calls) | 13.5% (15 calls) | 11.1% (17 calls) |
| Premium | 27.6% (7 calls) | 15.3% (13 calls) | 14.1% (14 calls) |

Every replay asserts the summary ceiling and exact equality of **all other payload fields**, including original/candidate text and evidence. The rewrite preserves evidence instead of trying to make the review cheaper by withholding chapter context. The stronger minimal-edit instruction still requires live quality measurement; this change does not claim that it will accept more edits, skip reviews, or reduce their count.

## Verification

The real compose/edit/acceptance prompt builders first failed the two regression cases: oversized note lists and duplicates displacing a later source. After the fix, the focused suites passed **60 tests**, covering those cases, escaped JSON, Unicode, whole-sentence boundaries, indivisible long sentences, full evidence retention, and the existing semantic/cut acceptance guards.

Full repository verification: **`pnpm check` passed all seven gates in 162.8s** (typecheck, lint, file sizes, gotcha index, subpath validation, subpath tests, and all workspace test suites).

Changed code:

- `packages/core/src/generation/chapterResearchContext.ts`
- `packages/core/src/generation/chapterResearchContext.test.ts`
- `packages/core/src/generation/composedChapter.ts`
- `packages/core/src/generation/chapterEditAcceptance.ts`

Local regression logs and replay script/results: `.scratch/chapter-context-fix-2026-09-23/`. Original immutable audit captures remain in `.scratch/token-audit-20-2026-09-22/baseline/`.
