# Stage-replay and blind-pair evals

Per-unit evals over frozen stage inputs (harness plan §F0 and §3, `.scratch/harness-redesign-2026-10-15/plan.md`):
extract logged provider calls as fixtures → replay them under named variants → deterministic checks →
blind position-swapped pairs → judges → one Markdown report. Whole books are smoke tests only.

```bash
pnpm exec tsx scripts/eval/eval.ts <command> [options]     # from the repo root, on the host
```

`extract`, `replay`, `variants` and `judge-api` run inside the worker container through `docker exec`, because the
run logs (MinIO), the database and the provider keys live there. The repo is bind-mounted at `/app`, so both sides
read and write the same data directory. Everything else runs on the host.

**Data** lives in `.scratch/eval-data/` (gitignored with the rest of `.scratch/`; override with `--data <dir>` or
`EVAL_DATA_DIR`). Nothing bulky is committed.

```
fixtures/<purpose>.jsonl      frozen inputs, one call per line
fixtures/manuscripts.jsonl    H1: pre-read Balanced manuscripts and their cuts
fixtures/index.json           counts per purpose × stratum, extraction parameters
plans/<projectId>.json        PlanVersion.planningPackage + inputSnapshot of every contributing book
results/<eval>/<variant>/<fixtureId>__s<n>.json   one replay
pairs/<set>/folders/<pair>-o1|o2/                 what a judge reads
pairs/<set>/verdicts/<judge>/<folder>.json        verdicts
pairs/_keys/<set>.json                            which variant is A — never shown to a judge
reports/<eval>.md
```

The projects partition is nearly full and MinIO stops accepting writes near 1% free. The extractor refuses to
start under 1.5 GB free; check `df -h .` before large runs. The whole data set is ~45 MB.

## End to end (the demo that was run on 2026-10-15)

```bash
E=scripts/eval/eval.ts
pnpm exec tsx $E extract                       # ~1 min; read-only on DB and MinIO
pnpm exec tsx $E fixtures                      # counts per purpose and stratum
pnpm exec tsx $E replay --eval h2-demo --purpose edit-chapter --variants baseline,no-extend \
  --tier fast,balanced --meta kind=line-edit --limit 5 --concurrency 5 --max-usd 0.3
pnpm exec tsx $E pairs --eval h2-demo --reference baseline --candidate no-extend --set h2-demo.no-extend-vs-baseline
pnpm exec tsx $E judge-api --set h2-demo.no-extend-vs-baseline          # gpt-6-sol, medium (secondary judge)
pnpm exec tsx $E manifest --set h2-demo.no-extend-vs-baseline --judge opus   # reader prompts for Opus subagents
#   … dispatch one Opus subagent per prompt in pairs/<set>/dispatch-opus.json (see "Judges") …
pnpm exec tsx $E ingest --set h2-demo.no-extend-vs-baseline --judge opus
pnpm exec tsx $E report --eval h2-demo --pairs h2-demo.no-extend-vs-baseline:opus,h2-demo.no-extend-vs-baseline:sol
```

## Fixtures

`extract [--since 2026-09-15] [--quota edit-chapter=80,…] [--max-books 400] [--projects id,id] [--dry-run]`

Candidate books come from the database (tier from `mediaSettings.modelTier`, writing mode from the current plan,
length bucket short ≤30 / medium ≤80 / long pages); they are visited in a stratified round-robin over
tier × writing mode × length, newest first, and only the run logs holding a wanted purpose are read (MinIO first,
the legacy `/app/storage/books/<id>/runs/` files second). Within a book, picks are spread across chapters.

Each line of `fixtures/<purpose>.jsonl`:
`{fixtureId, projectId, tier, category, writingMode, lane, targetPages, lengthBucket, language, purpose, jobName, op,
callId, loggedAt, chapterIndex, model, request:{temperature,maxTokens}, messages, query, response:{text,data?,sources?,grounding?},
usage:{promptTokens,outputTokens,reasoningTokens,cacheHitTokens}, durationMs, attempts, meta, context}`.
`messages` are verbatim (the content-safety prefix included). `payload` (the parsed last user message) and a JSON
reply's parsed data are **derived on load** (`loadFixtures` → `fixture.payload`, `fixture.recordedData`) rather than
stored twice. `context` holds what a pair judge needs: book title, brief, chapter title, the previous chapter's last
paragraph and the next chapter's first.

