# Opinion 3: where 10–20% more tokens per book should go

Reviewer notes, 2026-09-02, written against `spec.md` through "End of day", `opinion-fable-2.md`,
`research-improvements.md`, the panel verdicts under `evals/`, the code in the working tree, and the
worker run logs of composed-19a-luna480 (`cmtjxvvt50000vng0pzw8v2em`) and composed-14-deepseek
(`cmtjsoy440000v0g0871yiqnf`), read call by call (every compose/edit/describe/read/forms/revise
request and response, plus the twelve research responses of each). Nothing was changed; no book was
generated. Token counts below are the `usage` fields of the run logs, not estimates.

## Verdict

**Do not spend the 10–20% on the prose layer. Spend it on giving the writer something to write from,
and pay for it with tokens the pipeline is currently wasting.** Two defects, both in code rather than
in prompts, explain most of what the panel complains about, and neither was varied in any of the
twenty-one runs:

1. **The chapter research is discarded.** `expandChapterResearch` (`packages/core/src/generation/planner.ts`)
   runs twelve Gemini-grounded searches per book (346 sources in 19a, 363 in 14, each query also
   returning a 700–1,400-word synthesised brief with "Verified Fact"/"Contested Claim" markers),
   then applies `.slice(0, cap)` with `cap = 12` to the **flattened source list**. Twelve sources
   survive, all from the first query in `plan.chapters` order — chapter 1's — and the briefs are never
   stored. Every chapter of every composed book has been written against chapter 1's dictionary
   snippets ("pearson.com: Human aggression encompasses any behavior…" ×12 in 19a; the same twelve
   lines are in the chapter 8 payload about the Zong and Barbados). Chapters 13–15 are never
   searched at all (`uniqueQueries.slice(0, cap)` with 15 chapters). The previous reviewer blamed
   query wording; the queries are fine — the Jebel Sahaba brief in 19a's log has the 2021
   re-analysis, 41 of 61 individuals, 16 with both healed and unhealed trauma. The writer never saw it.
2. **The form plan assigns the silhouette the panel names.** 19a's plan gives all fifteen chapters
   exactly four sections at exactly 0.25 each (composed-14 the same). `compositionVarietyIssues`
   (`chapterForms.ts`) checks form sequences, positions and landings, and never section count or
   share spread; and `compositionWriterLines` drops `share` entirely, so the writer is not told any
   section is bigger than any other even when the plan says so. "Identical chapter architecture" is
   fifteen chapters of 8 pages × 4 sections × 25%, assigned before a word is written.

Everything else — the tail, the digests, the editor, the read — is where the tokens to pay for the
fix come from. On 19a's own numbers the reallocation below nets out at roughly **+4% of total tokens**
against a 10–20% allowance, so there is room left for one bounded experiment (the deletion-only tail
cut) that attacks complaints #4 and #5 directly.

Where I disagree with the owner's reading: the ceiling *is* above the prose layer, but "the balanced
writer's house style" is not what was measured. What every arm held constant was (a) an empty research
payload, (b) 4×25% sections, and (c) a stance whose five positions are the five refrains — see §3.

## Ranked table

Effects are on the panel's overall scale; the replicate spread on one configuration is 0.67, so
anything under ±0.3 needs ×3. Tokens are per balanced book against 19a's 439k prompt + 171k output.

