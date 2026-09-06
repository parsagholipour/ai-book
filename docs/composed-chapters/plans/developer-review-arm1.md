# Developer review: arm 1 wiring and the rest of the paradigm

2026-09-03, against the working tree (worker typechecks; `composedChaptersState.ts` was mid-edit). Nothing changed. Line numbers are today's.

## A. Arm-1 defects

**A1. The page re-cut is inert.** `composedChaptersPass.ts:115` computes `setups = chapterSetupsForPlan(plan, …)` before the arc exists; `plan = cut.plan` at :174 rebinds only the local used for prompts. Chapter rows (`resetBookForDirectGeneration`, :137), the form plan's `ranges` (:192), word budgets, pagination and `chapterPosition.pages` all read the original equal cut. `distributeTargetPages` (planner.ts) keeps targets that already sum to the book, so the cut would survive normalisation — ordering is the only blocker. Fix: stance → arc → cut → `setups` → resume/reset. As wired, arm 1 does not test length at all.

**A2. The cut must be persisted, not just applied.** `persistBookArc` (:710) writes only `bookArc`. The compile places chapter headings by walking the *stored* plan's `chapters[].targetPages` (`markdown.ts:334`; `compileExport.ts:176` parses `planningPackage`); `pagesPageMap.ts:697` and `pageRestructure.ts:113` derive ranges from the plan too. After A1, rows carry the arc's cut, the plan carries the old one, and the PDF prints headings mid-chapter. Fix: the same `planVersion.update` writes `{ …pkg, bookArc, chapters: cut.plan.chapters }`; re-applying is then a no-op and `composedResumeState` matches on retry.

**A3. A missing arc is silent.** `architectBook` (bookArc.ts:164) swallows every non-stop error and returns `undefined`; the pass (:167) neither warns nor records it. `maxTokens: 14000` carries a 3–4k-word `proposal` inside a JSON string — ~9k output tokens before reasoning shares the budget — so a truncated reply makes an arm-1 replicate a base book the results table cannot distinguish. Fix: warn with an event, put `arcSource` on the chapter report, and drop `proposal` from this call: nothing reads it (grep) and it bloats `planningPackage`.

**A4. The persist guard blocks repair.** It bails on `isRecord(pkg.bookArc)`, but `planBookArc` returns undefined precisely when the stored arc does not parse; every retry re-architects, never persists, gets a different cut, and resume says `fresh`. Guard on `bookArcSchema.safeParse(existing).success`.

