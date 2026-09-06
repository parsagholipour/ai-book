# Opinion 4: the next book, not the next prompt

Reviewer notes, 2026-09-03, written against `spec.md` through iteration 23, `opinion-fable-2.md`,
`opinion-fable-3.md`, `research-improvements.md`, every verdict under `evals/`, chapters 1, 8 and 15 of
composed-23a-trim and chapters 1 and 8 of composed-14-deepseek read in full, the traces of 23a/22a/14/7,
and the code in the working tree (`composedChapter.ts`, `composedChaptersPass.ts`, `chapterForms.ts`,
`authorStance.ts`, `planner.ts`, `costs.ts`, routing). Nothing was changed; no book was generated.
Baseline per the owner: **7.45 ± 0.4**, engagement **6.0**, pacing **5.7**, $0.32–0.36, 27–28 min.

## Verdict in one screen

| Question | Answer |
|---|---|
| What is actually wrong | Not the writer and not the prompt. The **book design** is fifteen demonstrations of one safe thesis, on one 8-page template, by a writer that may cite nothing quotable and is told, in every chapter, the same thesis and the same five beliefs. Every writer given that job writes the same five patterns; DeepSeek's negation rate (61.7/1000) was *higher* than luna's. The readers' sentence is exact: "nothing a reader could disagree with, no human voices, the argument complete by chapter four". Those are properties of a plan, not of a cadence. |
| Paradigm | **Proposal-first, dossier-backed.** Do what a trade-history author does: (1) an *architect* call writes the whole book's argument as a 3–4k-word proposal with a real question, a real named opponent, a turn, and chapters that differ in kind and length; (2) a *dossier* per chapter of verbatim public-domain primary text (letters, rolls, statutes, protocols) and the named scholarly dispute the search already marks as "Contested"; (3) luna drafts each chapter against its *job in the argument* and its dossier, never against the thesis; (4) one cross-family read audits the arc and names cuts; a global *seams* call rewrites all thirty chapter openings/closings together; deletion-only cuts consume the read. Paraphrase line edit dropped (38% of cost, never ablated, homogenises). Net: **$0.36–0.41**, same wall time. |
| Why it does not reproduce the five patterns | Each pattern has a cause in the current design and the cause is removed, not banned: couplet ← citation contract with nothing to cite + an epistemological thesis performed as syntax; antithesis closer ← every chapter ends on a *verdict* about the thesis; one architecture ← 15 × 8 pages × the same job; thesis per chapter ← the thesis and all five positions are in every prompt; recap tails ← sequential drafting with a verdict landing and a read nobody consumes. What survives is luna's sentence cadence, which the seams call and the cuts reach and a ban never did. |
| Build first | The arc (one day) and the seams+cuts consumer (half a day); the dossier and its verbatim-quote guard (two to three days) in parallel. Run arm 1 (arc + seams + cuts) ×3 as soon as it exists; arm 2 (arm 1 + dossier) ×3 when the guard is exact. Both on composed-7's plan. |
| The one experiment | Composed-7's chapter list, pages re-cut by the arc (sum 120), three replicates, judged on **engagement and pacing means**, a **pairwise cross-family excerpt win rate against 23a**, **counts on chapters 8 and 12**, and the provenance probe — not on "overall". Pass: engagement ≥ 7.0 and pacing ≥ 6.5 with quotes 100% verbatim and the model-supplied proper-noun share no higher than luna's 25%. |
| Evaluation | The panel cannot rank inside the 7-band: across the 25 books between 6.8 and 8.0, the Spearman correlation between two reader samples is 0.08 / −0.13 / 0.28 (computed below). It *does* see engagement move (7/7/7 for both model swaps). Stop optimising the mean; score a human baseline; go pairwise and cross-family; count on fixed chapters; ask for the put-down page. |
| Disagreements | "House style is the ceiling", "the one lever is the writer model", "position rotation cost the argument", "the inputs fix gained 0.14", and "$0.33 per book" — each is drawn from arms that held the wrong thing constant or from an instrument that cannot see the difference claimed. Section 4. |

## 1. The paradigm: proposal-first, dossier-backed

### 1.1 What the readers are describing

