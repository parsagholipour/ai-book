# Opinion 6: the ceiling is the rubric's and the plan's; the room is in the last third of the chapter

Written 2026-09-03 against `ladder-report-2026-09-03.md`, `session-report-2026-09-03.md`, opinions 4 and 5,
`plan-5c93566-amendments.md`, the 111 verdicts under `evals/` for the baseline, the arc and the seven rungs, the
twelve pairwise verdicts, the traces, and the prompts in `composedChapter.ts`, `composedChapterMaterial.ts`,
`chapterExits.ts`, `chapterForms.ts`, `composeScene.ts`, `chapterApparatus.ts` and `composedChaptersPass.ts`. I
read chapters 1, 8 and 15 of ladder-6a-exits and of composed-23a-trim, and the opening and closing paragraph of
every chapter of 6a, 5b and 7b. Nothing was changed, nothing generated, no panel run. Four measurements the
record did not have are in §2; the rest is argument. Rung means below are nine-reader means; a book mean is three.

## Verdict in one screen

| Question | Answer |
|---|---|
| Why not 8 | The mean is ten equal criteria. Seven sit at 7.8–8.9 on every rung and the readers never give a 10, so they hold at most +0.5 between them. The other three carry the gap — at rung 5: engagement 7.00, pacing 6.11, slop resistance 6.44 — and 8.0 needs them to sum to 22.2 against 19.6 now. Pacing is the one that cannot move on this plan: no book of the sixty, by Luna, DeepSeek or Gemini, has averaged above 6.33 on it, because the rubric's pacing is redundancy across 52,000 words and the plan is fifteen demonstrations of one claim. Criterion 10 is anchored on a list the output format fills every time (57 of 57 ladder verdicts name exactly five patterns). Those two are ~1.9 of the 2.7 points. The remaining ~0.8 is engagement, which told material does move — and every uniform placement of it is charged back on criterion 10. |
| The instrument's share | About a point of the gap, and it is not noise so much as construction: the pattern list saturates, the slop score has twice the reader variance of any other criterion (within-book SD 0.46 against 0.25 for engagement), and there is still no human-written book scored on this rubric, so "8" has no unit. A three-book rung detects a 0.6 change, not the 0.3 the ladder has been reading; identical-configuration replicates (6a 7.97, 6c 7.17) span more than the whole ladder's rung means (7.32–7.76). |
| The writer's share | Slop resistance's floor and craft's ceiling. The couplet counter fell 44 → 5 per thousand and the readers renamed the move ("not merely a place where grain waited") — criterion 10 scores a gestalt the detector cannot reach, and effort halves it without moving the panel. Under the Luna-only constraint, 7.0 on slop (rung 6) is the best measured and came at engagement's cost. |
| The design's share | Two things never touched. The plan itself overlaps chapters 1/2 and 13/15, and the episode planner has no ownership rule, so readers of eleven books, the baseline included, name the same case narrated twice. And the editor's extension: the compose call delivers ~87% of its ask, and the editor is then told to "develop the existing sections with more particular detail" — 8–26% of every material-first book is written by a call whose payload carries no dossier, no episodes and no scene (§2.1). The praised 5b chapter 8 is 82% larger after the edit than the writer left it. |
| The trade the ladder found | Along the scene count the panel moves one for one: rung 3 (13–15 scenes) engagement 7.22 / slop 6.11; rung 5 (7–8) 7.00 / 6.44; rung 6 (2–3) 6.56 / 7.00. The sum sits at 13.3–13.6 from rung 2 onward and falls only where a stub appeared (rung 7, 12.66). Nothing since the creative contract has moved the frontier; rungs 3–6 moved along it. |
| The two open options | (a) softening the exit line is a third rule about the last sentence, after the landing forms and the exits; 6a's readers named all three exit kinds as stubs already. No. (b) material on the non-scene openings is half right: told material moved engagement, apparatus (rung 5's epigraph) moved slop and not engagement. Yes — but told, by the narrating call, and at the *close* of the chapters the opening scene does not reach, so the scene cap holds and no position is uniform. |
| Build first | Told closing sections on five chapters, written by the scene call from the chapter's own episode, replacing the editor's extension (§6). Then episode ownership as a deterministic rule on the episode JSON, the epigraph OCR filter, and the human calibration of the rubric — the last of which costs $3 and decides whether 8 exists. |
| Trust | Per-criterion means, counts, and the pairwise on fixed chapters. Not the ten-criterion mean below a 0.6 difference, not the pattern list, and not rung 6 against rung 7 (0.26 apart, same stub in both). |

