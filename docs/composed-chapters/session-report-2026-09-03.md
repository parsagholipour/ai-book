# Composed-chapters quality programme — session report (2026-09-02 → 2026-09-03)

Written for a fresh session. Everything here is reproducible from the repo; the detailed log is
`.scratch/composed-chapters/spec.md` (487 lines, chronological), the advisor opinions are
`opinion-fable-2.md`, `opinion-fable-3.md`, `opinion-fable-4.md`, the developer review is
`developer-review-arm1.md`, every applied patch is under `patches/`, every generated book is under
`runs/<label>/book.md` with its `trace.json` and `scorecard.txt`, and every blind verdict is under
`evals/<label>/{A,B,C}.json`.

## 1. The problem and the measuring instrument

The product generates full non-fiction books from a short brief (plan → chapters → pages →
PDF/EPUB). The readers' complaint was "AI slop": templated moves, symmetrical hedges, recap loops,
aphoristic closers. This session's goal was to raise the quality of the **balanced** tier (writer
`gpt-5.6-luna`, reasoning effort low) and, secondarily, the **fast** tier; the user excluded ultra.

**Instrument.** A rerun harness (`scripts/dev-rerun-book.ts run --source <projectId> --label <l>
--reuse-plan <projectId> --tier balanced --stance-positions <json>`) clones a finished project's
creation input, reuses one approved plan so every arm writes the *same book* (composed-7's plan,
"Aggression Through Time", 120 pages, 15 chapters, English, history), runs the real pipeline in the
Docker worker, and exports `book.md` + trace + a deterministic scorecard. A **blind panel** of three
independent Opus readers scores each book on ten criteria 1–10 (`blind-rubric.md`), and
`scripts/blind-panel-summary.ts` averages them. Three replicates per arm, so nine verdicts per arm.

**Noise, measured.** Identical configuration replicates spread 0.26–0.67 in overall; a three-reader
book mean is ±0.4; inter-reader agreement inside the 6.8–8.0 band is ~0. Only arm means over nine
readers are worth reading, and differences under ~0.3 are not signal. Engagement and pacing are the
two criteria that never moved in any configuration (6.0 / 5.7), and became the pre-registered
targets for the last arm (≥ 7.0 / ≥ 6.5).

## 2. What was built (all committed in `abde3af` unless marked *new*)

**The composed-chapters strategy** replaced the per-page pipeline for long non-picture books:
author stance → chapter form plan → one prose call per chapter (~4,000 words) → line edit →
deterministic paragraph merge and duplicate-sentence drop → paginate → describe pages → stage
PENDING rows → one whole-manuscript read → finalize. Files: `packages/core/src/generation/
composedChapter.ts`, `chapterForms.ts`, `authorStance.ts`, `chapterPagination.ts`,
`chapterIntegrity.ts`, `chapterJudge.ts`; worker `apps/worker/src/generation/composedChaptersPass.ts`
+ `composedChaptersState.ts`.

**Guards that ship:** `chapterDegeneracy` (a looping or foreign-script chapter is recomposed once,
then fails the job — the fast tier's qwen writer produced a 12k-word CJK loop that was published
before this); the read degrades to "skipped" on provider failure (a Luna-high run failed at 70% on
`max_output_tokens`); a provider content-filter refusal falls back to the fallback writer (Alibaba
`data_inspection_failed` failed a paid book); source-packet language ("research brief", "supplied
evidence", domains) is a prompt-leak pattern and the writers are told never to refer to their notes.

**Research routing fix (iteration 22):** every chapter is searched with its own brief and sources,
its own query ranked first, other chapters' briefs excluded; the brief is stored untitled. Before
this every chapter's payload carried 14.7k words of research (all 25 briefs outranked its own
sources): cost +37% for nothing.

**Token trims (iteration 23):** previous-chapter tail 1,200 → 300 words, earlier-chapter digests
capped at 60 words with a `told` registry, section counts assigned per chapter by walking a range
(asked to vary them, the planner returned 4–5 everywhere). Cost back to $0.33 a book.

**Caching, settled:** OpenAI requests carry `prompt_cache_key`; a probe proved the gateway behind
`gpt-5.6-luna` caches whole prompts only, never prefixes, so prompt-prefix ordering cannot save
tokens on this provider.