Read chapter 1 of composed-23a as an acquiring editor would. It opens on a real mass grave, moves to a
textbook definition of aggression ("behaviour intended to cause harm to another person who wishes to
avoid it"), to Hobbes, to homicide registers, and every paragraph is about 96 words (the editor's own
measured note says so: "38 paragraphs are all about 96 words"). It is an intelligent survey essay. Chapter
8 is another: the *Brookes*, Codrington, the 1661 code, Stono, resistance, the economic argument. Chapter
15 is Able Archer and Srebrenica. Each chapter *proves the thesis on new cases*; none of them changes
what the reader believes. There is no question the book does not already know the answer to on page 1,
no person the book follows for more than a paragraph, no primary text longer than a clause, and nobody
the author disagrees with by name. A reader who has understood chapter 3 can predict chapter 12 — which
is what "argument complete by chapter four" and "predict a paragraph's shape before reading it" mean.

DeepSeek's chapter 1 shows what the readers pay for: a court roll, a Thursday, a butcher, a bone, a
widow's brass pot, a clerk's hand on a membrane. Engagement 7/7/7. It is invented — and the *real*
version exists for free: Maitland's *Select Pleas in Manorial and Other Seignorial Courts* (Selden
Society, 1889; public domain; on archive.org) is page after page of exactly such entries. The readers
were not rewarding fabrication; they were rewarding the presence of a human being in a document. The
pipeline never gives luna one.

### 1.2 The five patterns, their causes, and what removes each

| Pattern (every panel) | Where it comes from today | What the paradigm does instead |
|---|---|---|
| "It shows X. It does not show Y." as the sentence engine | Two things at once. The **citation contract** (`citationContractFields` + `GROUNDED_FACTUALITY_RULE`) forbids naming any source not in `researchNotes`, and the notes are secondary snippets and a synthesised brief — nothing quotable — so a careful writer characterises evidence instead of using it. And the **plan's subject is epistemology**: the thesis is about "scale, targets and meaning shaped by institutions", position 5 of the flat file is still "the differences … are the finding", the plan's `voiceGuide` orders "distinguish documented evidence from interpretation", chapter 15 is titled "What History Can and Cannot Explain". The couplet is the plan performed as syntax. | The dossier gives the writer verbatim primary text to *quote* (≤250 words a piece, 3–6 per chapter) and a named dispute to *take a side in*; the contract becomes "quote only from the dossier, verbatim" and is checked deterministically. The book's question is about the world (§1.3), the epistemology moves to one chapter whose *kind* is "method", and no other chapter is told about evidence limits at all. |
| Paired-antithesis closer | Every chapter's last paragraph is a `landing` — a *verdict* about the thesis — and every section is "a movement of one argument"; luna's verdict cadence is the mirrored clause. | A chapter's ending is its *job's* ending: a case chapter ends when the episode ends, a document chapter on the document's last line, a complication chapter on the problem it raises; only the resolution chapter lands. The **seams** call (§1.5) then rewrites all thirty openings/closings together under a no-two-alike, no-verdict, no-thesis contract — the one global call that can enforce a global property. |
| One chapter architecture | 15 chapters × 8 pages × 4–7 sections from one palette, each chapter told to argue the thesis. Section counts were varied in 23; chapter kinds and lengths never. | The arc assigns **kinds and lengths**: case (10–14 pages, one episode narrated from documents), argument (6–8), portrait (6–8, one person), document (3–4, one text read line by line), complication/counter-case (6–8, where the thesis is in trouble), resolution (6–8). Sum fixed at the paid count. |
| Thesis restated per chapter | `authorStancePromptLines` puts the thesis and all five positions in every compose *and* edit call; the rotation arm gave each chapter one position *to demonstrate* — still a demonstration. | Chapters 2..n−1 never see the thesis. Each sees its **job**: what the reader believes so far, what this chapter does to that belief (establish / complicate / reverse / repair / resolve), the one thing it adds, and what it leaves open. The thesis is spoken twice in the book: chapter 1's question and the resolution. The read audits the arc, not the chapters. |
| Recap tails | Sequential drafting with a verdict landing, a 300-word tail it is told to ignore, and a read whose notes are stored and never consumed. | Deletion-only tail cut (`cutChapter` + `deletionOnlyResult`, both already written) consuming the read's notes, scoped to the last 600 words of flagged chapters. Cannot add a tic. Never isolated; it is time. |

What this does *not* remove: luna's sentence-level cadence (the four-word aphorism, the 16-word mean). Two
of the three places it hurts are the seams, which the seams call rewrites; the third is inside paragraphs,
where a ban rebounds and only a different model's idiolect or a cut reaches it. Budget for that in §1.6.

### 1.3 The architecture, call by call