**A5. The thesis reaches the middle chapters anyway.** `stanceLinesFor` (composedChapter.ts:369) withholds it and the payload hands it back: `bookPayload` (:193) sends `premise` (composed-7's premise *is* the thesis), `promises` and `voiceGuide` in every compose call; `chapter.summary` (:297) says what the chapter proves; `planChapterForms` (chapterForms.ts:636) gives the form planner the thesis and positions, whose `subject`/`note` reach the writer; `job.believesSoFar` (bookArc.ts:82) is, after the turn, the answer in other words — the test passes only because the fake's text does not overlap. `readManuscript` (:889) gets thesis and positions but never the arc, so it cannot audit "answer stated before the resolution". Fixes: under an arc, middle chapters get `question` for `premise`, `job.does` for `summary`, no `promises`; the form planner gets `job` per chapter; any arc line sharing ≥4 content words with `arc.answer` is dropped (reuse chapterForms' `contentWords`/`overlap`); the read gets `answer`/`turn` and returns `answerStatedIn: number[]`. Add a test that renders a middle chapter's whole prompt and asserts that overlap on every line.

**A6. Opponent and turn reach nobody who needs them.** `arcChapterLines` shows the opponent only for `resolution` (:92–96); `KIND_RULES.argument` says "argue with the named opponent by name" to a writer never told the name; chapter 1, where the diagnosis places question and opponent, gets neither. `arc.turn` is parsed, stored and used by no prompt. Fix: opponent block (name, work, claim, whereRight) for chapter 1, every `argument` chapter and the resolution — `whereTheBookBreaks` only for the resolution; `turn.trouble` to `turn.chapterIndex`, `turn.repair` to the next chapter whose `does` starts "repair".

**A7. Seams before cuts is the wrong order.** Pass :509 rewrites seams, :512 runs the tail cuts. The read's notes quote the paragraph to delete from the pre-seam text; once a closing is replaced, `cutChapterTail` hands the model a tail whose flagged paragraph is gone, and it deletes nothing (`deletionOnlyResult` refuses) or deletes the paragraph the seams just bought. Cuts first, then seams over what survives; that also halves the re-describes.

**A8. A seams failure fails the book.** `rewriteSeams` (seams.ts:81) is a bare `generateJsonWithRetry`, awaited bare at :474 — the composed-17 class, after every chapter is composed. Catch non-stop errors, return no replacements, warn.

**A9. Seams cost is undercounted.** Each accepted replacement re-paginates and re-runs `describe-pages` sequentially (:483): up to 15 calls in series plus the cuts' 6, ~$0.04 and 3–5 min on luna against the diagnosis's $0.01. Run changed chapters under `Promise.all` (concurrency 3), and verify in the run log that `describe-pages` really routes to the judgment model.

**A10. Seam acceptance is Latin-only, and the two splits differ.** `properNouns` (`[A-Z][a-z]`) and `contentWords` (`[a-z]{4,}`, seams.ts:27–46) protect nothing in a Persian, Arabic or CJK book: acceptance degrades to the length band. Gate `SEAMS_TOGETHER` on the Latin-script set `chapterIntegrity.ts` has. `chapterSeams` filters empty paragraphs, `applySeam` does not, so a stored chapter ending in `\n\n` (rows joined at :221) gets its new closing appended after the old one.

**A11. The read's arc metrics are dropped.** `stopsDevelopingAt` and `swappable` return from `readManuscript` and the pass never logs or stores them; the pre-registered "stops developing ≥ 12" is unmeasurable. Log with an event and store on chapter 1's report.

**A12. Two arc-level gaps.** `KIND_RULES.document` says "quoting its own words" while `citation.rules` allows only `researchNotes`, which are snippets — in arm 1 that invites fabrication; say "quote only words that appear verbatim in researchNotes" and run the B4 guard now with the notes as corpus. And `applyBookArcPages` refuses a cut whose pages do not sum to the target, which models miss routinely; repair deterministically (scale, round on the largest chapters, clamp 3..14) rather than dropping the axis arm 1 exists to test.

Nits: a stray `seamsApplied?` inside `wordBudget`'s literal (composedChaptersState.ts:150); `--reuse-plan` copies `planningPackage` whole, so a replicate reused from an arm-1 project inherits its arc.

## B. Applying the rest of the paradigm

Order: A1/A2/A4/A7/A8 (half a day), then A5/A6/A11 in the same arm, ×3 — the current wiring measures neither length nor withholding. Then:

**B1. Primary-source acquisition** — `packages/core/src/adapters/primarySources/` (wikisource, gutendex, archive.org, Avalon/Fordham) behind one `PrimarySourceAdapter.search({query, language}) → [{url, title, licence, fetchText}]`, wrapped by the worker's logging decorator like every provider. Inputs per chapter: arc `cast`, `dispute`, title, research brief. Deterministic: licence by host allowlist, `stripHtml`/`normalizeExtractedText`, sha256, cache under `<BOOK_STORAGE_DIR>/<projectId>/dossier/`. Output 3–8 candidate documents per chapter. $0.

**B2. `extract-excerpts`** — `generation/dossier.ts`, one mechanical JSON call per chapter over the candidates (capped ~12k words) and the chapter's job; output `{docId, start, end, speaker, date, work}` as **offsets, never text**. Code slices the excerpt, so verbatim-ness is a property of the code; accept 40–250 words, sentence-bounded, non-overlapping, ≤6. Store as `ResearchSource` rows with a new `kind`, `offset`, `sha256`, `licence` (migration in `packages/db`) so the Sources back matter can cite them. ~$0.08/book.

**B3. Compose contract** — a `dossier` payload key; "quote only from dossier, verbatim, up to the whole excerpt, naming person and document; paraphrase everything else"; `citationContractFields` accepts dossier rows. +~$0.01/chapter.

**B4. Quote-provenance guard** — `generation/quoteProvenance.ts`, model-free: every quoted span ≥8 words, NFKC + whitespace + quote/dash folding, `[…]`/`...` as segment breaks, each segment a substring of a folded dossier `text`. A miss is a note to the deletion-only cut; if the cut refuses, the guard strips the quotation marks itself — a veto, so the 99% rule applies. Replay on the 34 books first (every quote should miss: the recall half), then hand-check 50 flagged spans on the first arm-2 book. $0; yields the quote-verbatim rate.

**B5. Arc-leak and arc-paste** — `promptLeak.ts` patterns ("this chapter", "the next chapter", "as we saw", "we will see") and ≥80% content-word overlap of a sentence with `job.leavesOpen`/`job.adds` → note to the cut. Heuristics: replay on the 34 books and count hits on shipped prose before shipping either. $0.

**B6. Kind compliance** — beside `chapterDegeneracy`: a `case` chapter whose first 1,000 words carry no year and no capitalised name, a `document` chapter with <2 dossier quotes → recompose once, never fail. Replay the `case` rule over the 34 books as if every chapter were one; a rule that fires on shipped history chapters is removed.

**B7. Opponent verification** — `opponent.sourceUrl` must be a project `ResearchSource.url`, or `opponent.work` must appear in a row's title/summary; otherwise the opponent leaves every prompt. $0.

**B8. The proposal, made to earn its cost** — split `architect-book` into a plain-text proposal call (prose lane, routable by purpose) and a mechanical JSON extraction of the arc *from* it, checked deterministically (every plan title once, pages sum). Then use it: split by chapter and hand each writer its own passage — the only reason to write one. The gate is the read's `answerStatedIn`/`stopsDevelopingAt` against the arc, consumed by ≤2 `recompose-chapter` calls. $0.02–0.04; build only if arm 2 moves engagement and `stopsDevelopingAt` stays under 10.

Measure arm 2 on engagement/pacing means, `stopsDevelopingAt` paired with a cross-family judge (it is a same-model self-report), quote-verbatim rate, and `provenance-probe.ts`.

## C. Disagreements

- "Deterministic, so 99% by construction" holds for the substring test only; the arc-leak phrases and kind compliance are the heuristics the 2026-09-02 replay removed, and need the replay.
- The brief's "Contested Claim" markers do not exist in the code (grep: nothing). The dispute comes from the architect, as wired, or from a parse nobody has written.
- "Chapters 2..n−1 never see the thesis" is a property of five payload fields, not one function (A5); it is unmeasured until the rendered-prompt test exists.
- Bundling A+B+C into one arm repeats the composed-9 confound the diagnosis criticises; ablate the line edit as its own arm.
- The architect at $0.02 assumes a purpose route that does not exist — `architect-book` is prose-lane, luna on balanced. Route it or re-price it.
