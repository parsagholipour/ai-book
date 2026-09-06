# Fresh-plan candidate on the Opus panel — 6 September 2026

Registered before any verdict was read. Continues the sequential whole-book programme in
`../2026-09-05-whole-book/report.md` at its step "If we continue" (`../../session-summary-2026-09-06.md`):

1. fix the initial plan parser so authored chapters nested under `authorStance` survive (a bugfix, verified against
   the saved candidate-4 response and by regression tests; no quality claim);
2. generate **one** Luna book from a recovered fresh plan (candidate 5, label `fresh-plan-5`);
3. assess it, and decide.

## What changes from the earlier candidates

- **Assessors are Opus, not Sol.** The user's instruction for this session: Opus implements and assesses. The
  instrument is therefore the one every ladder rung was judged by — three independent Opus readers a book, fresh
  Agent contexts, `model: opus`, the unchanged rubric `../../rubrics/blind-rubric.md` — exactly the
  `../2026-09-05-opus/` procedure (`blind-books.py`, `summarize.py`, `evals/<CODE>/<reader>/{verdict,coverage}.json`).
- **Controls are read in the same sitting.** The panel drifts ~0.6 between sittings, and Opus reads about 0.6
  above Sol on the same books (rung 5: 7.82 Opus on 5 September against 7.19 Sol; candidate 3: 7.03 Sol). So two
  controls are blinded beside the candidate: `J2` = `ladder-5a-apparatus` (rung 5, the shipped configuration) as
  `reference`, and `R4` = `material-progression-3` (candidate 3, the immediate predecessor on the old outline) as
  `baseline`. No historical Opus or Sol number is subtracted from a score taken today.

## Candidate 5

Same source project (`cmtjbz54o000w6rjyvzewwqj4`, "Aggression Through Time", English, 120 pages), balanced tier
(writer gpt-5.6-luna, low effort), quality revision 49 (`bookDevelopment`, `caseEvidence`, `developmentalEdit`
off; creative contract, material-first, couplet rewrite, chapter apparatus on), designed cover, no `--reuse-plan`,
no stance override. The only code change between candidate 4 and candidate 5 is the plan-recovery fix (schema
normaliser, one prompt sentence, tests). The plan is inspected after PLAN_READY for: authored chapters preserved
(no generic "Opening/Development/Perspective/Resolution" titles), chapter count and page targets summing to 120,
varied chapter lengths, and Luna routing. A plan that fails that inspection stops the run before prose and is
recorded as a failed launch, not a score.

## Readout and stop rule

Primary: the unrounded equal-weight ten-criterion mean across the three readers of the candidate. The user's stop
rule stands: stop generating when that mean is at least 8.0. Because the Opus panel reads rung 5 at about 7.8, an
8.0 here is inside the ±0.4 noise of a three-reader book mean, so the report also gives the same-sitting
differences against `J2` and `R4`, per criterion, and treats a difference under 0.4 as unresolved.

Validation (`summarize.py`): manuscript hash and word count, every reader's chapter list and count, score ranges
and arithmetic, and every quoted highlight and pattern instance verbatim in the assigned manuscript. Readers get
only the blinded manuscript path, the rubric path and their output paths: no arm label, past score, code, trace,
other manuscript, or web. Scores are never replaced because a result disappoints.

If the candidate misses, no further review loop is added. Diagnosis follows the summary's third step: does the new
outline actually vary length and question; do chapters still close on the same institutional sentence; can each
chapter's material answer its own question at the allotted length.

## Candidate 6, registered after candidate 5 scored 6.87 (Opus; rung 5 read 7.63 and candidate 3 read 7.10 in the same sitting)

Candidate 5 completed (120 pages, 56,605 words, 117 PDF pages, 25 minutes, $0.40, all calls on Luna, production
source unchanged during the run). Its plan was properly authored (14 chapters, targets 4–13 pages summing to 120,
no generic titles) and the chapter lengths reached the prose (1,776–6,259 words). All three readers named one
paragraph engine: what a source establishes, then what it cannot establish, closing on a balanced antithesis; and
the same duplications (Nuremberg/Wannsee in chapters 8 and 12; Nataruk in 1, 2, 13, 14; chapters 13–14 as recap).

