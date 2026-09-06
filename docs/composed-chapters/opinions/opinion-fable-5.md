# Opinion 5: the room that is left, and where it is

Written 2026-09-03 against `session-report-2026-09-03.md`, the 34 books under `runs/`, the verdicts
under `evals/`, the compose prompt in `packages/core/src/generation/composedChapter.ts`, and my own
reading of chapter 7 of composed-23a. Two new measurements are in §2; everything else is argument.

## Verdict in one screen

| Question | Answer |
|---|---|
| Is there room? | Yes, and most of it is not in the prose. The panel says thesis 9, clarity 9, engagement 6, pacing 5–6 for every Luna book. A book that is coherent and dull is a book with no *material* — no letter, no ledger line, no person on a date — and a writer told not to invent any. Twenty-five arms varied what the writer was told to do with the same search snippets. None varied what it had. |
| The tic is not the dullness | Luna at high effort halves the negation couplet (19.7/1000 sentences against 43.5 at low) and engagement stays at 5–6. Gemini at 4/1000 and DeepSeek at 28/1000 both got engagement 7, and the readers named *particularity* as the reason for both. Removing the couplet will move criterion 10 and not criterion 7. Treat cadence as polish, budget it at $0.03, and stop expecting it to move engagement. |
| The arc made the tic worse | Every arc book (24a, 25a–c) measures 46–53 couplets/1000 against 34–44 for the 23 baseline. Withholding the thesis gave Luna less to say and it said it with more negation. |
| Paradigm | **Material-first.** Plan the book as episodes (a person, a place, a date, a document) before it is planned as an argument; fetch verbatim primary text for each from public repositories into a dossier the code can verify; draft each chapter *around* its episodes with a quote contract enforced by substring, not by prompt. Fable-4's arm 2 is the right mechanism; I would make it the pipeline, not an arm, and I would open a second door to material that no repository has: the reader's own. |
| Product, not prose | The panel reads plain text; the customer reads a 520-word page on a phone with no epigraph, no pull quote, no timeline, no document box. Pacing is typography and apparatus as much as sentences, and the instrument is blind to it by construction. Retypeset to 350–400 words a page and let the dossier furnish the apparatus. Measure this with two humans, not nine Opus readers. |
| Build first | (1) cross-family line editor by purpose override, config only, ×3; (2) the dossier and its guard, 3–4 days, ×3; (3) retypeset + apparatus, 1–2 days, human-read; (4) targeted couplet rewrite, half a day, last. |
| Trust | The tight couplet counter (§2) and a verbatim-quote rate, because they have no noise; pairwise cross-family preference on chapters 8 and 12; a put-down page from two human readers. Not the ten-criterion mean, and not the current `negationContrast` counter, which ranks DeepSeek worse than Luna while every reader ranked it better. |

## 1. What I read

Chapter 7 of composed-23a, "Steppe Powers and Connected Worlds", opens on a Mongol army and then
delivers "The first requirement was accumulation… The second requirement was concentration…
Communication formed the third requirement… The final requirement was endurance." Fifteen paragraphs
of about a hundred words each, every one the same texture: claim, elaboration, qualification. No
person appears until the Secret History is named in paragraph eleven, and it is named, not quoted.
The first date is 1258, in paragraph fifteen. The prose is clean, adult and controlled, and I would
not finish the chapter. That is exactly what the three readers said in nine different ways, and it
is not a sentence-level fault. It is what a competent writer produces when it has a thesis, a form
plan, and nothing to put on the page.

The research the writer is given is `ResearchSource = { query, title, url, summary, publishedAt }`
(`packages/core/src/schemas/plan.ts`). A search hit and its snippet. The citation contract then says
"use only sources present in researchNotes when assigning, writing, or reviewing named evidence; do
not invent a diary, dispatch, archive, citation, named testimony". Luna obeys. So the page has no
diary, no dispatch, no testimony, and the writer fills the space with mechanism. DeepSeek disobeyed
(Dutemple 1914 against 1870) and scored 7 on engagement. Gemini brought its own knowledge (depth 9)
and scored 7. The "DeepSeek premium" Fable-4 warned about is the same thing as the engagement gap:
particulars, honestly or dishonestly obtained.

## 2. Two measurements the record did not have

**A tighter couplet counter.** `structural-scorecard.ts` counts `while`, `yet`, `did not`, `rather
than` as "negation-contrast", and by that measure DeepSeek (61.7) is worse than Luna (31–37) while
every reader preferred DeepSeek. I counted the move the readers actually quote: a sentence of at most
18 words containing `was/were/is/did/… not`, immediately followed by a sentence of at most 22 words
opening on `It/They/That/This/What/The`. Per 1,000 sentences, whole book:

