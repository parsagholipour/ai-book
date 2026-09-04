Edi# Structural slop in composed chapters: evidence, causes, and what to try next

Status: research report, 2026-09-02. Written against runs composed-1..4 (panel-scored), the per-page
baseline, the partial composed-5 log (chapters written and first-edited; the read and second edits
were still running), the full provider logs of every run, and the pipeline code as of today. All
numbers below are reproducible with the scripts described in the appendix; nothing in the repository
was changed.

## Executive summary

The panel is not reacting to counts of any move. It is reacting to *the same move in the same
position on every page*, and the pipeline manufactures that in four places the logs make visible.

1. **The plan is pasted.** In composed-3, 42 of 45 section handoffs (93%) and 15 of 15 chapter
   landings reach the prose verbatim or near-verbatim; composed-4: 76% and 15/15; composed-5, which
   carries the new "the plan is not visible to the reader" rule, 80% and 15/15. The panel's
   "rhetorical question as the hinge between sections" and "identical chapter-closing paragraph" are
   those strings. Every chapter in composed-3/4/5 is four sections of exactly 25%, each owning named
   cases, plus one landing: the roll-call conclusion is the only paragraph that can close that plan.
2. **The line edit is a paraphrase.** It rewrites 63% of sentences (composed-3) and leaves every
   paragraph boundary, the paragraph-length CV (0.16→0.19), the generalising-closer share (0.43→0.44),
   the list share and the roll-call untouched. It obeys the quoted measurement notes lexically
   (negation-correction sentences 148→56) and fuses the two-sentence hedge into the one-sentence
   antithesis the panel then names: "while" rises 20%, intra-sentence hedges 1.5→2.7 per 1000
   sentences, in composed-3, -4 and -5 alike. It is 45% of the book's cost.
3. **The read is right and unheard.** Its per-chapter notes are executed at 95–100%, but they are
   local cuts steered by the measurement payload; its `bookNotes` — which in composed-3 name the
   panel's three top patterns exactly — are consumed by nothing.
4. **The writer is shown the shape it is told to avoid.** Since the sample rules changed, a third to
   a half of the voice sample's sentences are contrastive antitheses (composed-1's sample was 74%
   aphorisms, and composed-1's tic was the aphorism); the stance is five "believes X, rejects Y" pairs; the prompt
   carries 47–60 negations and a list of thirteen earlier closings that are 54% contrastive. The
   writer has ~1 quotation per 53,000 words because the research notes are web summaries and the
   prompt forbids any source not in them, so "what the source shows / cannot show" is the only honest
   move it has.

The deterministic scorecard cannot be the target: every number improved from composed-3 to -4 while
the panel fell, and composed-4's loss came from artefacts of the mechanical fixes (orphan lines,
chapter cross-references, duplicated sentences). Three evaluators also cannot resolve differences
under ~0.6 (composed-1 → composed-3 is inside evaluator noise).

Recommendations, in order: (A) a subtraction run — hide the plan's sentences and the closings list
from the writer, replace the generated voice sample with a fixed public-domain rhythm exemplar,
restate positions as plain assertions, cut the rule list to a handful; (B) best-of-2 chapter drafts
chosen by a position-swapped pairwise judge from another model family, paid for by dropping the
second edit; (C) one call that rewrites all fifteen chapter endings side by side under the read's
bookNotes. Then build quotable-evidence retrieval, which is the ceiling-raiser. Replace the
scorecard with a pairwise, chapter-aligned judge protocol plus a small set of pass/fail regression
guards.

---

## 1. Evidence

### 1.1 What the panel resolves

| run | overall | per evaluator | readiness | engagement | pacing | slop res. |
|---|---|---|---|---|---|---|
| per-page | 6.03 | 5.9 / 6.3 / 5.9 | moderate ×3 | 4.00 | 4.00 | 4.67 |
| composed-1 | 7.10 | 7.4 / 7.2 / 6.7 | light / moderate / light | 6.00 | 5.33 | 6.00 |
| composed-2 | 5.40 | 6.0 / 5.3 / 4.9 | moderate / major / major | 3.33 | 2.67 | 5.00 |
| composed-3 | 7.47 | 7.7 / 7.5 / 7.2 | light ×3 | 5.67 | 5.67 | 6.67 |
| composed-4 | 6.90 | 6.7 / 7.2 / 6.8 | moderate ×3 | 4.67 | 5.00 | 6.00 |

Within-panel spread is 0.25–0.55 points. Per-page → composed (+1.07) and composed-3 → composed-2
(−2.07) are real; composed-1 → composed-3 (+0.37) is inside noise, and composed-3 → composed-4
(−0.57) is marginal. The readiness labels corroborate composed-3 as the best book, but the
iteration log's "7.10 → 7.47" should not be read as two distinct results. Any proxy must therefore
be pairwise (section 5), and any experiment that hopes to move the panel by less than half a point
needs more than three absolute reads to be seen.

Where the score is lost is stable across runs: composed-3 scores 8–9 on thesis, structure,
reasoning and clarity and 5.7 / 5.7 / 6.7 on engagement, pacing and slop resistance. The panel is
consistent that the book *says* the right things and *reads* like one machine.

