# Composed-chapters quality research, 2 to 6 September 2026

**Latest code change (6 September):** removed automatic heuristic prose edits and lexical plan enforcement; the existing Luna editor judges passages in context. This change has no new whole-book score. See [the removal, regression evidence and source-first proposal](heuristic-removal-2026-09-06.md). The measured configurations below are historical.

The complete record of the programme that took the balanced tier's non-fiction books from a blind-panel mean of
7.46 to the configuration shipped at commit `2984fe4`: what was built, what was measured, what moved, what did
not, and why the panel mean did not cross 8. Every document, rubric, verdict, patch and generated book from the
three sessions is in this folder; the generated books under `runs/` are gitignored (61 MB) and live only on the
machine that ran them.

## Implementation after the ladder

A narrative of the 5–6 September attempt to cross 8 — diagnosis, the disabled development stages, the regression, the Chapters 6–7 cut, and whole-book candidates 1–4 — is in [session-summary-2026-09-06.md](session-summary-2026-09-06.md).

**6 September, continued:** the plan parser was fixed and two fresh-plan books were read by three Opus readers each beside rung 5 and candidate 3 in one sitting: candidate 5 **6.87**, candidate 6 (the plan contract, `packages/core/src/generation/planContract.ts`) **7.00**, rung 5 **7.63**. The contract removed the distinction-shaped chapter assignments and the cross-chapter case revisits the readers had named; the remaining hedge is the writer's register and the engagement gap is the strict reconstruction rule with thin dossiers. Later the same day, back on rung 5's composition path with the plan contract, read cuts and a broadened antithesis rewrite: candidate 7b **7.40**, candidate 8 (the readers' prescription applied deterministically) **7.50** with slop resistance 7.0, candidate 9 (told scenes without excerpts) **7.07** and reverted. See [experiments/2026-09-06-fresh-plan/report.md](experiments/2026-09-06-fresh-plan/report.md).

**Current decision:** the three development additions remain disabled in compiled defaults and live revision 49 after a completed-book regression. A fresh Sol reader scored that book **6.5**, with pacing and slop resistance **4**. See the [parent assessment and rollback decision](experiments/2026-09-05-fixes/regression-decision.md).

**Sequential whole-book work, resumed at the user's request:** generate one book at a time, stop when one averages at least 8.0 across three fresh Sol readers. Candidate 1, which connected case assignments across planners and writers, scored **7.1**. Candidate 2 added chapter-specific questions and stricter nonfiction reconstruction, but scored **6.8667**; its readers still found the same three-case architecture and repeated conclusions. Candidate 3 removed mandatory equal case treatment and section-form quotas, but scored **7.0333**. Candidate 4 now tests a fresh plan from the original user brief instead of reusing the old uniform outline. Writing/editing remains **Luna only**, with Fable 5.1 implementing bounded changes and Sol assessing. No 8+ whole-book result has been established. See the [complete experiment record](experiments/2026-09-05-whole-book/report.md).

**Bounded chapter repair:** two fresh Sol readers preferred a parent-specified compression of Chapters 6–7, averaging **8.2 versus 6.6** in an order-swapped blind comparison. They also identified lost explanatory depth; three short passages were restored and accepted in a nonblind follow-up. The final excerpt is 63.2% shorter. These are excerpt results, not a new whole-book or pipeline score; the experimental gates remain disabled. See the [complete result and revised text](experiments/2026-09-05-chapter-repair/report.md).

**Automated follow-up:** independent edit groups now survive invalid neighbors, extractive cuts need no prose rewrite, and the worker no longer polishes unchanged chapters or automatically refills cuts. Four Luna planning replays cost $0.0847. Sol preferred a weak-book diagnostic cut **7.6 versus 6.75**, but it lost details and failed the actual length floor; on an older reference, Sol preferred the original **8.4 versus 8.3**. A narrower cross-chapter-only version left the reference unchanged and rejected the weak-book cut on length. This remains disabled and does not establish an 8+ book. See the [full experiment and limitations](experiments/2026-09-05-automated-repair/report.md).

[Research-led planning, case evidence, and developmental editing](development-pipeline-2026-09-05.md)
were implemented on 5 September. The [live benchmark and blind Sol assessment](experiments/2026-09-05-sol/report.md)
found that both first live attempts failed evidence readiness before drafting; the
[follow-up fixes](experiments/2026-09-05-fixes/protocol.md) (implementations 1–6b, twelve launches on three projects)
were what it took to complete one book.

**Measured on the Opus instrument, same sitting** ([report](experiments/2026-09-05-opus/report.md)): the first
completed development-pipeline book reads **5.90** (readers 5.9 / 5.7 / 6.1) against **7.82** for the three rung-5
books and **7.73** for composed-7, every book read by three fresh Opus readers today. Pacing 3.0 (rung 5: 6.6), depth
5.0 (8.0), engagement 4.0 (7.0). The readers name the evidence review-repair loop performing the concede-and-withhold
couplet in nearly every paragraph (24.9 couplets per 1,000 sentences against 5.7–11.5 at rung 5), the source packet's
own language leaking into the prose, and a synthesis chapter that re-narrates its prerequisite chapter. The two further
replicates were stopped by a user at 08:19 UTC with their pages staged. Recommendation there: do not enable `bookDevelopment`,
`caseEvidence` or `developmentalEdit`; keep the evidence packets as writer material and drop the post-edit repair loop.

## The shipped state

Commit `2984fe4` with quality revision 37 on the balanced tier — the **rung 5** configuration:

| flag | on | what it does |
|---|---|---|
| `creativeContract` | yes | the writer draws on its own knowledge for people, dates, documents and scenes; quotation marks stay a promise |
| `materialFirst` | yes | episodes are planned per chapter, a public-domain dossier is fetched and sliced by anchors, an opening scene is told by its own call, the chapter is composed around its episodes, a substring quote guard checks every quotation |
| `coupletRewrite` | yes | a deterministic detector finds the "X was not A. It was B." pair and one call on the writer rewrites only those, accepted by code |
| `chapterApparatus` | yes | an attributed epigraph from the dossier and no two consecutive chapters opening on a told scene |

Every model call stays on the tier's writer (gpt-5.6-luna, low effort). Cost $0.40–0.43 a book against $0.33
before. The one later commit kept is the degeneracy guard's foreign-script ceiling (`44832c2`): the guard failed
two paid books on one quoted Arabic word.

Measured, nine blind Opus readers on the same plan: **7.74 overall, engagement 7.0, voice 8.22, craft 8.22**,
against the baseline's 7.46 / 6.0 / 7.7 / 7.9. Pairwise on fixed chapters against the baseline, position-swapped:
eight votes of eight. Re-read in a later sitting beside the old book: 7.52–7.58 against the old book's 7.07.

## How to read the numbers

- The instrument is three independent Opus readers per book on the ten-criterion rubric in
  `rubrics/blind-rubric.md`; "overall" is the equal-weight mean; a rung is three replicate books, nine verdicts.
- Reader noise: replicates of one configuration spread up to 0.8; a three-reader book mean is ±0.4; inside the
  6.8–8.0 band the readers do not agree on rank.
- **The panel drifts between sittings by about 0.6**: the same book (composed-7) read 7.73 on 2 September and 7.07
  on 4 September under the same rubric and model. Compare rungs within a sitting; treat cross-day differences under
  0.6 as unknown. The tables below mark the sittings.
- The noise-free readouts are the counts (`scripts/ladder-counts.ts`, `scripts/structural-scorecard.ts`), the
  pairwise position-swapped comparisons on fixed chapters, and the per-criterion means — not the ten-criterion mean.

## The ladder

Same plan for every arm (composed-7's, project `cmtjlkn0z0000g8g08zbzxerc`: "Aggression Through Time", 120 pages,
15 chapters, English history), balanced tier, three replicates a rung.

### Sitting 1 — 2 September (the earlier session; `session-report-2026-09-03.md`)
Twenty-five arms of prompt, model, effort and design changes on the composed-chapters pipeline. Plateau at 7.46
(six replicates 7.45); engagement 6.0 and pacing 5.7 never moved. Conclusion: the ceiling was not model
intelligence and prompt levers were exhausted.

### Sitting 2 — 3 September, rungs 1 to 5 (`ladder-report-2026-09-03.md`)

| rung | change (cumulative) | overall | engagement | pacing | slop | couplets /1000 | proper nouns /1k | quotes | $ |
|---|---|---|---|---|---|---|---|---|---|
| baseline | iteration-23 pipeline | 7.46 | 6.0 | 5.7 | 6.6 | 34–44 | 9–12 | 2 | 0.33 |
| 1 (closed) | line edit on a second model family | 7.17 | 6.0 | 6.0 | 6.3 | 10 | 12–21 | 2–14 | 0.55 |
| 2 | creative contract | 7.76 | 6.67 | 6.0 | 6.78 | 31–34 | 16–22 | 2 | 0.35 |
| 3 | + material-first | 7.62 | **7.22** | 6.11 | 6.11 | 27–34 | 19–22 | 8–23 | 0.40 |
| 4 | + couplet rewrite | 7.51 | 6.78 | 5.89 | 6.0 | **5–8** | 20–21 | 13–30 | 0.42 |
| 5 | + epigraph, rotated scene openings | **7.74** | 7.0 | 6.11 | 6.44 | 6–11 | 18–22 | 19–26 | 0.42 |

Rung 1 was rejected by Parsa mid-run (every editing call stays on the writer) and reverted; its result confirmed
that halving the cadence does not move engagement. Rung 2 was the first arm in twenty-eight to move engagement.
Rung 3 crossed 7 on engagement for the first time on this writer, and its scene in every chapter became a
template. Rung 4 removed the couplet from the page and the panel did not notice. Rung 5 is the composite.

### Sitting 3 — 3 September, rungs 6 and 7 (commits on branch `quality-ladder-rounds-2-3`)

| rung | change | overall | engagement | pacing | slop |
|---|---|---|---|---|---|
| 6 | assigned chapter exits, the scene form capped, a deterministic repetition cut | 7.58 | 6.56 | 5.89 | **7.0** |
| 7 | the amendments of `plans/plan-5c93566-amendments.md` | 7.32 | 6.33 | 5.78 | 6.33 |

The exits were correct on every count (landing not pasted, epigraph and exit two documents) and the readers named
the material exit as a bibliographic stub. The scene cap took the opening scenes from 7–8 a book to 2–4 and
engagement went with them. The repetition cut made zero calls: the readers' repeated closers are paraphrase.

### Sitting 4 — 4 September, ladder-8 (`opinions/opinion-fable-6.md`'s experiment)

| arm | change | overall | engagement | pacing | slop |
|---|---|---|---|---|---|
| A | rung-5 flags, exits off, the line editor's extension off | 7.52 | 6.78 | 6.0 | 6.56 |
| B | A + told closing sections on five non-scene chapters | 7.58 | 6.44 | 6.0 | 6.33 |
| old book | composed-7, re-read in this sitting | 7.07 | 6.0 | 6.0 | 6.33 |

Arm B failed its pre-registered pass (engagement ≥ 7.0, slop ≥ 6.8): the told sections read as "bolted to the end".
Arm A found that with the extension off the books print 96–126 pages for 120 paid, because the writer's 87%
delivery is corrected only on told chapters. Both arms beat the old book in the same sitting by about 0.5.

## What was learned

1. **Material moves engagement; cadence does not.** Two rungs halved the couplet and neither moved the panel; two
   rungs added particulars and engagement went 6.0 → 6.67 → 7.22. The engagement sevens of every writer were
   bought with particulars, honestly or dishonestly obtained; the creative contract and the dossier obtain them.
2. **A prompt field present in every chapter is a template whatever it says.** The scene call on every chapter,
   the `dispute` line, the exits, the told closings: each was named by the readers as the new pattern. Assign
   content to some chapters, distributed, never to all.
3. **Every rule about shape shown to the writer is performed on schedule.** Content assignments moved the panel;
   shape rules (last-sentence rules, landing forms, the exit line) were performed and named.
4. **Pacing is a book-scale criterion and never moved** (5.7 → 6.1; no reader ever gave it above 7 for any writer).
   The readers' pacing complaints are cross-chapter: the same case narrated in two chapters, the thesis restated
   with the nouns swapped. The plan overlaps by design and no chapter-level lever reaches it.
5. **Criterion 10 saturates.** Every verdict lists exactly five patterns; engagement plus slop resistance sat at
   13.3–13.6 from rung 2 onward, trading one for one along the scene count.
6. **Why not 8.** Seven criteria sit at 7.8–8.9 on every rung and cannot rise; the other three would have to sum to
   about 22.2 (now 19.6), with pacing at 7 a first for any writer; replicate noise (0.8) exceeds the ladder's range.
   `opinions/opinion-fable-6.md` has the decomposition.
7. **Wikimedia is a thirty-a-minute host.** Three launches were lost to 429s before the throttle (one request every
   two seconds to Wikimedia hosts only, a twenty-second back-off, one search per episode, a contact user-agent, a
   ten-minute dossier budget).
8. **Deterministic vetoes must be replayed.** The foreign-script guard, calibrated when no shipped chapter carried a
   foreign character, failed two paid books on one quoted Arabic word; the compile audit's prompt-leak scanner
   fired on "the plan" in a chapter about a ship's deck plan.

## What was not shipped, and why

- The cross-family line editor (rung 1): Parsa's rule that every editing call stays on the writer; also three times
  the edit cost and a thousand proper nouns the writer never wrote.
- The exits, the scene cap, the repetition cut, the told closings, the extension flag, episode ownership and the
  epigraph OCR filter (rounds 2 and 3): measured, correct on their counts, not rewarded by the panel; preserved on
  branch `quality-ladder-rounds-2-3` with the plan and opinion that specified them.
- Retypesetting to 12pt (129 pages against 103 for the same book): a words-per-paid-page decision left to Parsa;
  renders in `ladder-report-2026-09-03.md`.

## Open questions, ranked by the last advisor

1. The line editor's extension pads five or six chapters a book from a payload with no dossier; turning it off
   needs the compose ask corrected for every chapter, not only told ones.
2. Deterministic episode ownership (no two chapters about the same document or person-and-place) is the one lever
   aimed at pacing; built on the side branch, unmeasured on its own.
3. A human calibration of the rubric (two readers, chapters 1 and 8, the put-down paragraph; packets in
   `human-packets/`), and a de-primed rubric v2 beside the panel.

## Files

| path | what |
|---|---|
| `ladder-report-2026-09-03.md` | rungs 1–8, every count and verdict mean, the pairwise results, the typesetting measurement |
| `session-report-2026-09-03.md` | the earlier session: 25 arms, the instrument and its noise, the plateau |
| `spec.md` | the chronological log of the earlier session, iteration by iteration |
| `opinions/opinion-fable-2..6.md` | the five advisor opinions, in order; 5 proposed the material-first paradigm, 6 answers "why not 8" |
| `plans/plan-5c93566-amendments.md` | the amendments plan for round 2 with its pre-registered readouts |
| `plans/developer-review-arm1.md`, `research-improvements.md`, `review-run-a-b.md` | the earlier session's reviews |
| `rubrics/blind-rubric.md`, `pairwise-rubric.md`, `stance-positions-flat.json` | the panel rubric, the pairwise prompt, the stance positions every arm reused |
| `evals/<label>/{A,B,C}.json` | every blind verdict, per book and reader; `evals/pairwise-*/` the pairwise verdicts |
| `human-packets/` | chapters 1 and 8 of the baseline, rung 5, rungs 6–8 and composed-7, with the one-question protocol |
| `patches/` | the earlier session's applied patch scripts |
| `runs/<label>/` (gitignored) | every generated book (`book.md`), its trace (`trace.md`, `trace.json`), pages and scorecard |

## Reproducing a rung

```bash
# one balanced replicate on the shared plan (three in parallel is fine; stagger by 150 s for the dossier)
pnpm exec tsx scripts/dev-rerun-book.ts run --source cmtjbz54o000w6rjyvzewwqj4 \
  --label <label> --reuse-plan cmtjlkn0z0000g8g08zbzxerc --tier balanced \
  --stance-positions docs/composed-chapters-research/rubrics/stance-positions-flat.json
# flags: pnpm exec tsx scripts/dev-set-quality.ts feature <id> balanced on|off | restore <version>
# counts: pnpm exec tsx scripts/ladder-counts.ts <label>...   (rung 5 state: scripts/structural-scorecard.ts)
# panel: three Opus readers per book with rubrics/blind-rubric.md, verdicts to evals/<label>/{A,B,C}.json,
#        then pnpm exec tsx scripts/blind-panel-summary.ts evals/<label>...
# pairwise: rubrics/pairwise-rubric.md on human-packets/, both orders, no ties
```