## 1. Why not 8

### 1.1 The decomposition

Nine readers a rung; the arc and the two other writers for scale.

| | thesis | struct | depth | reason | clarity | voice | **engage** | **pacing** | craft | **slop** | mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline 23a–c | 8.89 | 7.78 | 7.11 | 8.11 | 8.89 | 7.67 | 6.00 | 5.67 | 7.89 | 6.56 | 7.46 |
| rung 2 creative | 8.89 | 7.78 | 8.00 | 8.56 | 8.89 | 8.00 | 6.67 | 6.00 | 8.00 | 6.78 | 7.76 |
| rung 3 material | 8.67 | 7.67 | 7.67 | 8.11 | 8.78 | 7.78 | 7.22 | 6.11 | 8.11 | 6.11 | 7.62 |
| rung 4 couplets | 8.78 | 7.56 | 7.89 | 8.11 | 8.33 | 7.78 | 6.78 | 5.89 | 8.00 | 6.00 | 7.51 |
| rung 5 apparatus | 8.89 | 7.78 | 7.78 | 8.22 | 8.67 | 8.22 | 7.00 | 6.11 | 8.22 | 6.44 | 7.73 |
| rung 6 exits | 8.67 | 7.67 | 7.67 | 8.33 | 8.56 | 7.78 | 6.56 | 5.89 | 7.67 | 7.00 | 7.58 |
| rung 7 exits2 | 8.44 | 7.22 | 7.67 | 8.11 | 8.11 | 7.56 | 6.33 | 5.78 | 7.67 | 6.33 | 7.32 |
| composed-25 arc | 8.56 | 7.67 | 7.33 | 8.22 | 8.33 | 7.89 | 6.22 | 5.56 | 7.67 | 6.44 | 7.39 |
| composed-14 DeepSeek (n=3) | 9.00 | 8.00 | 8.00 | 8.00 | 9.00 | 8.00 | 7.00 | 6.00 | 8.00 | 5.67 | 7.67 |
| composed-15 Gemini (n=3) | 8.33 | 8.00 | 8.67 | 7.33 | 8.33 | 7.33 | 7.00 | 6.33 | 8.00 | 6.33 | 7.57 |

Seven criteria never left 7.6–8.9 on any rung, and across the 174 verdicts in `evals/` no reader gave a 10 on any
criterion; the practical ceiling is 9. Thesis (8.9) and clarity (8.7) are there. Reasoning, voice and craft
(8.2) have perhaps +0.4 each, structure and depth (7.8) perhaps +0.5 — and structure's deduction is "every
chapter obeys the same architecture" (5b-A, 6a-A, 7a-A), a property of the plan. Call the seven's headroom
+0.5 in total, and only if nothing else moves.

The three that carry the gap, with what each has measured across the ladder:

- **Engagement** 6.00 → 6.67 (creative contract) → 7.22 (scene on every chapter) → 7.00 (scene on half) →
  6.56 (scene on a fifth) → 6.33. The one criterion that moved, and it moved with told material and nothing
  else. Book-level maximum in the programme: 7.33 (3a, 3c, 5b). Pool maximum from a single reader: 8, given
  three times in 174 verdicts.
- **Pacing** 5.67 → 6.11 and back. No rung, no writer, no arc. Pool mean 5.64; no reader in 174 verdicts has ever given
  more than 7, and 7 only seven times; no book of the sixty has averaged above 6.33 (Gemini); the DeepSeek book at 69 printed pages
  scored 6.0, so it is not length. What the readers write under it is book-scale: "Jebel Sahaba is argued
  twice across Chapters 1 and 2" (23b-B), "Baghdad and al-Tusi told twice at length, Pinker twice" (6a-A),
  "the thesis is restated in near-identical two-clause form perhaps forty times; at 55,000 words the book
  proceeds at one unvarying speed" (7b-C), "excellent at chapter length becomes predictable at book
  length" (5a-C).
- **Slop resistance** 6.56 → 6.78 → 6.11 → 6.00 → 6.44 → 7.00 → 6.33. It moves *against* the scene count
  (§2.3) and with the exits' stub (rung 7). Within-book reader SD 0.46, the noisiest criterion by far.

### 1.2 What 8 requires, as numbers

