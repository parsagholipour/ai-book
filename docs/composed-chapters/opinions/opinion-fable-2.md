# Opinion: the composed-chapters programme after fifteen runs

Reviewer notes, 2026-09-02, written against `spec.md` through the composed-15 entry, the three
earlier documents, every panel verdict under `evals/`, the book texts and traces under `runs/`,
the run log of composed-14 in the worker container, and the code as it stands in the working tree.
Nothing was changed; no book was generated.

## Verdicts in one screen

| Question | Verdict |
|---|---|
| 1. Diagnosis right? | **Yes.** The slop is shape, the per-page brief manufactured it, and the chapter is the right unit. The prose confirms it: composed-12's first chapter runs the negate-then-correct engine in nearly every paragraph, and I found it without the rubric's help. |
| 1. "House style is the ceiling for prompt work"? | **Not warranted.** Three things were never separated from the model: the 57-negation compose prompt (the subtraction ablation in the research report was never run), the plan's own `voiceGuide`/`continuityRules`/`promises`, which order the hedge and the comparison caveat in every compose payload, and length, which no luna run ever varied on one plan with one draft. The iterations that "made it worse" changed three to five things at once and were reverted wholesale, so nothing in them was falsified. Two model swaps moved engagement from 5.7 to 7.0 by supplying particulars, which luna was never given honestly. |
| 2. Evaluation sound enough to steer with? | **Sound enough to rank a 1.0 gap, not a 0.3 one, and it has one blind spot that already bit.** Three Opus samples of one prompt are one judge; the rubric names the five patterns it then finds and asks for five, so frequency cannot move; runs 1–8 each re-planned, so the "3 → 7" story mixes plan lottery with pipeline changes; "do not fact-check" rewards invented archives, which is most of what DeepSeek was praised for. |
| 3. DeepSeek: model, length, or noise? | **Part model, part length, part fabrication, and n = 1.** Its three most-quoted particulars — the 1275 Aylsham brawl with named parties, "Émile Dutemple" at the Gare de l'Est, "James Jones and his partners" owning the *Brookes* — appear in no research note in the run log, only in compose responses; the *Brooks* belonged to Joseph Brooks; Dutemple does not exist on the web. The panel scored depth 8 on those. |
| 4. Page budget vs pacing | **Change the page, not the book.** The printed page is A4 at 11pt/1.55 with 20/18/22 mm margins, ~490 words: a dense academic page, 40–60% denser than trade nonfiction. Retypeset to ~340–370 words and 120 paid pages is the 42–45k-word book every reader preferred, at 25–30% lower generation cost, and the short-writing models print full. Add a printed-page floor so 69/120 can never publish as COMPLETE again. |
| 5. Code/docs | Nine concrete items below; the two that matter are the absent provenance guard and the plan's distribution rules riding in the compose payload against the repository's own rule. |

## 1. The diagnosis and the "ceiling"

The diagnosis holds. What does not hold is the inference from "everything I tried at the prompt
level failed" to "the model's house style is the floor". Look at what was actually tried and what
was not.

