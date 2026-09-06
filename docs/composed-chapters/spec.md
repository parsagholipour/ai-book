# Composed chapters: chapter-scale composition, author stance, form plan, editor pass

Status: in progress (2026-09-02)

## Why

Two 120-page balanced books ("Aggression Through Time", projects cmtj5zdel0012o1p5msfy2ygy and
cmtizhgya000x1yp50qqf4bo8) were blind-reviewed at 6.40 and 5.55/10. The phrase scanner found one and
four candidates; the slop is structural: every page runs example → evidence limit → symmetrical
qualification → bounded conclusion, sentence-length CV 0.41, 23–31% of sentences are 4+ item lists,
the top five page-shape signatures cover 76–78% of pages. The template is *assigned*: every page
brief carries a bounded `claim`, 2–4 `evidenceAnchors` and an `endingPressure` landing sentence
shaped "X could A, while B"; the reviewer rejects a page that develops the next page's reserved beat
or "closes with a synthesis rather than a controlled handoff". The gates that were added between
the two books (page review, rewrite loop, plan critic, page-map critic, final QA) bought +0.85 at
717 calls vs 171. Every gate is page-local or a literal phrase counter, so 120 individually approved
pages of identical architecture pass.

## What changes

A new generation strategy pair, `composed-chapters` and `composed-chapters-research`, auto-selected
for every non-KIDS book of 12+ pages. It changes the unit of composition from the page to the
chapter and replaces the rule list with an author.

1. **Author stance** (`plan.authorStance`, optional on `BookPlan`): thesis, 3–5 positions, refusals,
   and a 180–260 word voice sample written *as the author* on a subject outside the book. The planner
   asks for it; the pass generates it (`author-stance`) when a plan lacks one.
2. **Chapter form plan** (`plan-chapter-forms`, one call per book): each chapter gets 3–8 sections,
   each with a *form* from a writing-mode palette (scene, close reading, portrait, argument,
   counter-argument, mechanism, catalogue, open question, comparison, aftermath, quiet transition …),
   a subject, the cases it owns, and one landing for the whole chapter. A deterministic variety check
   (no form over half a chapter or 40% of the book, no two chapters with the same sequence, no two
   consecutive chapters opening alike) gets one repair call, then a deterministic rotation. Never
   blocks.
3. **Compose** (`compose-chapter`, prose model, plain text): one call per chapter writing continuous
   Markdown from the stance, the form plan, the previous chapter's tail verbatim and a digest of every
   earlier chapter. Only the final paragraph lands. Word budget = chapter pages × target words.
4. **Edit** (`edit-chapter`, prose model): a line-editor pass per chapter: cut repeated caveats and
   restatements, vary paragraph shape, shorten lists, name the concrete thing instead of the abstract
   noun, let stated positions stand without counterweights, keep every fact. Gated by
   `chapterEditorPass` (default all tiers).
5. **Paginate** deterministically at paragraph boundaries into exactly the chapter's page count;
   pages are a typesetting unit, not an argument unit. `describe-pages` (mechanical JSON) supplies
   each page's title, summary, continuity notes and, for illustration slots, its image prompt.
6. **Read** (`read-manuscript`, prose model): one whole-book read returning per-chapter notes and at
   most ⌈chapters/3⌉ (≤6) chapters to re-edit. Gated by `manuscriptReadPass` (default all tiers).
7. **Finalize**: deterministic local checks only (prompt leaks, placeholders, opening rule), then
   the existing staged publication (illustrations, continuity notes, story state) and compile. The
   compile's per-page final-QA repair loop is skipped for this execution mode; the deterministic
   manuscript audit and targeted structural review still run.

Chapters are checkpointed as PENDING page rows plus a derived `Chapter.productionBrief` (one beat per
page, `composition` beside it) so a worker restart resumes at the first chapter with no pages.

## Not changed

Per-page strategies, KIDS books, chat edits, structural edits, imports, continuation, pricing.

## Measurement

`scripts/structural-scorecard.ts <book.md>` prints sentence-length CV, opener concentration, list
share, page-shape coverage, concession density and paragraph-ending hedge rate, the deterministic
half of the blind rubric. Baseline: A 0.41 / "The same" ×36 / 23% / 76% / 11.0 per 1000 words.

## First live run (2026-09-02, cmtjbz54o000w6rjyvzewwqj4, balanced, composed-chapters-research)

| | composed | book A | book B |
|---|---|---|---|
| provider calls / cost / wall time | 58 / $0.32 / 21 min | 717 / $1.67 / 72 min | 171 / $0.42 / 48 min |
| sentence-length CV | 0.477 | 0.428 | 0.423 |
| 4+ item list sentences | 17% | 23% | 31% |
| concession markers /1000w | 7.2 | 10.8 | 11.3 |
| abstract nouns /1000w | 6.1 | 17.2 | 14.0 |
| paragraphs ending on a hedge | 7.6% | 15.8% | 14.5% |
| paragraph-length CV | **0.20** | 0.64 | 0.58 |
| words / printed pages | 45.6k / 95 | 59.6k / 128 | 68.3k / 146 |
| blind mean, two Opus reviewers, same prompt | 5.60, 5.30 | 4.40, 5.10 | — |

Reviewer-named residual tics: assert-then-negate couplets, paragraphs closing on a placed object,
one-line thesis chapter endings, question clusters, four-noun lists, recap final chapter, and the
uniform paragraphs. Fixes shipped the same night: tolerant stance positions (the planner's
`{believes, rejects}` objects had been dropped), 540-word page budget with editor extension,
`chapterShape.ts` measurements driving one reshaping edit, rotating landing forms, couplet and
question caps, particulars per section, last-chapter rule. Next: generate the same brief again and
re-run `pnpm scorecard` plus the blind pair.

## Iteration 2 (2026-09-02, after the first composed book)

Project cmtjbz54o000w6rjyvzewwqj4: 58 calls, 503k prompt tokens, 21 minutes, $0.32 (vs 717 calls,
72 minutes). Blind panel 7.0 vs 6.4, leading on nine criteria, but slop resistance 3.7. Scorecard:
sentence CV 0.50 (0.43), concessions 6.9/1000w (10.8), abstract nouns 6.2 (17.2), hedge endings 7%
(16%), but "did not" ×150, "it could" ×23 as top opener, top-5 page shapes still 78%, 46k words and
95 printed pages for 120 paid.

What the run log showed:

- The plan's stance came back with `positions: []`; the only thing the writer could imitate was a
  voice sample made of aphoristic generic-singular openers and negation-correction pairs. Every
  chapter opened on that move; chapter 10 opened with the sample's first sentence verbatim.
- The form plan wrote all ten landings in one shape ("X did not simply A; it B, C, D"), each a
  restatement of the thesis, and the writer pasted each verbatim as the chapter's last sentence.
- The line edit changed under 2% of the words: it was told to keep the final paragraph and given
  nothing concrete. The read's notes were good but hit a JSON error (notes as objects), flagged two
  chapters, and lost to the editor's keep-rule.

Changes:

- `proseMeasurements.ts`: deterministic measurements quoted as sentences (negation-correction,
  negation-then-short pairs, generalising closers, list sentences, stock pivots, opener
  concentration, generic-singular opening, generalising closing, voice-sample leaks). Never a gate:
  `measurementNotes` go to the editor and the read. `pnpm scorecard` prints the same numbers.