Per balanced book of 120 pages. Existing calls are marked; luna prices are $0.20/M in, $1.20/M out
(`costs.ts`); 23a's measured totals are the baseline.

| # | Call | Model | New? | What it produces | Cost |
|---|---|---|---|---|---|
| 1 | `plan-book` | as now | – | plan, stance | as now |
| 2 | `chapter-research` ×15 | Gemini grounded | exists | brief + 8 sources per chapter | **not in the trace** (§4.6) |
| 3 | `find-primary-sources` ×15 | HTTP only | new | candidate public-domain pages per chapter from repository APIs (Wikisource `action=query&list=search`, Internet Archive `advancedsearch` + full text, Gutenberg via gutendex, Fordham sourcebook and Avalon static pages, Hathitrust PD), fetched and reduced with `stripHtml`/`normalizeExtractedText` (`ingestion/documentText.ts`) | $0 |
| 4 | `extract-excerpts` ×15 | gemini-3.1-flash-lite ($0.25/$1.5) | new | 3–6 excerpts ≤250 words each, with speaker, date, provenance, byte offsets into the fetched text | ~12k in / 1.5k out each → **$0.08** |
| 5 | `architect-book` ×1 | deepseek-v4-pro ($0.66/$1.98 off-peak) or gemini-3.7-flash ($0.75/$3.75) | new | the proposal (3–4k words of prose) + `bookArc` JSON (§1.4) | ~10k in / 7k out → **$0.02–0.04** |
| 6 | `plan-chapter-forms` ×1–2 | as now | exists, takes `kind` | sections per chapter within the kind's palette | $0.02 |
| 7 | `compose-chapter` ×15 | luna | exists, prompt changed | chapter prose from job + kind + dossier + tail | $0.112 + ~$0.01 for the dossier |
| 8 | `edit-chapter` ×15 | luna | **dropped** | – | −$0.126 |
| 9 | `describe-pages` ×15 | balanced *judgment* model (deepseek-v4-flash) | exists, rerouted | titles, summaries, notes | $0.042 → ~$0.01 |
| 10 | `read-manuscript` ×1 | gemini-3.7-flash (cross-family) | exists, prompt changed | per-chapter deletion notes, arc audit ("at which chapter does the argument stop developing; which two chapters could swap without loss"), seam notes | 75k in / 3k out → **$0.07** (luna: $0.02) |
| 11 | `seams-together` ×1 | luna (or flash for a second idiolect) | new | thirty replacement paragraphs (first and last of each chapter) | 10k in / 6k out → **$0.01** ($0.03 on flash) |
| 12 | `cut-chapter` ×≤6 | luna | exists, tail-scoped | deletion-only cuts on flagged chapters | **$0.03** |
| 13 | `recompose-chapter` ×≤2 | luna | exists (`composeChapter` with a sharpened job) | the chapters the arc audit names | **$0.02** |
| | **Total** | | | | **~$0.36** with the read on luna, **~$0.41** cross-family, against $0.334 |

Wall time is unchanged: 3–5 run before and during planning; 11–13 add two or three minutes after the
read; compose stays the serial spine at ~77 s × 15.

If $0.41 is over the line, the cheapest thing to give back is the cross-family read (keep luna, $0.36),
not the dossier: the read's *notes* were already good on luna; its self-review bias matters less for
deletion than for prose.

### 1.4 The data

**`BookArc`** (new, stored on the plan version beside `authorStance`; produced by call 5; validated by zod;
the writer sees only its own chapter's lines):

```
question:      one sentence the book answers, with at least two live answers in the literature
opponent:      { name, work, year, claim, whereRight, whereTheBookBreaks, sourceUrl }   -- verified: sourceUrl must be one of the research rows
answer:        the book's claim, contestable, stated once
turn:          which chapter puts the answer in trouble, and how it is repaired
chapters[]:    { index, kind, pages, job: { believesSoFar, does, adds, leavesOpen }, cast[], dispute? }
  kind:        case | argument | portrait | document | complication | method | resolution
  does:        establish | complicate | reverse | repair | resolve   (one verb, then one sentence)
  cast:        2–4 named people from the dossier, each with the excerpt that carries them
  dispute:     { sideA: {name, claim}, sideB: {name, claim}, atStake }  -- from the brief's "Contested Claim" markers
proposal:      3–4k words of prose, the book as its author would pitch it, chapter by chapter
```

For composed-7's plan the arc keeps the fifteen titles and their order and re-cuts the pages (one
plausible cut: 5 / 8 / 10 / 8 / 7 / 6 / 10 / 12 / 6 / 8 / 8 / 8 / 10 / 6 / 8 = 120), e.g.:

- ch 1 *What Do We Mean by Human Aggression?* — kind `method`, 5 pages, does `establish`: the question
  and the opponent (Pinker's *Better Angels*: the Leviathan pacifies; the book will agree for the
  homicide register and disagree for everything above it). Hobbes ch. 13 quoted, not paraphrased.
- ch 3 *Cities, Kings, and the Invention of Organized War* — kind `case`, 10 pages: the Stele of the
  Vultures and Eannatum's boundary war, narrated from the inscription's own text (public-domain
  translation), one episode. Ends when the stele's last register ends.
- ch 8 *States, Slavery, and the Atlantic World* — kind `case`, 12 pages: the *Zong* through *Gregson v.
  Gilbert* (the judgment is quotable), the 1739 "Account of the Negroe Insurrection" (quotable), the
  Barbados code's own words. Cast: Collingwood, Sharp, Jemmy. Dispute: Williams thesis vs its critics.
- ch 10 *Revolution and the Politics of the Crowd* — kind `complication`, 8 pages, does `reverse`: crowds
  kill without offices; the book's answer is in trouble. `leavesOpen`: whether the sections and
  committees are the office. Chapter 11 `repairs`.
- ch 13 *Genocide, Total War* — kind `document`, 10 pages: the Wannsee Protocol read line by line
  (the Nuremberg translation is a U.S. government work, public domain), then Rwanda's radio
  transcripts (ICTR exhibits). Dispute: intentionalist vs functionalist, by name.
- ch 15 — kind `resolution`, 8 pages: the answer, spoken for the second time, through Able Archer.

**Dossier rows** (new `ResearchSource.kind = "primary-excerpt"` or a `Chapter.dossier` JSON column):
`{ chapterIndex, text (≤250 words, verbatim), speaker, date, work, url, fetchedSha256, offset, licence:
"public-domain" | "government" | "court" }`. Only these may be quoted. Scholars' positions are stored as
`dispute` and are *paraphrased* with a name and a title, never quoted — no copyright exposure.

**Compose prompt** (what changes in `composeChapter`): drop `stanceLinesFor` for chapters 2..n−1 (keep the
rhythm exemplar); add `arc.chapters[i]` as five prose lines (job, kind, cast, dispute, what the reader
believes); add `dossier` to the payload with the rule "quote only from dossier, verbatim, up to the whole
excerpt; name the person and the document; argue with `dispute.sideA/B` by name"; drop the three
evidence-limit sentences from `shapeRules` for every kind but `method`; drop `book.styleNotes`/
`continuityRules`/`promises` (they were kept because removing them scored 7.08 vs 7.32 — inside the noise
band of §3.1, and under the arc their job is done by the proposal). `previousChapterTail` stays at 300.

**Guards** (deterministic, model-free, so they meet the 99% rule by construction):

- *Quote provenance*: every quoted span of ≥8 words in the chapter, whitespace- and quote-normalised, must
  be a substring of a dossier row's `text`. A miss is a note to the cut, which removes the sentence or its
  quotation marks; nothing rewrites it. Replay on the 34 existing books first: they contain no dossier
  quotes, so the guard should fire on every quoted span there and on none of the arm's — that is the
  precision test.
- *Arc paste*: `job.leavesOpen` and `job.adds` content-word overlap with any sentence ≥80% → note to the cut
  (the composed-1 landing-paste check already exists in this shape).
- *Arc leak*: "this chapter", "the next chapter", "we will see", "as we saw" → page leak pattern.
- *Kind compliance*: a `document` chapter with fewer than two dossier quotes, a `case` chapter whose first
  1,000 words carry no date and no named person → recompose once with the shortfall named.

### 1.5 The seams call, since it is the piece nobody has run

Input: for each chapter its first and last paragraph verbatim (30 paragraphs, ~6k words), the arc's
per-chapter jobs, and the read's `bookNotes`. Contract: return the thirty paragraphs; no two closings may
share a shape; no closing may state the book's answer, weigh two sides, or re-list the chapter's cases; a
`case` chapter closes on its last event, a `document` chapter on its document, a `complication` chapter
on the problem; openings may not open on the same construction as any other opening; every fact, name,
date and quotation in the input paragraph is kept. Deterministic acceptance: thirty paragraphs back, each
within 0.6–1.4× the length of the one it replaces, each keeping every proper noun and number of the
original, pairwise closing similarity under a threshold; a paragraph that fails keeps the original. This
is `research-improvements.md` experiment 4, priced at $0.02, ranked "run third" on 2026-09-02, and never
run. It attacks three of the five complaints at their address.

