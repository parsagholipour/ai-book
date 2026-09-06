# Fresh plans on the Opus panel — 6 September 2026

Two more single-book candidates in the sequential programme (`../2026-09-05-whole-book/report.md`), both from a
fresh Luna plan rather than the reused composed-7 outline, both read by three fresh Opus readers beside two
controls in the same sitting. **Neither reached 8.0.** Candidate 6 removed every defect candidate 5's readers
could trace to the plan, and the readers then named the writer's own sentence rhythm.

| Book | Arm | Words | A | B | C | Mean | Engagement | Pacing | Slop res. |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ladder-5a-apparatus (J2) | reference, rung 5 | 56,471 | 7.6 | 7.6 | 7.7 | **7.63** | 7.00 | 6.00 | 6.00 |
| material-progression-3 (R4) | baseline, candidate 3 | 60,331 | 7.8 | 6.7 | 6.8 | **7.10** | 5.33 | 5.33 | 6.00 |
| fresh-plan-5 (J5) | new | 56,726 | 7.5 | 6.3 | 6.8 | **6.87** | 5.00 | 4.33 | 5.67 |
| plan-contract-6 (T6) | new | 58,614 | 6.7 | 6.9 | 7.4 | **7.00** | 5.33 | 5.00 | 6.00 |

Validation (`summarize.py`): manuscript hashes, word counts, every reader's twelve-to-fifteen-chapter list, score
arithmetic and every one of the twelve verdicts' quoted highlights and pattern instances verbatim in the assigned
manuscript — zero issues. Protocol and the pre-registered candidate-6 prediction: `protocol.md`. Per-criterion
means: `summary.json`.

**Read the numbers within this sitting.** Opus reads about half a point above Sol on the same books (rung 5:
7.63 today, 7.82 on 5 September, 7.19 on Sol; candidate 3: 7.10 today, 7.03 on Sol), so 8.0 on this panel is
inside the ±0.4 noise of a three-reader book mean above rung 5, and the differences between the three lower
books (6.87, 7.00, 7.10) are unresolved. What is resolved: rung 5 beats every fresh-plan book by more than the
noise, and every reader of every book but rung 5 put pacing at 4–6 and engagement at 4–6.

## Step 1: the plan parser (a bugfix)

Candidate 4 had stopped at zero pages because Luna nested its fourteen authored chapters inside `authorStance`
and `bookPlanModelOutputSchemaWithFallback` discarded them for the generic fallback outline. The fix
(`packages/core/src/schemas/plan.ts`: book-level fields missing from the answer are recovered from the stance
object, and initial planning never inherits the fallback's chapters — a missing array now fails `.min(1)` and
reaches the bounded JSON repair; one prompt sentence in `planner.ts` naming the root contract;
`initialPlanRecovery.test.ts`) makes the saved candidate-4 response replay with all fourteen chapters
(`../2026-09-05-whole-book/replay-plan-4.ts`). Whole-repo check: 7 gates (`check-5.log`).

## Candidate 5: a fresh plan, unchanged pipeline — 6.87

Project `cmtp6zavs0000e8g0xx9tld49`. The plan was properly authored: 14 chapters, targets 4–13 pages summing to
120, no generic title, `analytical-history`, a 13-page single-case chapter (Sarajevo) and a 12-page document
chapter (Hammurabi). The lengths reached the prose (1,776–6,259 words a chapter). 120 pages, 56,605 words, 117 PDF
pages, 80 calls, $0.40, 25 minutes, all calls on Luna, 579 production files unchanged during the run
(`code-5-*.sha256`).

All three readers named one paragraph engine — what a source establishes, then what it cannot establish, closing
on a balanced antithesis — and the same duplications: Nuremberg/Wannsee expounded in chapters 8 and 12 with the
same flow figure, Nataruk in 1, 2, 13 and 14, chapters 13–14 as recap. The live compose prompt for chapter 6
(`../../runs/fresh-plan-5/trace.json`, run log) located the assignment. The focused writer never sees the stance
positions, but:

- `focus.contribution` was a distinction in 13 of 14 chapters ("The reader can distinguish evidence of violent
  capability … from evidence of violence's frequency"; "… rather than reducing it to hatred"; "… without treating
  prejudice, persecution, and mass murder as identical stages"). The same was true of candidates 2 and 3 (13/15,
  11/15): `CHAPTER_FOCUS_RULES` asked for "the new distinction the reader can make afterward". Five of fourteen
  `focus.question`s asked what the evidence can and cannot establish.
- Three of seven `voiceGuide` lines were method rules ("Separate what evidence shows from what scholars infer",
  "Use moderate confidence. Name competing interpretations…") and rode every compose and edit call as
  `styleNotes`.
- Two of five stance positions were hedged evidence statements, copied by the episode planner into
  `alreadyEstablished`.