**Never tried, and predicted by the codebase's own rule.** The compose payload of composed-14
chapter 1 (read from the worker's run log) carries `book.styleNotes` = the plan's `voiceGuide`:
"Anchor each major claim in identifiable evidence, while distinguishing documented evidence from
interpretation", "Compare regions carefully without treating Europe, states, or warfare as the
default measure", "Explain competing interpretations fairly, then state what the available evidence
supports most securely", "acknowledge uncertainty when the record is incomplete", and — a shape
rule — "Vary chapter openings, paragraph lengths, transitions, and endings". Beside it,
`continuityRules` ("Distinguish claims about institutions and recorded events from claims about
ordinary human motives", "Do not contradict ... the stated limits of evidence") and five `promises`,
delivered twice (as `book.promises` and again as `storyState` lines), one of which orders the
balanced ending ("will avoid both the claim that humans are naturally ... violent and the claim
that history follows inevitable moral progress"). That is the establish-then-withhold couplet, the
comparison caveat and the paired-antithesis verdict, assigned by the plan to every chapter.
`packages/core/src/generation/CLAUDE.md` already states the rule: distribution rules reach
manuscript review only. `bookPayload` in `composedChapter.ts` ignores it. The review of run A listed
this as item 6; the spec does not record it as done, and the log shows it is not.

**Never tried: the prompt-subtraction ablation** (research report, experiment 6). The composed-14
compose system prompt is 1,704 words with 57 negations — a higher negation density than composed-5's,
which the report called the worst. The banned couplet is spelled out verbatim in both the compose
and the edit prompts ("It can show X. It cannot show Y."), and `STOCK_PIVOT_BAN` lists fifteen
phrases. Whether luna writes the couplet because it is luna or because it has been told the couplet
fifty times per chapter is exactly the question a $0.35 run answers, and it has not been run. Until
it is, "house style" is a hypothesis with no control.

**Never tried on luna: length with one draft.** Composed-7 (52.9k words, best-of-2, 480/page)
scored 7.73; the three 60k replicates at 540/520 scored 7.31 ± 0.13. Gemini at 48.9k scored 7.57,
DeepSeek at 40k 7.67. Every book under 55k words scored 7.57–7.73; every 60k book 7.17–7.43. That
is four points on one side of a line and three on the other, with model confounded — but luna is
on both sides. The spec guesses "most plausibly the 6k fewer words"; a guess this cheap to test
should not remain a guess.

**Never isolated: anything in iterations 8–9.** Composed-9 changed position rotation, the stripped
editor, shape notes off, the deletion-only cut, the tail rule and the 540 budget in one run, scored
6.73, and iteration 10 reverted four of them together. The deletion-only cut has therefore never
been measured alone on a good plan; neither has the stripped editor. Both remain live hypotheses,
and the cut is the one intervention in the whole programme that structurally cannot add a tic.

**The lesson recorded is right but under-applied.** "Content assignments do not become tics; shape
prescriptions do" is the best sentence in the spec. Then look at what content is assigned: every
chapter is 8 pages (the planner is held to 6–9), every section is 25% of its chapter (60 of 60 in
composed-3/4, per the report), and every chapter carries the same thesis to a landing. The
silhouette the readers call "identical chapter architecture" is assigned by the page arithmetic
before any prompt is read. Uneven chapter lengths (4 to 14 pages), section shares with a ≥2× spread,
and one chapter per book that develops a single case at length are content assignments in the
spec's own sense, and none has been tried.

**What the model swaps actually showed.** DeepSeek and Gemini both moved engagement from 5.67 to
7.0 and both were praised for the same thing: particulars doing the arguing (a court roll, a
tariff table, a Genizah letter). Luna's engagement never moved because luna was never given
anything to quote: chapter 1's `researchNotes` in the composed-14 log are seven copies of one
textbook sentence ("Human aggression refers to any behavior intended to cause harm or pain")
from lumenlearning, pearson, wikipedia, nih and medium. The run-B research fix produced dictionary
snippets instead of lead-magnet snippets. A writer forbidden to name a source outside those notes
can either hedge about what a source "cannot show" (luna) or invent the source (DeepSeek). The
ceiling that the A/B found is an input ceiling, and it has been sitting in section 1.9 of the
research report since this morning.

So: is there an untried class? Yes — three of them. (a) Subtraction: take the plan's distribution
rules and the negation list out of the writer's prompt. (b) Content assignment at the plan level:
uneven chapter and section lengths, one single-case chapter, and a *progression* (each chapter's
landing is a question the previous chapter could not answer) so the book develops instead of
re-demonstrating — the one complaint all nine luna panels share is "the argument is complete by
chapter four". (c) Inputs: retrieval of quotable public-domain primary text and two or three named
historians' positions per chapter, which is what the model swaps proved the readers pay for.
Within balanced and fast, in that order of cost.

## 2. The evaluation method

What it can do: it ranked composed-2 (5.4) below everything and the per-page book (6.0) below every
composed book with no ambiguity, and the three same-configuration replicates landed within 0.26
of each other. A 1.0 effect is visible on one run; a 0.4 effect on three.

What it cannot do, and why:

1. **Three samples of one judge are not three readers.** The evaluators are Opus three times under
   one prompt (spec, "three Opus evaluators"). The ±0.4 band is Opus's sampling variance plus the
   writer's, and the five patterns every panel returns are Opus's taste. That taste looks right to
   me — but I am the same family, so my agreement is weak evidence. Before a release decision, add
   one non-Anthropic reader (Gemini 3.7 or DeepSeek) to the panel and report whether it names the
   same five.
2. **The rubric names the patterns it finds and asks for five.** Criterion 10 lists "symmetrical
   hedges, recap loops, ... aphoristic closers, paired antitheses" and the output contract asks for
   "up to five" recurring patterns with two instances each. A reader primed with the list and asked
   for five returns five. That is why "every book gets the same five complaints" — it is partly the
   form. The consequence is that the panel cannot show a *reduction*: a book with half the couplets
   still yields five patterns. Add a frequency task: "In chapter 8, count the sentence pairs of the
   form 'It shows X. It does not show Y.'" for two fixed chapters per book, plus "at which chapter
   did the book stop developing its argument?" Those are numbers that can move.
3. **Absolute 1–10 is compressive.** Thesis, clarity, reasoning and structure sit at 8–9 for every
   composed book and never discriminate; the whole signal is engagement, pacing and slop
   resistance. Score those three pairwise (chapter-aligned excerpts, both orders, forced choice,
   two judge families, Bradley–Terry) — the research report's 5.1 protocol, which has been written
   up twice and run zero times. The judge-validation script exists and shows that a DeepSeek-flash
   judge on excerpts ties on 13/15 close pairs; Opus and Gemini as pairwise judges on the same
   excerpts is the version worth validating.
4. **Runs 1–8 each re-planned.** Composed-3 → 6 → 7 is three different plans, three different
   stances, three different form plans. Only 9–14 hold the plan. Every conclusion drawn from the
   first eight runs about a *pipeline* change carries plan variance the harness only learned to
   remove at iteration 9. The composed-8 thesis ("a rule about evidence") was the plan lottery
   losing, not iteration 8 failing.
5. **One factor per arm.** See iteration 9 above.
6. **Length was never controlled.** Every reader who scored pacing 5 was reading 60k words. Either
   fix the word budget across arms or add length as a covariate; do not compare a 40k book with a
   60k one and call the difference "the model".
7. **"Do not fact-check externally" rewards invention.** See section 3. Add a deterministic
   provenance probe (proper nouns and dates in the prose that appear in neither the research notes
   nor the plan) and a ten-claim web spot-check per book, reported beside the panel score.

Power, from the numbers you already have: the three luna replicates have SD 0.13, so the SE of a
three-run mean is ~0.075 and of a difference of two such means ~0.11. Three runs per arm on one plan
sees a 0.2 effect at ~1.9 SE; four per arm at ~2.2 SE. On balanced that is $1.1–1.5 and 60–90
minutes of worker time per arm (one worker, serial), plus the panel's tokens. That is affordable;
what is not affordable is another day of single runs on fresh plans with bundled changes.

## 3. The DeepSeek result

Decompose 7.67 against 7.31 ± 0.13:

- **Noise.** n = 1. A single run's own spread is at least the replicate SD (0.13) and the
  single-reader swing is 0.7; 7.67 is ~2.5 SD above luna's replicate mean, so a real effect is
  likely but not established. Two more DeepSeek runs on the same plan settle it.
- **Length.** 40k words. The three best-scored books are the three shortest (40k, 49k, 53k). The
  A/B is confounded with length *by construction*: `composeChapter` accepts any draft at or above
  `budget.min * 0.7` (2,408 words against a 4,160 target) after at most two attempts, and the
  editor's "develop the existing sections" line is advisory — composed-14 chapter 1 went 1,937 →
  2,476 → edited 2,435. The pipeline let DeepSeek stop at the length readers like and then
  paginated 333-word "pages" into 120 rows so the run read as 120/120.
- **Fabrication.** The three panels praise, in every summary, the Aylsham court roll, Dutemple at
  the Gare de l'Est, the *Brookes* diagram, the Libro delle Galleazze, the Burgundian petition over
  hay and chickens. In the composed-14 run log, "Aylsham", "le Blake", "Matilda atte Cross",
  "Dutemple", "James Jones" and "Libro delle Galleazze" occur in compose-chapter *responses* and
  downstream (edit requests, describe-pages, read-manuscript) and in no research request or
  response. On the web: the *Brooks* was owned by Joseph Brooks (Hull Museums, RMG); James Jones
  owned the *Lovely Lass*; "Émile Dutemple" returns nothing; the 1783 log "kept by the captain"
  recording Anomabu purchases is unverifiable and almost certainly composed. "The fine was recorded
  in the same hand as the brawl, on the same membrane" — the sentence all three readers quoted as
  the book's best — is an invented manuscript. Luna's factual wobbles (Magdeburg "1648", "the abbé
  de Launay") are errors about real things; DeepSeek's are confident particulars about things that
  do not exist, and they are exactly what "reads as a serious writer". Part of the +0.35 is a
  hallucination premium, and the rubric is blind to it by design.
- **Model.** What survives the above: sentence mean 26.6 words against luna's 16.8, paragraphs of
  ~190 words against ~100, generalising closers 0.08 against 0.35–0.40, top-5 shape coverage 0.61
  against 0.85. DeepSeek varies at the paragraph and sentence level where luna is uniform, and the
  readers felt it (voice 8.0 vs 7.67, craft 8.0 vs 7.67). It also announced its own outline and
  recycled the thesis verbatim at three chapter ends, and the panel's slop-resistance score was
  *lower* (5.67 vs 6.33). So: a better sentence-writer, a worse self-editor, and it was run under
  measurement notes tuned against luna's shape ("let at least four turns stand alone as one- or
  two-sentence paragraphs", "paragraphs all about 206 words; reshape") — the swap ran each
  alternative writer under the other writer's corrective.

**One more run — actually two orthogonal runs plus a probe, all on composed-7's plan:**

1. DeepSeek at full length: raise the retry acceptance to `budget.min`, allow three attempts, and
   make the editor's extension mandatory (re-run the edit with the shortfall until ≥ min or two
   tries). Target 120 printed pages. (~$1.6, ~45 min.)
2. Luna at DeepSeek's length: `chapterWordBudget` at 340/page (≈41k words), one draft. (~$0.25,
   ~15 min.)
3. The provenance probe on all four books (DeepSeek@40k, DeepSeek@60k, luna@41k, luna@60k): share
   of proper nouns and four-digit years not present in any research note or plan field, plus ten
   spot-checked claims per book.

Read it as a 2×2. DeepSeek@60k ≥ 7.6 with luna@41k ≈ 7.3 → model. Luna@41k ≥ 7.6 → length. Both
up → both. And whichever wins, if its engagement gain disappears when the probe's invented
particulars are counted, it is a retrieval gap you can close honestly, not a model gap you have to
pay 3× for. On cost: $1.09–1.10 per book on the default tier against $0.36 needs the break-even
check from the tier-pricing memory before it is a candidate at all; Gemini's 13-minute wall time is
the more interesting number for the product.

## 4. The page budget

The tension is manufactured by the typesetting. `pdfCss.ts`: A4, `margin: 20mm 18mm 22mm`, 11pt,
`line-height: 1.55` → 174 × 255 mm of text, ~42 lines, ~11–12 words a line, ≈ 490 words. A trade
nonfiction page (5.5×8.5 or 6×9 in, 11–12pt, ~1.4) holds 300–350. The product is selling the reader
"pages" that are 40–60% denser than any book they have held, and then generating enough words to
fill them, and the readers score the result pacing 5.

Resolve it at the page:

- Retypeset to ~340–370 words a page (12pt/1.6 on A4 with wider margins, or a 6×9 in trim). 120
  paid pages becomes 41–44k words — the length of the three best-scored books — generation cost
  drops 25–30%, and DeepSeek/Gemini books print 100–120 pages instead of 69–102. This is the one
  change that improves every book on every tier without touching a prompt. Cost: a day, including
  the `verify-pdf-typography` fixture run, and a stylesheet version per compile so an old book's
  chat-edit recompile does not renumber the reader's highlights and printed Contents (the page map
  is measured at publish; the reader renders the PDF).
- Whatever the density, add a **printed-page floor**: a compile that prints under ~95% of the paid
  pages is not COMPLETE — the pass extends (editor with shortfall, then one more compose of the
  shortest chapters) before publication. Today a 69-page book publishes with "review recommended".
- Do not solve it with more words per chapter or more chapters. The readers' complaint is total
  words and re-demonstration; the plan already gives them fifteen chapters of one thesis.
- If typography cannot move for product reasons, sell length ("about 120 pages") and derive the
  page count from words; the current arrangement charges by a unit the reader never sees.

## 5. Code and docs: what looks wrong, risky or stale

Ranked by consequence.

1. **No provenance guard on composed prose.** `packages/core/src/generation/composedChapter.ts`
   carries `GROUNDED_FACTUALITY_RULE` and `citationContractFields` as prompt text only; the
   per-page evidence ledger and integrity gates do not run in this mode, and `finalizePendingPages`
   runs local checks only. Composed-14 shipped invented archives to a COMPLETE book. Before any
   further writer swap: a deterministic pass that lists proper nouns, titles of documents and years
   in the chapter that occur in neither `researchNotes` nor the plan, written to the chapter
   report, with a threshold that flags the book for review. Cheap, model-free, and it would have
   caught Aylsham on the day.
2. **Distribution rules in the writer's payload.** `bookPayload()` sends `voiceGuide`
   (`styleNotes`), `continuityRules` and `promises`; the pass adds `storyState` with the promises
   again. `packages/core/src/generation/CLAUDE.md` ("Style contract routing") says these reach
   manuscript review only. Route them to `readManuscript` and give the writer the local lines.
3. **Research notes are still worthless.** Chapter 1 of composed-14 received seven copies of one
   definitional sentence. `expandChapterResearch` now queries on title + chapter, which for
   "What Do We Mean by Human Aggression?" returns dictionary entries. The writer is then forbidden
   any other source. Either retrieve primary text (report #7) or drop the prohibition; the current
   combination forces hedge-or-invent.
4. **Length acceptance.** `composeChapter`: `if (words >= budget.min * 0.7) break;` after at most
   two attempts; the editor's extend branch is a request. No book-level floor. This is the
   mechanism behind 69/120 and it is silent.
5. **`readManuscript` is a paid diagnostic.** `manuscriptReadPass` defaults on for every tier, the
   read takes up to 110k words of input on every production book of 12+ pages, and with
   `READ_SECOND_EDITS = false` in `apps/worker/src/generation/composedChaptersPass.ts` its notes go
   to the console and nowhere else. Either the cut consumes it or the gate defaults off.
6. **The pipeline plants the tic it then flags.** Editor prompt: "let a turn or a landing stand
   alone as a one- or two-sentence paragraph"; `paragraphShapeNotes`: "let at least four turns ...
   stand alone as one- or two-sentence paragraphs"; `readManuscript`: flag "a one-sentence paragraph
   placed for effect"; three panels: "planted one-sentence paragraph, roughly once per chapter".
   Pick one. The shape notes were also fired unchanged at DeepSeek's 190-word paragraphs, so the
   A/B ran each writer under luna's correction.
7. **Experiment flags are source constants.** `ROTATE_STANCE_POSITIONS`, `READ_SECOND_EDITS`,
   `COMPOSE_CANDIDATES`, `SHAPE_NOTES_TO_EDITOR`, `SECOND_CANDIDATE_TEMPERATURE_STEP`. Each flip is a
   core edit that restarts the Docker worker mid-book (your memory note), none is visible on the
   Quality tab, and none can differ by tier. They belong in the quality revision beside
   `chapterEditorPass`, which is also what would have let the "ultra by accident" and
   "fast that ran on balanced" mistakes not happen.
8. **Dead and inert code.** `LANDING_FORMS`/`landingFormFor` (the core CLAUDE.md says it rotates
   the final paragraph's kind; nothing calls it); `detemplateChapter`/`DETEMPLATE_CHAPTER_PURPOSE`;
   `earlierOpenings`/`earlierClosings` computed in the pass, passed in `ComposeChapterOptions`,
   used by nothing; `judgeChapterDrafts` takes `input` and ignores it; the second candidate's
   `temperature` is dropped by `openai.ts:211` under any effort but `none`; `MIN_VOICE_SAMPLE_WORDS`
   in `authorStance.ts` regenerates a whole stance when a plan's sample is short, for a field only
   `sampleSentenceLeaks` reads — a leak check on text the writer never sees. The judge purpose is
   in neither `pipelineStages.ts` nor `qualityGateCosts.ts` (known).
9. **Routing and blast radius.** `router.ts` sends every non-KIDS book of 12+ pages through the
   composed strategy: instructional, reference and fiction palettes that no panel has read. The
   narrative `shapeRules` line ("every scene and every paragraph inside it ends on action, speech,
   or an image") is precisely the kind of rule the log says becomes a tic. Chat page edits on a
   composed book run the per-page rewrite against a derived brief whose `endingPressure` says the
   page "ends where the typesetter cut"; a per-page rewrite will land that page. And the spec's own
   last line: `reviewWholeBookDraftPages` rewrites one page per book in isolation at finalize, on
   pages the editor deliberately left mid-argument.

Docs: core CLAUDE.md "Composed chapters" says the writer imitates the voice sample (it sees
`RHYTHM_EXEMPLAR`), the read flags ⌈chapters/3⌉ (≤6) (`manuscriptReadEditCap` is `min(12, n)`),
`LANDING_FORMS` rotates (dead), the budget is 540 (520), and "the prohibition list does not" ride
along (57 negations do). Worker CLAUDE.md "two model calls in flight at most" is true only while
`COMPOSE_CANDIDATES` is 1. `spec.md` step 6 repeats the ⌈n/3⌉ figure. `chapterWordBudget`'s
comment says a page holds ~470 words and then ~490. The harness's `--reuse-plan` copies the plan
but research is re-expanded per run, so "same plan" runs differ in `researchNotes`; note it in
the table.

## 6. Next experiments, ranked

All on composed-7's plan unless stated; "×3" means three replicates, which is the minimum that can
see 0.2. Effect sizes are my estimates on the panel's overall scale.

| # | Experiment | Expected effect | Cost | Why this rank |
|---|---|---|---|---|
| 1 | **Provenance probe + guard** (deterministic; run it on all fifteen existing books first) | 0 on score; blocks shipping invented archives; re-reads the DeepSeek/Gemini wins honestly | 0.5 day, $0 | Prerequisite for every model decision. |
| 2 | **Luna at 480/page, one draft, ×3** | +0.2–0.4 if length is the composed-7 effect; 0 if not | $1.1, ~1 h | Cheapest unresolved confound; decides #7's budget. |
| 3 | **Distribution rules out of compose/edit payload** (voiceGuide, continuityRules, promises, storyState → read only), ×3 | +0.1–0.3 on slop/pacing; couplet and caveat counts should fall | $1.1, ~1 h | The repository's own rule predicts it; zero new-tic risk. |
| 4 | **Prompt-subtraction ablation** (stance + forms + material + budget + ≤5 positive rules; no measurement notes to the editor), ×2 | unknown, ±0.5; it is the measurement of the "house style" claim | $0.7, ~40 min | Never run; without it the ceiling conclusion has no control. |
| 5 | **Retypeset to ~350 words/page + printed-page floor** | the #2 effect for every book on every tier, −25–30% cost, DeepSeek/Gemini print full | 1 day incl. fixtures | Product fix, model-independent. |
| 6 | **Q3's 2×2**: DeepSeek at full length (retry to `min`, extension enforced) and luna at 340/page, with #1's probe on all four | separates model / length / fabrication | $2, ~1.5 h | Only after #1; otherwise you are re-scoring invention. |
| 7 | **Uneven chapter lengths (4–14 pages), section shares ≥2× spread, one single-case chapter per book** — planner content assignments, ×3 | +0.2–0.4 structure/pacing | $1.1 + 0.5 day planner work | Content assignment, the class the spec's lesson endorses; report #5, never tried. |
| 8 | **Progression in the plan**: each chapter's landing is a question the previous chapter could not answer; the read checks it, the writer never sees it, ×3 | +0.2–0.5 engagement ("complete by chapter four" is every panel's complaint) | $1.1 + 0.5 day | Attacks the lowest criterion directly; risk that the planner writes it as a handoff string. |
| 9 | **Quotable evidence retrieval**: public-domain primary text + 2–3 named historians per chapter into `researchNotes`; writer may quote and argue | +0.3–0.6 depth/engagement (DeepSeek bought +0.35 with the fabricated version) | 1–2 days + $0.15/book | Highest ceiling; the only change to inputs. Requires #1. |
| 10 | **Cross-family pipeline**: Gemini draft (13 min, varied paragraphs) + luna deletion-only cut instead of the paraphrase edit | +0.1–0.3; −$0.10 (edit is ~45% of cost) | $0.9/run | The paraphrase edit homogenises; the cut cannot add a tic. |
| 11 | **Deterministic couplet thinning**: delete the negated twin of every "It shows X. It does not show Y." pair past the third per chapter (`COUPLET_*` regexes exist); replay on the fifteen books for precision first | +0.1; couplet count halves | 0.5 day | Model-free; hold it to the 99% rule before it ships. |
| 12 | **Panel upgrade**: one non-Anthropic reader; frequency counts on two fixed chapters; "where did it stop developing"; pairwise excerpt protocol validated on the existing books | makes 0.2 visible | $0.5–1 per comparison set | Do this before spending on #7–#9. |
| 13 | Effort `none` + temperature 0.9 on compose, ×1 | probably 0; closes the question | $0.35 | The knob was never connected. |

Order for the next working day: 1, 2, 3 and 4 (all four fit in an afternoon on one worker), then 5
as engineering while 6 runs, then 12, then 7–9 with the upgraded panel. Do not run anything on a
fresh plan until the panel can see 0.2, and do not run anything that changes more than one thing.