| arm | couplets /1000 | engagement (readers) |
|---|---|---|
| composed-15 gemini-3.7-flash | 4.0 | 7 / 7 / 7 |
| composed-17 luna high | 19.7 | 6 / 5 / 6 |
| composed-16 luna medium | 25.0 | 6 / 6 / 5 |
| composed-14 deepseek-v4-pro | 27.9 | 7 / 7 / 7 |
| composed-7 | 32.5 | 6 / 6 / 6 |
| composed-23c | 33.8 | 6 / 6 / 6 |
| composed-23b | 40.5 | 5 / 6 / 6 |
| composed-23a | 43.5 | 6 / 7 / 6 |
| composed-24a arc | 45.9 | — |
| composed-21a minimal | 47.6 | 5 / 5 / 6 |
| composed-25b, 25c arc | 49.1, 49.1 | 6 / 6 / 7, 7 / 6 / 6 |
| composed-25a arc | 53.0 | 6 / 6 / 6 |

Two things fall out. Reasoning effort is the one lever that halved the couplet, and it bought nothing
on engagement or pacing: the tic and the dullness are different things. And the arc raised the
couplet rate in every replicate. A writer given a job and denied the answer negates more, not less.
Fable-4 predicted the opposite ("the cause is removed, not banned"); the measurement says the cause
is Luna's decoding, and the only things that reached it were effort (cost ×1.5) and another model.

**What the readers' seven means.** Read the DeepSeek and Gemini verdicts beside the Luna ones: "opening
carried by one archival detail", "reads as the work of a serious writer", depth 8–9. Not one reader
credited cadence. The seven was bought with particulars. That is the whole case for material-first.

## 3. The paradigm: material-first

The current pipeline is argument-first: stance → thesis → chapters that prove it → form plan → prose.
Material enters last, as snippets, and the writer is forbidden to add any. A trade historian works the
other way: a shoebox of documents first, the argument found in them. The pipeline should too.