The live compose prompts locate the assignment. The focused writer never sees the stance positions, but the
episode planner's `focus.contribution` was a distinction ("The reader can distinguish A from B", "… rather than …",
"… without treating …") in 13 of 14 chapters — and in 13/15 and 11/15 of the two earlier focused books — and
`focus.question` asked "what can X establish and what does it leave undecided" in 5 of 14. Three of seven
`voiceGuide` lines were evidence-method rules carried into every call as `styleNotes`. Two of five stance positions
were hedged evidence statements. The episode plan gave Nataruk to three chapters and Keeley to two as separate
episodes. The manuscript read diagnosed all of it (12/14 chapters flagged, five book-wide restatements) and its cut
is switched off (`READ_SECOND_EDITS = false`, measured once on composed-8/9 with no gain); it stays off.

**Intervention (plan-time, combined; no new review loop over prose):** a deterministic method-shape detector,
calibrated on the stored plans of candidates 2, 3 and 5 and on the hand-written flat positions (which it must
pass), applied as: (1) the episode planner is re-asked once with the violating chapters and episode collisions
named, then method-shaped contributions are blanked, method-shaped investigation lines dropped, and a later
chapter's colliding episode (≥2 shared proper nouns) removed; (2) a plan stance whose thesis or positions are
method-shaped is regenerated through the existing stance call; (3) method-shaped voice-guide lines are withheld
from the per-chapter styleNotes; (4) one planner sentence: at most one synthesis chapter, no keyBeat revisits an
earlier case; (5) the focus rules no longer ask for "the new distinction the reader can make". At most one extra
plan-episodes call and one stance call per book. Nothing can fail a book; a non-English book is not gated.

Prediction: fewer concession couplets and antithetical closers per chapter, no re-narrated case across chapters,
and the same-sitting mean above candidate 5's 6.87; the readout that matters is pacing and slop resistance. Same
source project, balanced Luna, quality revision 49, fresh plan, designed cover, one book, three fresh Opus readers,
the unchanged rubric and the 8.0 stop rule. Alternative explanations if it misses: Luna's default nonfiction
register hedges without being asked; the dossier reaches too few chapters for scenes to be anything but invented;
the two synthesis chapters are the plan's own recap.

## Candidate 7, registered after candidate 6 scored 7.00 (same sitting: rung 5 7.63, candidate 3 7.10, candidate 5 6.87)

The user's instruction: keep going until a book averages 8+. Candidate 6 removed everything its readers could
trace to the plan and still read the writer's own assert-then-retract rhythm; rung 5 — legacy composition with
the stance positions shown, a told opening scene where the material has one, the creative reconstruction rule —
remains the best-measured path (7.63 today; 7.82 on 5 September), and its readers named what would lift it:
trim the restatements, vary the closings, keep the scenes.

**Intervention (combined, all gated or code-accepted; nothing may fail a book):**

1. `chapterFocus` gate, off: the episode planner plans no question/investigation/contribution, so the chapter is
   composed the rung-5 way (positions shown, told opening scene, creative reconstruction) with the parser fix,
   the plan contract (stance gate, style-note filter, collisions, one synthesis chapter) and candidate 1's
   routing still in force, on a fresh plan.
2. `manuscriptReadCuts` gate, on for balanced: the chapters the manuscript read flags get one deletion-only cut
   call each on the writer over the **whole chapter** (not the tail), accepted only when every kept sentence is
   verbatim, the cut removes 0.5–25%, and the chapter stays above its page floor (the last book had 12% of room).
3. The couplet rewrite broadened to the forms the readers quote — "X does A. It does not do B.", "X does A; it
   does not do B.", "X can show A without showing B" — measured at 18 per 1,000 sentences on the fresh-plan
   books against 6.5 at rung 5 with every sampled hit the tic; "neither … nor" and "not only … but" measured with
   false positives and are excluded. Same one call per chapter, same code acceptance, cap 18 pairs a chapter.