| # | Change | Expected effect | Tokens | Why this rank |
|---|---|---|---|---|
| 1 | **Fix `expandChapterResearch`**: cap per query, search every chapter, store the per-query brief; route each chapter its own brief + top sources (`loadResearchNotesForGeneration`) | +0.2–0.5 on depth/engagement (the two criteria where luna sits at 6–7 and DeepSeek/Gemini at 7–8, without the fabrication premium) | +50k prompt (compose +1.9k, edit +0.5k, read +1k per chapter) | Code bug, already paid for; the only arm never run. Also the honest version of the Gemini/DeepSeek gain. |
| 2 | **Trim `previousChapterTail` 1,200 → 300 words; replace `earlierChapters` digests with an "already told" registry** (earlier sections' `owns` + top proper nouns per finished chapter) | 0 to +0.1 (less re-telling: Jebel Sahaba ch1+ch2, Baghdad 1258 ×2, Atlantic statutes ×4); pays for #1 | −70k prompt | The writer is told to neither resume nor answer the tail; 1,200 words is context for an instruction to ignore it. Digests are page summaries in describe-pages idiom and reach 11k chars by ch15. |
| 3 | **Plan-level unevenness**: variety contract on section count and share spread; word count per section shown to the writer; planner told 4–12 pages per chapter with one single-case chapter | +0.1–0.3 structure/pacing | 0 (the repair call already fires every run) | Content assignment, the class the spec endorses; the plan is where a deterministic check is exact. |
| 4 | **Rewrite the reused plan's stance positions as flat claims about the subject** (they are five antitheses; four are the panel's refrains verbatim) | ±0.3, unknown; zero cost to find out | 0 | The "thesis about the subject" guidance shipped in iteration 9 for *future* plans; every run since reuses composed-7's plan, made before it. Never tested on this plan. |
| 5 | **Deletion-only tail cut on read-flagged chapters** (last ~600 words + the read's notes → `deletionOnlyResult`), cap 6 chapters | +0.1–0.2 pacing/slop (recap tails, thesis restated) | +15–25k | The read's 73k prompt tokens currently buy notes nobody consumes; this is the smallest consumer that cannot add a tic. Never isolated (composed-8/9 bundled it with rotation). |
| 6 | **Route `describe-pages` to the cheap judgment model** (routing revision, not code — balanced.judgment is luna in revision 21) and **reorder prompts for prefix caching** | 0 | −$ ≈ 10–15% (81k prompt tokens off luna; 0 of 63 calls cache-hit today) | Funds everything above at the cost line. |
| 7 | **Fix the two mis-measuring detectors** the editor is quoted (`isListSentence` fires on three items; `isGeneralisingCloser` fires on 16-word factual sentences) | +0.1 craft; stops the editor rewriting good sentences | −5k | Replay on the 21 books first, per the repo's own rule. |
| 8 | **Stop `reviewWholeBookDraftPages` running the styleNatural family on composed pages** (or run it on the chapter before pagination) | 0 to +0.1; removes a coherence risk | −12k (19a) to −43k (14) | A typesetting cut rewritten in isolation by the per-page prompt, against a brief that says it is a cut. |
| 9 | **Extend instead of re-ask** when a draft is short (send the draft back, name the two thinnest sections and the shortfall) | 0 on luna; fixes printed-page shortfall on other writers | −30k on DeepSeek (6 blind retries, one came back shorter) | Length compliance is what put 69/120 pages in COMPLETE. |
| 10 | **Ablate the line edit alone** (`chapterEditorPass` off, ×3, same plan) | unknown; it is 35% of prompt and 39% of output tokens | −221k if it loses | Never run. On DeepSeek the edit returned the draft byte-for-near-byte in 11 of 15 chapters (similarity ≥ 0.98). On luna it moves 3–22% of tokens. If it does nothing the panel sees, that is the whole 20% allowance and then some. |

**Do not spend on:** best-of-2 with the judge (settled 2/15, ties by construction under a one-point
gap); reasoning effort (7.31/7.30/7.23); more bans or shape rules; a second paraphrase edit;
`detemplateChapter`; a writer swap at 3× cost on balanced; a whole-manuscript read whose notes go to
the console; more words per page.

Order: 6 and 2 first (pure savings, one afternoon, no panel needed); then 1 (half a day) and 3 and 4
together on composed-7's plan ×3; then 5 and 7 as one arm ×3; 10 as its own arm when a worker is
idle. Do not bundle 1 with 3/4 in one arm if you want to know which one moved the score — but if the
goal is the shipping configuration rather than attribution, 1+3+4 in one arm ×3 is the fastest route.

## 1. Where the tokens go today (19a, balanced, luna low)

| purpose | calls | prompt | output | share of prompt | notes |
|---|---|---|---|---|---|
| compose-chapter | 15 | 101,575 | 68,837 | 23% | system ~1,560 words; user payload 8.9k chars (ch1) → 31.5k (ch15) |
| edit-chapter | 15 | 154,977 | 66,257 | 35% | same tail + digests + draft + 2.4k chars of measured notes |
| describe-pages | 15 | 81,276 | 18,475 | 18.5% | on gpt-5.6-luna despite `MECHANICAL_TEXT_PURPOSES` |
| read-manuscript | 1 | 72,918 | 3,233 | 16.6% | notes stored on the report; `READ_SECOND_EDITS = false` |
| plan-chapter-forms | 2 | 15,981 | 12,298 | 3.6% | repair fired (positional + two negation landings) |
| revise-page | 2 | 12,056 | 1,612 | 2.7% | per-page prompt on a typesetting cut |
| total | 63 + 12 research | 438,783 | 170,712 | | reasoning 5,016; **cache hits 0** |

Composed-14 (DeepSeek) is the same shape plus 6 compose retries and 7 revise-page calls: 461k / 148k.

What the compose payload is made of by chapter 8 (25.4k chars ≈ 7k tokens): `previousChapterTail`
8.3k, `earlierChapters` 5.3k (11.0k by ch15), `continuityNotes` 2.7k, `book` 2.6k, `researchNotes`
2.1k, `userPrompt` 1.3k, `composition` 0.9k, `storyState` 0.7k. So about 60% of the user payload is
memory of earlier chapters, 8% is research, and the research is wrong.

## 2. The two code defects, with the evidence

### 2.1 Research

`planner.ts`, `expandChapterResearch`:

```ts
const uniqueQueries = uniqueStrings(queries).slice(0, cap);      // 12 of 15 chapters + researchQueries
const results = await Promise.allSettled(uniqueQueries.map(...));
return results.flatMap(...sources...).slice(0, cap);              // 12 SOURCES, all from query 1
```

`cap` is `strategy.researchDepth` = 12 (`strategies/composed.ts`). In 19a the twelve responses
carried 22–37 sources each and briefs of 716–1,377 words; `maybeExpandStrategyResearch`
(`apps/worker/src/handlers/generateBook.ts:440`) stores what comes back — twelve rows. The chapter 1
compose payload's `researchNotes` are the first twelve sources of chapter 1's query, verified against
the log; chapter 8's payload carries the identical twelve lines. `loadResearchNotesForGeneration`
(`apps/worker/src/generation/generationContext.ts`) then takes the 24 newest URL-backed rows and
filters by term overlap, which on twelve rows returns the same twelve for every chapter.

The consequence is not only thin notes. The compose prompt says "Use only sources present in
researchNotes when … writing named evidence; do not … accept a diary, dispatch, archive, citation,
named testimony, or other source identity that researchNotes does not contain", and the shape rule
says "Every section names at least three particulars … and where researchNotes holds a source for
the matter, paraphrases or quotes it." With twelve definitional lines, the first rule can only be
obeyed by hedging and the second cannot be obeyed at all. Chapter 8 of 19a wrote the *Zong*,
Collingwood, 29 November, *Gregson v. Gilbert*, Mansfield, Equiano and Sharp, the 1661 code's full
title and the 1739/40 treaties from parametric memory (all correct), while performing the contract:
"according to the later legal record", "the evidence about her life is limited and later traditions
have supplied details that cannot all be verified". DeepSeek obeyed the same bind the other way and
invented the Aylsham court roll. The "It shows X. It does not show Y." couplet is what a careful
writer produces when told it may cite nothing. Every ablation in the spec held this constant.

The briefs the adapter already returns are exactly the "quotable evidence retrieval" the previous
reviewer priced at 1–2 days (its #9): dated, numbered, with named sites and papers, contested claims
marked. They cost one Gemini-flash grounded call each, already made.

**Fix (half a day):**

- `expandChapterResearch`: build one query per chapter (no cap on queries; `plan.researchQueries`
  after them), keep `Math.max(4, …)` sources per query (6 is plenty), and return the brief beside
  them. `ResearchSource` has no column for the brief; store it as a row with `url: null` and a
  reserved title (`Research brief: <chapter title>`), or add a nullable `Chapter.researchBrief`.
  `urlBackedResearchSources` already keeps URL-less rows out of the Sources back matter and the
  citation contract, which is right: the brief is grounding, not a citeable source.
- `loadResearchNotesForGeneration` (composed path): select rows whose `query` starts with
  `${plan.title} ${chapter.title}` — the query string is deterministic — and fall back to term
  overlap only when that set is empty. Return the brief separately.
- `composeChapter` / `editChapter` payload: `researchNotes` stays the citeable list (title + URL +
  excerpt; keep `citationContractFields`), and a new `researchBrief` key carries the chapter's brief
  with one system line: "researchBrief is background the writer may use as fact; it is not a source
  to name." The read gets the brief too, under `expectedClaim`, so it can say when a chapter
  contradicts its own research (composed-10's Magdeburg "1648" would have been caught).
- Token cost: brief ≈ 1,350 tokens + 6 sources ≈ 400 → +1.75k per compose; +0.4k per edit (sources
  only); +1.4k per chapter to the read → ≈ +50k per book.

### 2.2 The form plan

19a's repaired form plan, every chapter: `n=4 shares=[0.25, 0.25, 0.25, 0.25]`. Composed-14 the
same. `sectionCountForPages(8)` allows 4–6; the model chose 4 fifteen times and the contract had
nothing to say. Then `compositionWriterLines` (`chapterForms.ts`) prints "Section 1, form "scene"
(…): subject. Its material: …" — no share, no word count — so even a plan that varied would reach
the writer flat. The planner is told "Give each chapter six to nine pages" (`planner.ts`,
`targetPages >= 40`), which is why it is fifteen chapters of eight.

**Fix (zero tokens; the repair call already fires on every run):**

- `compositionVarietyIssues`: add "no section count in more than 40% of chapters when the book has
  six or more" and "shares in a chapter spread at least 2× (largest ≥ 2 × smallest) in at least half
  the chapters; no chapter with all shares within 0.05 of equal". Put both in the prompt's "Variety
  rules, enforced after you answer" line so the repair can act on them, and give
  `rotateFormsForVariety` a deterministic fallback (e.g. 0.4/0.3/0.2/0.1 rotated by chapter offset).
- `compositionWriterLines`: append `about ${Math.round(share × budget.target)} words` to each section
  line. The writer needs the number, not the fraction.
- `planner.ts`: replace "six to nine pages" with "four to twelve pages; at least one chapter
  develops a single case at length and at least one is short; chapter lengths are not equal", and
  keep the sum rule. `normalizePlanPageTargets` already handles the arithmetic.

## 3. Is the ceiling above the prose layer?

Partly. The owner's evidence is sound that *rules about shape* do not move luna, and the
subtraction ablation (6.50) proves the rules are net positive rather than the source. But "the
writer's house style is the floor" is inferred from arms that all shared three things nobody varied:

1. **The research payload** (§2.1) — the same twelve dictionary lines in every arm of every run.
2. **The section geometry** (§2.2) — 4×25% in every arm.
3. **The stance.** Composed-7's plan, reused by every run from composed-9 on, carries these positions
   (verbatim from 19a's compose prompt):
   - "Historical violence should be studied through specific evidence rather than broad assumptions about human nature."
   - "States can restrain private violence while also creating capacities for larger and more systematic harm."
   - "Economic pressure matters, but it gains destructive force through political institutions and ideas about belonging."
   - "Technological change alters the reach and organization of violence without determining human motives by itself."
   - "Historical comparison is valuable when it preserves difference and states the limits of its evidence."

   Set those beside the panel's recurring patterns for 19a and 19c: "denial of object agency — a
   tool is said not to have chosen its own use — the standard pivot"; "'technology/economics did not
   decide; politics did', restated as a closing beat in chapter after chapter"; "the 'protection and
   coercion issue from the same institution' antithesis, restated as a stand-alone couplet"; "terminal
   epistemic caveat". Four of five positions are antitheses ("X, but Y", "while also", "without"),
   and two are rules about method — exactly what the iteration-9 planner guidance now forbids. That
   guidance was shipped for future plans and never applied to the plan every later run used.
   Rotation (composed-8/9) tested *how many* positions the writer sees, not *what shape they are*.
   A stance of five flat claims about the world ("The state has been the largest organiser of
   killing in every period since Uruk"; "Slavery was a legal invention before it was an economic
   one") is a 60-token edit to one plan row and a $1 experiment. Run it on composed-7's plan ×3.

So the answer to "is a prose-layer lever untried" is yes, three: the research payload, the section
word counts, and the stance's sentence shape. None of them is a rule about shape, which is why none
should meet the fate of the bans: each gives the writer *material* or a *belief* to write from, where
a ban gives it a move to avoid and a sibling to reach for. The honest prediction is that #1 moves
depth/engagement (the criteria the model swaps moved) and #3 moves slop-resistance (the refrains),
and that neither moves the couplet much on its own — the couplet is also the citation contract
performed, which #1 relaxes only by giving the writer something to cite.

Two things I would still call model-bound after those: the mirrored two-clause closer ("Insurance
converted death at sea into a claim. Barbados law converted descent into status.") and the
one-sentence aphoristic paragraph ending ("Descent did the work."). Those are luna's cadence, and the
one lever left for them is deterministic and post-hoc (§5, item 7 and the tail cut), held to the
99% replay rule.

On the evaluation: I agree with the previous reviewer's four points (three Opus samples are one
judge; the rubric names what it finds; absolute scores compress; no human baseline) and add one —
the panel scores "specificity" without provenance, so #1 should be judged with the provenance probe
beside the panel score, and a run that raises the panel by raising the probe's "supplied by the
model" share has not improved.

## 4. The compose prompts and outputs, read

### 19a chapter 1 (system 1,560 words; user 8.9k chars; output 2,504 words, under the 3,200 minimum)

What the payload gave the writer: the definitional twelve; a composition whose scene subject is "The
2011 excavation of a mass grave at Talheim" (the form plan invented the date — Talheim was excavated
in 1983–84); an `openingHook` asserting healed and lethal wounds in the same soil. The output opens
on Talheim and "in 2011 the excavation and examination of the burial drew attention again", then
runs the couplet as the engine of nearly every paragraph: "The excavation could recover the position
of bones…; it could also establish… It could not recover their names", "Plausibility is not the same
as evidence", "Bone records impact with a stubborn economy… It does not preserve the emotional
temperature", "A burial is an act after death; it is not a transcript of the killing." Section 3
(argument: the working definitions) paraphrases the twelve notes almost verbatim — "aggression is
conduct intended to cause harm to another person who wishes to avoid that harm. Harm may be physical,
verbal, emotional, psychological, sexual, or financial" — because those were the only sources it had
and the rule says to paraphrase what the notes hold. The chapter came in 700 words short because
the material ran out.

Changes, tied to this output:
- `researchNotes` → the Talheim/Nataruk/Jebel Sahaba brief from the log (it exists: the 2021
  re-analysis, the counts). The chapter would have had three sites and numbers to argue from instead
  of a definition to paraphrase.
- The form plan's invented "2011" shows the form planner also needs the brief: pass each chapter's
  brief into `planChapterForms` (+15k tokens once per book) so `owns` names real sources rather than
  plausible ones.
- The `openingHook` line "take it or find a better one" is fine; the hook's "healed fracture" claim
  entered the prose as fact ("Some of the victims had wounds that had healed before the final
  event"). With the brief present the writer can check it; without, it trusts the plan.

### 19a chapter 8 (user 25.4k chars; output 3,328 words)

The payload: the same twelve notes; a 1,200-word `previousChapterTail` of chapter 7's catalogue of
Mongol integration practices, with the instruction to neither resume, summarise nor answer it; seven
`earlierChapters` digests in describe-pages idiom ("The page introduces… It emphasizes that the site
proves people were together at death, not how long they lived together… handing off to the
excavation's cautious methods") — i.e. seven models of the couplet, supplied by the pipeline; 24
`continuityNotes`, all chapter 6's (chapter 7 was still being finished); `storyState` repeating
`book.promises`; and `userPrompt` = the app's planning instruction ("choose … children's fable, short
story, workbook, practical guide, client tool, offer guide, or lead magnet").

The output is the best chapter in the book and still shows every named pattern: "Law did not replace
coercion. It stabilized its operation." / "The crop supplied pressure. Colonial rule supplied the
means." / "Kinship did not remove aggression. It gave aggression a family vocabulary." (from the tail,
quoted back). After the portrait section ends it appends four paragraphs the rule "the chapter ends
where its last section ends" forbids: a roll-call ("Insurance converted death at sea into a claim.
Barbados law converted descent into status. Jamaican treaties converted…"), the restraint/domination
antithesis (position 2), the "people did not simply receive them" reversal, and a closing pair
("The *Zong* case reached London because… Nanny's community endured because…"). The line edit kept
all four. The read then flagged exactly these across chapters — and nothing consumed the read.

Changes, tied to this output:
- `previousChapterTail` to ~300 words (the last paragraph or two). The writer quoted its cadence, not
  its content, and the rule already says the content is off limits.
- `earlierChapters` → a registry: per earlier chapter, its sections' `owns` plus the ten most frequent
  proper nouns of its finished text ("Chapter 7 told: Baghdad 1258, Hülegü, Ghazan, paiza, ortoq,
  Sorghaghtani Beki…"), one line each, ~300 tokens for the whole book. That is what the
  never-re-tell rule needs, and it is not written in the couplet.
- Drop `userPrompt` from the compose payload in favour of `researchSubjectForPrompt(input.prompt)`
  (`planner.ts` already has it: "Write a book on human aggressiveness in different areas in history and
  what affected it"). Drop `storyState` when it duplicates `book.promises`.
- The four-paragraph coda is the case for the deletion-only tail cut (§5, item 5): send the last 600
  words and the read's notes, accept only `deletionOnlyResult`.

### Composed-14 chapter 1 and 8 (DeepSeek)

Same prompt. Chapter 1 opens on the invented Aylsham roll ("The fine was recorded in the same hand as
the brawl, on the same membrane"), 300-word paragraphs, sentence mean 26 words, and the couplet
anyway ("The aggression was in the system, not in the tempers of the men who operated it"; "The
documents do not simply preserve the violence; they define it"). Chapter 8 opens on the *Brookes*
with an invented 1783 log "kept by the captain". Both drafts came in under 0.7× minimum and were
re-asked from scratch with no draft attached; the second chapter 1 was 2,476 words, still under the
3,200 minimum, and the editor's "develop the existing sections" branch returned 2,435. What the
DeepSeek log shows about the prompt is that the citation contract with empty notes selects for
invention in a model that will not hedge — the same bind, the other exit. Fix #1 is the fix for both.

## 5. Waste, wrong and risky at the token level

1. **`planner.ts`, `expandChapterResearch`** — `uniqueQueries.slice(0, cap)` and
   `flatMap(...).slice(0, cap)`: 346 sources fetched, 12 stored, all chapter 1's; chapters 13–15
   never searched; the per-query brief (`result.value.summary`) discarded. §2.1.
2. **`apps/worker/src/generation/generationContext.ts`, `loadResearchNotesForGeneration`** —
   recency `take` then term overlap; on the rows above it returns the same twelve for every chapter.
   Select by the chapter's own query string.
3. **`composedChapter.ts`, `composeChapter`/`editChapter` payloads** — `previousChapterTail` 1,200
   words (≈1.6k tokens × 30 calls ≈ 48k) for an instruction to ignore it; `earlierChapters` digests
   growing to 11k chars (≈2.7k tokens by ch15, ≈40k per book across both calls); `userPrompt` the
   app's planning instruction (≈330 tokens × 15); `storyState` = `book.promises` again. ≈ 90k prompt
   tokens a book, a fifth of the total, buying memory the writer is told not to use.
4. **No prompt caching** — `cacheHitTokens` is 0 on all 63 luna calls; `cacheWriteTokens` equals
   `promptTokens` every time. The compose system prompt opens "Write chapter N, "title"…", so no two
   calls share a prefix. Move the chapter line to the end of the system prompt (or into the user
   payload), keep stance + exemplar + rules first and byte-identical across compose and edit, and
   keep `userPrompt`/`book` at the head of the user payload: ~2k cached tokens per call, ~60k per
   book at OpenAI's cached-input rate.
5. **`describe-pages` on gpt-5.6-luna** — 81k prompt tokens (18.5%) for titles and summaries.
   `MECHANICAL_TEXT_PURPOSES` lists it; the balanced routing revision points `judgment` at luna, so
   `selections.mechanical` is luna (`factory.ts:320`). A routing-revision change, not code: set
   balanced.judgment to the fast DeepSeek/qwen model.
6. **`readManuscript`** — 73k prompt tokens (17%) for notes stored on the chapter report;
   `READ_SECOND_EDITS = false` (`composedChaptersState.ts`). Its notes are good and deletion-shaped
   (19a: "'Babylon was rebuilt. The city entered the rule' — closing paragraph re-lists the chapter's
   destruction, restoration…"). Either the tail cut consumes them (item 5 in the table) or the gate
   defaults off on balanced.
7. **`proseMeasurements.ts` detectors quoted to the editor** — `isListSentence` fires on three short
   comma segments ("owned, insured, and commanded the ship" after a date clause) while the note says
   "four or more"; `isGeneralisingCloser` (≤16 words, no digit/quote/mid-sentence capital) fires on
   "Its owners then sought payment from insurers for the value of those who had been killed." and
   sends it to the editor as a "general truth" to cut. Replicated by hand on 19a's chapter 8 notes.
   `chapterShape.ts` repeats the list share as a second note. ~2.4k chars per edit call, half of
   whose examples are wrong. Require ≥4 short segments; cap the generalising closer at ~10 words
   (the tic is "Descent did the work.", four words); replay on the 21 books before shipping.
8. **`composeChapter` short-draft retry** — `while (attempts < 2)` re-asks from scratch with
   "Your previous answer was N words" and no draft; `best` = the longer. DeepSeek: 6 retries,
   chapter 10's came back shorter (2,240 → 1,930). An extend call (draft + "develop sections 2 and 4
   by ~900 words") is cheaper and monotone. Luna never tripped the 0.7× threshold, but chapters 1, 2
   and 12 of 19a were under `budget.min` after the edit and nothing enforces the minimum —
   the printed-page floor the previous reviewer asked for is still absent.
9. **`wholeBookPageReview.ts` on composed pages** — `hasFormulaicContrastOveruse` (`pagesLocalQa.ts`,
   two "not just X" setups on a page) fails a typesetting cut, then `revisePageDraft` rewrites it
   with the per-page prompt: "Advance beyond recentPages… satisfy the current page brief… the page
   summary must name the new beat", on a brief whose `endingPressure` says the page ends where the
   typesetter cut. 2 calls in 19a (page 39), 7 in composed-14, ~6k prompt tokens each, and a page
   that no longer joins its neighbours. Skip the `styleNatural` rules for `executionMode ===
   "composed-chapters"`, or run the contrast check on the chapter before pagination and hand it to
   the editor as a note.
10. **`editChapter`** — 35% of prompt tokens and 39% of output. Similarity draft→edited (token
    SequenceMatcher): luna 0.78–0.97, median ~0.90; DeepSeek ≥0.98 in 11 of 15 chapters. It is the
    largest single spend and has never been switched off in an arm (`chapterEditorPass` is a gate
    already). It also re-sends the tail and the digests (item 3) for a task that needs neither.
11. **`compositionVarietyIssues`** — no check on section count or share spread; `compositionWriterLines`
    drops `share`. §2.2.
12. **Dead and stale** — `earlierOpenings`/`earlierClosings` are computed in the pass
    (`earlierEdgesFor`), carried on `ComposeChapterOptions`, and read by nothing; `LANDING_FORMS`/
    `landingFormFor`, `detemplateChapter`; `pipelineStages.ts` "compose" stage still says "Two
    continuous drafts per chapter… a fast cross-family judge" with `COMPOSE_CANDIDATES = 1`;
    `chapterWordBudget`'s comment gives both 470 and 490. None costs tokens; all cost the next
    reader's trust.
13. **`describeChapterPages`** sends `illustrationPlan` and the full `characters` list on every call
    whether or not any page in the chapter is illustrated; gate on `illustratedIndexes.length > 0`.

## 6. Specific edits, in order

1. `packages/core/src/generation/planner.ts`, `expandChapterResearch`: per-chapter queries, no query
   cap, `PER_QUERY_SOURCE_CAP = 6`, return `{ sources, briefs: [{ query, chapterIndex, text }] }`.
   `apps/worker/src/handlers/generateBook.ts`, `maybeExpandStrategyResearch`: store briefs (URL-less
   rows with a reserved title, or a `Chapter.researchBrief` column — the column is cleaner and the
   composed pass already updates `Chapter.productionBrief`). Keep the existing-rows guard.
2. `apps/worker/src/generation/generationContext.ts`: a composed-specific loader — rows where
   `query` starts with `${plan.title} ${chapter.title}`, top 6 with URL, plus the brief; fall back to
   the current path when empty. `composedChaptersPass.ts`, `composeOptionsFor`: pass `researchBrief`.
3. `packages/core/src/generation/composedChapter.ts`: add `researchBrief` to `ComposeChapterOptions`
   and both payloads with the one-line rule above; `PREVIOUS_CHAPTER_TAIL_WORDS = 300`; replace
   `earlierChapters` digests with `toldSoFar: [{ chapter, cases: string[] }]` built in the pass from
   `composition.sections.flatMap(s => s.owns)` plus the finished text's top proper nouns (the
   provenance probe's `properNouns` is the extractor to reuse); drop `userPrompt` for
   `researchSubjectForPrompt(input.prompt)`; drop `storyState` when it equals `plan.promises`; move
   the "Write chapter N" line and `positionLines` to the end of `systemLines` so the prefix is stable.
4. `packages/core/src/generation/chapterForms.ts`: the two new contract clauses in
   `compositionVarietyIssues` and the prompt's variety line; a share fallback in
   `rotateFormsForVariety`; word counts in `compositionWriterLines` (needs the budget — pass
   `budget.target` in). `planner.ts`: the chapter-length line.
5. The reused plan (`cmtjlnfgr0003c1p2j72t7f0x`'s copy): rewrite `authorStance.positions` as five
   flat claims about the subject; run ×3 with `--reuse-plan`. Zero code.
6. Routing revision: balanced.judgment → the fast DeepSeek/qwen model (describe-pages, judge). Check
   the Costs tab attributes it.
7. `composedChaptersPass.ts`: after the read, for flagged chapters (cap 6) call a new
   `cutChapterTail` — `cutChapter` restricted to the last 600 words, with `deletionOnlyResult` applied
   to the whole chapter (prefix unchanged + cut tail). Keep `READ_SECOND_EDITS` as the switch.
8. `proseMeasurements.ts`: `isListSentence` ≥4 short segments; `isGeneralisingCloser` ≤10 words.
   Replay: `pnpm scorecard` over `runs/*/book.md`, count hits on the panel's quoted "strength"
   highlights.
9. `wholeBookPageReview.ts`: skip `styleNatural` rules when `strategyComposesChapters(strategy)`.
10. `composeChapter`: replace the second attempt with an extend call carrying the draft.

The measurement to run beside every arm: the provenance probe's "supplied by the model" share and
the printed page count, next to the panel mean. A run that raises the mean by raising the first has
found the DeepSeek premium, not a lever.