- Stance: positions required (a plan stance without ≥2 is regenerated), sample must be prose about
  particulars, prompt presents it as diction only and forbids reusing its sentences or moves.
- Form plan: landings are particulars, never thesis restatements or negation-corrections, no two
  alike (`landingIssues`); scenes in non-fiction are documented or framed as reconstruction; the
  final chapter is new material.
- Compose: opening-move rule, negation-correction and stock-pivot bans, the previous chapters'
  first and last sentences passed as moves not to repeat, reconstruction rule, retry under 85% of
  the minimum. Word budget raised so the printed book matches the pages paid for.
- Edit: measured notes with quoted sentences; may rewrite a generalising opening or closing
  sentence; reader notes outrank keep-rules. Read: tolerant note schema, per-chapter measurements,
  cap ⌈chapters/2⌉ (≤8), asked for cross-chapter repeated moves.

## Rerun loop (2026-09-02, `scripts/dev-rerun-book.ts`)

Same creation input (cloned project + the plan job's exact `inputSnapshot`, approved the way the
route approves), scored blind by three Opus evaluators on the ten-criterion rubric
(`blind-rubric.md`, `scripts/blind-panel-summary.ts`). Panel means on one scale:

| run | overall | slop res. | notes |
|---|---|---|---|
| per-page book (2026-09-01) | 6.03 | 4.7 | page-brief template |
| composed-1 | 7.10 | 6.0 | aphoristic openers, can/cannot couplet, thesis-restating landings, closing-object tic |
| composed-2 (iteration 2) | **5.40** | 5.0 | *worse*: object-tableau closers at every seam (from "end on a particular"), "the claim fails at X" formula (from the counterargument rule), "does not" couplet replacing "did not", chapters as anthologies of 3 sealed cases, final chapter with no conclusion (from "no recap"), 7 empty paragraphs around a thin source (from the documented-scene rule) |

Lesson: a prescription about how to open or close is performed every time and becomes the next
tic; bans move the habit to its nearest sibling; deterministic measures improved while the panel
score fell. Iteration 3 therefore *removes* prescriptions: palette rules describe content only, the
landing is the claim the chapter adds (reasoned in a final paragraph, never a one-line verdict or an
object), sections carry a `handoff` to the next and are told to be movements of one argument, the
final chapter states the author's conclusion through a new case, compose and edit get low reasoning
on balanced, the planner keeps chapters to 6–9 pages (the writer produces ~4.5k words per call
whatever the budget: composed-2 was 47.8k words / 99 printed pages), the cutting edit and the
reshaping edit are one call, and the read may flag every chapter.

| composed-3 (iteration 3) | **7.47** | 6.7 | best so far: thesis/reasoning/structure 8–9, "needs light revision" ×3, 52.9k words / 112 printed pages, 15 chapters of 8. Remaining: roll-call recap ending every chapter (from "conclusion in a full paragraph"), "establishes X; cannot establish Y" by the hundred, balanced two-clause closers, "A rival interpretation…" announced identically, handoffs written as questions at the seams, one labelled list, paragraphs still one size (CV 0.15–0.25) |

Iteration 4 (composed-4): a focused `detemplate-chapter` pass that rewrites only quoted sentences
(`detemplateNotes`: assert-retract pairs, symmetrical closers, roll-call ending, question seams,
pivots, labelled lists), `varyParagraphs` merging continuation-cue paragraphs and splitting a long
paragraph's short last sentence (deterministic; CV 0.15→0.4), a positional variety check on the form
plan (no form in the same position in more than a third of chapters; the model put "comparison"
third in 12 of 15), the conclusion rule reworded (argued from the chapter as a whole, no roll call),
handoffs never written as questions, catalogues in sentences, "a rival interpretation" and "the
claim fails" on the pivot list, medium reasoning on balanced (low gave ~100 reasoning tokens).

| composed-4 (iteration 4) | 6.90 | 6.0 | *worse than 3*: artefacts from the additions — orphan one-line paragraphs from the deterministic split ("errors rather than emphasis"), a chapter quoting an earlier chapter's opening sentence (the forwarded openings list), "Chapter 12 uses… chapter 14 returns" in prose (the plan's `avoid` notes + digests), a sentence duplicated verbatim by successive edits; the focused `detemplate-chapter` pass changed almost nothing and truncated three chapters (guard kept the drafts); medium reasoning cost +6 min for no gain. Measures all improved while the panel fell, again. |

Iteration 5 (composed-5) = composed-3 base + positional variety check + paragraph merge only (no split)
+ duplicate-sentence sweep + "the plan is not visible to the reader: no chapter numbers, no
re-narration, notes never mentioned" + closings forwarded as never-quotable + balanced left at its
configured effort. De-templating pass removed.