Prediction: pacing and slop resistance above rung 5's 6.0 in the same sitting, engagement back near 7 with the
scenes restored, and the book mean above 7.63; the pre-registered readouts are the three criteria, the
deterministic negation-contrast and antithesis counts, the number of chapters cut and words removed, and the
told-scene count. Alternatives if it misses: the cut removes reasoning the readers valued (the 8.4→8.3 control
in the automated-repair experiment); the rewrite is another cadence change the panel does not reward (rung 4);
the legacy path's positions restated per chapter return as the refrain composed-7's readers named.

Same source project, balanced Luna, fresh plan, designed cover, one book, three fresh Opus readers, the unchanged
rubric and the 8.0 stop rule. Live quality revision moves from 49 to 50 for the cuts flag only.

## Candidate 8, registered after candidate 7b scored 7.40 (7.6 / 7.7 / 6.9; rung 5 7.63 in the same sitting)

Candidate 7 was stopped at 15% when the collision rule dropped four legitimate episodes on a modern editor's name,
a polity and a book-title word; the rule was refined (document-only overlap never counts; a token filed under
`place` is never strong; a drop needs two strong tokens) and the candidate relaunched as 7b. 7b: 120 pages,
52,301 words, 106 PDF pages, 28 minutes, $0.46; one told scene; the broadened rewrite took the semicolon
retraction to 0.9 and the assert-then-retract pair to 2.2 per 1,000 sentences (candidate 6: 4.6 and 10.6); seven
chapters flagged by the read, one cut applied — the legacy path drafts at 87% of the ask and the book sat 700
words above its floor. Readers: the paragraph-final disclaimer in nearly every paragraph, "the unresolved
question" endings, one foil dispatched in four chapters, one scene, a thin letters chapter, two bad epigraphs.

**Intervention (six deterministic or content-assignment changes):** (1) the episode planner assigns a scene
episode where the material has a datable event — at least half the chapters, never all; (2) the compose ask
rises from 520 to 570 words a page so the draft lands ~10% above the floor and the cuts can apply; (3) at most
two chapters end on the `open-question` form; (4) voice-guide shape rules (about endings, openings, paragraph
shape) are withheld from chapter prompts like the method rules; (5) a deterministic cap on paragraph-final
disclaimer sentences — keep every third, delete the rest when the paragraph has three or more sentences and the
sentence carries no unique fact, never below the floor; (6) an epigraph may not be a sentence of the chapter body
and must share an anchor with the chapter's episodes. Live flags unchanged (revision 50).

Prediction: engagement toward 7 with scenes in about half the chapters; pacing and slop above 6 with the cuts
applying and the disclaimer share halved; a book mean above 7.63. Pre-registered readouts: scenes told, cuts
applied and words removed, disclaimer sentences removed, hedge-ending share, generalising-closer share,
open-question endings, the three criteria.

## Candidate 9, registered after candidate 8 scored 7.50 (7.5 / 7.7 / 7.3; slop resistance 7.0, engagement 6.0, pacing 5.67)

Candidate 8 asked for scene episodes in eleven chapters and told none: the nonfiction scene call returns before
any request unless the dossier holds an excerpt for the episode, and its prompt returns empty when the passage
does not describe it. Fresh plans have excerpts in two or three chapters. Rung 5a told eight scenes (engagement
7.0), rung 3 one in every chapter (7.22). **Intervention:** under the creative contract a nonfiction chapter with
no excerpt is told from what the record makes likely, with the reconstruction grammar and the contract's
own-knowledge rule, minimum 300 words kept; the strict rule stays for the grounded contract and for any chapter
with an excerpt; the apparatus rotation still forbids two consecutive scene openings. Second change: the planner's
chapter length floor rises from three to five pages. Everything else as candidate 8. Prediction: told scenes in
about half the chapters, engagement toward 7, the same-sitting mean above 7.63; risk: reconstructed particulars
the rubric does not fact-check (the Zong class), which the summary flagged and the user's "8+" instruction
accepts.