- The episode plan gave Nataruk to three chapters and Keeley to two as separate episodes; the reservation lines
  named them and the writer re-narrated them anyway.
- The manuscript read flagged 12 of 14 chapters and five book-wide restatements; its cut is off
  (`READ_SECOND_EDITS`, measured once with no gain) and stays off.
- Dossier excerpts reached 3 of 14 chapters (rung 5a: 8 of 15): the fresh plan's episodes are mostly modern
  scholarship with no public-domain text.

Deterministic counts corroborate the readers (`../../runs/*/scorecard.txt`): negation contrasts per 1,000
sentences 23.0 (rung 5a) → 31.1 (candidate 3) → 42.8 (candidate 5); hedge-ending share 0.083 → 0.113 → 0.135;
abstract nouns per 1,000 words 5.4 → 12.4 → 12.5.

## Candidate 6: the plan contract — 7.00

The intervention (`packages/core/src/generation/planContract.ts`, pre-registered in `protocol.md`): a
deterministic method-shape detector, calibrated on the stored plans of candidates 2, 3 and 5 and on the
hand-written flat positions (which it must pass; `replay-contract.ts`), applied as (1) one episode-planner re-ask
with the violating fields and the episode collisions named, then a deterministic clean-up — method-shaped
contributions blanked, method-shaped investigation lines dropped, a later chapter's colliding episode (two or more
shared proper nouns, at least one not a nationality or institution word) removed; (2) a fresh run regenerates a
stance whose thesis or positions are method-shaped, through the existing stance call; (3) method-shaped voice-guide
lines are withheld from per-chapter `styleNotes`; (4) one planner sentence: at most one synthesis chapter, no
keyBeat revisits an earlier case; (5) the focus rules ask for a claim, not a distinction. Nothing can fail a book; a
non-English plan is not gated. Implemented by Opus in three passes; the first whole-repo run caught one regression
(a resumed book re-generated its stance because the pass's own persisted stance was method-shaped — the gate is now
a fresh run's decision only); final check 7 gates in 99 s (`check-6-final.log`).

Project `cmtp8p8bg0000xwg05v49tihd`. The plan: 12 chapters (8–14 pages, one synthesis chapter, a 14-page Nineveh
case, a 6-page frontier-letter chapter), chapters at the root at the first ask. The contract fired as designed
(`generation.composed_chapters.focus_contract`): the first episode plan had 2 method-shaped fields and 1 collision
against candidate 5's 21 and 5 — the revised focus rules had already changed what Luna wrote — and the re-ask left
one question and no collision; nothing had to be dropped or blanked. The live compose prompt for chapter 7 carried
a claim-shaped contribution ("Vindolanda Tablet 291 records a frontier community converting fear of attack into
requests for patrols…") and four of the eight voice-guide lines. The stance passed and was not regenerated. 120
pages, 58,515 words, 118 PDF pages, 68 calls, $0.41, 29 minutes, all Luna, 580 production files unchanged.

What moved: no reader names a re-narrated case; structure 7.67 (from 7.33); pacing 5.0 (from 4.33); voice 6.67
(from 6.33); list-sentence share back to rung 5's level (0.166); abstract nouns 10.3 (from 12.5); top-five
paragraph-shape coverage 0.70 (from 0.76). All inside noise except the disappearance of the duplication.

What did not: all three readers name the same "assert, then symmetrically retract" sentence ("Context narrows
possibilities; it rarely supplies motive."; "Mobility changes the geography of danger; it does not abolish
danger."), the two-case chapter architecture, recap codas and aphoristic closers. Negation contrasts stayed at
41.7 per 1,000 sentences and the couplet count rose to 19.1. With the assignment verifiably gone from the prompts,
that rhythm is the balanced writer's own nonfiction register. Chapters 1 and 2 both open at Nataruk (the plan's
`openingHook` names it; chapter 2 owns it as an episode; the collision rule reads episodes only). The manuscript
read again flagged 11 of 12 chapters for recap tails.

## What the two books say together

1. **The assigned distinction was real and is gone.** Since the focus path began (candidate 2), every chapter's
   contribution had been a distinction and every voice guide a method; the contract removes both at plan time at no
   cost, and candidate 6's prompts prove it. Keep it: it is the difference between a defect the pipeline
   manufactures and one the writer brings.
2. **The hedge is now the writer's.** Rung 5 (legacy path, flat positions shown to every chapter, creative
   reconstruction) sits at 23 negation contrasts per 1,000 sentences; every focused-path book sits at 31–43. The
   remaining lever on that criterion is the writer's register — model or effort — which earlier sittings measured
   (effort does nothing; DeepSeek V4 Pro and Gemini 3.7 Flash read 7.6–7.7 with engagement 7) and which is a routing
   decision, not a prompt.
3. **Engagement 5.0–5.3 against rung 5's 7.0 is the reconstruction contract.** Rung 5a told 8 scenes and kept 10
   verbatim quotes with excerpts in 8 of 15 chapters; candidates 3, 5 and 6 told **no** scene and kept 4–6 quotes
   with excerpts in 2–4 chapters. Candidate 2 made nonfiction scenes depend on supplied excerpts
   (`FOCUSED_RECONSTRUCTION_RULE`), the dossier rarely supplies any for a fresh plan's episodes, and the ladder's
   own finding was that material moves engagement and cadence does not. Honest scenes at engagement 5 or
   reconstructed scenes at engagement 7 (with the Zong verdict reversed) is the trade the summary named, and it is
   Parsa's to make; the cheap test of the other side is the creative reconstruction rule on the focused path.
4. **The dossier reaches too few chapters for material-first to do its work on a fresh plan** (2–3 of 12–14
   chapters with excerpts). The episodes Luna chooses for a modern survey are largely not on Wikisource, Gutenberg
   or Archive.org; retrieval through the general research adapter would be the next material lever, and it is not a
   bounded prompt change.

No candidate 7 was launched: the next levers are a routing decision, a contract decision, or a retrieval project,
none of which the sequential protocol's "one bounded implementation, one book" step covers.

## Files

| path | what |
|---|---|
| `protocol.md` | registered before any verdict; candidate 6 pre-registered after candidate 5's result |
| `candidate-5.json`, `candidate-6.json` | manifests: IDs, execution, scores, diagnosis |
| `plan-5.json`, `plan-5-complete.json`, `plan-6.json`, `plan-6-complete.json` | the plans as approved and as completed (episodes, focus, dossier) |
| `blind/<CODE>/manuscript.txt`, `evals/<CODE>/<reader>/{verdict,coverage}.json`, `summary.json` | the panel; codes J2, R4, J5, T6 |
| `replay-contract.ts`, `inspect-plan.ts`, `chapter-shape.py` | the contract replayed over stored plans; plan inspection; per-chapter lengths, openings, closings |
| `run-5.log`, `run-6.log`, `code-*.sha256`, `check-5.log`, `check-6*.log` | launches, source hashes before/after each run, whole-repo checks |
| `../../runs/fresh-plan-5/`, `../../runs/plan-contract-6/` (gitignored) | `book.md`, `pages.json`, `trace.json`, `trace.md`, `scorecard.txt` |

## Candidate 7b: the rung-5 path with cuts and the broadened rewrite — 7.40

After candidate 6, the user asked for the sequence to continue. Candidate 7 (`legacy-cuts-7`) put the book back on
rung 5's composition path through a `chapterFocus` gate (off: positions shown, told opening scene where the material
has one, creative reconstruction), turned on `manuscriptReadCuts` (the read's flagged chapters get one whole-chapter
deletion-only cut, floor-bounded; live revision 50), and broadened the couplet rewrite to the forms the readers
quote (assert-then-retract, semicolon retraction, "without proving"). Its first launch was stopped at 15% when the
collision rule dropped four legitimate episodes on a modern editor's name, a polity and a book-title word
(`candidate-7.json`); the rule was refined (document-only overlap never counts; a drop needs two strong tokens) and
the book relaunched as `legacy-cuts-7b` (project `cmtpb81zh0000cyg0yv6c3aex`; `candidate-7b.json`).