| composed-5 (iteration 5) | 7.07 | 6.0 | composed-3 base + positional check + merge only + duplicate sweep + no-cross-reference rule; inside the panel's noise band around composed-3. Research report (`research-improvements.md`): plan strings pasted into prose at 76–100%, the line edit is a paraphrase that fuses the two-sentence hedge into the one-sentence antithesis, the read's book notes are unconsumed, the writer is shown the contrastive shape in sample, stance and forwarded closings. |
| composed-6 (run A) | 7.60 | 6.0 | Best so far (A 7.8 / B 7.6 / C 7.4; "needs light revision", slop Medium ×3). Writer saw forms/subjects/material only; rhythm exemplar; no refusals or forwarded closings; strict landing paste fell to 1/16 and handoffs to 0/48. Panel: paired antithesis as default closer, negation-then-correction, recap tails re-listing the chapter's exhibits, identical chapter silhouette, anaphoric list paragraphs, a sentence recycled verbatim inside chapter 5, chapter 1 restating its taxonomy. **Confounded** (Fable review, `review-run-a-b.md`): the planner answered positions as `{belief, rejects}`, `stanceLine` had no `belief` alias and fell back to `rejects`, so every compose/edit prompt said "What you hold to be true: The rival view that…" and the drafts rebutted them (34 assert/negate couplets vs 23). Also still reaching the writer: previous chapter's throughLine via the provisional digest, keyBeats "Open with…/End with…", the openingHook as a commitment, the last-chapter conclusion rule; the OpenAI adapter drops `temperature` under any reasoning effort and the balanced writer row is at `low`, so no composed run ever sampled hotter than default; chapter research queries were built from the app's planning instruction (`input.prompt`), so the notes were about lead magnets. |
| composed-7 (run B) | 7.73 | 6.0 | New best, tightest spread (7.7/7.7/7.8; light revision ×3; slop Medium ×3). Review fixes + best-of-2 with prompt-varied second draft and an excerpt judge. Judge agreed on 2/15 chapters (both took the second draft), 13 order-dependent ties → first draft; 105 calls, $0.48, 23 min. Deterministic negation-contrast tripled (10.0 → 32.9 per 1000 sentences) once the negation notes stopped reaching the editor; per-chapter proxy on the run log: first drafts 45.5, second drafts 41.3, edited 43.2 — the negation is composed, not edited in, and the edit is a paraphrase. All three readers named the same five moves, and four of them are the stance's five positions restated in every chapter: technology-extends-reach, economic-insufficiency, the limits-of-evidence hedge ("It shows X. It does not show Y."), the comparison caveat; plus the terminal roll-call and a planted one-sentence paragraph per chapter (the editor's "let a landing stand alone as a one- or two-sentence paragraph" line). Printed 107 PDF pages for 120 paid. |
| composed-8 (iteration 8) | 7.23 | 6.0 | Regression (7.1/7.1/7.5; moderate/moderate/light; slop Medium ×3). Printed 120/120 pages (59k words); 84 calls, $0.50, 33 min. Read flagged 12 chapters, the deletion-only cut removed 59 whole paragraphs (8–23% each), all of them the restated-limits and comparison-caveat paragraphs the read named, no sentence-level cuts, nothing refused. But the fresh plan's thesis was a rule about evidence ("each class of source licenses only certain claims") and the writer performed it as the sentence shape of nearly every paragraph ("It shows X. It does not show Y."), which no paragraph cut reaches; cases were re-told with dates across chapters; and chapter 8 opened by paraphrasing chapter 7's tail (the prompt said "continue from it in voice and time"), then the cut removed chapter 7's own closing, so all three readers found chapter 7's coda under chapter 8's heading. Negation 35.6/1000 (composed-7 32.9); top-5 shape coverage 0.78 (0.85). |
| composed-9 (iteration 9, composed-7's plan) | 6.73 | 6.0 | 6.9/6.5/6.8; moderate ×2, light ×1; slop Medium ×3. Same plan as composed-7, so this measures iteration 8's pipeline: −1.0 with all three readers lower. 120/120 pages (58.5k words), 82 calls, $0.47, 31 min; 9 chapters cut; every chapter opened on its own particular (tail rule worked). Readers: negation-then-correction as the only cadence, every paragraph 90–140 words, the archive-silence caveat in every case study, aphoristic two-beat closers on schedule, the capacity/policy thesis restated 15–20 times, "nothing a reader could disagree with", "no discernible authorial personality", over-long. Deterministic measures within noise of composed-7 (negation 31.2 vs 32.9, paragraph CV 0.36 vs 0.33, lists 0.21 vs 0.21) — the panel is not reading what the counters count. |
| composed-10 (iteration 10, composed-7's plan) | 7.33 | 6.0 | 7.2/7.7/7.1; light ×2, moderate ×1; slop Medium ×3. Composed-7's writer and editor back (all positions, shape lines, shape notes), cut off, one draft, tail rule, 540 words/page: 60.9k words, 124 printed pages, 56 calls, $0.36, 19 min. Near-replicate of composed-7 (7.73) at +15% length: the gap is the panel's noise plus pacing ("aggressive compression" from two readers, pacing 5/6/5). Two factual errors named for the first time (Magdeburg sacked "in 1648"; the Mexica "across the eastern side of North America"). Same five patterns as every run. Budget set to 520 afterwards (a printed page holds ~490 words of this prose). |
| composed-11-balanced (iteration 10 replicate, composed-7's plan) | 7.17 | 6.0 | 6.8/6.9/7.8; moderate ×2, light ×1; slop Medium/Medium/Low. Same configuration and plan as composed-10 (launched by accident under an "ultra" label when the tier flag had not been wired; kept as a replicate). 59.3k words, 121 printed pages, 60 calls, $0.35, 20 min. One reader gave the same configuration 7.1 (composed-10) and 7.8 (composed-11): the single-reader noise is ~0.7 and the three-reader mean's ~±0.4. The balanced tier's level under the best configuration is ~7.3; composed-7's 7.73 was the favourable end of that band, shorter by 6k words. Two readers again name the planted one-sentence paragraph. |
| composed-12-balanced (iteration 10 replicate 2, composed-7's plan) | 7.43 | 6.0 | 7.0/7.6/7.7; light ×3; slop Medium ×3. Launched as a fast-tier test, but the copied plan's `inputSnapshot` still said balanced and the worker routes from the snapshot, so the compose/edit calls ran on gpt-5.6-luna — a third balanced replicate. 60.8k words, 124 printed pages, 61 calls, $0.36, 22 min. Replicates of one configuration on one plan: 7.33 / 7.17 / 7.43 (mean 7.31, spread 0.26); composed-7's 7.73 at 480 words/page and best-of-2 sits above that band, most plausibly the 6k fewer words (every reader of the 60k-word books scores pacing 5). The harness now writes the tier into the copied snapshot. |

Run A (composed-6) = the report's experiments 1+2: the writer sees forms, subjects and material
only (no landing, handoff, through-line, avoid, no forwarded closings); "the chapter ends where its
last section ends" replaces every conclusion rule; positions restated as plain assertions;
refusals not shown to the writer; the generated voice sample replaced by a fixed rhythm exemplar
(`RHYTHM_EXEMPLAR`, an original passage about a village pump: long narrated stretch, two-sentence
paragraph, plain assertion, particulars, no antithesis); the plan's landing goes only to the read
as `expectedClaim`.

## Run B (composed-7, 2026-09-02) — review fixes + best-of-2

Applied before launch (`patches/review-fixes-applied.py`, `patches/run-b-applied.py`), per the review's priority list:

1. `stanceLine`: `belief`/`holds`/`assertion` aliases; the rejected view is never a position and is never joined on. Planner stance guidance and the fallback's output contract ask for plain assertions.
2. `expandChapterResearch` queries from `plan.title` + chapter, never `input.prompt`.
3. Second candidate is prompt-varied (`variant: "second"`: different door into the first section, sustained stretch elsewhere, short paragraphs elsewhere); the +0.25 temperature stays but is inert at effort `low`.
4. `READ_SECOND_EDITS=false` still re-stages every noted chapter's brief with the read's notes; no edit call.
5. Judge reads aligned excerpts (first 900 + last 450 words), rubric without the "people, places and documents" clause; both orders, tie → first draft; `chapterJudge.test.ts`.
6. `keyBeats` out of the compose payload; openingHook offered not commanded; last-chapter rule is "last section carries the resolution, chapter ends where it ends"; throughLine out of the provisional digest.
7. Measurement notes to the editor carry paragraph shape, lists, openers and pivots only; negation-contrast, negation-then-short and closing-verdict notes are diagnostics (`includeNegationNotes` off).

Not done: a `judge-chapter-drafts` stage in `pipelineStages.ts`/`qualityGateCosts.ts` (judge spend shows as unattributed in the Costs tab); the read criterion still names "an ending that recaps".

### Judge validation (`apps/worker/scripts/judge-validation.ts`, run in the worker container)

Chapters paired by position across runs the panel ranked; the judge (fast-judgment routing, DeepSeek flash, both orders, excerpts) should prefer the higher-scored book's chapter.

| pair (panel) | preferred better | preferred worse | disagreed (order-dependent) |
|---|---|---|---|
| composed-3 (7.47) vs composed-2 (5.40) | 7/10 | 0 | 3 |
| composed-6 (7.60) vs composed-4 (6.90) | 5/15 | 0 | 10 |
| composed-6 (7.60) vs composed-5 (7.07) | 2/15 | 0 | 13 |

Never anti-correlated, so a tie falling back to the first draft costs nothing but the second compose call; but two drafts of one chapter under the same prompt are closer than composed-6 vs composed-5, so expect the judge to settle few chapters. Read `bestOf.agreed` per chapter in composed-7's trace before keeping the second call.

## Iteration 8 (composed-8, 2026-09-02) — one lens per chapter, cuts instead of paraphrase

`patches/iteration-8-applied.py`:

1. **One position per chapter**, rotated (`chapterPosition`), shown as "write this chapter from, without stating it as a sentence of its own"; the read still sees all five. The refrains were the positions performed fifteen times.
2. **Editor stripped to content operations**: the paragraph-reshaping line, the "only the final paragraph lands" line and the "It can show X / cannot show Y" rule are gone; shape notes no longer reach the editor (`SHAPE_NOTES_TO_EDITOR = false`).
3. **One draft** (`COMPOSE_CANDIDATES = 1`); the judge path stays for a tier that earns it.
4. **Word budget 540/page** (min 440, max 660) so 120 paid pages print as 120 after cuts.
5. **Read-driven deletion-only cut** (`cutChapter`, purpose `cut-chapter`): the read's notes quote the sentences to delete and its bookNotes name the claims restated across chapters; the cut may only delete whole sentences or paragraphs, and `deletionOnlyResult` refuses any output that is not the draft minus whole sentences in order with 75–99.5% of the words kept. Nothing the model writes can enter the book through this pass.

Judge validation and the cross-chapter near-duplicate sweep (0 hits at Jaccard ≥ 0.5 over 2,815 sentences) are why the refrains are treated as a prompt problem and the recaps as a cut problem rather than a detector problem.

## Iteration 9 (composed-9, 2026-09-02) — same plan as composed-7

`patches/iteration-9-applied.py`, on top of iteration 8:

1. `previousChapterTail` is "where the previous chapter stopped, already printed: this chapter opens on its own first section's material and neither resumes, summarises nor answers that paragraph"; earlier chapters' cases may be named in passing, never re-told, dates and figures not repeated.
2. Planner and fallback stance guidance: the thesis is a claim about the subject, stated as a fact about the world, never a rule about reading evidence or making comparisons ("a method is not a thesis, and a writer given one performs it in every paragraph"); positions likewise.
3. Harness `--reuse-plan <projectId>` copies an approved plan instead of re-planning, so composed-9 runs on composed-7's plan (cmtjlkn0z0000g8g08zbzxerc) and the comparison measures the writing pipeline: rotation + content-only editor + one draft + 540 words/page + read-driven deletion-only cut + the tail rule.

## Iteration 10 (composed-10, 2026-09-02) — composed-7's writer back, product fixes kept

Read of composed-8/9 against composed-7 on the same plan: one position per chapter cost the book its argument, and stripping the editor's shape rules did not reduce the tics the theory said they caused. `patches/iteration-10-applied.py` restores composed-7's editor lines and shape notes and shows all positions again (`ROTATE_STANCE_POSITIONS = false`, kept as a documented rejection), and turns the read-driven cut off (`READ_SECOND_EDITS = false`; the code stays for a test on its own). Kept from 8/9: the tail rule and never-re-tell line, the 540-word budget (120 printed pages for 120 paid), the planner's thesis-about-the-subject guidance, one draft, `--reuse-plan`. Composed-10 runs on composed-7's plan: if it lands near 7.7 the configuration is stable and the budget is free; if it lands near 7.0, the panel's noise band is ±0.5 and the extra 6k words cost pacing.

### Where this leaves the balanced tier (2026-09-02, after ten composed runs)

Stable best: composed-7's configuration (`iteration-10-applied.py` state, budget 520). Panel plateau 7.3–7.7 on balanced; the panel's own spread on one book is up to 0.6. Everything tried at the prompt level against the five constant patterns — rules, measured notes, stance positions, form plans, best-of-2, whole-paragraph cuts, position rotation, stripped editor — either did nothing the readers noticed or made the book worse. The establish-then-withhold couplet and the paired antithesis are the balanced writer's (gpt-5.6-luna, effort low) house style. Ultra is not to be tested (Parsa, 2026-09-02; an ultra run was started by mistake and stopped with `scripts/dev-stop-project.ts`). The tiers under test are balanced and fast (Quick Draft): composed-12-fast runs composed-7's plan on the fast tier (qwen3.7-flash, thinking on).

## Writer model A/B (2026-09-02, Parsa: "try deepseek v4 pro or gemini 3.7 flash to see if the problem is the model")

Same plan (composed-7's), same balanced configuration, only `models.balanced.writer` swapped through an appended quality revision (`scripts/dev-set-tier-writer.ts balanced <provider> <model> [key=value]`; restore with `balanced restore 21`):

| run | balanced writer | revision |
|---|---|---|
| composed-10/11/12 | gpt-5.6-luna, effort low | 21 (7.33 / 7.17 / 7.43) |
| composed-13-fast | fast tier: qwen3.7-flash, thinking on | 21 |
| composed-14-deepseek | deepseek-v4-pro | 22 |
| composed-15-gemini | gemini-3.7-flash, effort medium (its premium setting) | 23 |

Then, per Parsa: composed-16-luna-medium (gpt-5.6-luna, thinkingEffort=medium), composed-17-luna-high (thinkingEffort=high), and composed-18-deepseek-vision (`deepseek-v4-flash-vision-exp`, the account's newest DeepSeek model; the routing takes any provider/model pair, so no catalog change), same plan. The luna low writer is restored afterwards (`balanced restore 21`).

The content-filter fallback (`isProviderContentFilterError`, `retry.ts`) shipped 2026-09-02 after composed-13-fast; the fast book was retried with the new `retry` command and resumed from its staged chapters.

**composed-13-fast FAILED at 62% (chapter 14/15).** Alibaba answered the compose call with `400 data_inspection_failed: "Input text data may contain inappropriate content."` on a chapter about genocide, and the book failed instead of falling back to the fast tier's `writerFallback` (deepinfra DeepSeek-V4-Flash). A provider content filter refusing a legitimate history chapter is a fallback case, not a book failure; every fast-tier history book with a chapter on mass violence hits it. To fix after the DeepSeek run (core edit restarts the worker), then `resume --project cmtjrc8gb0000qsg0pu9oacph --label composed-13-fast`.

| composed-14-deepseek (balanced config, writer deepseek-v4-pro, composed-7's plan) | **7.67** | — | 7.6/7.7/7.7; light ×3; slop Medium ×3; engagement 7/7/7 (every luna book: 5–6). Readers: "first nine chapters read as the work of a serious writer rather than a generator", opening carried by one archival detail, "the raw prose is already there". But: 39.9k words → **69 printed pages for 120 paid** (drafts short despite retries; the editor's extension did not close the gap), cost $1.09 (3× luna), 33 min; one internal contradiction (Dutemple 1914 vs 1870); the chapter template announced aloud ("The chapter has moved from a single document to a mechanism to an argument to a comparison"); the thesis sentence recycled verbatim at three chapter ends; "not a difference in human nature" formula; ordinal-step mechanisms. Deterministic: negation 61.7/1000 (luna 31–37), generalising closers 0.08 (0.35–0.40), top-5 shape coverage 0.61 (0.85), paragraph CV 0.30. So the readers' "paired antithesis" is not what the negation counter counts, and DeepSeek's variety shows up where the counters said luna was uniform. |

| composed-15-gemini (balanced config, writer gemini-3.7-flash effort medium, composed-7's plan) | **7.57** | — | 8.0/7.5/7.2; light ×3; slop Low/Medium/Medium; engagement 7/7/7, pacing 7/6/6. 48.9k words → **102 printed pages for 120 paid**, $1.10, **13 min**. Praised: tariff tables and ration tallies doing the arguing, a victim's voice (the Genizah letter), "unusually accomplished". Faults: chapters 1 and 2 both open on the Jebel Sahaba excavation with conflicting counts (the never-re-tell line did not hold); chapter 5's catalogue form came out as twelve colon-headed "Place: description" entries; rhetorical-question chapter closers; a garbled officer name; no synthesising conclusion. Same five shapes named. Deterministic: negation 33/1000, generalising closers 0.08, paragraph CV 0.41, top-5 shape coverage 0.78. |

### Writer A/B so far (same plan, same balanced configuration)

| writer | panel | printed pages / 120 | cost | minutes |
|---|---|---|---|---|
| gpt-5.6-luna, effort low (×3) | 7.31 (7.33/7.17/7.43) | 121–124 | $0.36 | 19–22 |
| deepseek-v4-pro | 7.67 | 69 | $1.09 | 33 |
| gemini-3.7-flash, effort medium | 7.57 | 102 | $1.10 | 13 |

Both alternatives beat luna by a margin the panel can see (engagement 7 vs 5–6) and both under-deliver pages; luna is the only writer that fills the budget. A per-book `revise-page` call fires once on nearly every composed book: the finalize step runs `reviewWholeBookDraftPages` (page-level local QA + revise) over composed pages, and one page per book fails a page rule and is rewritten in isolation.

### Fable opinion (`opinion-fable-2.md`, 2026-09-02) and the provenance probe

The reviewer's two checkable claims held: `bookPayload()` sends the plan's `voiceGuide`, `continuityRules` and `promises` to every compose/edit call (distribution rules in the writer's payload, against the repo's own rule), and the composed-14 writer's research notes for chapter 1 were twelve copies of one dictionary sentence from twelve domains. Its fabrication check on composed-14 (Dutemple, le Blake, Matilda atte Cross, James Jones as the Brookes' owner) stands: those names occur only in compose output.

`apps/worker/scripts/provenance-probe.ts <projectId> [label]` (run in the worker container): proper nouns in the book absent from everything the writer was shown (plan, research notes, payloads).

| book | distinct proper nouns | supplied by the model |
|---|---|---|
| composed-12-balanced (luna) | 579 | 145 (25%) |
| composed-14-deepseek | 677 | 183 (27%) — incl. William le Blake, Roger de Weston, Matilda, Pipe Rolls, Lahr |
| composed-15-gemini | 1,453 | 723 (50%) |

Crude (ordinary places and possessives count), so a fraction, not a guard; a guard needs an entity filter or a web check (reviewer's #1). What it shows: Gemini's density of particulars is 2.5× luna's and half of them are its own; the panel's "specificity" criterion rewards that without distinguishing sourced from supplied.

| composed-16-luna-medium (balanced config, gpt-5.6-luna effort medium, composed-7's plan) | 7.30 | — | 7.9/7.0/7.0; light/moderate/moderate; slop Low/Medium/Medium. 61.9k words, 125 printed pages, $0.39, 24 min. Same as luna-low (7.31): reasoning effort does not reach what the readers see. Same five patterns; the isolated one-sentence paragraph named by all three. |

**composed-17-luna-high FAILED at 70%** (project cmtjvbmgg0000qqg0xstu0qip): every chapter composed and edited, then the manuscript read returned `OpenAI response was incomplete: max_output_tokens` — at effort high the reasoning shares the read's 6,000-token output budget — and the whole book failed. Two defects: the read's budget does not scale with effort, and a read that only produces notes may not fail a paid book (the pass already handles a `skipped` read). Fix after the fast book finalizes, then `retry --project cmtjvbmgg0000qqg0xstu0qip --label composed-17-luna-high` (resumes from the staged chapters).

| composed-13-fast (fast tier: qwen3.7-flash thinking on, composed-7's plan) | **2.83** | — | 2.9/3.1/2.5; **major revision ×3; slop High ×3**. 56k words, 108 printed pages, $0.22, 153 min wall (failed at chapter 14 on Alibaba's content filter, retried after the fallback fix). Chapter 5 is 12,005 words of a rotating three-subject verb-chain ("The codex plate polished these tables, shining them with oils and creams"), drifting through supply-chain jargon into algebraic topology, with stray CJK tokens (索取, 绞合), stopping mid-sentence; chapters 1–3, 7, 10–11 drop articles into telegraphese; sentences duplicated verbatim inside chapters; invented authorities (Robert Belah, Joan Arzu, William Buddy Menziez, the Yukle Bei monument); an anachronistic "thirteenth-century" Çatalhöyük log; the book ends without a conclusion on a placeholder-grade case. **The pipeline published it as COMPLETE.** Nothing in the composed pass detects degenerate output: the compose retry only fires under 0.7×min words, the edit paraphrased the loop, the page rules passed it. Deterministic separation on 231 chapters across all runs: share of sentences opening on the same three words (≥6 sentences per opening) is 0.58 on the broken chapter, ≤0.26 everywhere else (a DeepSeek chapter's ordinal steps), 0.00 on every luna/gemini chapter; the chapter is 2.8× its word target where no other exceeds ~1.3×; CJK characters 4 vs 0. |

| composed-17-luna-high (balanced config, gpt-5.6-luna effort high, composed-7's plan) | 7.23 | — | 7.7/6.7/7.3; moderate ×3; slop Medium ×3. 56k words, 112 printed pages, $0.49, 48 min (first attempt failed at the read on `max_output_tokens`; retried after the read fix, the read then succeeded with the 16k budget). Effort low/medium/high: 7.31 / 7.30 / 7.23 — effort is not a lever. Two defects surfaced: the writer cites "psychstory.co.uk", "lumenlearning.com" and "wikipedia.org" by name in the prose (research notes reach it as "domain: snippet"), and the Atlantic statutes chronology is told in full in chapters 8, 10, 11 and 15 (the never-re-tell line does not hold). |

### Guards shipped after the fast and Luna-high books (2026-09-02)

- `chapterDegeneracy` (`packages/core/src/generation/chapterIntegrity.ts`): a composed draft is recomposed once and then fails the job if ≥40% of its sentences open on a three-word template repeated six or more times, or it exceeds 1.8× the chapter's word maximum, or (Latin-script books) it carries more than two characters of another script. Calibrated on 231 chapters: fires on composed-13's chapter 5 and nothing else. An edited chapter that trips it is discarded for the draft.
- The manuscript read degrades to "skipped" on a provider failure and runs with a 16k output budget (`readManuscript`).
- A provider content-filter refusal falls back to the configured fallback writer (`isProviderContentFilterError`).
- Writers are told never to name a website, domain or URL in prose (research titles are often bare domains).
- Harness: `retry` re-queues a FAILED book on its approved plan and the composed pass resumes; `--tier` writes the tier into the copied plan's snapshot.

Open, noted for the product: the research adapter's `title` is the domain for many hits and the summary is often one sentence repeated across domains (chapter 1 of composed-14 had twelve copies of one dictionary sentence); `reviewWholeBookDraftPages` rewrites one page per composed book on the dash rule; the fast tier's `extract-story-state` per page at finalize is the slow part of a fast book.

| composed-18-deepseek-vision (balanced config, writer deepseek-v4-flash-vision-exp, composed-7's plan) | 6.57 | — | 6.5/6.7/6.5; moderate ×3; slop Medium ×3. 42k words → 73 printed pages, $0.25, 17 min; the guard discarded one 10.5k-word edit. Recycled chapter codas nearly verbatim ("The comparison preserves the difference…", "The question that remains open is whether…"), anaphoric list-paragraphs ("The log records…" ×6), a 1794 decree explaining a 1791 rumour, an interpretive point built on its own duplicated sentence. Below v4-pro (7.67) on every criterion the readers weigh. |

### Writer A/B, complete (same plan, same balanced configuration)

| writer | panel | printed / 120 | $ | min |
|---|---|---|---|---|
| gpt-5.6-luna low ×3 | 7.31 | 121–124 | 0.36 | 20 |
| gpt-5.6-luna medium | 7.30 | 125 | 0.39 | 24 |
| gpt-5.6-luna high | 7.23 | 112 | 0.49 | 48 |
| deepseek-v4-pro | 7.67 | 69 | 1.09 | 33 |
| gemini-3.7-flash medium | 7.57 | 102 | 1.10 | 13 |
| deepseek-v4-flash-vision-exp | 6.57 | 73 | 0.25 | 17 |
| qwen3.7-flash (fast tier) | 2.83 | 108 | 0.22 | 153 (with the refusal retry) |

Luna's reasoning effort does nothing; DeepSeek V4 Pro and Gemini 3.7 Flash read better (engagement 7) and under-fill the pages, with DeepSeek's particulars partly invented; the fast tier's writer produced a broken book, now caught by the guard.

### Ablation 1 — Luna at 480 words/page, one draft, ×3 (composed-19a/b/c, composed-7's plan)

| replicate | panel | words | printed pages |
|---|---|---|---|
| 19a | 7.60 (7.5/7.8/7.5) | 53.2k | 108 |
| 19b | 7.43 (7.2/7.2/7.9) | 54.0k | 111 |
| 19c | 6.93 (7.2/6.8/6.8) | 54.1k | 112 |

Arm mean **7.32** against **7.31** for the 520-word arm (composed-10/11/12, 59–61k words). Length is not the composed-7 effect; 7.73 was the favourable end of a band whose replicate spread is now 0.67 (6.93–7.60) on identical configuration. New defects the readers found in this arm: a drafting instruction leaked into prose ("in half a sentence"), chapter 9 restating chapter 1's definitions, Baghdad 1258 told twice, no conclusion in one replicate. Budget goes back to 520 (120 printed pages).

### Ablation 2 — plan's voiceGuide, continuityRules and promises out of the writer payload, ×3 (composed-20a/b/c, 480 words/page, composed-7's plan)

| replicate | panel |
|---|---|
| 20a | 7.20 (7.3/7.1/7.2) |
| 20b | 6.73 (6.6/6.8/6.8) |
| 20c | 7.30 (7.8/7.2/6.9) |

Arm mean **7.08** against 7.32 with the rules in (composed-19). The readers named the same five moves in the same words, so the plan's distribution rules were not their source; the couplet and the caveat come from the model given this prompt. Reverted after the run. Textual defects surfaced in this arm: a garbled name ("Lieutenant Colonel Arthur L. Y. N. N."), a broken Hadrian sentence, one summary clause reproduced verbatim inside chapter 6, Toussaint narrated twice, a Kano succession with the same name on both sides.

### Ablation 3 — prompt subtraction, ×2 (composed-21a/b: stance + forms + material + budget + grounding, no shape rules, no bans, no measured notes to the editor; 480 words/page; distribution rules also out)

| replicate | panel | words |
|---|---|---|
| 21a | 6.47 (6.2/6.4/6.8) | 62.5k |
| 21b | 6.53 (6.0/6.5/7.1) | 60.1k |

Arm mean **6.50** against 7.32 for the full prompt. The compose prompt fell from ~1,700 to ~1,050 words and the books got longer, looser and more repetitive: the same five moves, plus near-verbatim clause strings reused across chapters, a case compared before it was introduced, and "specificity is thin for the length". For this writer the bans and shape rules are net positive, not the source of the tics. The "house style" conclusion stands with a control behind it now.

### End of day (2026-09-02): the configuration that ships

Full prompt (`COMPOSE_PROMPT_MODE = "full"`), measured and shape notes to the editor, the plan's distribution rules in the writer payload, all stance positions, one draft, 520 words/page, the read on with its second edits off, plus the guards shipped today (degeneracy, read degrade, content-filter fallback, no domains in prose). Balanced level 7.3 ± 0.4 on this plan; the one lever the panel can see is the writer model.

| arm (all on composed-7's plan, luna low unless stated) | mean | n |
|---|---|---|
| full prompt, 520/page | 7.31 | 3 |
| full prompt, 480/page | 7.32 | 3 |
| distribution rules out | 7.08 | 3 |
| prompt subtraction | 6.50 | 2 |
| writer deepseek-v4-pro | 7.67 | 1 |
| writer gemini-3.7-flash medium | 7.57 | 1 |

## Iteration 22 (composed-22a/b/c, 2026-09-02) — the second Fable opinion's top items

`opinion-fable-3.md` (read it): don't spend the extra tokens on prose; two code defects were constant across all 21 runs. Applied (`patches/iteration-22-applied.py`):

1. **Research routing** (`expandChapterResearch`, planner.ts): every chapter is searched (the query list was capped at 12), sources are capped *per query* (8) instead of over the flattened list (12 total, all chapter 1's), and each query's synthesised brief is stored as a URL-less "Research brief" row. `loadResearchNotesForGeneration` reads the whole project's rows when it has a chapter to match and ranks a chapter's own query first (its title is in the query), then the brief, then by shared terms — word overlap alone had put three chapters' briefs ahead of chapter 1's own. Verified live: 225 rows over 25 queries with 25 briefs; chapter 1's writer received 16 notes. Test: `planner.test.ts` "searches every chapter…".
2. **Form-plan shape** (`compositionShapeIssues`, chapterForms.ts): every chapter with the same section count, or a chapter with evenly split shares, is an issue for the repair call (never for the deterministic settle, whose contract is to clear form issues); the planner is told to vary counts and give each chapter one section ≥40% and one <15%; the writer sees each section's word count.
3. **Prompt order for caching**: the compose and edit system prompts open with the book-stable block and end with the chapter lines, so OpenAI's prefix cache can hit (0 of 63 calls hit before).
4. **Flat stance positions** for the reused plan (`--stance-positions .scratch/composed-chapters/stance-positions-flat.json`): the five antitheses replaced by five claims about the subject.

Three replicates, 520 words/page, luna low, composed-7's plan. Compared against the 520 arm (7.31).

### Iteration 22 result (composed-22a/b/c)

| replicate | panel | words | printed | $ |
|---|---|---|---|---|
| 22a | 7.60 (7.7/7.5/7.6) | 54.1k | 112 | 0.48 |
| 22b | 7.53 (7.4/7.6/7.6) | 51.9k | 107 | 0.47 |
| 22c | 7.20 (6.6/7.5/7.5) | 55.1k | 114 | 0.50 |

Arm mean **7.44** against 7.31 for the 520 arm (three replicates each); spread 0.40 against 0.26–0.67. Thesis 9 in eight of nine verdicts, depth 7–8, engagement still 6, pacing 5–6. The same five moves named. New defects the inputs produced: the writer cited "the research brief" / "the research record supplied for this history" in prose (the brief reached it titled; now untitled, and both writers are told never to refer to their notes), and one chapter discusses Samori Touré for a page before introducing him. Cost +37%: every payload carried 14.7k words of research because a flat brief bonus put all 25 briefs ahead of a chapter's own sources — fixed after the run (own query first, other chapters' briefs excluded). Section counts came back 4–5 everywhere: the planner ignored the request for uneven counts and the shape check only fires when every count is equal. Cache hits: 0 of 48 despite the reordered prompt.

## Iteration 23 (composed-23a/b/c) — token trims and assigned section counts, on top of 22

`patches/iteration-23-applied.py`: previous-chapter tail 1,200 → 300 words; earlier-chapter digests capped at 60 words and carrying `told` (the cases each chapter's sections owned); section counts assigned per chapter by walking the range (the planner asked to vary them returned 4–5 everywhere); composed pages may fail only the two integrity rules in the per-page finalize review (the dash rule was rewriting one typesetting cut per book); OpenAI requests carry a `prompt_cache_key` derived from the stable prompt prefix (0 of 48 calls hit before). Research ranking fixed after 22 (own query first, other briefs excluded) and the brief untitled with a rule never to refer to notes. Flat stance positions kept. Expect: same or better than 7.44 at roughly 22's cost minus the digests and tails, with cache hits.

**Caching, settled (2026-09-02):** a probe through the worker's own client: the same 1,621-token prompt sent twice hits 1,604 cached tokens; two of composed-23's consecutive compose prompts, sharing a 6,151-character prefix (~1,500 tokens), hit 0. The gateway behind `gpt-5.6-luna` caches whole prompts, not prefixes, so the prompt reorder and `prompt_cache_key` cannot save tokens on this provider. Both stay (correct for prefix-caching providers); the savings claim does not. Verified live on composed-23a: research 1.6–2.2k words per payload (was 14.7k), tail ~360 words (was ~1,200), `told` present.

### Iteration 23 result (composed-23a/b/c)

| replicate | panel | words | printed | $ | min |
|---|---|---|---|---|---|
| 23a | 7.57 (7.5/7.9/7.3) | 53.8k | 110 | 0.33 | 28 |
| 23b | 7.33 (6.8/7.7/7.5) | 50.7k | 104 | 0.32 | 27 |
| 23c | 7.47 (7.7/7.6/7.1) | 55.4k | 115 | 0.36 | 77 |

Arm mean **7.46** at the base cost (22 was 7.44 at $0.48; base 7.31 at $0.35). Slop "Low" in two verdicts, engagement 7 in two, thesis 9 in eight of nine. Same five moves. Defects: "the supplied evidence" / "figures supplied for this period" (a spelling the note rule missed — source-packet language is now a page-leak pattern and the writers' rule names the phrases), Jebel Sahaba still opened twice (chapters 1 and 2 both own it in the plan), one factual slip (the Lachish reliefs assigned to Ashurnasirpal's palace), an Ibn al-Athir contradiction. Section counts 4–7 (assigned, the planner kept them within one of the assignment).

### Shipping configuration after the second opinion (2026-09-03)

Composed-7's writer configuration + iteration 22/23: every chapter searched with its brief and sources routed to its own writer (own query first, other chapters' briefs excluded, brief untitled), assigned section counts walking the range with shares asked to spread, the previous tail at 300 words, digests at 60 words with a `told` registry, composed pages failing only integrity rules in the finalize review, source-packet language a page leak, `prompt_cache_key` on OpenAI calls (inert on this gateway), 520 words/page. Six replicates on composed-7's plan: 7.20–7.60, mean 7.45, against the base's 7.17–7.43, mean 7.31 — at the base's cost. The planner's flat-claim stance guidance covers new plans; the test plan's positions were overridden by file.

## Arm 1 of the paradigm shift (composed-24a/b/c-arc) — book arc + seams + tail cuts, per opinion-fable-4 §1.6 A+B+C

Built 2026-09-02/03 on top of the committed iteration-23 state (`abde3af`). Everything below is a
switch or a new module; nothing from 23 was removed.

**New modules.** `packages/core/src/schemas/bookArc.ts` (the `BookArc` zod schema: `question`,
verified `opponent`, `answer`, `turn`, per-chapter `kind` ∈ case/argument/portrait/document/
complication/method/resolution, `pages`, `job` {believesSoFar, does, adds, leavesOpen}, `cast`,
`dispute`, `proposal`) and `packages/core/src/generation/bookArc.ts` (`architectBook` — one
`architect-book` call after the stance; `planBookArc`; `applyBookArcPages` — the plan's page cut is
replaced by the arc's only when it covers every chapter once and sums to the book;
`arcChapterLines` — the chapter's job, cast and dispute as prompt lines, with *"Do not state the
book's answer"* on every chapter but the resolution). `packages/core/src/generation/seams.ts`
(`rewriteSeams` — one `rewrite-seams` call over every chapter's first and last paragraph together,
with the read's `bookNotes`; `acceptSeam` keeps a candidate only at 0.6–1.4× length that preserves
every proper noun ≥4 letters and every number, and pairwise closing Jaccard < 0.5 across chapters;
a rejected paragraph keeps the original). `cutChapterTail` in `composedChapter.ts`: the read-driven
deletion-only cut now sees only the last ~600 words of a chapter and splices the rest back.

**Prompt changes under an arc.** Middle chapters get the stance's rhythm exemplar only — no thesis,
no positions — plus their arc lines; the first and last chapters keep the full stance. The
"state what a source shows" rule survives only for `method` chapters. The form planner takes a
`kind` per range and the page guidance asks for three-to-fourteen-page chapters.

**Worker.** `composedChaptersPass.ts`: `BOOK_ARC = true` (arc planned once, persisted onto
`planningPackage.bookArc` beside the stance, re-read on resume), page re-cut before
`chapterSetupsForPlan`, `kind` to the forms planner, `arc` in every compose call;
`SEAMS_TOGETHER = true` (after the read, before the flagged loop; changed chapters are re-described
and re-staged with `seamsApplied` on the report); `READ_SECOND_EDITS = true` (tail cuts on the
read's `edit` chapters). Tests: `bookArc.test.ts`, `seams.test.ts`, the pass test now expects two
plan writes, one `architect-book`, one `rewrite-seams`, and describe-pages twice per chapter.

**Tier configuration for the arm** (`scripts/dev-set-quality.ts`, new): revision 29
`chapterEditorPass` off for balanced (the paraphrase edit dropped, per Fable-4); revision 30
`balanced.judgment` → `deepseek/deepseek-v4-flash` (describe-pages and the other mechanical
purposes off Luna). Writer unchanged: Luna, effort low. Restore with
`dev-set-quality.ts restore 28`.

**Launch** (2026-09-03 20:50, three in parallel, composed-7's plan, flat stance positions):
`run --source cmtjbz54o000w6rjyvzewwqj4 --label composed-24{a,b,c}-arc --reuse-plan
cmtjlkn0z0000g8g08zbzxerc --tier balanced --stance-positions stance-positions-flat.json`.
Projects: 24a cmtkkll9t0000zzg0f1b3x7y1, 24b cmtkklmtx00002rg0q509w9xh, 24c cmtkklo7600008mg0lobpv0jh.

**Pre-registered pass criterion** (Fable-4): nine-reader mean engagement ≥ 7.0 and pacing ≥ 6.5
(iteration 23: 6.0 / 5.7); overall is secondary. Confounds accepted knowingly: the editor pass and
the judgment model change ride the same arm, as the advisor prescribed.

### Arm 1 as launched was only half the design — composed-24 result and the developer review

`developer-review-arm1.md` (Fable, 2026-09-03), read while 24a/b/c were generating: the arc's page
re-cut never reached the chapter setups (`setups` was computed before the arc; the re-bound `plan`
fed prompts only), the cut was not persisted with the plan (compile headings walk the stored
`targetPages`), a failed architect was silent, the thesis reached middle chapters through
`premise`/`promises`/`chapter.summary`/the form planner, the opponent reached only the resolution
and `turn` nobody, seams ran before the cuts and a seams failure failed the book. So composed-24
measured: arc job/kind lines (with leaks), seams, tail cuts, editor off, judgment on DeepSeek —
not length variety and not real withholding.

**Composed-24a/b/c (partial arm), nine readers:** overall 7.63 / 7.43 / 7.63 = **7.56** (23: 7.46;
band ±0.4). Engagement 6.33 / 6.00 / 6.33 (23: 6.00), pacing 5.67 / 6.00 / 6.00 (23: 5.67). Neither
pre-registered threshold met (7.0 / 6.5). Cost $0.26–0.28, 30 min (editor off, describe-pages on
DeepSeek V4 Flash: the cheapest balanced book so far). Mechanics: architect answered in all three
(Pinker as opponent; turn at 10 repaired by 11; kinds varied; pages 8×13 + 12 + 4, inert); seams
accepted 5/30, 2/30, 4/30 (the model returned most paragraphs unchanged); read flagged 14/12/11
chapters, tail cuts applied on 10/10/8; `stopsDevelopingAt` 11 / 8 / 12; 24a printed 109 PDF pages
for 120 paid (the cuts), 24b 129.

**What the readers said, all nine:** the same five moves as before ("X establishes A; it does not
establish B", paired antithesis, aphoristic one-liners, enumerated chains, recap tails) **plus one
new one manufactured by the arc**: every chapter stages two named scholars, grants each a part and
declines to adjudicate ("their disagreement improves the question") — the per-chapter `dispute`
line with "Argue it by name". A prompt field that is present in every chapter is a template
whatever it says.

**Fixes applied (2026-09-03, `patches/arm1-fix*.py` in the job dir; all suites green):** stance →
arc → cut → setups; `persistBookArc` writes `bookArc` + cut `chapters`, and overwrites an arc that
no longer parses; `architectBook` returns `{arc | failure}`, warns on failure, no `proposal`, 8k
budget; `repairArcPages` scales a cut that does not sum (clamp 3..14, residual onto the largest);
`arcChapterLines` shows the opponent to chapter 1, every `argument` chapter and the resolution
(`whereTheBookBreaks` only there), the turn to its chapter and the repair to the next one, drops any
job line sharing ≥4 content words with the answer, and shows the `dispute` only to `argument`
chapters (architect prompt says so too); middle chapters' `bookPayload` gets the question for
`premise` and no `promises`, `chapter.summary` becomes the arc job; the form planner gets the
question for the thesis, no positions, and the job for the summary; the read gets the arc and
returns `answerStatedIn`, logged with `stopsDevelopingAt`/`swappable` as `read_metrics`; cuts run
before seams; `rewriteSeams` failure → skipped; re-describes three at a time; seams gated on
Latin-script languages; `applySeam` ignores trailing blank lines; `arc` source on the report.
Rendered-prompt test: a middle chapter's whole prompt contains none of answer, premise, promises,
positions or the plan summary.

**Composed-25a/b/c-arc2**: the corrected arm 1, same recipe, launched after the fixes.

### Composed-25a/b/c-arc2 result — the corrected arm 1, and the decision

| replicate | panel | words | printed | $ | min | seams applied | tail cuts | answerStatedIn (read) |
|---|---|---|---|---|---|---|---|---|
| 25a | 7.00 (7.0/7.0/7.0) | 53.8k | 108 | 0.32 | 32 | 1 | 12 | — (not returned) |
| 25b | 7.63 (7.6/7.7/7.6) | 60.5k | 121 | 0.34 | 28 | 6 | 10 | 10 of 14 chapters |
| 25c | 7.53 (7.9/7.2/7.5) | 50.9k | 102 | 0.30 | 30 | 6 | 11 | 14 of 14 chapters |

Arm mean **7.39** (24 partial: 7.56; 23 baseline: 7.46, six replicates 7.45). Engagement 6.00 /
6.33 / 6.33 = 6.22 (24: 6.22; 23: 6.00). Pacing 5.00 / 5.67 / 6.00 = 5.56 (24: 5.89; 23: 5.67).
Pre-registered thresholds (7.0 / 6.5) not met; nothing outside the ±0.4 band. The wiring was
verified live this time: the arc's page cut reached the Chapter rows (chapters ran 1,500–6,200
words: a 4-page document chapter, 12–14-page case chapters), the form planner saw the question with
no positions, middle chapters saw the question for the premise and the arc job for the summary,
the opponent (Pinker in all three) reached chapter 1, the argument chapters and the resolution.

**The finding that matters:** with every thesis field withheld from the middle chapters' prompts,
the manuscript read reported the book's answer stated in 10 of 14 (25b) and 14 of 14 (25c)
non-resolution chapters. The writer reconstructs the answer from the question and the chapter's
job and lands on it anyway; the same five moves were named by all nine readers, in the same words
as in every earlier arm ("establishes X but cannot establish Y" in nearly every evidentiary
paragraph, the "silence of the record" set-piece, paired antithesis, verdict paragraphs). Withholding
in the prompt is not withholding in the prose. The kinds and the page variety were real and the
panel did not notice them.

**Decision (Parsa: "change the code to the last best result and implementation"):** the default
is the iteration-23 pipeline — `BOOK_ARC = false`, `SEAMS_TOGETHER = false`,
`READ_SECOND_EDITS = false` in `composedChaptersState.ts`, quality revision 31 = a copy of 28
(editor pass on for balanced, judgment on Luna). Iteration 23 is the best *replicated* result
(7.46 over six books, base cost); composed-24's 7.56 is three books on wiring that was defective by
design, inside the band, and not reproducible as code. The arm-1 modules (`bookArc.ts`,
`seams.ts`, `manuscriptRead.ts` split out of `composedChapter.ts`, `cutChapterTail`,
`dev-set-quality.ts`) stay in the tree, tested, behind the flags, for the next arm.

**Untested, cheap lever left on the table:** the 24/25 tier row (editor pass off, describe-pages
and other mechanical purposes on DeepSeek V4 Flash) cut the book to $0.27–0.34 with no measured
loss — but it was never measured *alone* on the 23 pipeline (the developer review's confound
objection). One ×3 arm would settle it.