`meta` per purpose: edit-chapter `kind` (line-edit / final-line-edit / factual-correction / reader-notes), `extend`
(the editor was told to extend), `draftWords`, `editedWords`, `acceptanceVerdict` (Balanced: the logged whole-chapter
verdict); review-chapter-edit-acceptance `operation`, `verdict`; read-manuscript `readKind` (manuscript-read /
coverage / other), `chapters`, `words`; cut-chapter `chapterIndex`, `draftWords`, `cutWords`, `acceptanceVerdict`.

Extracted 2026-10-15 (books since 2026-09-15; 183 books read, 109 plans, 34 MB of fixtures + 9 MB of plans). The
round-robin is per purpose: on the first pass a purpose takes at most quota ÷ (strata holding its calls) from any one
stratum, and a stratum keeps drawing books until one contributes (books whose logs were lost in the 2026-10-01 MinIO
disk incident yield nothing); a second, uncapped pass tops quotas up.

| purpose | n | by tier | notes |
|---|---|---|---|
| compose-chapter | 40 | balanced 23, fast 14, premium/ultra 3 | |
| edit-chapter | 60 | balanced 32, fast 21, premium/ultra 7 | all line edits. fast + balanced by mode: analytical-history 25, narrative 14, instructional 10, children's 4. Balanced logged whole-chapter verdicts: 17 pass, 10 reject, 5 none |
| review-chapter-edit-acceptance | 91 | balanced 81 | quota 40 + every cut acceptance of the manuscript books |
| read-manuscript | 70 | balanced 42, fast 22 | 60 post-loop reads (`jobName` generate-book) + 10 compile reads |
| cut-chapter | 97 | balanced 88 | every cut of the manuscript books (58 accepted) |
| extract-chapter-facts | 40 | balanced 24, fast 16 | |
| final-book-qa | 30 | balanced 15, fast 11, premium 4 | |
| patch-page | 30 | balanced 16, fast 14 | compile repairs and chat edits |
| chapter-research / case-source-search | 30 / 30 | balanced 16, fast 14 each | grounded searches (query + answer + sources) |
| extract-excerpts | 30 | balanced 14, fast 12 | |

