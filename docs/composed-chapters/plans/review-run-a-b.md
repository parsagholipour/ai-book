# Review: run A (composed-6, live) and the staged run B patch

Reviewer notes, 2026-09-02. Evidence is from the live run log of project `cmtjk5ias000055g01gj0rll8`
(job `cmtjk833k000255g0s6i7aj5e`, 16 chapters; at review time all 16 composed and first-edited, the
read done, second edits in progress), composed-5's log (`cmtjizvsj0000z0g09vlyrypn`), the current
tree, and a write-free dry run of `patches/run-b-staged.py`. Nothing in the repository was changed.

## Verdicts in one screen

| Q | Verdict |
|---|---|
| 1. Run A faithful to experiments 1+2? | **Partly, and the run is confounded.** The landing, handoffs, `avoid` and the closings list are gone from the writer (verified). But (a) the stance the writer received is *inverted*: a coercion bug turned the planner's five `{belief, rejects}` pairs into the five rejected views, labelled "What you hold to be true"; (b) the planner was never told to write plain assertions, only the pass-side fallback was; (c) the previous chapter's `throughLine` reaches every compose prompt verbatim through the provisional digest; (d) the plan's `keyBeats` ("End with…" in 12/16 chapters, "Open with…" in 16/16) and the `openingHook` still reach the writer; (e) the conclusion rule survives in the editor and in a measurement note. The exemplar is adequate but two of its four paragraphs close on record-silence. |
| 2. What the writer still sees | 51–52 negations per compose system prompt (composed-5: 67), 37–47 per edit prompt (50). No landing/handoff/avoid string reaches any prompt. `throughLine` of chapter N−1 reaches compose N in 15/15 cases. Own-landing paste into the prose fell to 1/16 on a strict test; the roll-call close did not. |
| 3. Run B patch correct? | **Compiles and would run, but the experiment it claims to run does not happen on balanced**: the OpenAI adapter drops `temperature` unless `thinkingEffort === "none"`, and the balanced writer runs at `low`, so both candidates sample at the provider default and the +0.25 is a no-op. Judge family is right (DeepSeek vs OpenAI). Both-orders/tie logic is right. `READ_SECOND_EDITS = false` silently loses the read's notes (never persisted). The judge reads whole 4k-word chapters against the report's own advice, and has not been validated on the five scored books. |
| 4. Other contradictions | The stance alias bug and the research query bug (every chapter's research query is the *planning instruction*, so the notes are about "lead magnets") come first; then keyBeats/openingHook/last-chapter rule, the digest leak, the editor's conclusion rules, and the fact that no composed run has ever actually sampled at 0.65. |

---

## 1. Does run A implement experiments 1 and 2?

### 1.1 What is correctly done

- `compositionWriterLines` shows forms, subjects, owned material and notes only; the compose payload's
  `composition` is `{form, subject, owns, note}`. Searched all 16 compose and 27 edit prompts for every
  landing, handoff, `avoid` line and through-line of the (repaired) form plan, verbatim and by 6-word
  shingle: **no landing, handoff or `avoid` string reaches any prompt.**
- `earlierClosings`/`earlierOpenings` are no longer rendered (`edgesLines` is gone; the pass still computes
  them and passes them as dead options).
- Refusals are off the writer's prompt. The voice sample is off the writer's prompt (0 of its 11
  sentences found in any prompt). No exemplar noun ("Little Wenlock", "Coalbrookdale", "Pryce",
  "sexton", "shilling") reached any draft or edit.
- "The chapter ends where its last section ends. A catalogue is written in sentences…" replaced the
  compose conclusion rule and the handoff-as-fact rule. The read receives `expectedClaim`.

### 1.2 Deviations, with evidence and whether they matter

**D1. The positions the writer holds are the rejected views. Matters: confounds the whole run.**

The planner (unchanged `PLANNER_AUTHOR_STANCE_GUIDANCE`: "…what the author believes … and the rival view
they reject") answered with objects:

```json
{ "belief": "Historical violence should be analyzed in distinct forms and contexts.",
  "rejects": "The rival view that all aggression can be measured or explained as one timeless behavior." }
```

`stanceLine` in `packages/core/src/schemas/plan.ts` looks for
`["believes", "position", "claim", "stand", "text", "statement", "habit", "refusal"]` — not `belief` — finds
`rejects`, and returns `believes ?? rejects`. So the plan's stance has `positions` = the five rejected views,
`planAuthorStance` accepts it (≥2 positions, sample ≥80 words), and **every compose and edit prompt of the
run** says:

> What you hold to be true, and write from: The rival view that all aggression can be measured or explained
> as one timeless behavior. | The rival view that state formation is simply a civilizing reduction of
> violence. | …

The writer resolved the contradiction with the thesis by rebutting the "positions" in negations — which is
the shape the report is fighting:

> "Neither account supplies a timeless measure called aggressiveness." · "Nor does a timeless theory of
> aggression explain why…" · "Northern Ireland's containment was therefore neither a simple civilizing
> reduction of violence nor proof that negotiation always prevails." · "History does not demonstrate
> inevitable improvement. Nor does history demonstrate inevitable brutality." · (final chapter, last
> paragraph) "It cannot calculate one timeless aggression rate, read an unchanging human essence from
> violence, or predict that any society will improve forever."

The read's own `bookNotes` name it: "The book's recurring rebuttals to timeless human nature, simple state
pacification, and religious essentialism are persuasive but often restated in chapter endings." Adjacent
assert/negate couplets in the drafts are **34** (composed-5 drafts: 23). This is the CLAUDE.md alias rule
("an alias is how the model spelled a plan field") failing in the one place run A depended on. The read is
also told `Positions: <the rival views>`.

**D2. "Positions restated as plain assertions" was applied to the wrong prompt. Matters.** Only
`stanceShapeLines` (used by `generateAuthorStance`, the pass-side fallback) was changed. The book's stance
came from the planner, whose guidance still asks for believes/rejects pairs, and even the fallback's
`outputContract` still says `positions: ["Three to five stands, each with the rival view rejected."]`,
contradicting its own system line. No `author-stance` call ran in this book, so experiment 2's stance half
was not exercised at all.

**D3. The through-line still reaches the writer, once per chapter. Matters moderately.**
`provisionalDigests.set(idx, chapterDigest([composition.throughLine, ...subjects]))` is what compose N sees
as `earlierChapters[N−1].digest`, because N−1's real digest is not ready while N is composing (by design).
Verified verbatim in 15 of 15 compose prompts for chapters 2–16, e.g. compose 2 carries
"This chapter establishes the distinctions and evidentiary discipline needed to compare aggression across
time." The report measured through-line paste at 4–7/15 when it was shown directly; here it is labelled as
"what the reader already knows", which is a weaker claim on the writer, but it is a thesis-shaped plan
sentence in the prompt all the same.

**D4. The plan's landing is hidden by one door and delivered by another. Matters.** The compose user
payload still carries `chapter.keyBeats`, and in this plan 12 of 16 chapters have an "End with / End by /
Conclude with / Close with" beat and 16 of 16 an "Open with…" beat, e.g.

> ch14: "End with a bounded synthesis: historical aggression is shaped by interacting conditions rather
> than one permanent human impulse." · ch16: "Close with a precise, bounded statement about what historical
> study can reveal about aggression and what it cannot predict." · ch11: "End by asking how administrative
> categories made whole populations objects of strategy." · ch16: "Open with a brief return to an image or
> record from Chapter 1…"

`fallbackChapterComposition` even derives the landing from `keyBeats.at(-1)`, so these *are* landings.
Chapter 10's and 16's last paragraphs match their "End with" beat by 3-word shingle. The report's section
1.12 named `landing/handoff/throughLine`; it did not look at `keyBeats`, and the engineer took the list
literally.

Also still in the writer's prompt: the `openingHook` verbatim as a command ("Its first lines open exactly
as the plan committed: In a dim archive, a clay tablet … inviting a question the book will carry across
centuries: what conditions turn human conflict into organized aggression?") — chapter 1 opens with it
word for word, question included; and the final-chapter rule in `positionLines` ("draw the book's argument
to its conclusion and state the author's own answer plainly, as a reasoned paragraph … The promises still
owed to the reader: …"), which is a conclusion rule plus the plan's promise 6 ("It will end without claiming
either that humans are naturally peaceful or that violence is inevitable") — a balanced ending, ordered.

**D5. The conclusion rule survives in the editor. Matters.** The edit prompt still says "Only the
chapter's final paragraph lands an idea; every other paragraph ends where its matter ends", and the
measurement note "The chapter ends on a one-sentence verdict (…); write the chapter's conclusion as a
reasoned paragraph in the author's voice instead" fired in the edits of chapters 3 and 7. That is the
"conclusion in a full paragraph" rule the report traced to the five-paragraph-essay close (1.2), reinstated
after compose removed it.

**D6. The exemplar.** Written for the purpose; not a quotation. What it carries: paragraphs of ~170 / 17
/ 75 / 7 words, sentences from 8 to ~65 words, a subordinate-clause opener, plain assertions, particulars
throughout, no balanced antithesis. That is what the report asked for, and the engineer's reason for not
using Strachey/Macaulay (period antithesis) is fair for Macaulay. Two problems: (i) two of its four
paragraphs close on the record's silence — "The diary says nothing else about that week." and the final
line "Nobody recorded the boy's side of it." — which is the evidence-limit/negation-with-evidence-word
family of section 1.3, modelled twice, once as the passage's landing; for a source-conscious history that
is the wrong thing to demonstrate. (ii) It did not move the drafts' shape: draft paragraph mean 89 words,
CV 0.185 (composed-5: 97 / 0.161); 15 of 16 drafts have no paragraph over 150 words and 12 of 16 none under
30. The "long stretch / two-sentence paragraph" was not imitated. So it is neither a new tic (yet) nor a
measurable gain — consistent with the report's 3.2 (exemplars set register, not variance). No subject leak.
Public-domain vs original is not a material deviation.

**D7. Keeping `measurementNotes` to the editor/read and the negation-heavy `shapeRules`. Matters for
attribution.** Recommendation (A) in the report reads "cut the rule list to a handful" alongside hiding
the plan; 1.12 lists the notes (item 4) and the negations (item 7) as actively harmful, and 1.3 shows the
notes are the mechanism of the hedge fusion. Run A reproduces that mechanism: "while" per 1,000 words goes
3.18 → 4.32 across the first edit (composed-5: 3.09 → 4.60); couplets 34 → 22 by lexical compliance. The
compose prompt is 1,471–1,567 words with 51–52 negations (composed-5: 1,933 / 67): a fifth shorter, the
same corpus. Keeping them is a defensible way to isolate experiments 1+2, but it means a flat panel result
cannot separate "hiding the plan does nothing" from "the editor re-manufactures the shape", which is the
question run A is supposed to answer. See fixes.

---

## 2. What the writer was actually shown

From the live `text.generateText.request` events, `compose-chapter` and `edit-chapter`:

| | run A compose | run A edit | composed-5 compose | composed-5 edit |
|---|---|---|---|---|
| system prompt words | 1,471–1,567 | 1,693–1,930 | 1,933 | 2,156 |
| negations (`not/never/no/none/nothing/nobody/neither/nor/cannot/without/don't/doesn't/isn't`) | 51–52 | 37–47 | 67 | 50 |
| "do not" / "never" | 27–28 | 9–12 | 31 | 14 |
| user payload | 11–32k chars | 35–53k chars | | |

Still in the compose prompt that section 1.12 called harmful, or is of the same kind:

- `throughLine` of the previous chapter, verbatim, via `earlierChapters[N−1].digest` (15/15).
- `chapter.keyBeats` with an ending instruction (12/16) and an opening instruction (16/16); the
  `openingHook` verbatim as an order; the final-chapter conclusion rule with the promises list.
- `previousChapterTail`: ~1,250 words of the previous *draft*, ending on its closing paragraph — by design,
  but it is one exemplar of the close per chapter (the report's closings list was thirteen).
- `earlierChapters` digests written as page summaries ("The page introduces the problem of…", "The page
  compares two early Holocene sites…") — item 8 of 1.12, and they say "page" to a writer told pages are
  not units of argument.
- `book.styleNotes` (the plan's `voiceGuide`): "Separate what sources directly show from what historians
  infer…", "Treat broad comparisons as provisional. Explain differences in evidence… before drawing
  conclusions", "Maintain a balanced, natural tone with moderate confidence" — the hedge, prescribed by
  the plan itself; and `book.continuityRules` carrying five "Avoid repeating this beat: …" distribution
  rules (CLAUDE.md: distribution rules reach manuscript review only) — one of which says vary the openings
  while every `keyBeats[0]` says "Open with a specific…".
- `storyState`: six promise lines, including the balanced-ending promise, in every chapter.
- The full `shapeRules` list (negation-correction ban, pivot ban, 3-item cap, opener rules…), the stock
  pivot ban again in the editor, and the measured notes (8–10 per chapter, each quoting 4–6 sentences of
  the banned shapes back to the editor).

Not there any more: landing, handoffs, `avoid`, closings list, voice sample, refusals.

What it produced (strict test — any 4 consecutive content words of the plan string in the prose):

| | own landing in prose | own handoffs in prose | ≥4 owned cases named in the last paragraph | last paragraph words |
|---|---|---|---|---|
| run A drafts (16) | 1/16 (ch16) | 0/48 | 6/16 | 61–135 |

The paste guard of section 5.2 passes. (The report's looser ≥80%-content-word test says 8/16 landings,
but at that threshold it is matching the chapter's topic words — the landing was never in the prompt.)
The synthesis close persists without the landing: last paragraphs open on "therefore" in four chapters
("The aftermath of conquest was therefore part of conquest itself", "The history of aggression is
therefore altered when…", "Mass mobilization was therefore both an invitation and a command", "Northern
Ireland's containment was therefore neither…"); chapter 7 closes on a six-person roll-call, chapter 8 on
an eight-person one; chapter 16 on "The answer offered by these cases is bounded and plain." Draft
measures against composed-5 drafts: evidence-limit sentences 3.4% vs 4.3%, "therefore" 0.89 vs 1.07 per
1,000 words, short sentences (≤6 words) 7.0% vs 5.8%, sentence-length CV 0.485 vs 0.455, couplets 34 vs 23.
Small moves in both directions; the couplet rise is D1.

---

## 3. The run B patch

Dry-run (writes intercepted): every `assert old in s` anchor matches the current tree, so the script
applies cleanly. `pnpm -F @book-maker/core typecheck` and `-F @book-maker/worker typecheck` pass on the
run-A tree; the patch's additions type-check by inspection (`temperature?: number | undefined` on
`ComposeChapterOptions`, `bestOf?` on the report, `judgeTextModel?` on the pass options, `TextModelAdapter`
type import). Nothing found that throws at runtime.

**3.1 Judge family.** The latest `GenerationQualityRevision.settings.models`: `fastJudgments` =
`deepseek / deepseek-v4-flash` (thinking off), fallback `deepinfra / DeepSeek-V4-Flash`; balanced writer =
`openai / gpt-5.6-luna` (effort `low`), judgment `gpt-5.6-luna` (`none`). `LiveGenerationTextModelAdapter.bindForCall`
with `fastJudgments: true` takes `routing.fastJudgments` regardless of tier and purpose, so the judge is
DeepSeek and the writer is OpenAI: another family, as required. `DEEPSEEK_API_KEY` is set in the worker
container. Two caveats: this is the first *worker* consumer of `fastJudgments` (the API's
`createLiveFastJudgmentsTextModel` is the only one today), and the route is a single global,
operator-editable row — nothing checks that it differs from the writer's family. Log the bound judge
selection beside the writer's at the start of the pass and warn when the providers match.

**3.2 Both orders / tie.** Correct. `forwardPick = winner==="A" ? 0 : 1`; in the reversed call draft A is
`second`, so `reversedPick = winner==="A" ? 1 : 0`; disagreement → `pick: 0`. Candidate 0 is the one at the
book's own settings, so the tie fallback is "the draft the book would have got anyway", which is the
fallback the best-of CLAUDE.md entry insists on.

**3.3 Does the second candidate's temperature reach the call? No, not on balanced.**
`packages/core/src/adapters/openai.ts:211`:

```ts
...(options.temperature !== undefined && this.thinkingEffort === "none"
  ? { temperature: options.temperature }
  : {}),
```

The balanced writer's effort is `low` (the log shows 60–180 reasoning tokens per compose). So no composed
run has ever sent 0.65 to OpenAI — the `temperature: 0.65` in every log line is the request object, not
the wire — and run B's `Math.min(1, 0.65 + 0.25) = 0.9` is discarded the same way. Both candidates sample
at the provider default. They will still differ (sampling noise at default temperature is not small over
4,000 words), so best-of-2 remains a real selection step, but "T 0.65 vs 0.9" is not the experiment that
runs, and the report's 1.11 ("Temperature 0.65 throughout") and 3.1 remarks about temperature were about a
knob that was never connected. Options: (a) set the balanced writer to effort `none` for `compose-chapter`
/`edit-chapter` (≈100 reasoning tokens is not a think; `elevatedThinkingSelection` already special-cases
composed purposes, so this is one clause) — then temperature applies, and pick the pair deliberately;
(b) keep effort as is, drop the temperature override, and make the second candidate differ by prompt
(the report's other option: "one prompt asking for two chapters that differ in rhythm", or in-context
regeneration — show draft 1, ask for a chapter that moves differently — which 3.1 cites as the one
inference-time lever that restores diversity). Either way the patch's comment and the run label must say
what actually varied.

If (a): the CLAUDE.md best-of invariant says no candidate samples hotter than the candidate-free pass and
the ladder descends. The patch climbs (+0.25) because the report said so. The invariant's reasoning (page
1 is the style lock) applies here in a weaker form — the chosen draft's tail is the next chapter's
continuation exemplar and its digest feeds every later chapter — so either follow the ladder (0.65, 0.50)
or write the exception into `packages/core/src/generation/CLAUDE.md` with the reason. Also guard
`Number.isFinite(input.temperature)` as `bestOf.ts` does.

**3.4 Cost and wall time.** Live unit times in this run: compose 37–82 s (median ~60), edit 23–52 s,
describe 11–17 s. Today the critical path per chapter is one compose, because `finishChapter(N−1)` overlaps
`compose(N)`. With the patch the loop becomes `Promise.all(two composes)` → `judgeChapterDrafts` (two
parallel judge calls, ~11–12k tokens each) → `drafts.set` → next compose. Chapter N+1's
`previousChapterTail` needs N's *chosen* draft, so the judge sits on the critical path: expect
+8–12 s (max of two composes) + 10–25 s (judge) per chapter ≈ **+5–9 min on a 16-chapter book**, at the
top of the report's "+0–8 min". Cost: +16 composes (~$0.13 at the report's $0.008) + 32 judge calls on
DeepSeek flash (~$0.03–0.05) − the second edits (run A's read flagged 11 of 16 chapters, ~$0.10, ~6 min).
Net ≈ +$0.08, +0–3 min. `Promise.all` rejecting on one candidate leaves the sibling call running to
completion, logged and costed — wasteful, not wrong. The worker CLAUDE.md line "Two model calls are in
flight at most" and the pass header comment become false (up to two composes + an edit + a describe, then
two judges) and need rewriting; check the OpenAI rate limit for three concurrent 5k-token outputs.

**3.5 MOCK_AI.** `createLoggedJudgeTextModel` under MOCK builds `createProviders(config, input).text` (a
`FakeTextModelAdapter`); the fake's `generateJson` → `fakeForSchema` gets the new `judge-chapter-drafts`
branch returning `{winner: "A", reason}`, which `parseSchemaWithContext` validates against
`verdictSchema`. Fake compose is deterministic, so both candidates are identical and the judge picks A.
Fine. `MECHANICAL_TEXT_PURPOSES` gains the purpose as a literal (the module must stay import-free — done).

**3.6 Tests.** `generateBook.test.ts` mocks `../providers/loggedAdapters.js`; the patch adds
`createLoggedJudgeTextModel` to that mock — needed, since the composed case is not itself exercised there
but the named import must resolve. Other handler tests mock the same module without the new export and do
not reach the composed case; vitest only complains on access. `composedChaptersPass.test.ts` covers
`composedResumeState`/`derivedChapterBrief`, not the loop, so `READ_SECOND_EDITS` and the judge have no
test. Add one: a fake judge returning "B" in one order and "A" in the other must keep draft 0; one
returning "B" in both must pick 1 and record `agreed: true`.

**3.7 A real bug: `READ_SECOND_EDITS = false` loses the read's notes.** The patch's replacement branch
does `reports.set(idx, { ...previous, readNotes: entry.notes })` — but every chapter's report was already
written into `Chapter.productionBrief` by `stageComposedChapter` inside `finishChapter`, and nothing after
the read block reads the `reports` map or re-stages a brief. The existing second-edit path re-stages with
`replace: true` precisely "so the console shows what the read said even when the edit changed nothing";
the new branch does not. Result: the console's "Manuscript read notes" is empty for every chapter, and the
comment "its notes are kept on the chapter report for the console" is false. Fix by re-staging each noted
chapter's brief (the stored pages + updated report, `replace: true`), or a direct `chapter.update` of the
brief's `report`. Also: the comment's justification ("the run that carried them (composed-5) scored inside
the noise of the run that did not") is wrong — composed-3 carried second edits too (12 chapters, per
report 1.3/1.5; its log has 27 edit calls like composed-5's). The right justification is the report's:
the second edit changes ~10% of sentences and no shape measure. Dropping it is still the right trade;
say why correctly. `bookNotes` stays unconsumed until run C.

**3.8 Rubric vs section 5.1, and how it can be gamed.** The core matches 5.1 ("keep reading",
paragraph rhythm, sentences that commit, forward motion vs re-balancing, ignore topic/facts). Extras:
"paragraphs and sections end differently" (fine, and a reason to see the whole chapter), "people, places
and documents present rather than abstractions" — this rewards name density, and the tic to beat in this
book is the six- and eight-name roll-call closer; drop or rephrase ("developed, not listed"). Length: the
rubric says ignore it, but the judge is fed both whole drafts (4k words each, ~11k tokens per call) and
`composeChapter`'s retry keeps the *longer* attempt, so length is exposed; 5.1 controls it at the source
with equal-length excerpts (first ~900 / last ~450 words) and cites LongJudgeBench's near-noise accuracy
on ~9k-token items with up to 79% order-swap inconsistency — which under this patch means many ties, i.e.
paying for a second draft and keeping the first. Family: the judge cannot prefer its own text (both drafts
are OpenAI's), but a DeepSeek judge is also a post-trained model and will like the tidy expository
paragraph too; the report's answer is two families (Qwen is already routed on `fast`). Position: handled.
Refusals: the report kept them "for the judge"; the patch's judge sees only title, audience and chapter
title — acceptable, but not what was written. Validation: 5.1 says validate the judge on the five scored
books before trusting it (expect composed-2 < per-page < composed-4 < composed-1 ≈ composed-3, and a tie
for the last pair); no such script exists (`scripts/` has `blind-panel-summary.ts` and
`structural-scorecard.ts` only) and it has not been run. That is a $0.15, two-minute prerequisite for a
$0.50, 35-minute run.

**3.9 Small things.** The judge purpose is in neither `COMPOSED_STAGES` (`pipelineStages.ts`) nor
`COMPOSED_STAGE_COST_GATES` (`qualityGateCosts.ts`), so its spend is unattributed on the Quality/Costs
tabs — add a stage. `judgeChapterDrafts` takes `input` and never uses it. `createLoggedJudgeTextModel`
under MOCK constructs a whole provider set to take `.text`. `earlierOpenings`/`earlierClosings`,
`LANDING_FORMS`, `landingFormFor`, `detemplateChapter` and `DETEMPLATE_CHAPTER_PURPOSE` are dead now.

---

## 4. Other contradictions with the report, ranked

1. **`stanceLine` alias bug** (`schemas/plan.ts`): add `belief`/`believe`/`holds`; never fall back to
   `rejects` alone (a position with only a rejection is not a position); and stop joining "X Rejects: Y",
   which hands the writer the believes/rejects couplet even when the alias hits. Then ask the *planner*
   for plain assertions (`PLANNER_AUTHOR_STANCE_GUIDANCE`, and `generateAuthorStance`'s `outputContract`),
   not only the fallback. Until this is fixed every composed book on this brief writes from the rival views.
2. **Research queries are the planning instruction.** `expandChapterResearch` (`planner.ts`) builds each
   chapter's query as `[input.prompt, title, summary, ...keyBeats].join(" ")`; for a chat-created book
   `input.prompt` is "Create the best-fitting book from the user's creation chat. Decide the real book
   shape during planning…", so all 12 `research.search` calls in this run begin with that, and the seven
   notes every chapter received are about "lead magnets", "practical guides" and "children's fables"
   (medium.com, scribd.com, ziprecruiter.com), duplicated. The writer is then forbidden any source not in
   `researchNotes` and writes about the Bayeux Tapestry anyway. This is the material cause behind 1.9 and
   it is a bug, not a ceiling: query on `plan.premise`/title/summary/keyBeats for chat-created inputs.
   Fix before experiment 7 is even considered.
3. **The plan reaches the writer through `keyBeats`, `openingHook` and the last-chapter rule** (D4).
   Send the writer `chapter.summary` and the beats with any "Open with…/End with…/Close with…" beat
   dropped or rewritten as material; keep the hook as a *suggestion* or give it to the read as an
   `expectedOpening`; cut the final-chapter conclusion rule to "the last chapter carries one new case" and
   stop forwarding the promises list (promise 6 orders a balanced ending).
4. **Through-line in the provisional digest** (D3): build it from `chapter.summary` and the section
   subjects, not `composition.throughLine`; and write digests as prose about the matter, not "The page…".
5. **The editor still carries the conclusion**: "Only the chapter's final paragraph lands an idea", the
   closing-verdict measurement note ("write the chapter's conclusion as a reasoned paragraph"), and the
   read's flag criterion "an ending that recaps or generalises instead of ending on a particular" (the
   object-tableau instruction of composed-2). Remove all three; keep the paragraph-shape numbers if you
   must, since `varyParagraphs` merges deterministically anyway.
6. **Distribution rules and hedge prescriptions in the compose payload**: the plan's `voiceGuide` lines
   about provisional comparison and moderate confidence, and the five "Avoid repeating this beat" rules in
   `continuityRules`. The CLAUDE.md rule is that distribution rules reach manuscript review only; route
   them to the read and give the writer the local style lines.
7. **Temperature is not connected on balanced** (3.3). Decide, document, and stop quoting 0.65 as a
   property of any composed run.
8. **The stance still requires a voice sample** (`MIN_VOICE_SAMPLE_WORDS`) the writer never sees; a plan
   whose sample is short triggers a whole `author-stance` regeneration for a field only the leak check
   reads. Relax to "has a thesis and ≥2 positions".
9. **Docs**: `packages/core/src/generation/CLAUDE.md` still describes the stance as "positions with the
   alternative they reject" and the voice sample as what the writer imitates; the worker CLAUDE.md says
   two calls in flight. Update with run B.

---

## Fixes, in priority order

Before run B is launched:

1. Fix `stanceLine` (`belief` alias; no `rejects`-only positions; no "Rejects:" joining), change the
   planner's stance guidance and the fallback's `outputContract` to plain assertions, and re-run the plan
   or patch this plan's `authorStance.positions` to the five `belief` strings. Without this, run B is not a
   test of best-of-2; it is a second run of the inverted stance.
2. Fix `expandChapterResearch`'s query for chat-created inputs (or strip the planning instruction from
   `input.prompt` before it is used as a query). Cheap, and the notes are worthless as they stand.
3. Decide the second candidate: either effort `none` on balanced compose/edit so temperature is real
   (then 0.65 / 0.50 per the ladder, or document the +0.25 exception), or a prompt-varied second draft.
   Rename the experiment accordingly.
4. Persist the read's notes when `READ_SECOND_EDITS` is false (re-stage the brief), and correct the
   comment's justification.
5. Judge on aligned excerpts (first ~900 + last ~450 words of each draft) rather than whole chapters,
   drop "people, places and documents present" from the rubric, and run the 5.1 validation over
   composed-1..5 (24 calls, ~$0.15) before paying for the panel. Add the tie/agreement unit test and a
   `judge-chapter-drafts` stage in `pipelineStages.ts` / `qualityGateCosts.ts`.
6. Take the plan out of `keyBeats`/`openingHook`/the last-chapter rule, and the through-line out of the
   provisional digest.
7. Remove the three surviving conclusion rules (editor line, closing-verdict note, read criterion) and
   the negation-correction note to the editor; keep the shape numbers as diagnostics only.

For run A's result: read it knowing D1. If the panel scores it near composed-5, that is what an
inverted stance plus an unchanged editor predicts, not evidence against hiding the plan; the strict paste
numbers (landing 1/16, handoffs 0/48) are the part of experiment 1 that can be trusted.