7b: 120 pages, 52,301 words, 106 PDF pages, 28 minutes, $0.46, all Luna, 580 production files unchanged. The
rewrite took the semicolon retraction to 0.9 and the assert-then-retract pair to 2.2 per 1,000 sentences
(candidate 6: 4.6 and 10.6; rung 5a: 1.4 and 5.1); abstract nouns 7.8 (from 10.3); list sentences 0.138 (best of
the set). Only one told scene (the planner returned documents and figures); seven chapters flagged by the read and
one cut applied, because the legacy path drafts at 87% of the ask and the book sat 700 words above its floor.

Three fresh Opus readers: **7.6 / 7.7 / 6.9, mean 7.40** — thesis 8.67, structure 7.67, depth 7.67, reasoning
8.67, clarity 8.67, voice 7.33, engagement 6.0, pacing 5.33, craft 7.67, slop resistance 6.33. Zero validation
issues. The best fresh-plan book and inside noise of rung 5's 7.63; still not 8. What the readers name now: the
paragraph-final epistemic disclaimer (measured: 84 such sentences, 22 paragraph-final and deletable), chapter
endings on "the unresolved question" (the `open-question` form placed last, and a voice-guide line asking for it),
one foil ("the timeless-aggression thesis") dispatched in four chapters, a thin letters chapter built on a document
never quoted, and two epigraphs that are body sentences or OCR fragments. This is the state committed on
6 September at the user's request ("commit the 7.4 for now"); candidate 8, targeting those five complaints
deterministically, is registered in `protocol.md` and was set aside uncommitted.