**Arm 1 of the paradigm shift (*new*, this session's last work):**
- `packages/core/src/schemas/bookArc.ts` + `generation/bookArc.ts`: one `architect-book` call
  produces a `BookArc` — the book's question, a verified named opponent, the answer, the turn (where
  the answer gets into trouble and which chapter repairs it), and per chapter a kind
  (case/argument/portrait/document/complication/method/resolution), a page count, a job
  (believesSoFar/does/adds/leavesOpen), a cast and, for argument chapters only, a dispute. The arc
  is persisted on `planningPackage.bookArc` with its page cut, re-cuts the chapters
  (`applyBookArcPages`, with `repairArcPages` when the model's pages do not sum), and gives each
  chapter its own prompt lines (`arcChapterLines`), withholding the answer from every chapter but
  the resolution and dropping any line that is the answer in other words.
- Middle chapters see only the stance's rhythm exemplar (no thesis, no positions), the question for
  the premise, no promises, the arc job for the summary; the form planner gets the question and the
  job; the read gets the arc and returns `answerStatedIn`, `stopsDevelopingAt`, `swappable`.
- `generation/seams.ts`: after the read and the cuts, one `rewrite-seams` call rewrites every
  chapter's first and last paragraph together; `acceptSeam` keeps a candidate only within 0.6–1.4×
  length that preserves every proper noun and number, closings must differ pairwise (Jaccard < 0.5);
  a failed call is a skipped revision, never a failed book.
- `cutChapterTail`: the read-driven deletion-only cut sees only the last ~600 words.
- Worker flags in `composedChaptersState.ts`: `BOOK_ARC`, `SEAMS_TOGETHER`, `READ_SECOND_EDITS`.
- `scripts/dev-set-quality.ts feature|model|restore|show`: quality revisions for A/B arms.
- Tests: `bookArc.test.ts`, `seams.test.ts`, a rendered-prompt test asserting a middle chapter's
  whole prompt contains none of answer/premise/promises/positions/plan summary, pass-test updates.

## 3. Results — every arm, same plan, nine readers unless noted

| arm | config | overall | engagement | pacing | $ / book | min |
|---|---|---|---|---|---|---|
| per-page pipeline (before) | old strategy | 6.03 | — | — | — | — |
| composed-6/7 (first chapter-scale) | luna low | 7.60 (n=1) | 6 | 5–6 | 0.45 | 25 |
| base ×3 (composed-10/11/12) | full prompt, 520 w/page | 7.31 | 6.0 | 5.7 | 0.36 | 20 |
| 480 w/page ×3 (19) | shorter | 7.32 | 6.0 | 5.7 | 0.33 | 20 |
| distribution rules out ×3 (20) | | 7.08 | | | | |
| prompt subtraction ×2 (21) | no bans/shape rules | 6.50 | | | | |
| stance position rotation (8/9) | one position per chapter | −1.0 vs 7 | | | | |
| luna effort medium / high | | 7.30 / 7.23 (n=1 each) | | | 0.39 / 0.49 | 24 / 48 |
| writer deepseek-v4-pro | | 7.67 (n=1), 69 printed pages, invented particulars | 7 | | 1.09 | 33 |
| writer gemini-3.7-flash medium | | 7.57 (n=1), 102 pages | 7 | | 1.10 | 13 |
| writer deepseek-v4-flash-vision-exp | | 6.57 (n=1) | | | 0.25 | 17 |
| fast tier qwen3.7-flash | | 2.83 (broken book; guard added) | | | 0.22 | 153 |
| iteration 22 ×3 (research routing) | | 7.44 | 6.0 | 5.7 | 0.48 | |
| iteration 23 ×3 (trims) — **committed baseline** | | 7.46 (six replicates 7.45) | 6.0 | 5.7 | 0.33 | 27 |
| composed-24 ×3 (partial arm 1) | arc lines + seams + cuts, editor off, judgment DeepSeek | 7.56 | 6.22 | 5.89 | 0.27 | 30 |
| composed-25 ×3 (corrected arm 1) | full arc, cut applied, thesis withheld, dispute on argument chapters only | **7.39** (7.00 / 7.63 / 7.53) | 6.22 | 5.56 | 0.30–0.34 | 30 |

**What every panel said, in every arm:** the same five moves — the "X establishes A; it does not
establish B" couplet, paired antithesis as the default cadence, one-sentence aphoristic paragraphs
as hinges, enumerated administrative chains ("first assessment, then collection…"), and chapter
tails that recap or restate the thesis. Thesis 9, clarity 9, structure 8, engagement 6, pacing 5–6
— a highly coherent, well-argued book that is dull to read. Composed-24 added a sixth: two named
scholars per chapter, each granted a part, "their disagreement improves the question" — manufactured
by the arc's per-chapter `dispute` line (now argument-chapters only).

## 4. What was learned (the conclusions the next session should not re-derive)

1. **The ceiling is not model intelligence.** Luna at low/medium/high effort scores the same; the
   two stronger writers score +0.2–0.3 at three times the cost and under-fill the pages, with
   DeepSeek inventing particulars. (Parsa's reading, confirmed.)
2. **Prompt-level levers are exhausted on this writer.** Bans, measured notes, stance positions,
   form plans, best-of-2, whole-paragraph cuts, position rotation, stripped editor: nothing the
   readers noticed, or worse. The prompt-subtraction control (6.50) shows the bans and shape rules
   are net positive, not the source of the tics. The couplet and the antithesis are Luna's house
   style under any prompt.
3. **Code defects were worth more than prompts.** Research routing (+0.13, −37% cost) and the
   token trims came from reading the payloads, not the prose.
4. **A prompt field present in every chapter is a template whatever it says** (the `dispute`
   lesson, and before it the page briefs' `endingPressure`).
5. **Deterministic checks that can veto the model must be ~99% accurate against shipped prose or
   be removed** (Parsa's rule; a reserved-beat gate was removed after a 1,200-page replay showed
   76/295 false rejections).
6. **The panel cannot rank inside the 6.8–8.0 band.** Nine readers per arm and a ±0.3 threshold;
   the per-criterion means (engagement, pacing) are the meaningful readouts.
7. **Never edit `packages/core`, `packages/db` or `apps/worker` while a book is generating**:
   nodemon restarts the Docker worker and the jobs recover but the run is contaminated. Validate a
   patch in a throwaway git worktree with symlinked `node_modules` (done this session) instead.

## 5. Diagnosis and the paradigm shift (opinion-fable-4)

The block is **book design**, not sentence craft: a uniform plan (fifteen 8-page chapters, each a
survey), the thesis restated in every chapter call, nothing quotable, no dispute the book
actually joins. Proposed: **proposal-first, dossier-backed** books.
- Arm 1 (built, measured as composed-25): the arc — question, opponent, answer, turn, per-chapter
  kind/job/pages; middle chapters never see the answer; seams rewritten together; deletion-only
  tail cuts; the paraphrase edit dropped.
- Arm 2 (designed, not built — see `developer-review-arm1.md` §B for the engineering plan): a
  **dossier** of public-domain primary-source excerpts per chapter (wikisource / gutendex /
  archive.org behind one `PrimarySourceAdapter`), an `extract-excerpts` call returning byte
  **offsets** (never text, so verbatim-ness is a property of code), stored as `ResearchSource`
  rows with a new kind, a compose contract that quotes only from the dossier, and a model-free
  **quote-provenance guard** (every quoted span ≥ 8 words must be a substring of a folded dossier
  text; a miss is a note to the cut; the only veto is stripping the quotation marks) — replayed on
  the 34 existing books before shipping. Then opponent verification (the opponent must be a real
  `ResearchSource`), kind-compliance recompose, and the proposal split into a prose call plus a
  mechanical extraction, used only if `stopsDevelopingAt` stays under 10.
- The developer disagreed with bundling the editor-off and judgment-model changes into arm 1 (a
  confound), noted that `architect-book` runs on the prose lane (Luna) rather than the cheap
  mechanical route, and that the arc-leak and kind-compliance heuristics need the same replay as
  every other deterministic rule.

## 6. Cost flags for Parsa

- Every "$0.27–0.36 per book" excludes Gemini grounding research (25 searches per book). Fable-4
  estimated it could be ~$0.5 more per book. Check the Gemini invoice.
- The balanced row now runs describe-pages and the other mechanical purposes on DeepSeek V4 Flash
  (quality revision 30) and the editor pass off (revision 29); both were part of arm 1 and are
  the cheapest balanced configuration so far. `dev-set-quality.ts restore 28` returns to Luna-only.

## 7. Code state at the end of the session

**Default pipeline = iteration 23** (the best replicated result: 7.46 over six books at base
cost). In `apps/worker/src/generation/composedChaptersState.ts`: `BOOK_ARC = false`,
`SEAMS_TOGETHER = false`, `READ_SECOND_EDITS = false`, `COMPOSE_CANDIDATES = 1`,
`SHAPE_NOTES_TO_EDITOR = true`, `MEASUREMENT_NOTES_TO_EDITOR = true`. Quality revision 31 (a copy
of 28): balanced writer `gpt-5.6-luna` effort low, judgment `gpt-5.6-luna` effort none, editor
pass on for every tier. `COMPOSE_PROMPT_MODE = "full"`, 520 words/page, `ROTATE_STANCE_POSITIONS
= false` in `packages/core/src/generation/composedChapter.ts`.

**Kept in the tree, tested, dormant:** `packages/core/src/schemas/bookArc.ts`,
`generation/bookArc.ts` (architect, page repair, chapter lines, answer-overlap filter),
`generation/seams.ts` (seams rewrite + deterministic acceptance, Latin-script gate),
`generation/manuscriptRead.ts` (the read, split out of `composedChapter.ts` for the 900-line
budget; the read now returns `answerStatedIn`), `cutChapterTail`, the worker's arc/seams wiring
(stance → arc → cut → setups; cut persisted with the plan; cuts before seams; seams failure =
skipped), `scripts/dev-set-quality.ts`. Turning the arm back on is the three flags plus
`dev-set-quality.ts feature chapterEditorPass balanced off` and `model balanced judgment deepseek
deepseek-v4-flash thinkingEnabled=false` if the cheap row is wanted.

**Verification:** `pnpm -F @book-maker/core exec vitest run` 2,582 passed; worker 1,773 passed;
core and worker typecheck clean; lint clean on every touched file. `pnpm check` still reports three
gates red that predate this work and belong to other sessions' files: apps/api typecheck
(`src/mobile/bookEditOperationRetries.ts`, `src/projectStatus.ts`), five size debts
(`pagesReview.test.ts`, `pageReview.ts`/`.test.ts`, `costs.ts`, `restructurePages.test.ts`) and two
drifted gotcha headlines. Committed as the commit after `abde3af` (see `git log -1`).

**Products of this session, all under `.scratch/composed-chapters/`:** `spec.md` (the log),
`opinion-fable-2/3/4.md`, `developer-review-arm1.md`, `patches/` (every applied script, including
`arm1-fix-core.py`, `arm1-fix-worker.py`, `split-read.py`, `repair-spread.py`), `runs/composed-1 …
composed-25c-arc2/` (34+ books with traces and scorecards), `evals/` (every verdict),
`stance-positions-flat.json`, `blind-rubric.md`, `review-run-a-b.md`, this report.

## 8. Open items, in order

1. **The writer restates the thesis whatever the prompt says.** The read's `answerStatedIn` is the
   first instrument that measures it (a same-model self-report; pair it with a cross-family judge).
   The lever left is in the *manuscript*, not the prompt: detect thesis restatements in middle
   chapters deterministically (content-word overlap with the answer, replayed on the 34 books for
   the 99% rule) and feed them to the deletion-only cut — or change the writer for the middle
   chapters only (DeepSeek V4 Pro / Gemini 3.7 Flash read better at +$0.7).
2. **Arm 2 — the dossier** (`developer-review-arm1.md` §B): primary-source excerpts by byte
   offset, a quote-provenance substring guard, `ResearchSource.kind = primary-excerpt`. The one
   piece of the paradigm that adds something the readers have asked for in every arm ("nothing
   quotable", "specificity thin for the length") and that no prompt can fake. Estimated +$0.10/book.
3. **The cheap tier row, measured alone** (editor off + mechanical purposes on DeepSeek V4 Flash on
   the 23 pipeline, ×3): −20% cost if it holds 7.4.
4. **Tail cuts need a floor if they ever ship:** 25c printed 102 pages for 120 paid.
5. **Seams acceptance is low** (1–6 of 30 paragraphs per book): the model returns most paragraphs
   unchanged; if seams are tried again, ask for the rewrite only where the deterministic
   pre-check finds a template (paired antithesis, recap), not everywhere.
6. **Cost reporting:** Gemini grounding research is not in any per-book figure; check the invoice.
7. **Fast tier (Quick Draft):** one book, 2.83, degenerate chapter caught by the guard; no
   iteration on it yet.
8. **Pre-existing red gates** listed above; the size debts and the two gotcha headlines are not this
   programme's files.

## 9. How to run the loop again

```bash
# a balanced replicate on composed-7's plan (three in parallel is fine)
pnpm exec tsx scripts/dev-rerun-book.ts run --source cmtjbz54o000w6rjyvzewwqj4 \
  --label <label> --reuse-plan cmtjlkn0z0000g8g08zbzxerc --tier balanced \
  --stance-positions .scratch/composed-chapters/stance-positions-flat.json
# run logs (host storage/ is permission-denied)
docker exec ai-book-maker-worker-1 sh -c 'cat /app/storage/books/<projectId>/runs/*.jsonl'
# blind panel: three Opus agents per book with blind-rubric.md → evals/<label>/{A,B,C}.json, then
pnpm exec tsx scripts/blind-panel-summary.ts .scratch/composed-chapters/evals/<label> ...
# quality-row A/B
pnpm exec tsx scripts/dev-set-quality.ts show | feature <id> <tier> on|off | model <tier> writer|judgment <provider> <model> [k=v] | restore <version>
```

## 10. The question for the next session

Twenty-five arms on one plan say the balanced writer's prose sits at 7.3–7.6 whatever it is told,
and that the book's *design* (arc, kinds, page variety, withheld thesis) did not move the two
criteria that are stuck — engagement 6, pacing 5–6 — because the writer restates the thesis and
performs the same five moves regardless. Given that: (a) is there a way to get engagement and
pacing above 7 at under ~$0.50 a book on this writer, and what would you build first — the
manuscript-level thesis cut, the dossier, a different writer for the middle chapters, or something
none of the four advisors proposed; and (b) which of the deterministic instruments here (the
scorecard, `answerStatedIn`, the panel) would you trust to prove it, given a ±0.4 noise band?