### 1.6 Build plan and what to implement first

| Step | Work | Days | Depends on |
|---|---|---|---|
| A | `BookArc` schema + `architect-book` call + arc lines in the compose prompt + thesis withheld from 2..n−1 + kinds/lengths into `chapterSetupsForPlan`/`normalizePlanPageTargets` + forms planner takes `kind` | 1 | – |
| B | `seams-together` + deletion-only tail cut consuming the read + arc-audit question in the read + ≤2 recomposes | 0.5 | – |
| C | Drop `edit-chapter` behind `chapterEditorPass=false` on balanced; reroute `describe-pages` to judgment | 0.1 | – |
| D | `find-primary-sources` (repository clients, fetch, extract, cache by URL) + `extract-excerpts` + dossier rows + `dispute` from the brief's contested markers | 2–3 | – |
| E | Quote-provenance, arc-paste, arc-leak, kind-compliance guards + replay on the 34 books | 0.5 | D |
| F | `opponent.sourceUrl` verification against research rows; first person permitted in `argument` sections only, counted by the read | 0.2 | A |

**First: A + B + C, run as arm 1.** It is a day and a half, costs about $0.07 less than today, and it is the
half of the paradigm that attacks pacing (5.7) and "complete by chapter four" directly. D + E while arm 1
runs, then **arm 2 = arm 1 + D + E**, which is the half that attacks engagement (6.0) and depth (7.1), and
the only honest version of the +1 engagement the model swaps bought with invented particulars.

Model for the architect: deepseek-v4-pro off-peak ($0.02) — its book had the best paragraph-level
judgment of any writer tried, and an architect writes 4k words, not 55k, so its short-draft habit costs
nothing. gemini-3.7-flash ($0.035) is the alternative and the one to use if DeepSeek's peak rate applies.
gpt-5.6-terra ($0.10) fits only because the paraphrase edit is gone; not first choice.

### 1.7 The experiment

Composed-7's plan via `--reuse-plan`, the arc allowed to re-cut pages among the fifteen titles (sum 120)
and assign kinds, luna low, three replicates per arm, the flat stance file kept for the `method` and
`resolution` chapters only.

Primary measures (pre-registered, in this order):

1. **Engagement and pacing means** over nine verdicts. Pass: engagement ≥ 7.0 and pacing ≥ 6.5. The swaps
   showed +1 on engagement is visible with three readers (7/7/7 twice).
2. **Pairwise, cross-family, chapter-aligned excerpt win rate against composed-23a** (§3.3): six fixed
   excerpts, both orders, gemini-3.7-flash and deepseek-v4-flash as judges. Pass: ≥ 65%.
3. **Counts on chapters 8 and 12** (§3.4): couplets per 1,000 sentences, verdict closers, thesis
   restatements, one-sentence paragraphs. Pass: each at most half of 23a's.
4. **Provenance**: quote-verbatim rate 100% (the guard makes this a property of the code); model-supplied
   proper-noun share (`provenance-probe.ts`) ≤ 25%.
5. **Printed pages ≥ 108** of 120 (23a–c printed 104–115).

Secondary: overall ≥ 7.9 on two of three replicates; the read's "chapter at which the argument stops
developing" ≥ 12 (23a's answer, if asked, would be about 4). Cost ≤ $0.42, wall time ≤ 30 min.

Kill criteria: engagement still ≤ 6 with the arc *and* dossier in, quotes verbatim, counts halved → the
block is the writer's cadence and the next arm is the seams on gemini-3.7-flash ($0.03) and, if that
fails, a writer swap on the *fixed* inputs (§4.2). Engagement up but provenance share up → the dossier
leaked invention through paraphrase; tighten the contract before believing the score.

### 1.8 What I considered and would not build first

- *Whole-book prose drafting by a strong model, then per-chapter expansion.* No model in the catalog holds
  55k words of prose in one output, and expansion of a strong draft by a weak model is a paraphrase edit
  in reverse — the homogenising operation the record already has. The proposal *is* the whole-book draft
  at the only granularity one call can hold coherently (3–4k words); expansion happens against it.
- *Multi-chapter blocks (three chapters per call).* Luna already delivers ~4.4k words per call at most;
  a 12k-word call would come back as one chapter and a tail.