`fixtures/manuscripts.jsonl` (H1): 60 pre-read manuscripts — **35 Balanced** (analytical-history 16, instructional
10, narrative 7, children's 2), 22 Quick Draft (older books, from before the read pass left Quick Draft), 3
premium/ultra — each `{manuscriptId (= the read-manuscript fixtureId), projectId, tier, writingMode, chapters, words,
cuts:[{chapterIndex, cutFixtureId, acceptanceFixtureId, verdict}]}`. The manuscript itself is `payload.chapters[].text`
of that read fixture; its plan is `plans/<projectId>.json`. For H2, the drafts are `payload.draft` of the edit-chapter
fixtures (`--meta kind=line-edit`; the Balanced ones carry `meta.acceptanceVerdict`).

`fixtures/edit-acceptance.jsonl` (H2/E2): the logged whole-chapter acceptance call of each Balanced edit fixture, written by
`docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/edit-acceptances.ts [--ids …]`
from `meta.acceptanceCallId`. Check the link by exact text before trusting a verdict: the review's `candidate` must equal the
fixture's recorded edit (it did for all 20 E2 fixtures; the extractor's head-40-words match can pick a cut's review instead).

Filters for `replay` (and `loadFixtures`): `--tier fast,balanced`, `--mode narrative,instructional`, `--length short`,
`--job generate-book`, `--meta kind=line-edit`, `--ids a,b`, `--limit N` (a stratified round-robin that alternates tiers).
Test Quick Draft (`fast`) and Balanced only unless the plan says otherwise.

## Replay

`replay --eval <name> --purpose <purpose> --variants <spec,spec> [--samples N] [--concurrency N] [--max-usd X] [--force]`

Each call is built from the tier's **live** route: the latest stored quality revision decides model and effort per
purpose, exactly as for a book (`createLiveGenerationTextModel(...).bindForCall(purpose)`), and the variant's
override is applied on top. Calls go straight to the provider adapter: no run log, no `ProviderCallLog` row, no
cross-family fallback (it would confound an arm), up to three attempts on a recoverable network error. Results are
resumable (an existing result file is skipped unless `--force`); `--max-usd` (default 1) stops new calls once this
invocation's provider $ passes it. Each result records output, the post-processed `finalText` for chapter purposes
(`normalizeChapterMarkdown` as the product stages it), tokens in/out/reasoning, latency, $ at the recorded rate card
(core `calculateTextGenerationCost`), the model and effort used, and the check results.

**Variant specs** are `<base>[+modifier…]` (`pnpm exec tsx $E variants` lists them):

| base | purposes | what it does |
|---|---|---|
| `recorded` | any | no call: the reply the book got, with its logged latency, tokens and model (free reference arm) |
| `baseline` | any | the logged request replayed unchanged on today's live route; search purposes run a grounded search |
| `no-edit` | edit-chapter | H2 arm (a): the draft staged as composed (free) |
| `no-extend` | edit-chapter | H2 item 4: the length instruction is always "keep within ten percent" |
| `patch-mode` | edit-chapter | H2 arm (d): find/replace patches, maxTokens 3,000, ≤20 patches, finds ≤2 sentences / 60 words, applied one by one with core `applyPagePatches` |
| `today` | edit-chapter | E2 (b): sample 0 the recorded edit, sample 1 `baseline`'s sample 1; then `editChapter`'s guards and, on Balanced, the whole-chapter acceptance (recorded verdict / replayed with today's prompt, from `fixtures/edit-acceptance.jsonl`). Run `baseline` first |
| `hunk-judged` | edit-chapter | E2 (d): `today`'s edit split into hunks (`variants/chapterEditHunks.ts`), one per-hunk acceptance call at medium (`variants/hunkAcceptance.ts`), passing hunks merged, moves closed over, duplicate and length guards |
| `hunk-judged-linked` | edit-chapter | `hunk-judged`'s stored verdicts re-merged under the current merge rules; no call |
| `hunk-protected` | edit-chapter | E2 (d′): `today`'s edit with hunks that change a number, name or negation reverted unless the fact ledger licenses them; no call |

Modifiers: `+effort=none|low|medium|high`, `+model=openai:gpt-6-sol`, `+tier=fast`, `+temp=0.3` — e.g.
`baseline+effort=none`. One axis per eval.

**Adding a variant** — a `Variant` (`variants/types.ts`) is `run(context) → {output, finalText?, data?, calls}`. The
context gives `fixture` (with `payload`), `call({purpose, messages, json?, maxTokens?, temperature?, route?})` and
`search(query)`, plus `sample` and `peer(label)` (another arm's stored result for the same fixture and sample, for arms built on
another arm's output). Use `replayLogged(context, transform)` from `variants/common.ts` for a message transform, or build
new messages with product builders imported read-only (`import { … } from "../../../packages/core/src/index.ts"`), or
make several calls (edit then acceptance). Register it in `BASES` in `variants/index.ts`; put purpose-specific arms in
their own file like `variants/editChapter.ts`.

**Hook points, not product flags.** Product code is imported read-only and never edited for an eval. Where an arm
needs a code path the logged messages cannot express:
- Prompt changes inside one builder: transform the system/user messages (`rewriteSystem`), as `no-extend` does.
- A new algorithm (H2 hunk verdicts, H1 deletion patches, H3 merged search): the fix lands as a new core module
  (`chapterEditHunks.ts`, …); the variant imports it by path and calls it on `fixture.payload` and the replayed reply.
  Until it lands, the variant can carry a prototype of the function in `variants/`.
- Existing product options (`editChapter`'s `allowExtension: false`, gates in the quality revision) are reached by
  rebuilding the options from `plans/<projectId>.json` + the payload and calling the product function directly.
- The product's zod schemas are module-private, so JSON replies are validated against the **recorded reply's shape**
  (`schema_shape`). Exporting the schemas (`chapterEditAcceptance.ts` `reviewSchema`, `manuscriptRead.ts`
  `manuscriptReadSchema`) would let checks use them; that is a one-line product change left to the fixes.

## Deterministic checks

`lib/checks.ts` (pure, host and container) and `container/purposeChecks.ts` (which checks run per purpose; uses core
`chapterDegeneracy` and `applyPagePatches`). Gates report a pass rate; measures report a mean.

| purpose | checks |
|---|---|
| all text purposes | `non_empty`, `not_truncated` (hit maxTokens or ended mid-sentence), `no_runaway` (repeated sentence/8-gram, blank-line run), `no_prompt_leaks` |
| all JSON purposes | `json_valid`, `schema_shape` (keys and value types of the recorded reply), `not_truncated` |
| compose-chapter | `length_in_budget` (payload `wordBudget`), `not_degenerate`, `quotes_verified` (quotations ≥5 words found in dossier/episodes/research notes) |
| edit-chapter | `length_in_budget`, `length_ratio` (≥0.62 of the draft, the product's refusal line), `not_degenerate`, `no_new_names_or_numbers` (number or proper-noun types the draft never contained), `fences_identical`, `tables_survive`, `figures_survive`, `words_kept_share`, `no_new_unsourced_quotes`, `product_keeps_edit` |
| cut-chapter | `deletion_only`, `length_ratio`, `above_floor` (`cutConstraints.minimumWords`), `words_removed` |
| review-chapter-edit-acceptance | `verdict_pass`, `agrees_with_recorded` |
| read-manuscript | `notes`, `chapters_flagged`, `note_quotes_verified` (quoted spans in notes found in the chapters) |
| extract-chapter-facts | `subjects`, `facts` |
| final-book-qa | `issues`, `approved` |
| patch-page | `patches_apply` against `originalPages` |
| extract-excerpts | `excerpts`, `excerpts_anchored` (first/last words found in their window) |
| chapter-research, case-source-search | `has_sources`, `grounded`, `brief_chars` |

Library helpers for manuscript-level evals (H1): `crossChapterDuplicateGrams(chapters, 8)`, `deletionOnly`,
`quotesVerified`/`verifyQuote`, `protectedTokenDelta`, `changeStats`.

## Pairs and judges

`pairs --eval <e> --reference <variant> --candidate <variant> [--set <name>] [--artifact chapter|excerpt|research] [--sample 0] [--limit N] [--tier fast] [--mode narrative,children-narrative] [--ids a,b]`
builds both orders of every fixture both variants answered. Texts identical after whitespace folding are a tie by
construction and are not sent to judges. Rubrics (`rubrics/`): `chapter.md` (overall + engagement, clarity,
repetition, hedging, fidelity), `excerpt.md` (whole-book excerpt), `research-brief.md`; every folder also carries
`instructions.md` (`rubrics/judge-instructions.md`: read only this folder, ignore order and length, "[Figure: …]" is a
chart, tie only when no reader-visible difference).

**Aggregation** (`aggregate --sets set:judge[+judge…]`, also in `report`): per order the readers' picks are mapped
to variants and combined by majority (no majority → tie); a pair is a win only when both orders agree, otherwise a
tie. Reported: W/T/L, decided-pair win share with Wilson 95% CI, win+tie share with its CI (the plan's gates read
this), two-sided exact sign test.

**Opus readers (primary).** `manifest --set <s> --judge opus [--batch 4] [--print]` writes
`pairs/<s>/dispatch-opus.json`: one prompt per batch of folders, never both orders of a pair in one batch. Give each
prompt to a fresh general-purpose subagent on Opus (`Agent` tool, `model: "opus"`); each reads only its folders and
writes `pairs/<s>/verdicts/opus/<folder>.json`. For three readers per pair-order, dispatch the manifest three times
with `--judge opus-1`, `opus-2`, `opus-3` and aggregate `set:opus-1+opus-2+opus-3`. An agent without the Agent tool
hands `dispatch-opus.json` to its coordinator, then runs `ingest --set <s> --judge opus` (validates every verdict file
and lists missing folders).

**API judge (secondary).** `judge-api --set <s> [--judge sol] [--model openai:gpt-6-sol] [--effort medium] [--max-usd 1]`
reads the same folders and instructions. ~$0.02 per pair-order on edit-chapter pairs, ~$0.026 on 3,500-word chapters.
See calibration before trusting it.

## Calibration (2026-10-15)

`calibrate build` makes the `calibration` set (17 pairs, `lib/calibration.ts`); `calibrate score --judges opus,sol`
writes `reports/calibration-score.md`. Known winners: 9 *decided* pairs from the 2026-09-03/04 same-sitting Opus
pairwise panels (`docs/composed-chapters/evals/pairwise-*`, both orders and both questions agreeing), 1 *tie* (orders
disagreed), 4 *clear* pairs from the 2026-09-05 same-sitting Opus panel (development book 5.90 vs rung-5 books ~7.8,
every reader), 3 *synthetic* pairs (a rung-5 chapter vs a copy with planted production notes, a duplicated passage +
truncated ending, or padding hedges). A judge is accepted only if it never prefers the known loser on a clear or
synthetic pair.

Results (one reader per pair-order, both orders required to agree; `reports/calibration-score.md`):

| judge | decided (9): agree / tie / wrong | clear (4) | synthetic (3) | historical tie (1) | tie rate on decided+clear | verdict |
|---|---|---|---|---|---|---|
| Opus subagents | 6 / 1 / 2 | 4 / 0 / 0 | 3 / 0 / 0 | decided a side | 1 of 13 | **accepted** |
| gpt-6-sol, medium | 3 / 1 / 5 | 3 / 0 / **1** (c12) | 3 / 0 / 0 | decided a side | 1 of 13 | **not accepted** |

- **Opus is the judge of record.** It never preferred a known loser on a clear or planted-defect pair. Its two misses
  on decided pairs (c01, c07) were low-confidence chapter pairs from inside the band where the original panels' own
  readers disagreed (README of `docs/composed-chapters`: "inside the 6.8–8.0 band the readers do not agree on
  rank"). Use three readers per pair-order for decisions, as the plan says. One reader was enough for calibration.
- **gpt-6-sol is a defect screen, not a taste judge.** It caught every planted defect, but it was consistently
  wrong in both orders on 5 of 9 decided pairs. It preferred the drier, more hedged version (the baseline over
  rung 5's told scenes, c01–c02) and the development-pipeline chapter that every Opus reader ranked last (c12). Use
  it unattended for smoke-checking that an arm did not break something, and for agreement statistics beside Opus.
  Do not use it as the deciding vote on prose quality. Combining it with Opus (`opus+sol`) only turns decisions
  into ties.
- Cost of this calibration: sol $0.89 for 34 pair-orders; Opus 10 subagents (Claude usage).

Demo (`reports/h2-demo.md`, 5 edit-chapter line edits, fast + balanced, 1 sample): `no-extend` vs `baseline` was
4/0/1 by Opus and 4/1/0 by sol. That is n = 5, so the 95% CI is 38–96%: a working pipeline, not a result.

## Checking the toolkit

```bash
pnpm exec oxlint scripts/eval                                  # part of pnpm check
pnpm exec tsc -p scripts/eval/tsconfig.json                    # host code (seconds)
pnpm exec tsc -p scripts/eval/tsconfig.container.json          # + container/variants against product code (slow)
node --import tsx --test scripts/eval/lib/eval.test.ts         # unit tests of the pure library
```

`scripts/` belongs to no workspace, so `pnpm check` lints these files but neither typechecks nor tests them; run the
three lines above after changing the toolkit.

## Gotchas

- **Container paths.** Host paths do not exist in the container; container scripts resolve everything from the data
  dir (`/app/.scratch/eval-data`). The host CLI translates `--data` for you.
- **File ownership.** Container scripts set `umask 0`, so the root-owned files they write stay editable on the host.
- **Worker restarts.** Other sessions saving under `apps/worker/src` or `packages/*/src` restart the dev worker; a
  replay importing `/app` at that moment can see a half-applied tree. Rerun it (results are resumable).
- **Grounded searches** (`baseline` on chapter-research / case-source-search) draw on Google's shared 1,500/day
  free allowance and are not counted by the product's allowance counter. Spread large H3 runs over days.
- **Same sitting.** Judge every arm of a comparison in one sitting; panels drift ~0.6 between days.