### 1.2 Chapter endings, read side by side

I read the final paragraph of all fifty chapters (dump in the appendix method). Counts:

| run | chapters | roll-call close (≥3 of the chapter's names recalled) | landing sentence present in final paragraph | final-paragraph words | dominant close |
|---|---|---|---|---|---|
| composed-1 | 10 | 1 | 8/10 verbatim as last sentence | 54 | one-sentence "did not simply X; it Y" verdict (6 chapters) |
| composed-2 | 10 | 7 | 3 verbatim, 7 near | 57 | placed object tableau (8 chapters) |
| composed-3 | 15 | 9 | 7 verbatim, 8 near (15/15) | 125 | landing as topic sentence → one clause per section's case → abstract close (12 chapters) |
| composed-4 | 15 | 7 | 3 verbatim, 12 near (15/15) | 125 | same shape; landing paraphrased |
| composed-5 (partial) | 15 | — | 3 verbatim, 12 near (15/15) | 116 | same shape (every chapter's last paragraph opens on an abstract thesis sentence) |

In composed-3 the landing is the *first* sentence of the final paragraph in five chapters, the last
in two, inside it in three; in the remaining five no single sentence carries it, but every chapter
contains it at ≥75% of its content words, spread over the closing sentences or placed earlier. The "conclusion in a full
paragraph" rule did not create a conclusion; it created the five-paragraph-essay close: restate the
assigned thesis, touch each owned case in a clause, generalise. That is exactly what a plan of four
sections each *owning* named cases plus one *landing* sentence asks for, and the writer did it
fifteen times because it was asked fifteen times.

Composed-5's new rule ("never mention the sections, forms, handoffs or notes you were given")
changed nothing measurable: 80% of handoffs and 15/15 landings still reach the prose, because the
rule forbids *mentioning* the plan and the writer is *delivering* it.

### 1.3 The hedge, before and after the edit

The panel's "establishes X / cannot establish Y" family is wider than the adjacent two-sentence
couplet the code measures. Counting any sentence that pairs a negation with an evidence word
(record, source, bone, tablet, establish, show, reveal, identify, prove …):

| book | share of all sentences | count | share of paragraph-final sentences |
|---|---|---|---|
| per-page | 9.3% | 316 | — |
| composed-1 | 5.4% | 177 | 8.1% |
| composed-2 | 5.6% | 179 | 8.9% |
| composed-3 | 6.4% | 207 | 7.6% |
| composed-4 | 6.2% | 192 | 9.7% |

The family is ~200 sentences per composed book and did not move between composed-1 and composed-3
while the panel's slop score rose 6.0 → 6.7. What the edit does to it (composed-3, 15 chapters,
second edit over the 12 chapters the read flagged):

| measure | draft | line edit | second edit |
|---|---|---|---|
| evidence-limit sentences (share) | 8.0% | 6.5% | 6.1% |
| negation-correction sentences (lexical pattern quoted to the editor) | 148 | 56 | 41 |
| adjacent "It can show X. It cannot show Y." pairs | 16 | 9 | 7 |
| intra-sentence hedge ("shows X; it cannot Y", "X without Y") per 1000 sentences | 1.5 | 2.2 | 2.7 |
| "while" per 1000 words | 3.3 | 4.4 | 4.4 |
| symmetrical two-clause closers (share of paragraphs) | 0.09 | 0.10 | 0.10 |

The editor complies with the letter of the measured note and keeps the move. Two of the fusions,
draft → edit:

> "The archive can show how the police translated a domestic encounter into public order. It cannot
> by itself recover the household's full history." → "The archive shows how police translated a
> domestic encounter into public order; it cannot recover the household's full history."

> "It may show where structures were damaged without showing who lived there … It may distinguish
> types of damage without recording the political decisions…" → "A location could be marked without
> recording who lived there, who was absent, who lacked shelter, or who could restore a household."

Composed-4 (negation-correction 41 → 10 per 1000 sentences, "while" 4.0 → 5.2 per 1000 words) and
composed-5 (48.6 → 16.8; "while" 3.1 → 4.6) show the same transfer. This is the "bans move a habit to
its nearest sibling" lesson measured: the measurement notes are the mechanism.

### 1.4 What the line edit is

| run | sentences surviving draft → edit unchanged | word-level diff ratio | paragraphs draft → edit | paragraph CV | generalising closers | list share |
|---|---|---|---|---|---|---|
| composed-1 | 90.5% | 0.97 | 62.7 → 61.5 | 0.15 → 0.15 | 0.37 → 0.38 | 0.18 → 0.19 |
| composed-2 | 54.6% | 0.79 | 53.9 → 57.6 | 0.18 → 0.18 | 0.35 → 0.42 | 0.17 → 0.18 |
| composed-3 | 36.7% | 0.83 | 40.9 → 40.4 | 0.16 → 0.19 | 0.43 → 0.44 | 0.19 → 0.21 |
| composed-4 | 42.1% | 0.85 | 40.2 → 40.5 | 0.14 → 0.17 | 0.29 → 0.31 | 0.19 → 0.20 |

The edit rewrites most sentences and preserves every structural fact of the draft: paragraph count
(chapter 5 of composed-3 has 45 paragraphs in draft, edit and second edit, with near-identical
lengths), paragraph boundaries, section order, the closing move of each paragraph. "Reshape
paragraphs … merge … let a turn stand alone" has never been executed in any run, with words or with
numbers; the prompt's own keep-rules ("keep every fact … and the order of sections") describe a
paraphrase and a paraphrase is what it buys. It costs $0.22 of composed-3's $0.49 (27 of 79 calls)
and cuts 12% of words. The whole-passage rewrite is also the operation the literature finds most
homogenising (section 3.5).

The focused `detemplate-chapter` pass in composed-4, on the 12 chapters it did not truncate: word
diff ratio 0.993, sentence survival 97.1%; pivots fell 0.69 → 0.05 per 1000 words and symmetrical
closers 0.08 → 0.03, nothing else moved. Three chapters came back at 37, 134 and 266 words. $0.09 and
six minutes.

### 1.5 What the read does, and what happens to it

Compliance of the second edit with the read's quoted cut targets: composed-2 21/22, composed-3
36/36, composed-4 35/35. The second edit changes ~10% of sentences (survival 0.895) and no shape
measure; the reader notes are four local cuts per chapter ("cut the list …", "cut the closing
sentence that generalises …", "repeats chapter N's conclusion …"), i.e. the categories of the
`measurements` payload the read is handed. The read's `bookNotes` in composed-3, written without a
measurement to lean on, are the panel's verdict a day early:

> "Nearly every chapter closes with an abstract synthesis built from paired contrasts such as
> protection and coercion, records and silence, or organization and force." · "The same cases recur
> across adjacent chapters …" · "its repeated catalogue sentences sometimes make the argument sound
> like a taxonomy."

`bookNotes` is stored in the trace and read by nobody; no prompt receives it.

### 1.6 The plan is authored uniform and then pasted

- Section shares: 60 of 60 sections in composed-3 and in composed-4 have share 0.25. Every chapter
  is four ~900-word quarters. Pacing at chapter scale is a constant.
- Positions (composed-3): scene or close-reading first in 11/15, comparison third in 11/15,
  counterargument last in 4. The deterministic rotation the spec worried about changed 1 section of
  60; the shape was authored by the planner's single call under a single instruction, and the
  positional check added in composed-4 fixed the *labels* without touching the register in which
  every form is written.
- Paste rates (final text, verbatim or ≥80% of content words): handoffs composed-3 42/45, composed-4
  34/45, composed-5 36/45; landings 15/15 in all three; through-lines 4–7/15. The panel's instance
  "How did a single conquest continue through settlement, tribute, and memory? Carthage answers that
  battle was only the first conversion." is chapter 5's first handoff, verbatim.

### 1.7 The voice sample teaches the move

| run | sample sentences | generalising | balanced antithesis / contrastive (while, yet, but, ;) | the book's named tic |
|---|---|---|---|---|
| composed-1 | 19 | 14 | 0 / 1 | aphoristic openers and one-line verdicts |
| composed-2 | 13 | 5 | 1 / 3 | object tableaux (from the "end on a particular" rule) |
| composed-3 | 10 | 1 | 4 / 5 | "establishes X; cannot establish Y", "while" closers |
| composed-4 | 13 | 5 | 3 / 5 | same |
| composed-5 | — | — | (qualitatively the same: "held soldiers outside and suspicion inside, while each faction …") | — |

The sample rules ("every sentence names a particular, no general truths, no negation-correction")
are satisfied by the model with "particular A, while particular B" — the record/silence antithesis —
so the reference for diction *is* the shape the panel counts. The stance's positions are five
"believes X and rejects Y" pairs and its refusals four negatives: an assert-retract structure handed
to the writer as its identity. The prompt says "never reuse its sentences, its opening move, or its
closing move"; a sample can only teach moves.

### 1.8 The prompt as a corpus of the banned shape

Compose system prompts: composed-1 1,240 words / 27 negations; composed-2 1,882 / 60 (the worst
book); composed-3 1,734 / 47; composed-4 1,884 / 51; composed-5 1,933 / 56. The rule list has grown
every iteration. In composed-3's chapter-15 payload (52k characters, ~13k tokens) the writer also
sees 13 earlier closings (54% contrastive), 14 digests (24% contrastive) and 24 continuity notes (17%
source-limit hedges). The literature on negated instructions (section 3.1) says naming a shape
raises its probability; here the shape is named ~50 times and exemplified a dozen more.

### 1.9 The writer has nothing to quote

Quotations of 25+ characters per 10,000 words: per-page 0.58, composed-1 1.51, composed-2 1.06,
composed-3 0.19, composed-4 0.41 — about one quotation in composed-3's 53,000 words. First-person
pronouns: 1.2 per 10,000 words. The `researchNotes` a chapter receives are twelve web-search
snippets (unesco.org, medium.com, ebsco.com, tuenews.de …) of summary prose, no primary text, no
named historian's position; the prompt forbids "a diary, dispatch, archive, citation, named
testimony, or other source identity that researchNotes does not contain." An author who may not
quote and may not invent can only describe what a source *would* show: the hedge is the honest
residue of that constraint, and "no named interlocutor", "no quotation of primary text", "canonical
examples with thin historiographical engagement" (all three panels) are the same fact seen from the
depth and engagement criteria.

### 1.10 Deterministic measures against the panel

Composed-3 → composed-4: paragraph CV 0.19 → 0.31 (merge/split), negation-correction 17.5 → 11.2,
pivots 0.82 → 0.48, symmetrical closers 0.10 → 0.06, generalising closers 0.43 → 0.32, lists flat.
Panel: −0.57 overall, engagement −1.0. What the evaluators quoted instead were artefacts: orphan
one-line paragraphs from the deterministic split, "chapter 12 … chapter 14" in the prose (six
chapter-number references in composed-4, none in composed-3), a chapter quoting another chapter's
opening sentence as a source (from the forwarded openings list), sentences duplicated by successive
edits, and the "chain" metaphor in five chapters. Across the five books the only measure family
whose sign tracks every criterion is the hedge family (adjacent pairs r ≈ −0.9 with overall,
"establish" density r ≈ −0.7) — but composed-1 and composed-3 differ on it by less than one
sentence per chapter, so it cannot rank the runs that matter. Paragraph-shape entropy over a crude
move classifier rises monotonically composed-1 → composed-4 and does not track the panel either.

The panel punishes mechanical damage harder than it rewards mechanical variety.

### 1.11 Model behaviour visible in the logs

- Output ceiling: asked for 5,160 words (composed-1) the writer returned 4,500; asked for 3,840
  (composed-3) it returned 3,980. The 8-page chapter is right-sized to a ceiling the model has, not
  to the book (section 3.4).
- Reasoning: compose ran with 128 reasoning tokens in composed-3 and 126 in composed-5 (none);
  "medium" in composed-4 produced 327 — a label, not a think. Temperature 0.65 throughout.
- Paragraphs: draft mean 85–105 words, CV 0.14–0.18, essentially none over 150; 66–86% of
  paragraphs open on a topic sentence of ≤14 words or a generalisation; sentence-length CV 0.42–0.47;
  sentences of ≤6 words 5% (composed-3) vs 12% (composed-1); ≥35 words 1.3%; subordinate-clause
  openers 3%. This is the expository five-sentence paragraph, and the panel's "one paragraph shape".
  The per-page book, under different prompts and a different architecture, has the same hedge rate
  (9.3%) and the same closers: the shape is the model's default register for this task, which is
  what the literature on post-training collapse predicts (section 3.1).

### 1.12 What is actively harmful now

1. `landing`, `handoff` and `throughLine` strings in the writer's prompt (pasted at 76–100%).
2. `earlierClosings` in the writer's prompt (thirteen exemplars of the banned close; the openings
   list already caused one quotation and was removed).
3. The voice-sample rules and the believes/rejects stance framing.
4. `measurementNotes` to the editor (lexical compliance, fusion into antitheses) and to the read
   (steers its notes to local cuts).
5. Equal section shares.
6. The second edit as it stands: $0.10 and seven minutes for local cuts the panel cannot see, while
   `bookNotes` goes unread.
7. Fifty-plus negations in the compose prompt, growing by run.
8. Secondary: digests written as page summaries in the hedge shape fed back as "what the reader
   knows".

Not harmful, contrary to the spec's worry: the deterministic form rotation (1 change in 60);
`varyParagraphs` by merge alone (composed-5 keeps it; the split was the artefact).

## 2. Root causes

**Prompt-level (would move with wording).** The plan strings and closings list (1.6, 1.8); the
sample and stance shape (1.7); the negation list (1.8); the editor's brief, which describes a
paraphrase; the read steered by measurements. These explain the *specific* tics of each run: the
tics changed exactly when these strings changed, and the panel quoted the strings.

**Architectural.** (a) One call writes 4,000 words in one register; there is no seam at which
tempo or mode can change, and the form labels are all realised as the same expository paragraph.
(b) Equal quarters. (c) The edit is a whole-chapter rewrite under keep-everything constraints — a
paraphrase by construction, and the most homogenising operation available. (d) Every stage is
"generate once, keep": nothing anywhere compares two candidates, so there is no selection pressure
toward variety; variety is asserted by rules and rules are performed. (e) Cross-chapter variety
("no two endings alike") is a global property that no call ever sees — each chapter is written
against digests and one list, and the second edit sees one chapter. (f) The read's book-level
judgement has no consumer.

**Model.** gpt-5.6-luna without reasoning is a post-trained model, and the shape the panel describes
is what post-training does: sharpened output distributions, more nominalisations and participial
clauses, tidy structure, rhetorical devices spread evenly through a document, unchanged by
temperature (section 3.1). Its output ceiling sets the chapter length. Its self-judgement favours
its own text, so self-refinement with the same model as writer, editor and read amplifies rather
than corrects (section 3.3). None of the four runs changed the model at any stage.

**Plan and inputs.** Research notes with nothing quotable and no interlocutor (1.9); a form
palette whose "scene" needs a documented episode the notes cannot supply, so scenes degrade into
close readings; fifteen landings written by one call in one shape; digests in hedge shape; a stance
that is itself an antithesis. These set the ceiling: with the same inputs, a better-shaped book is
still a book *about* what evidence cannot show.

## 3. What is known to work, and what it means here

Citations are from three literature sweeps run for this report (details in the appendix).

### 3.1 Why the shape is in the weights, and why temperature and bans do not move it

- Post-training sharpens output distributions toward "typical" text: Verbalized Sampling (Zhang et
  al. 2025, arXiv 2510.01171) fits a typicality term α≈0.6 to human preference data and shows
  distribution-level prompting ("give five responses with probabilities") raises diversity 1.6–2.1×
  across GPT-4.1, Gemini 2.5, Claude 4, orthogonally to temperature. NoveltyBench (arXiv 2504.05228):
  frontier models give <4 distinct answers in 10 samples vs 8 for human writers; larger = less
  diverse; in-context regeneration (prior outputs in context) approaches human diversity. "Where does
  diversity collapse in post-training?" (arXiv 2604.16027): SFT is the main collapse and it "cannot
  be remedied through inference-time adjustments".
- The collapse is grammatical and structural, not lexical: Reinhart et al., PNAS 2025 (66 Biber
  features, 8,290 texts) — instruct models use present-participial clauses 2–5× and nominalisations
  1.5–2× human rates, base models track humans, the gap does not shrink with size. StoryScope (arXiv
  2604.03136, 61,608 stories): narrative-structure features alone detect model text at 93% F1.
  Shaib et al., EMNLP 2024 (arXiv 2407.00211): syntactic templates are more frequent in model text and
  "not overwritten" by RLHF. Bakhshi (arXiv 2604.19768): rhetorical devices spread "more uniformly"
  across model documents. This is the panel's "the same machine every paragraph".
- Temperature: Peeperkorn et al. 2024 — weakly correlated with novelty, moderately with incoherence;
  "Artificial Hivemind" (NeurIPS 2025 D&B best paper): intra-model similarity >0.8 at T=1.0; min-p
  contested (arXiv 2506.13681 finds no advantage once controlled). Sampling is not the lever.
- Negated instructions rebound: Pink Elephants (arXiv 2402.07896), White Bear / ReboundBench (arXiv
  2511.12381), DIM-Bench (arXiv 2502.04362); forbidden words remain a standing IFEval failure class.
  Our 47–60 negations per prompt are the textbook case.
- Length: LongWriter (ICLR 2025, arXiv 2408.07055) and HelloBench (arXiv 2409.16191) — instruct models
  fail past 2,000–4,000 words and the ones that continue repeat; reasoning models adhere best
  (LIFEBench, arXiv 2505.16234). Our 4.5k ceiling matches.

### 3.2 Exemplars and style, and the copyright of quoting them

- Exemplars beat descriptions for *register* but not for *variance*: STYLL / ASTRAPOP (arXiv
  2212.08986, 2403.08043); "Catch Me If You Can? Not Yet" (Findings EMNLP 2025, arXiv 2509.14543) —
  models "default to an average, generic tone" without exemplars, formal registers imitated at
  86–97%, content-similar exemplars *hurt*; Mikros 2025 (DSH 40(2)) — GPT-4o given 15,000 words of an
  author matched sentence length but still clustered with generic GPT output; Jemama & Kumar (arXiv
  2509.24930) — few-shot lifts style match up to 23× yet output perplexity stays at 15 vs 29 for
  humans: burstiness is not restored by showing it. ASTRAPOP documents content copied from exemplars,
  which is our composed-1 sample-leak in the literature.
- The best-supported exemplar *format* is contrastive: a weak paragraph, its rewrite, and a one-line
  reason (Gao & Das, AAAI 2024; TICL, arXiv 2502.08972, up to 91.5% win rate vs DITTO, explanations
  mattering most). Anthropic's own guidance: models copy the flaws in examples.
- Copyright: quoting a few hundred words of an in-copyright history inside a private prompt is
  low-to-moderate US risk (Bartz v. Anthropic and Kadrey v. Meta, June 2025, treat training as fair
  use but decide nothing about outputs; Harper & Row makes 300 words infringing when they are the
  "heart"; a cached prompt is a fixed copy) and has no exception in UK/EU commercial use. Style
  itself is not protected (17 U.S.C. §102(b)). Pre-1931 public-domain prose is zero-risk and
  plentiful: Macaulay, Henry Adams, Strachey, Bagehot, Hazlitt, Woolf's essays, J. R. Green, Turner.
  Avoid Gibbon — his period is *built* on antithesis, the tic we are fighting — and Carlyle. Use the
  original text, not a modern edition's apparatus; keep the exemplar off the book's subject.

### 3.3 Selection, critique, and judges

- Judges are good selectors and poor critics: JETTS (arXiv 2504.15253, 10 judges) — competitive with
  reward models for best-of-N selection, "ineffective in guiding the generator"; Landesberg (arXiv
  2603.12520) — a pointwise judge captured 21% of the best-of-4 gain, explicit pairwise judging 61%.
  Tyen et al. (ACL Findings 2024): models cannot *locate* their errors but fix them when told where.
  Our composed-4 detemplate result fits: the located spans were the wrong spans.
- Self-refinement with the same model amplifies self-bias and hacks its own score: Xu et al.
  "Pride and Prejudice" (ACL 2024), Pan et al. (arXiv 2407.04549) — evaluator scores climb while
  human judgement stagnates in iterated essay editing, worse when the judge shares the model and the
  context. Our writer, editor and read are one model.
- Pairwise, position-swapped, cross-family panels: Zheng et al. (NeurIPS 2023) — judge both orders,
  disagreement = tie; PoLL (arXiv 2404.18796) — a three-model panel beats a single GPT-4 judge (κ 0.76
  vs 0.63) at 7–8× lower cost and each judge over-ranks its own family; Panickssery et al. (NeurIPS
  2024) — self-preference is real and grows with self-recognition. LongJudgeBench (arXiv 2606.01629,
  ~9k-token items incl. creative writing): mean judge accuracy 0.56, order-swap inconsistency up to
  79% — long-document absolute judging is nearly noise; short aligned excerpts are the workable unit.
- Agreement with humans on writing: LitBench (arXiv 2507.00769; 2,480 length-debiased pairs — raw
  data had 65% longer-wins) Claude-3.7 73%, GPT-4.1 70%; "AI-Slop to AI-Polish" (arXiv 2504.07532):
  frontier models near chance on 4,729 writing-quality pairs, a trained reward model 74%, and its
  pipeline — flag spans, propose N rewrites, rank — preferred by experts 66%. Expert edits of LLM
  prose (LAMP, arXiv 2409.14509): awkward phrasing 28%, poor sentence structure 20%, redundant
  exposition 18%, clichés 17%. "The Reader is the Metric" (arXiv 2506.03310): reader profiles
  diverge; emotional variance, sentence-length and rhetorical variety are the features readers use.
- Whole-passage rewrites homogenise: van Nuenen (arXiv 2604.22142, 300 narratives, GPT-5.4 / Claude
  Sonnet 4.6 / Gemini 3.1 Pro) — "preserve voice" rewrites still compress variance in 78% of
  stylometric features (median −26%). No controlled study yet compares span-constrained edits with
  whole-document rewrites on long-form quality; our own logs are the closest data.

### 3.4 Architectures

- Finer plans buy adherence and cost variety: DOC (ACL 2023) — a 3-level outline with a controller
  gains coherence and relevance, but "further increasing control strength yields increasingly
  narrowly-focused, repetitive outputs"; only 58.5% of leaves achieved detailed relevance. Our page
  briefs were that. Re3 and DOC never had paragraph-level *shape* plans; nobody has shown those help.
- Chapter as unit with a learned plan: Gurung & Lapata 2025 (arXiv 2503.22828) — chapter plans
  rewarded by perplexity on the real next chapter, 76.5% human pairwise preference vs baseline,
  largest gain on creativity. Agents' Room (ICLR 2025): specialised writing agents doubled length
  and won; planner-only variants lost; humans still preferred human stories. Multi-agent for its own
  sake underperforms self-consistency at 10× cost (arXiv 2606.13003).
- Think-before-write: LongWriter-Zero (ICLR 2026) reports 1,200 vs 700 Elo with reasoning before
  drafting, and documents reward hacking toward stereotyped openings and keyword inflation when a
  single writing reward is optimised; RLMR (arXiv 2508.18642) needed a mixed reward.
- Diversity-targeted training (DivPO +74.6% story diversity at equal win rate; CrPO; Forcing
  Diffuse Distributions) needs weights we do not have; its inference-time analogue is best-of-N
  with a diversity-aware pick, and in-context regeneration.
- Constrained/guided decoding (FUDGE-style) is unavailable on the hosted models beyond `logit_bias`,
  and the DOC evidence says more control means more repetition. Not recommended.

## 4. Ranked experiments

Each runs in `scripts/dev-rerun-book.ts run --source cmtjbz54o000w6rjyvzewwqj4 --label <name>`
(~35 min, ~$0.5) followed by the panel. Composed-3 unit costs: compose $0.008 and 62 s per call,
edit $0.008 and 33 s, describe $0.003, read $0.02; the pipeline overlaps compose N with the finish
of N−1, so a second compose candidate adds cost but little wall time if it is issued in parallel.
Ranked by expected panel gain per run; "guards" are the deterministic pass/fail checks of section 5,
run before any panel is paid for.

| # | change | mechanism | new-tic risk | measure | cost |
|---|---|---|---|---|---|
| 1 | **Silent plan.** Writer receives forms, subjects and owned cases only; no `landing`, `handoff`, `throughLine`, no `earlierClosings`; no rule about the conclusion beyond "the chapter ends where its last section ends". The landing becomes a *question* the read checks the chapter against. | Removes the two strings pasted at 76–100% (1.2, 1.6); removes thirteen exemplars of the banned close. | Endings drift to thesis stamps (composed-1's tic) or objects; must be watched, not pre-empted with a rule. | landing/handoff paste rate → ~0; roll-call count; panel pacing/slop. | $0 |
| 2 | **Rhythm exemplar and assertive stance.** Replace the generated voice sample with a fixed ~250-word public-domain passage chosen for paragraph-length variety and committed assertion (Strachey, Adams, Macaulay), presented as "how paragraphs and sentences move", off the book's subject; positions restated as plain assertions; refusals removed from the writer's prompt (kept for the judge). | The sample's move becomes the book's move (1.7); exemplars set register (3.2). | Pastiche of period diction; content leakage from the exemplar (mitigated by off-topic PD text and the existing leak check). | short-sentence share, first-person rate, paragraph CV of drafts; panel voice. | $0 |
| 3 | **Best-of-2 drafts, pairwise cross-family judge.** Two compose calls per chapter (T 0.65 and 0.9, or one prompt asking for two chapters that differ in rhythm); judge = gemini-3.7-flash (not the writer), both orders, rubric = "which reads less like a template: paragraph rhythm, committed sentences, forward motion"; pick; drop the second edit to pay. | The only selection pressure in the pipeline; judges select well (3.3); pairwise recovers most of best-of-N gain. | Judge favours length or its own family's blandness — control length, swap order, forbid ties. | judge win margins; agreement of two judge families; panel engagement/slop. | +$0.15–0.25, +0–8 min |
| 4 | **Endings together.** After the read, one call receives all chapters' final paragraphs plus `bookNotes` and returns fifteen endings no two of which share a shape or restate the thesis; deterministic overlap check; same for openings. Replaces the second edit. | Cross-chapter variety is a global property only a global call can enforce (2.e); consumes the read's best output (1.5). | Fifteen contrived closes; truncation (guard on word counts). | pairwise Jaccard of endings, roll-call count, thesis overlap; panel. | ~$0.02, −$0.10 |
| 5 | **Uneven shares and one register break.** Planner must return shares with largest ≥2× smallest; in about half the chapters (planner's choice) one section is a narrated documented episode or a document quoted at length. | Pacing is variation in tempo (1.6). | The break becomes a tic if it is in every chapter — hence "about half", chosen by the planner, verified deterministically. | share variance; panel pacing. | $0 |
| 6 | **Prompt subtraction ablation.** Compose prompt cut to stance, forms, material, budget and at most five positively-phrased rules; no measurement notes to the editor; the read gets no `measurements`. | Rebound (3.1); the edit's fusion (1.3); the read's steering (1.5). | The composed-1 habits return ("did not simply" ×150) — that is the information this run buys. | negation-correction and hedge counts, paraphrase share of the edit; panel. | $0 |
| 7 | **Quotable evidence.** Research pass fetches public-domain primary text (Polybius, Ashoka's edicts, Domesday, Njáls saga in PD translations, Thucydides) and two or three named historians' positions per chapter into `researchNotes`; writer told it may quote and argue with them. | Removes the material cause of the hedge (1.9); gives depth and engagement something to score. | Hallucinated quotations if retrieval is thin (keep the existing invention ban; add a quote-provenance check). | quotations per 10k words; named-scholar mentions; panel depth/engagement. | +$0.1–0.2, +5 min; 1–2 days' engineering |
| 8 | **Structural edit as an operation list.** Editor returns JSON operations (merge, split, cut, move, rewrite-one-sentence) over numbered paragraphs, applied deterministically and diff-verified; no whole-chapter output. | Whole rewrites homogenise (3.3); the current edit keeps every boundary (1.4). | Mechanical merges produce orphan lines (composed-4) — reject operations that leave a paragraph under 15 words. | paragraph CV of edited chapters, share of sentences unchanged; panel pacing. | −$0.1; 1 day's engineering |
| 9 | **Cross-family editor.** Line edit by gemini-3.7-flash while the writer stays gpt-5.6-luna. | Breaks a single model's self-bias (3.3); a second idiolect over the first. | Cross-vendor similarity is still high (Wenger & Kenett 2025); expect modest gains. | hedge fusion rate; panel voice. | ~$0 |
| 10 | **Think-before-write.** A separate short reasoning call producing a chapter *rhythm* plan (where the long stretch is, where the turn is, what is quoted), fed to compose; or real reasoning effort on compose. | LongWriter-Zero's Elo gain; adherence improves with reasoning. | A rhythm plan is a plan and plans are performed (DOC) — keep it to three sentences. | draft paragraph CV; panel. | +time |
| 11 | Temperature 0.9 on compose. | Control; literature says weak. | Incoherence. | — | $0 |

**Run first: 1, then 3, then 4** (with 2 folded into run 1).

- Run A = experiments 1 + 2. Both are subtractions from what the writer is *shown*, and one
  mechanism explains both: the writer performs what it is shown. They cost nothing, they attack the
  patterns quoted by every panel, and composed-5 has just demonstrated that the polite version (a
  rule not to mention the plan) does not work. If the panel moves, a later ablation separates them.
- Run B = A + experiment 3. It is the first stage that ever *chooses*, it is robust to prompt
  wording, it uses another model family, and it is funded by dropping a stage shown to be invisible
  to the panel. Its judge is also the prototype of the proxy in section 5, so the run validates two
  things.
- Run C = B + experiment 4. Cheapest possible use of the pipeline's one accurate judge, aimed at the
  one pattern all three composed-3 evaluators put first.

Experiment 7 is the highest ceiling and should be built while A–C run; it changes the inputs, and no
prompt work can substitute for having something to quote. Experiment 6 should be run once as an
ablation regardless of A–C's result, because the team has never measured what the rule list buys.

Guard against the composed-4 lesson: before paying for a panel, run the regression guards (section
5.2). A run that fails a guard is fixed, not scored.

## 5. A proxy the panel would agree with

### 5.1 Primary: pairwise, chapter-aligned, position-swapped, two judge families

The scorecard cannot be a target (1.10) and three absolute Opus reads cannot resolve half a point
(1.1). The literature is unambiguous that pairwise beats pointwise, that order must be swapped, that
a small cross-family panel beats one strong judge, and that long documents should be judged in
aligned excerpts rather than whole (3.3).

Protocol, per candidate run against a fixed reference (composed-3 today; the best book to date
thereafter):

1. Align by chapter index (runs against the same source clone plan 15 chapters of 8 pages; where
   counts differ, align by position in the book).
2. Six fixed excerpts per book: the first ~900 words of chapters 1, ⌈n/3⌉, ⌈2n/3⌉ and n, and the
   last ~450 words of chapters ⌈n/2⌉ and n. Equal length by construction, so length bias is
   controlled at the source rather than by the judge.
3. Two judges from families the writer is not (gemini-3.7-flash and a DeepSeek/Qwen model the repo
   already routes to), each excerpt pair in both orders, forced choice, one-line reason. Rubric:
   "Which of these two would a demanding general reader keep reading? Judge paragraph rhythm,
   whether sentences commit, whether the passage moves forward or re-balances what it just said.
   Ignore topic and factual content." Disagreement between orders is a tie.
4. Aggregate with Bradley–Terry across excerpts and judges; report the win rate with a bootstrap
   interval, and the reasons as a pattern list.

Cost: 6 excerpts × 2 orders × 2 judges = 24 calls of ~2.5k tokens ≈ $0.05–0.15 and two minutes.
Validate first on the five existing books (expect composed-2 < per-page < composed-4 < composed-1 ≈
composed-3, and a *tie* for the last pair). The same judge call is the selector in experiment 3, so
the two share one prompt and one validation. Expect ~70% agreement with the panel at best (LitBench);
that is enough to rank runs, not to replace the panel for a release decision.

### 5.2 Regression guards (deterministic, pass/fail, free)

Run on every book before a panel is paid for; a failure is a pipeline bug, and the panel has shown
it punishes these harder than any tic:

- plan-string paste: share of handoffs and landings found in the prose (≥80% content words) — must
  be under 10% after run A;
- duplicated sentences (≥12 words) across the book;
- any edit or rewrite output under 80% of its input (truncation);
- `chapter N` references in prose; sentences from the voice sample or from another chapter;
- paragraphs under 15 words that end on a full stop and are not quotations (orphans);
- quotation count and named-source count per chapter (floor, not target), once experiment 7 exists.

### 5.3 What to keep from the scorecard, and how

Keep the measures as *diagnostics* printed beside the pairwise result — the hedge family (section
1.3's definition, not the adjacent-pair regex), paragraph CV, share and position uniformity, roll-
call count — and never quote them into a prompt again. Read them the way the composed-4 result
teaches: a measure that improves while the judge falls is an artefact being manufactured.

### 5.4 The whole-manuscript pattern read as a qualitative gate

Composed-3's read `bookNotes` reproduced the panel's top three patterns in one $0.02 call. Ask the
read, with no measurements in its payload, for "up to five recurring moves across chapters, two
quoted instances each" — the rubric's own question — from the writer's model and from one other
family. A pattern named by both is a blocker for the next iteration. This is not a score; it is the
cheapest available answer to "what will the panel quote".

---

## Appendix: method and reproduction

- Run logs were copied from the worker container
  (`docker cp ai-book-maker-worker-1:/app/storage/books/<projectId>/runs/<job>-generate-book.jsonl`)
  and split per chapter by the `Write chapter N` / `Revise chapter N` prefix of the system message;
  a second `edit-chapter` request carrying `readerNotes` is the second edit; the last of two
  `compose-chapter` responses is the retry that was kept. Stage texts, prompts and payloads were
  measured directly.
- Measures reuse the regexes of `proseMeasurements.ts` (negation-correction, assert/retract pairs,
  symmetrical closers, generalising closers, list sentences, pivots) reimplemented in Python, plus:
  the *evidence-limit family* (a negation word and an evidence noun or verb in one sentence); the
  *intra-sentence hedge* (show/establish clause followed by `; it cannot`, `but not`, or `without
  -ing`); paste detection (normalised substring, or ≥80% of a string's content words present in the
  chapter); sentence survival (share of edited sentences present verbatim in the draft) and
  word-level `difflib` ratio; paragraph-length CV over blank-line blocks of ≥12 words.
- Chapter endings were read in full for all fifty chapters; the classification in 1.2 is by hand,
  the counts by regex.
- The per-page baseline text is PDF-extracted and lost its paragraph breaks; only its sentence-level
  measures are quoted.
- Literature: three web sweeps (diversity and mode collapse; long-form architectures and judges;
  exemplars and copyright), 2026-09-02. Items marked as preprints or single-author studies in the
  sweeps are cited here only where a second source agrees; the copyright section is a risk
  assessment, not legal advice.