- *Best-of-N with a judge.* Settled 2/15 under a one-point gap; the judge is the wrong instrument for
  drafts that share a prompt. The arc changes what a draft is asked to do; that moves more than choosing
  between two answers to the same ask.
- *An author persona built from a stylistic exemplar.* The rhythm exemplar is already there; the
  literature says exemplars set register, not variance. Opinions come from an opponent, not a voice.

## 2. Incremental ideas that fit the current architecture, ranked by expected effect on engagement and pacing

None of these was run. "×3" is three replicates on composed-7's plan. Effects are on the panel's
engagement/pacing scale, where a one-point move is readable and a half-point is not.

| # | Change | Targets | Expected | Cost | Notes |
|---|---|---|---|---|---|
| 1 | **Withhold the thesis and positions from chapters 2..n−1; give each a deterministic job line** — `believesSoFar` = the landings of the chapters before it, `adds` = its own landing, `leavesOpen` = the next chapter's subject — built from the existing form plan, no new call | pacing (thesis restated, recap tails); engagement (complete by ch. 4) | +0.5–1.0 pacing | $0 | The rotation arm (composed-8/9) is *not* a measurement of this: it swapped five things and gave each chapter one position *to prove*. A job is not a position. |
| 2 | **Seams-together** (§1.5) | pacing/slop (closers, recap tails) | +0.5 pacing, slop +1 | $0.01–0.03 | Deterministic acceptance per paragraph; falls back to the original. |
| 3 | **Chapter kinds and lengths 3–14 pages** in the planner (one case chapter, one document chapter of 3–4 pages, one short interlude), `normalizePlanPageTargets` keeps the sum | pacing ("same middle temperature"), structure | +0.5 pacing | $0 | Section counts were varied in 23; chapter length and kind never. Planner line at `planner.ts:108` ("six to nine pages") is the one to change. |
| 4 | **A named, verified opponent and a per-chapter dispute** in the stance — from the brief's "Contested Claim" markers, which already exist and are thrown away as prose | engagement ("nothing to disagree with") | +0.5 engagement | $0 | Verify the work exists (a research row URL). First person permitted in `argument` sections only. |
| 5 | **Deletion-only tail cut consuming the read**, cap 6 chapters, last 600 words | pacing | +0.3–0.5 pacing | $0.03 | Never isolated. Code exists (`cutChapter`, `deletionOnlyResult`, `READ_SECOND_EDITS`). |
| 6 | **Primary excerpts + verbatim guard** (§1.4 D+E) without the arc | engagement, depth | +0.5–1.0 engagement | +$0.08, 2–3 days | The swaps' gain, honestly. Requires the guard; do not run without it. |
| 7 | **Cross-family read** (gemini-3.7-flash) whose notes the cut consumes | pacing (better cuts) | +0.2 | +$0.05 | Same-model self-review is the documented weak case; deletion is where it matters least, so this is rank 7 not 3. |
| 8 | **Ablate the line edit** (`chapterEditorPass` off on balanced) ×3 | unknown | 0 to −0.3, or +0.2 if the fusion is real | −$0.126 | 38% of cost, never ablated. If invisible, it funds every row above. |
| 9 | **Operation-list edit** replacing the paraphrase: JSON `{cut|merge|split}` over numbered paragraphs, applied deterministically | pacing; funds the rest | +0.2 pacing | −$0.09 | `research-improvements.md` #8. Only after #8 says the paraphrase buys nothing. |
| 10 | **Effort `none` + temperature 0.9** on compose ×1 | – | ~0 | $0.35 | The knob has never been connected on luna; closes the question. |
| 11 | **Cross-family seam writer** (flash writes the 30 seam paragraphs instead of luna) | slop (cadence at the seams) | +0.3 slop | $0.03 | Cheapest way to buy a second idiolect exactly where the tics cluster. |
| 12 | **Retypeset to ~350 words/page + printed-page floor** | product | 0 on this panel (480 vs 520 tied) | 1 day | Makes DeepSeek/Gemini print full; cuts cost 25–30%. Not an engagement lever on the evidence. |
| 13 | **`describe-pages` to the judgment model** | – | 0 | −$0.03 | Still on luna in 23a ($0.0415 for 81k/17.6k tokens matches luna's rates). Opinion 3 #6, not applied. |

Order for one working day: 1 + 2 + 3 + 4 as one arm ×3 (they are all content assignments and all free;
attribution later if it moves), 8 as its own arm when a worker is idle, 6 built meanwhile.

## 3. Evaluation

### 3.1 What the panel can and cannot see (computed from the 33 books under `evals/` with three verdicts)

The three verdicts per book are three samples of one Opus prompt; `A/B/C` is file order, not a reader
identity. Treating them as three readers:

| | all 33 books | the 25 books between 6.8 and 8.0 |
|---|---|---|
| Spearman between reader samples on "overall" | 0.56 / 0.42 / 0.62 | **0.08 / −0.13 / 0.28** |
| mean within-book SD of the three overalls | – | 0.25 (mean range 0.58) |

The correlation across all books is carried by the four broken ones (per-page 6.0, composed-2 5.4,
composed-13 2.8, composed-18 6.6). **Inside the band where every decision since composed-3 has been
made, two samples of the panel do not agree on which book is better.** A three-reader mean has an SE of
~0.14 from reader noise alone, before book-to-book variance (0.67 spread on identical configuration).
So: 7.31 → 7.45 is not a measurement; 7.73 (composed-7) was one draw; and "the panel's noise is ±0.4"
understates it for ranking purposes.

Per criterion, in the band: between-book SD of the three-reader mean versus mean within-book SD —
thesis 0.36/0.25, clarity 0.35/0.26, reasoning 0.33/0.34, craft 0.35/0.23, slop 0.36/0.49,
**engagement 0.49/0.23**, pacing 0.35/0.35. Engagement is the one criterion where the panel agrees with
itself more than it varies between books — and the between-book variance there is the two model swaps
(7/7/7 both times). The instrument sees a one-point engagement move and nothing else. Design experiments
that can produce one.

### 3.2 A human-written baseline, before anything else

Run three published trade histories of this kind through the identical rubric and the identical three
samples: Keeley, *War Before Civilization* (1996); Pinker, *The Better Angels of Our Nature*; Azar Gat,
*War in Human Civilization*; and one public-domain classic as a style anchor (Macaulay's *History*, ch. 3,
or J. R. Green). Purchased ebooks, text extracted locally, never stored in the repo. Three answers you do
not have: what "Ready" scores; whether human books also draw "engagement 6" and the five complaints (if
so, criterion 10 is priming and the list has to go); and whether Opus rates a book *it recognises* higher
(score Pinker with and without the title). Cost: an afternoon and about $3 of panel tokens. Until this
exists, "7.45" has no unit.

### 3.3 Pairwise, aligned, position-swapped, cross-family — the protocol written twice and run zero times

`research-improvements.md` §5.1, unchanged: six fixed excerpts per book (first ~900 words of chapters 1,
5, 10, 15; last ~450 of chapters 8 and 15), both orders, forced choice, two judges from families the
writer is not (gemini-3.7-flash, deepseek-v4-flash), Bradley–Terry, bootstrap interval. ~24 calls, $0.10.
Validate on the 33 existing books against the panel's band-order first; expect ~70% agreement and use it
to rank arms, the panel to release. `judge-validation.ts` is most of the harness.

### 3.4 Close reading of fixed chapters, as counts

For chapters 8 and 12 of every book (the same two, always): a reader with the *definitions* — not the
rubric — counts (a) sentence pairs of the form "X shows/establishes A. It does not show/establish B", (b)
section-final sentences that balance two clauses, (c) sentences that restate the book's answer, (d)
paragraphs under 20 words, (e) direct quotations ≥ 8 words and named persons who act. Report per 1,000
sentences. These are numbers that can halve; the pattern list cannot.

### 3.5 Two questions that measure engagement directly

Add to the rubric, unchanged otherwise: "**Put-down page**: the page at which a general reader who bought
this book would stop reading, and why" and "**Development**: the chapter after which the argument stops
changing what you believe". Both are integers, both move, both are the product question.

### 3.6 De-prime criterion 10

Remove the list of moves from the criterion text; ask for "up to five recurring moves, two quoted
instances each" with no examples; and add "three passages you would read aloud to someone" beside "three
you would cut". The pattern list is currently the rubric reflected back, which is why it cannot show a
reduction.

### 3.7 One non-Anthropic reader on the absolute rubric

Not for the mean — for the check that gemini-3.7-flash and deepseek-v4-pro *also* give luna 6 on
engagement and give each other 7. Family bias in judges is documented; one $0.50 run answers it for this
rubric.

### 3.8 Provenance beside every score

Keep `provenance-probe.ts` in the table; add the quote-verbatim rate once the dossier exists. A score that
rises with the model-supplied share has found the DeepSeek premium, not a lever.

## 4. Where I think the record is wrong

1. **"The couplet and the antithesis are the balanced writer's house style; the one lever the panel can
   see is the writer model."** Every ablation held the *task* constant: one epistemological thesis, five
   beliefs in every prompt, a citation contract with nothing quotable, 15 × 8 pages. Under that task
   DeepSeek's negation rate was 61.7/1000 to luna's 31–37 and every writer drew the same five complaints.
   The subtraction ablation (6.50) shows the rules are net positive *for this task*; it does not show the
   task is the ceiling. The task was never varied.
2. **The writer A/B is not a model ranking.** Composed-14/15 ran on the broken research (twelve dictionary
   snippets, chapters 13–15 unsearched) and were judged with "do not fact-check". Luna on fixed inputs
   (23a–c) was never compared with DeepSeek or Gemini on fixed inputs. Do not cite 7.67/7.57 vs 7.31 as
   "the model moves the panel" until the same inputs have been given to both; and note that Gemini at 13
   minutes and $1.10 is a *pricing* problem, which is a different department from prose.
3. **"One position per chapter cost the book its argument."** Composed-9 changed rotation, the stripped
   editor, one draft, the 540 budget, the deletion cut and the tail rule together; composed-10 restored
   four of them together. Rotation alone was never measured, and what rotation gave a chapter was a belief
   *to prove*, which is a demonstration with a smaller thesis. The withheld-thesis-plus-job design (§2 #1)
   is a different thing and is untested.
4. **"The gain is real but small" (7.31 → 7.45).** With reader agreement inside the band at ~0 (§3.1),
   the honest statement is: no detectable change on engagement or pacing, six replicates. The inputs fix
   was right for the product (the writer no longer cites pearson.com) and invisible to the instrument.
5. **"Content assignments do not become tics; shape prescriptions do."** Half right. The thesis and the
   five positions are *content*, assigned to all fifteen chapters, and they are the most-quoted refrains
   in every panel. Content assigned once per book becomes a refrain; content assigned once per chapter
   does not. The unit of assignment is the variable, not content versus shape.
6. **"$0.33 per book."** The trace's cost table has no research row. `LoggingResearchAdapter` logs request
   and response and records no usage; `costs.ts` has no grounding rate. A balanced book runs ~25 Gemini
   grounded queries; Google lists Grounding with Google Search at $35 per 1,000 grounded prompts beyond
   the free daily allowance. If that rate applies, research is ~$0.88 a book — 2.6× the prose — and every
   cost comparison in the spec is missing its largest line. Check the Costs tab and the Gemini invoice
   before adding queries; it is also why §1.3's dossier uses repository APIs and not more searches.
7. **The mean is the wrong target.** Ten equally weighted criteria, seven of which sit at 8–9 in every
   composed book, put a 6.0 engagement / 5.7 pacing book at 7.5. A book with thesis 9 and engagement 6 is
   a book people do not finish; the rubric reports it as "needs light revision". Report engagement and
   pacing first, the mean last.
8. **The read is the best instrument in the pipeline and feeds nothing.** 23a's `bookNotes` name the five
   refrains with chapter numbers, for $0.02, from the writer's own model. `READ_SECOND_EDITS = false` sends
   them to the console. Before any new gate, consume that one.
9. **Smaller.** `describe-pages` still runs on luna despite `MECHANICAL_TEXT_PURPOSES` (23a's $0.0415 for
   81k/17.6k tokens matches luna's rates; opinion 3 #6 was not applied). The paraphrase edit is 38% of
   spend and has never been switched off in an arm. `earlierOpenings`/`earlierClosings` are still computed
   in the pass and read by nothing. None of these changes a score; all of them cost the next reader's
   trust in the numbers.

## Appendix: the agreement numbers

Computed from `evals/*/{A,B,C}.json` over the 33 books with three verdicts (composed-20b, per-page and
the two failed books included where present); "overall" recomputed as the mean of the ten criteria.
Band = three-reader mean between 6.8 and 8.0 (25 books). Spearman between reader samples on overall:
all books 0.56 (A–B), 0.42 (A–C), 0.62 (B–C); band 0.08, −0.13, 0.28. Mean within-book SD of the three
overalls in the band 0.25; mean range 0.58. Engagement by book in the band: every luna book 5–6 with at
most one 7 (23a, 19b); composed-14 and composed-15 7/7/7. Pacing: every luna book 4–6; Gemini 7/6/6.