At rung 5 the seven non-target criteria sum to 57.78, so engagement + pacing + slop must sum to 22.22
(now 19.55): for example **engagement 7.6, pacing 7.0, slop 7.6**. Pacing 7.0 as a nine-reader mean is 0.67
above the best book any writer has produced on this plan and 0.9 above the best rung. If the seven were
all lifted to 6a's readers' levels (9, 8, 8, 9, 9, 8, 8 = 59), the three would still need 21.0 — 6a's own
readers gave 7 / 6.33 / 7.33 = 20.67, one pacing point from one reader short of 8.0. So a single book has
been within noise of 8; a *rung* has not, and cannot while its replicates spread 0.8 on one configuration.

### 1.3 The instrument's part

1. **The pattern list is full by construction.** The rubric asks for "up to five concrete structural
   patterns … quote two instances each". Every one of the 57 ladder verdicts returns exactly five;
   highlights average 7.98 of "up to eight". A reader who has just written five patterns with two quoted
   instances each does not then give criterion 10 an 8. This is why the couplet's disappearance from the
   page (rung 4, 44 → 5 per thousand) produced a list of five different patterns and the same score. The
   list cannot show a reduction, and it was never de-primed (Fable-4 §3.6, unrun).
2. **Criterion 10 charges any uniform thing, including material.** The criterion text names "uniform
   paragraph shapes" and "templated moves"; a dated vignette opening every chapter is a template whatever
   it contains, and the readers said so at rung 3 in one voice. So the criterion that content moves (7)
   and the criterion that uniformity costs (10) are opposed for any lever applied to every chapter, and
   the rung-by-rung sum of the two has been flat at 13.3–13.6 since the creative contract (§2.3).
3. **Absolute pacing is not pairwise pacing.** On fixed chapters the pairwise readers gave pacing to the
   chapter that opened on a scene, eight of eight (baseline vs 5b) and both chapter-8 pairs since; the
   absolute readers score pacing on the book and it has not moved. The instrument that can see a chapter
   move cannot see a book stop repeating, and the mean is scored on the second.
4. **Noise.** Book-to-book spread on one configuration is 0.26–0.80 (6a/6c is 0.80); a three-book rung
   has an SE of about 0.2 from that alone, so a rung difference under ~0.6 is not a measurement. The
   ladder read 7.58 vs 7.32 (rungs 6 and 7) as a result; it is inside that band, and both books carry the
   same stub. Per-criterion means and counts are the readouts, as the session report already says.
5. **No calibration.** Fable-4 §3.2 proposed scoring three published trade histories on the identical
   rubric; it has not been done. Until it is, nobody knows whether Keeley or Pinker draws pacing 6 and five
   named patterns from this panel — in which case 8 is not a property of prose and the programme is
   chasing the rubric's ceiling.

### 1.4 The writer's part