1. **Episodes in the plan.** The planner returns, per chapter, two or three episodes: a named person or
   body, a place, a date or date range, and the document or artefact that records it. Each episode
   carries a fetch query. Chapter kinds and page counts (arm 1's `BookArc`) hang off the episodes rather
   than the thesis; the thesis is what the episodes turn out to show.
2. **A dossier the code can verify.** Fable-4 §1.4 D+E and `developer-review-arm1.md` §B, as written:
   one `PrimarySourceAdapter` over Wikisource, Gutenberg, archive.org and the Internet History
   Sourcebooks; an `extract-excerpts` call that returns byte offsets, never text; excerpts stored as
   `ResearchSource` rows with a new `kind`; a quote-provenance guard where every quoted span of eight
   or more words must be a folded substring of the dossier, replayed on the 34 books before it ships
   (Parsa's 99% rule), whose only veto is stripping the quotation marks. Repository APIs cost nothing,
   which matters if grounding really is $0.88 a book.
3. **Compose around the episode.** Each chapter's prompt leads with its episodes and the excerpts;
   the opening section is the episode, not the claim; the contract permits quotation from the dossier
   and nothing else. Every rule about opening on a particular is then a fact about the input rather than
   an instruction the writer performs.
4. **Two-call chapters where the episode is a scene.** A narrating call is a different task from an
   arguing call and produces different prose from the same model: "tell this, 700 words, from these
   excerpts, no thesis", then the argument composed with the scene text already in the payload. About
   1.3× compose cost on the chapters that get one. This is the one place I would spend prose money.
5. **A second door for material: the reader's own.** The dossier covers history and older literature;
   a business or education brief on a 2024 subject has no public-domain primary text. The import
   pipeline already ingests documents. One optional step in the creation chat — "anything you want the
   book to draw on: links, files, notes" — puts the customer's own material in the dossier under the
   same guard. A book built from material nobody else has is the one thing a competitor cannot ship,
   and it is nearly free.

What this does to the five patterns: the couplet and the antithesis stay Luna's cadence (see §2) and
are handled by the editor lane below; the evidence-limit disclaimer and the recap tail lose their
function when a chapter has a document to read instead of a source to bound; "no human voices,
nothing quotable" is answered directly. What it cannot do: rescue a subject with no findable material.
For those the pipeline should say so at planning time and fall back to what it does now.

## 4. The cheap levers, in the order I would run them

| # | Change | Cost | Effort | What it targets | Readout |
|---|---|---|---|---|---|
| 1 | **Cross-family line editor.** Route `edit-chapter`, `cut-chapter` and `rewrite-seams` through a `purposeOverrides` entry (`textRouting.ts` already has the map) to gemini-3.7-flash, thinking off. The editor is 38% of spend and today paraphrases Luna into Luna; a second idiolect at the edit is the cheapest way to buy Gemini's 4/1000 cadence without Gemini's $1.10. | ≈ −$0.06 | config + one routing entry | slop, cadence | couplet counter, ×3 |
| 2 | **Dossier + guard** (§3 items 2–3), on the existing planner with an `episodes` field | +$0.05–0.10 | 3–4 days | engagement, depth | verbatim-quote rate 100%, engagement mean, pairwise on ch. 8 and 12 |
| 3 | **Retypeset** to 350–400 words a page with a printed-page floor, plus apparatus from the dossier: an epigraph excerpt per chapter, a dated timeline box on `case` chapters, a set-off document block on `document` chapters | −25–30% compose | 1–2 days | pacing as read on a phone | two human readers, put-down page |
| 4 | **Targeted couplet rewrite**: the §2 detector finds the pairs; a cross-family call rewrites only those sentences under "no negation, no antithesis, keep every proper noun and number"; accept only when the pattern is gone and length is 0.7–1.5×. Seams failed because whole paragraphs went out and came back unchanged; a two-sentence ask with one rule is a different task. | +$0.02 | half a day | criterion 10 only | couplet counter ≤ 15/1000 |
| 5 | **Scene call** (§3 item 4) on the chapters whose first episode is a scene | +$0.04 | 1 day | engagement | pairwise |
| 6 | **Fast tier**: do not iterate on the writer; run the composed pipeline with the cheap writer and lever 1's editor. A 2.83 book is a broken product, not a tier. | — | config | — | one book, not degenerate |

Run 1 first because it is free and isolates the cadence question. Build 2 while 1 runs. Do not run 4
before 2: polishing sentences on a page with nothing on it is the loop the last session was in.

## 5. Measurement

Agree with Fable-4 §3 on every point: drop the mean, go pairwise and cross-family, count on fixed
chapters, ask for the put-down page, de-prime criterion 10. Three additions.

- **Replace the negation counter** in `structural-scorecard.ts` with the §2 couplet detector, and add a
  one-sentence-paragraph share (Gemini's tic: 73 in composed-15 against 6–15 for Luna). A counter that
  ranks the writers the opposite way from every reader is measuring something the readers do not mind.
- **Two humans, two chapters, two arms.** The programme has zero human readings. A person reading
  chapters 1 and 8 of the baseline and of the first dossier book, asked only "where did you stop, and
  why", is the ground truth every Opus score is a proxy for, and costs an afternoon.
- **A verbatim-quote rate beside every score** once the dossier exists, and the model-supplied
  proper-noun share from `provenance-probe.ts`. Any engagement gain that rises with the model-supplied
  share is the DeepSeek premium, not a lever.

## 6. Where I disagree with the record

- *"Prompt-level levers are exhausted on this writer"* (report §4.2) is right, and the conclusion drawn
  from it — that the next lever is the manuscript-level thesis cut — is not. A deletion pass reaches
  restatement. It cannot add a person, a date or a document, and those are what the seven was bought
  with. Cutting a fifth of a dull chapter leaves a shorter dull chapter.
- *"The one piece the readers asked for in every arm is the dossier"* (report §8.2) is the most
  important sentence in the report and it is listed second. It should be the paradigm, not arm 2.
- *"Retypesetting: 0 on this panel"* (Fable-4 §2 #12). The panel receives plain text and cannot score
  typesetting. That is an instrument limit, not a null result.
- *"An author persona built from a stylistic exemplar — exemplars set register, not variance"*
  (Fable-4 §1.8). The couplet rate is register. But the untried exemplar is human prose, not a
  model-written voice sample, and I would still rank it below levers 1–3 because an exemplar changes
  what the writer sounds like, not what it has to say.

## 7. The report's question, answered

**(a)** Engagement and pacing above 7 at under $0.50 on this writer: yes, but not by anything done to
the writer. Give it verbatim material and a page shape that can carry it. Build the dossier first, the
cross-family editor in parallel because it is free, the typesetting third. The thesis cut and the
middle-chapter writer swap are both answers to the wrong criterion.

**(b)** Trust the instruments with no noise: the §2 couplet counter, the verbatim-quote rate, the
proper-noun provenance share. Trust the panel only as pairwise, cross-family, position-swapped
preference on fixed chapters. Trust two human readers over all of it for the put-down page. Do not
trust the ten-criterion mean, `answerStatedIn` without a cross-family twin, or the present
`negationContrast` counter.