Luna's argumentative engine is negation-then-substitution, in any surface form. The tight couplet went
from 44 to 5 per thousand (rung 4) and the 6a readers quote "A granary was not merely a place where grain
waited" and "The implement was not merely a weapon in the modern sense" as the same move; effort medium
and high halve it (Fable-5 §2) without moving engagement or pacing. Craft (8.0–8.2) and voice (7.8–8.2) are
pinned by the same cadence from above — readers praise "clean, concrete, free of the usual generative
tics" and dock the "semicolon-balanced antithesis … dozens of times" in the same verdict (6a-A). Under the
constraint this is a floor on criterion 10 of about 7.0 (rung 6's best) and a ceiling on craft of about
8.3. It is not the block; engagement and pacing are, and neither is cadence (session report §4.1, Fable-5
§2, rungs 1 and 4 all agree).

### 1.5 The design's part — two things the programme has not touched

**The plan overlaps itself, and nothing owns a case.** Composed-7's plan gives chapter 1 the
archaeological cases and chapter 2 "the archaeological record"; chapter 13 the genocides and chapter 15
"what history can explain" through Rwanda and Srebrenica. Readers of 23b, 23c, 25a, 3a, 4b, 6a, 6b, 6c,
7b and 7c name a case told twice — Jebel Sahaba, Nataruk, Baghdad 1258, Kigali, Douhet, Vicksburg,
Wannsee — and it is the first thing under pacing in most of those verdicts. The `told` registry gives the
writer a 60-word digest and a rule ("anything in told … is never re-told"); the episode planner
(`episodes.ts`) has no cross-chapter ownership rule at all, though the form planner has one for
sections; and under the creative contract the writer reaches for the famous case whichever chapter it is
in. This is the pacing lever the ladder never pulled, it is model-free on structured data (an assignment,
not a veto on prose, so Parsa's 99% rule does not bind it), and the readers' own count of it is the readout.

**The editor's extension is an unmeasured second writer.** §2.1. The compose call delivers about 87% of
its ask (the comment on `chapterWordBudget` says so and sized the budget around it); the editor is then
told, below 92% of target, to "develop the existing sections with more particular detail — the named
person, the document, the place, the next thing that happened". Its payload (`editChapter`) carries the
draft, the previous tail, the digests and the search snippets — not `episodes`, not `dossier`, not the
scene. In the material-first rungs that call wrote 8–26% of the book, unguarded by the scene contract,
the exit or the dossier. Whether it costs pacing the panel cannot yet say (the share does not track the
book means, §2.1); that it is a provenance hole under the creative contract, and the cheapest words in
the book to replace with told material, the counts can.

## 2. Four measurements the record did not have

### 2.1 The editor's extension share

From `trace.md` (`compose-chapter → N words`, `edit-chapter → N words`, scene words), whole book:

| book | compose + scenes | after edit | extension | chapters extended > 15% |
|---|---|---|---|---|
| composed-23a (grounded) | 53,791 | 53,792 | 0% | — |
| ladder-2b creative | 50,570 | 52,217 | +3% | — |
| ladder-3b material | 42,531 + 11,379 | 53,694 | **+26%** | 11 of 15 (ch 4 +58%, ch 10 +45%) |
| ladder-5a | 50,995 + 6,289 | 56,594 | +11% | 8 (ch 7 +66%) |
| ladder-5b | 44,781 + 5,410 | 52,757 | **+18%** | 8 (ch 1 +69%, **ch 8 +82%**) |
| ladder-5c | 57,084 + 5,191 | 59,306 | +4% | 4 |
| ladder-6a | 48,030 + 1,252 | 52,082 | +8% | 5 (ch 2 +57%, ch 9 +40%) |
| ladder-6b / 6c | | | +4% / +2% | ch 1 +61% / ch 8 +33% |
| ladder-7a / 7b / 7c | | | +8% / +2% / 0% | ch 1 +30% / ch 10 +29% / ch 1 +32% |

Three readings. The material-first prompt makes the compose call shorter (the dossier is up to 2,400
words of payload and the writer returns less), so the extension is largest exactly where the material is
richest. Chapter 1 — the opening scene in every book — is extended 16–69% in eight of nine books: the
scene's words are subtracted from the compose ask but the editor extends against the full budget. And 5b's
chapter 8, the Zong chapter that won every pairwise vote it was in, is 82% larger after the edit than the
writer and the scene call left it: the most-praised chapter in the programme is nearly half editor
expansion written without the dossier. The share does not track the book means (2b +3% 7.77; 3b +26%
7.73; 6a +8% 7.97; 7b +2% 7.17), so I do not claim it costs the panel; I claim it is unmeasured,
unguarded, and the cheapest words in the book to replace.

### 2.2 Pattern-count saturation

57 of 57 ladder verdicts: exactly five recurring patterns; 7.98 highlights of eight. The rubric's own
format fills the list; criterion 10 is scored after it is filled. A de-primed rubric (Fable-4 §3.6:
no list of moves in the criterion text, "up to five" replaced by "as many as you noticed, none if none")
is the only way this criterion can register a reduction.

### 2.3 The scene-count trade

| rung | scene calls / 15 | engagement | slop resistance | sum |
|---|---|---|---|---|
| baseline | 0 | 6.00 | 6.56 | 12.56 |
| 2 creative | 0 | 6.67 | 6.78 | 13.45 |
| 3 material | 13–15 | 7.22 | 6.11 | 13.33 |
| 4 couplets | 13–15 | 6.78 | 6.00 | 12.78 |
| 5 apparatus | 7–8 | 7.00 | 6.44 | 13.44 |
| 6 exits | 2–3 | 6.56 | 7.00 | 13.56 |
| 7 exits2 | 3–4 | 6.33 | 6.33 | 12.66 |

The creative contract moved the frontier once (+0.9 on the sum). Rungs 3, 5 and 6 sit on it and trade
along it; rungs 4 and 7 fall below it (the couplet rewrite on fifteen scenes; the stub). Twelve ladder books
give corr(engagement, scene calls) = +0.36 and corr(slop, scene calls) = −0.24 — weak at n = 12, but the
same sign as the rung means. A lever that raises engagement without paying criterion 10 has to put told
material where it is not uniform: different chapters, different positions, different kinds.

### 2.4 The exit, read from the page

The exit-aware count says 6a ends 0 of 15 chapters authorially; the readers say "every chapter terminates
in a formulaic apparatus paragraph — either a thesis restatement naming the chapter's three cases, or an
abruptly appended source citation with no analytic function" (6a-A), "a bibliographic capsule" (6a-B),
"a bolted-on citation sentence … repeatedly kills the chapter's closing cadence" (6a-C). The three kinds
on the page: *date* → "Fred Wendorf's *The Prehistory of Nubia* … records the Massacre at Jebel Sahaba …
sixty-one people were buried"; *excerpt* → "Jean Jules Jusserand, writing in *With Americans of Past and
Present Days*, described … and quoted a French statesman: '…'"; *person* → "In the final act of the
ordinance, Louis XIV ordered … and the *Code Noir* was registered in 1685" (after a chapter about the
*Zong* and the *Creole*). Silent landings → "Hamoukar's debris, Lagash's inscription, and Egypt's frontier
records connect durable warfare to the administrative conversion of surplus and labour". The stub is not
rung 7's; it is the exit line's, and rung 6 scored 7.58 with it. `exitPromptLines` asks that "the final
sentence of the chapter is that material itself" — a rule about the shape of the last sentence, handed
the material as a description ("what happened on 1219: the sack of Merv, told plainly, from Juvaini"),
and the writer performs it as a citation. The record has now tried three rules about the last sentence:
the landing forms rotation (`LANDING_FORMS`, whose sixth entry is already "a document or quotation: a
source's own words, then silence"), the landing itself, and the exits. All three were performed.

Two smaller things the readers dock that code can fix for nothing: OCR noise in epigraphs ("Be Jure
Belli ac Facis^" attributed to "The narrator", 6a chapter 1, named by two of three readers; "molt humble
terms … ſhaved", 7b chapter 10, named by two), one to two per book across rungs 5–7; and a Markdown list
merged into a paragraph by `varyParagraphs` (6a chapter 10, named by 6a-B).

## 3. The two options left open, and what the record says about each

**(a) Soften the exit line — "end inside the material rather than set it down last".** This is the fourth
formulation of the same instruction, and the amendments plan's own principle argues against it: "one fewer
instruction the writer can perform". The last sentence is the position the writer will always perform a
rule at, because it is the one place where a rule about shape has no material competing with it. Every
exit kind that reached the page in 6a was read as a stub; the *landing* chapters were read as recap. A
gentler sentence will be performed more gently. Not this.

**(b) Material on the openings of the ~10 chapters the scene call no longer reaches — "a set-off document
or a count as the first block".** The direction is right and the form is wrong. What moved engagement was
*told* material: the scene call, whose output the readers single out in every book ("the Zong opening is
the strongest narrative writing in the book", 6a-B; "the narrative openings — Peterloo, Lachish, the
Bastille — are genuinely well written", 7b-C). What a set-off block is, is apparatus, and the apparatus rung
(5: the epigraph) moved slop +0.44 and engagement 0 against rung 4 with fewer scenes. Put told prose on the
chapters the opening scene does not reach — and put it at the *close*, where the exit line failed, so that
the opening cap (≤ 5 scenes, none consecutive) stands and no position in the chapter is uniform across the
book. The chapter then ends inside an event because its last 700 words *are* one, written by the call that
knows how to write one, and no line about the last sentence exists.

## 4. What to do next, ranked

| # | Change | Content assignment, or why exempt | Criterion | Cost | Readout before the panel | Falsified by |
|---|---|---|---|---|---|---|
| 1 | **Told closing sections** on ≤ 5 chapters that do not open on a scene: the chapter's second scene/portrait episode, with its excerpts, written by `composeScene` in a closing register and appended after a deletion-only trim of trailing authorial sentences; the compose call told the last ~700 words are already written and to write toward them. `chapterExits` off. Editor extension off (§4 #4). | Content: an episode and its documents, assigned by chapter, told by a call that only tells. The position is decided by the form plan and the cap, not by a line the writer sees. | engagement (+0.4), slop held ≥ 6.8 | +$0.015 (five scene calls), −$0.01 (extension output) | closings 5, openings ≤ 5, no chapter both, no two consecutive chapters told at the same position; chapters ending inside told text 5; extension words ≤ 2% of book | engagement < 6.8, or slop < 6.4, or ≥ 5 of 9 verdicts naming the closing vignette as a pattern |
| 2 | **Episode ownership.** After `planEpisodes`, a deterministic pass over the JSON: no person + document pair and no (place, date) pair in two chapters; a duplicate is dropped from the later chapter and the planner is re-asked for that chapter alone. The form planner already has the rule for sections; the episodes have none. Add to the compose payload's `told` the episode titles of every earlier chapter as names, not digests. | Exempt: an assignment on structured data before prose exists; it vetoes nothing the writer wrote. | pacing (the readers' first complaint), structure | $0.005 | named cases with ≥ 4 mentions in ≥ 2 chapters (the readers' duplicates, counted): 0 in the episode plan, ≤ 2 on the page | readers still naming a case told twice in ≥ 4 of 9 verdicts — then the reach is the writer's own and the `told` names go to the deletion-only cut |
| 3 | **Epigraph hygiene.** `chapterEpigraphExcerpt` refuses an excerpt with OCR marks (`ſ ^ _`, a doubled token, a lone hyphen between letters), a `speaker` of "the narrator"/"unknown", or fewer than 90% dictionary tokens. | Exempt: a filter on a code-selected apparatus slot, not on prose. | craft, slop (the readers' "apparatus below the prose") | $0 | noisy epigraphs 0 per book (was 1–2) | nothing; it is free |
| 4 | **Editor extension off; the compose ask absorbs the 87%.** `EDITOR_EXTEND_BELOW_SHARE` → 0 (the editor always cuts to the band, never develops); the compose target ÷ 0.87 so the writer fills its own pages; where it still lands short the shortfall is #1's told section, not paraphrase. If any extension is kept, `editChapter` gets `materialPayload` so it develops from the dossier. | Exempt: it decides which call writes the words, not what shape they take. | provenance; pacing suspect | −$0.01 | extension words ≤ 2% of book (was 8–26%); printed pages ≥ 100 | pacing falls ≥ 0.3 or printed pages < 100 (then the ask, not the extension, is the fix) |
| 5 | **Human calibration of the rubric.** Two published trade histories of this kind (Keeley; Gat or Pinker) and one public-domain classic, extracted locally, through the identical rubric and three readers each; Pinker once with the title and once without. | Measurement. | all | ~$3, one afternoon | what "Ready" scores; whether human books draw pacing 6 and five patterns | — |
| 6 | **Rubric v2 beside the panel**, not instead: criterion 10 without its list of moves and with "as many patterns as you noticed, none if none"; two integers — the put-down page and the chapter after which the argument stops changing what you believe. Run both rubrics on the next rung so the old scale survives. | Measurement. | slop, engagement, pacing | 2× panel cost for one rung | a criterion-10 score that can rise; a pattern count that can fall below five | — |
| 7 | **Two human readers**, the packets that exist in `human-packets/`, one question. | Ground truth. | — | an afternoon | put-down paragraph | — |
| 8 | **Cross-chapter figure consistency** as a note to the deletion-only cut: a proper noun that carries two different years or counts in two chapters (Nataruk in 2c and 7c, the Creole "two years earlier" in 6a ch 8). Replay on the sixty books first; ship only if precision ≥ 99%. | Deterministic veto: the 99% rule applies and decides it. | reasoning, the product | $0.01 | replay precision | precision < 99% — remove |
| 9 | **Retypeset** to ~390 words a page with a printed-page floor. | Product; the panel is blind to it (Fable-5 §5). | — | — | two humans | — |

Order: 1 + 4 as one experiment (§6, with 4 alone as its control arm), 2 and 3 in the same week, 5 before
the next panel is believed, 6 and 7 with the next rung. 8 only after its replay. 9 is Parsa's.

## 5. What not to do

- **Another cadence pass.** Rung 1 (couplets 44 → 10, engagement 6, pacing 6), rung 4 (44 → 5–8, panel
  7.51 inside rung 3's noise, readers naming the sibling forms), Luna at medium and high effort (7.30 /
  7.23, couplet halved, engagement 5–6). Three measurements; the same answer. The pass is cheap and the
  tic is real; keep it and expect nothing from it.
- **Any further rule about the last sentence.** Landing forms, the pasted landing (15/15), the exits
  (rungs 6 and 7, both read as stubs). The writer performs whatever it is told about the position where
  nothing else competes.
- **Scenes on every chapter.** Rung 3: engagement 7.22 and slop 6.11; "every chapter runs the same
  machine". The cap is right; the question is where else told material goes, not whether to lift the cap.
- **Extending the repetition detectors toward paraphrase.** They fire 0 on every rung-5+ book because the
  restatement is paraphrase; a detector tuned until it fires on approved pages is what the reserved-beat
  replay removed (76/295 false rejections). Ownership at the episode level (#2) is the model-free route to
  the same complaint.
- **Reading rung 6 against rung 7, or any 0.3.** Same stub in both; 0.26 apart; 6a and 6c are 0.80 apart
  on one configuration. Read criteria and counts.
- **Withholding the thesis again.** Composed-25: pacing 5.56, engagement 6.22, couplets 46–53 per thousand
  (Fable-5 §2). The writer reconstructs the thesis from the chapter's job and negates more for having less
  to say. Fable-4's "the cause is removed, not banned" was tested and did not hold for this cause.
- **A second model family anywhere, including the edit.** Fixed by Parsa, and rung 1 showed why on its own
  terms: fourteen quotations and a thousand proper nouns the writer had not written.
- **More reasoning effort or a hotter compose.** Composed-16/17; the knob moves the couplet and nothing
  the readers score.
- **Chasing the mean.** A book with thesis 9 and pacing 6 is a book people do not finish, and the rubric
  calls it "needs light revision" nine times out of nine.

## 6. The one experiment: ladder-8, told closings

Composed-7's plan, `--reuse-plan cmtlkn0z0000g8g08zbzxerc`, balanced tier, the flat stance file, three
replicates an arm, two arms, launched with the Wikimedia cadence that holds (one request every two seconds
per host; do not launch both arms' dossiers at once).

**Arm A (control): rung 5's flags with the exit line gone and the extension off.** `dev-set-quality.ts
restore 37` (creativeContract, materialFirst, coupletRewrite, chapterApparatus on; chapterExits off), plus
`EDITOR_EXTEND_BELOW_SHARE = 0` in `composedChapter.ts` and the compose target divided by 0.87
(`chapterWordBudget`: 520 → 598 a page for the ask only; `min` and `max` unchanged). Scene openings as
the committed cap (form plan opens on `scene`, ≤ 5, none consecutive).

**Arm B: A + told closing sections.** In `composedChaptersMaterial.ts`, after `assignApparatusAndExits`
(now epigraphs only): for each chapter that does not open on a scene, excluding the last chapter, take the
first episode of kind `scene` or `portrait` not used as the opening whose excerpts total ≥ 40 words; rank
by excerpt words; assign the top five with no two consecutive chapters both closing-told and no chapter
adjacent to two told positions of the same kind. In the worker, after the compose call and before the
edit: `composeScene` with a `position: "closing"` variant of its prompt ("You are writing the closing of
chapter N … Tell one episode as a scene in time … end on its last event, not on a reflection"; the same
dossier rule; target 700), then `trimAuthorialExit`'s deletion of up to two trailing authorial sentences
of the draft, then append. The compose call gets one line and one payload key: "The chapter's last
~700 words are already written and printed: `closingScene`, the episode "…" told as a scene. Your last
paragraph is the one before it: write toward it, do not summarise it, and do not state the chapter's
claim after it." The edit call gets the existing scene line generalised ("the chapter opens/closes with a
scene of about N words … keep it a scene"). No exit line anywhere. Epigraphs as rung 5.

**Pre-registered counts, read before any verdict is opened** (`ladder-counts.ts` gains three columns:
closing told, told words, extension words):

| count | A | B |
|---|---|---|
| scene openings | ≤ 5, none consecutive | ≤ 5, none consecutive |
| closing told sections | 0 | 5, none consecutive, none on an opening-scene chapter, not chapter 15 |
| told words per book | 3–4k | 6–8k |
| editor extension words | ≤ 2% of book (was 8–26%) | ≤ 2% |
| chapters ending authorial (corpus reading) | report | ≤ 10, and 0 of the 5 told |
| chapters ending on a citation-shaped sentence (a proper noun + a year + "records/writes/reports") | report | 0 of the 5 told |
| couplets / 1,000 | ≤ 8 | ≤ 8 |
| quotes verbatim in dossier | ≥ 70% | ≥ 70% |
| named cases with ≥ 4 mentions in ≥ 2 chapters | report (#2 not yet in) | report |
| printed pages | ≥ 100 | ≥ 100 |
| cost, minutes | ≤ $0.43, ≤ 40 | ≤ $0.45, ≤ 42 |

A replicate that misses a count on its own arm is reported and excluded from the panel mean, not rerun
silently.

**Panel, nine readers an arm, then pairwise.** Pre-registered:

- B passes on **engagement ≥ 7.0 and slop resistance ≥ 6.8** — the sum ≥ 13.8, above the 13.3–13.6
  plateau every rung since 2 has sat on. That is the whole question: does told material at a rotated
  position escape the trade. Pacing is reported, not targeted; a move of ≥ 0.3 on A alone is the
  extension's cost made visible and is worth its own note.
- B fails if engagement < 6.8, or slop < 6.4, or five or more of the nine verdicts name a chapter-closing
  vignette as a recurring pattern — that is criterion 10 charging the closing the way it charged the
  opening, and the next rung rotates kinds (a document read line by line, a portrait) rather than
  positions.
- A against rung 5: within 0.3 on every criterion means the extension and the exit line were free to
  remove, which is the result on its own; A above rung 5 on pacing by ≥ 0.3 means the extension was a cost.
- Pairwise, both orders, B's best replicate against 5b: chapter 8 (5b's opening scene against B's, if B's
  chapter 8 opens on one, or against B's told close) and one B chapter whose close is told against 5b's
  same chapter. Pass: B takes the told-close chapter on engagement in both orders.

**Falsifiers, in advance.** If B's engagement rises and its slop falls to ≤ 6.4, told material is
engagement and criterion 10 will charge it at any position: the lever is real and the rubric is the
ceiling, which is §1.3's claim and the human calibration decides what to do about it. If B's engagement
does not rise with five told closings after rising with fifteen openings, the opening is the position that
pays and the closing is not — then the next rung is told openings of a different *kind* (a document read
aloud, a portrait) on five more chapters, under the same cap per kind. If A's printed pages fall under
100, the compose ask is the fix, not the extension.

Six books, about $2.60 and two worker-hours; the panel as before. Build: half a day (the closing variant of
`composeScene`, the assignment, the compose line, the counts, tests for the cap and for the compose prompt
containing no exit line).

## 7. Where I differ from the record, by name

- **Fable-5** put the two-call chapter fourth ("the one place I would spend prose money") and was right;
  the ladder then showed the call also *costs* when it is on every chapter (rung 3), so the variable is
  position and count, not the call. The cross-family editor is moot under the constraint and rung 1 gave
  its own reason. "Retypeset; measure with humans" — agree, and it is still unmeasured.
- **Fable-4**'s "each pattern has a cause and the cause is removed, not banned" did not survive composed-25
  for the thesis, and the seams call died on acceptance (1–6 of 30). But §3.2 (human baseline), §3.5 (the
  put-down page and the development chapter) and §3.6 (de-prime criterion 10) are the three measurement
  changes this opinion depends on, and none has been run. §4.6's grounding cost is still not in any
  per-book figure.
- **The ladder report** reads "rung 5 is the best composite" and "rung 6a is the best single book". Both
  are true and they disagree, which is the replicate spread, not the exits. Its "two ways forward" are
  answered in §3: neither, as written. Its lesson 5 ("pacing has not moved … length, the paired-case
  machine and the recap tail") should add the two causes nothing touched: the plan's own overlap and the
  editor's extension.
- **The amendments plan** predicted engagement would fall with the scene cap and said the next assignment
  goes to the chapters the scene does not reach. Both held. Its out-of-scope rung — "a set-off document or
  a count as the first block" — is apparatus, and rung 5 already measured what apparatus buys.
- **The session report §4.2**, "prompt-level levers are exhausted on this writer": still true, and the two
  rungs that moved anything since were not prompt levers — they changed what was on the page (rung 2) and
  who wrote part of it (the scene call). The remaining room is the same kind: what the last third of a
  chapter is made of, and who writes it.

## 8. The question, answered plainly

Eight is out of reach on this rubric and this instrument for three reasons, in order of size. Pacing is
scored on the whole book's redundancy, the plan is fifteen demonstrations of one claim with two pairs of
chapters that overlap by design, and no writer of three has averaged above 6.33 on it — a nine-reader 7.0
would be the first. Criterion 10 is scored after a list the format fills every time, and it charges any
uniform lever, so every engagement gain since the creative contract has been paid back on it. And the
instrument cannot see a 0.3 at three books a rung, while the best single book (6a) was one reader's pacing
point from 8.0. The room that exists is engagement, ~+0.4, bought with told material at positions and in
kinds the book does not repeat, and the words to make it from are the 4–11 thousand the editor is now
inventing without the dossier. That is §6. Whether the result is then called 7.9 or 8.1 will be decided by
the rubric's calibration against a human book, which costs three dollars and has not been done.
