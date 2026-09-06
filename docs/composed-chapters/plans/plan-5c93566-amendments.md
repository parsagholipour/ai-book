# Plan: amendments to 5c93566 (assigned exits, scene cap, repetition cut)

Status: proposed
Written: 2026-09-03 13:10, against commit `5c935665a7f0c4c657b2a75780a1f130a6164d9c` and the
ladder-6a/b/c-exits runs that started 12:52–12:57 and carry the commit as it is.

The commit is right about the lever: content assignments at the entrance moved slop (rung 5, the
only rung in twenty-nine arms that did) and the exit is the other position the form plan does not
reach. Four things in the implementation contradict the evidence the commit was built on, one of
them badly enough that ladder-6 should be read with it in mind. Everything below is a change to the
commit's own code; the next rung (openings as a payload) is out of scope and named at the end.

Ordered by how much it can move what ladder-6 measures.

---

## 1. The `landing` exit shows the planner's sentence to the writer — and the editor

**Where.** `packages/core/src/generation/chapterExits.ts:185-190`, the `landing` branch of
`exitPromptLines`:

```ts
if (exit.kind === "landing") {
  return exit.text ? [`The chapter's last paragraph reasons, in the author's voice, to this claim and stops: ${exit.text}`] : [];
}
```

It reaches the compose system prompt through `materialLines` (`composedChapterMaterial.ts:60,74`,
called at `composedChapter.ts:314`) and the edit prompt directly (`composedChapter.ts:616`). For a
15-chapter book `assignChapterExits` hands `floor(15 / 3) = 5` chapters a `landing` exit, so five
chapters per book now get the planner's landing sentence verbatim in both prompts.

**Why it is wrong.** `research-improvements.md` §1.2 and §1.6: landings shown to the writer reached
the prose at 15/15 in composed-3, -4 and -5, verbatim or ≥80% of content words, and were the
"identical chapter-closing paragraph" the panel quoted. The silent plan — `compositionWriterLines`
deliberately omitting `landing`, `throughLine` and `handoff` — was the first change that moved
anything, and its docblock in `chapterForms.ts:742-748` says so. This branch reopens the door on a
third of the chapters, and those are the chapters that have *no* material to end on, so nothing
competes with the pasted sentence.

The existing guard did not catch it: `composedChapter.test.ts:126-147` asserts the landing is absent
from both messages, but its fixture passes no `material`, so `exitPromptLines` is never reached.

**Change.**
- `landing` returns `[]`. Silence is what rung 5 had; the compose prompt already carries "The
  chapter ends where its last section ends." If a line is wanted at all it names the *kind* and no
  text: "This chapter ends in the author's voice: the final paragraph reasons to the chapter's own
  conclusion and stops." Prefer `[]` — one fewer instruction the writer can perform.
- Keep `text` on the `ChapterExit` for the trace and for `isAuthorialSentence`; it is never
  prompted.
- `chapterExits.test.ts:46` flips to `toEqual([])`.
- `composedChapter.test.ts` "composes a chapter from the stance and form plan": add
  `material: { episodes: [], excerpts: [], exit: { chapterIndex, kind: "landing", text: silentPlan.landing, source: "" } }`
  and keep the two `not.toContain(silentPlan.landing)` assertions; add the same for `editChapter`.
  That is the test that would have failed.

**Cost.** None. **Readout.** Landing paste rate on the five `landing` chapters (the
`research-improvements.md` appendix method: normalised substring or ≥80% content words) stays ~0
instead of returning to 15/15.

---

## 2. The epigraph and the excerpt exit are the same excerpt

**Where.** `chapterApparatus.ts:52-57` (`chapterEpigraph`) and `chapterExits.ts:76-79`
(`excerptExit`) rank a chapter's excerpts by the identical key — named (speaker or author) first,
then fewest words — and each takes the winner. The epigraph is that excerpt's *first* ≤60 words
(`epigraphText`), the exit is the *same* excerpt's *last* 8–45 words (`closingWords`). An excerpt
under ~100 words — the ranking prefers the shortest — is quoted at the head of the chapter and again
as its final sentence, and for a two-sentence excerpt the epigraph literally contains the exit.

With `chapterApparatus` and `chapterExits` both on (ladder-6), every chapter that has a dossier —
8 of 15 on rung 5 — opens and closes on one document. That is a per-chapter shape present in every
chapter that can have it, which is the definition of a template this programme has already paid
for twice (the scene call on 13–15 chapters; "a prompt field present in every chapter is a template
whatever it says", `packages/core/src/generation/CLAUDE.md`).

**Change.**
- Move epigraph *selection* out of `finishChapter` and up to where exits are assigned: add
  `chapterEpigraphExcerpt(excerpts): DossierExcerpt | undefined` in `chapterApparatus.ts` (the
  ranking, returning the excerpt rather than the block) and have `chapterEpigraph` build the block
  from it. In `composedChaptersPass.ts`, before `assignChapterExits`, compute the epigraph excerpt
  id per chapter when `chapterApparatus` is on.
- `assignChapterExits` takes `excludeExcerptIds: ReadonlySet<string>`; `excerptExit` skips them.
  A chapter with one excerpt then ends on `date`/`person`, or on the landing if it has neither.
- Make the two rankings disagree on purpose. An epigraph wants the shortest named excerpt; an exit
  wants the excerpt whose *closing sentence* carries a proper noun or a number (the test
  `isAuthorialSentence` already applies to prose). Rank `excerptExit` candidates by that first.
- Test: one named excerpt → epigraph XOR excerpt-exit, never both; two excerpts → different ones;
  `closingWords` of the exit is not a substring of the epigraph text.

**Cost.** None. **Readout.** `ladder-counts.ts` gains a column: chapters whose epigraph excerpt id
equals their exit excerpt id — must be 0.

---

## 3. The `person` exit asks the writer for a fact the dossier may not hold

**Where.** `chapterExits.ts:105-115`, `personExit`:

```ts
text: `${episode.person}'s last recorded act in ${episode.title}${episode.date ? ` (${episode.date})` : ""}, as ${episode.document || "the record"} has it`,
```

This is not material; it is a description of material the writer is told to end on "told plainly".
The `excerpt` exit is verbatim text and the `date` exit is planner-grounded episode data
(`date`, `title`, `place`). The `person` exit is a request for an act the dossier may contain
nothing about. Under the creative contract the writer supplies it from its own knowledge or
invents it, and because it is not in quotation marks the quote guard cannot see it — the one exit
kind whose failure mode is a fabricated final sentence about a named person.

**Change.** Either of:
- (preferred) `personExit` only when an excerpt for that chapter names the person
  (`excerpt.text` contains `episode.person`, whole-token); its `text` becomes that excerpt's
  sentence naming them, so the exit is verbatim again and the guard sees it. Otherwise fall to
  `date`.
- (simpler) drop `"person"` from `EXIT_KINDS` and the rotation until the dossier can back it.

Update `chapterExits.test.ts` "assigns material to most chapters…" expectations accordingly.

**Cost.** None. **Readout.** `ladder-counts.ts` reports the count of `person` exits and, on
rung 7, the quote guard's `misattributed` on the chapters that carry one.

---

## 4. Authorial exits sit at fixed periodic positions

**Where.** `chapterExits.ts:147-150`: after chapters with no material, landings go to positions
2, 5, 8, 11, 14 — chapters 3, 6, 9, 12, 15 — a period-3 rhythm, and the material kinds then rotate
on a fixed cycle around them. Low risk of a reader noticing, but it is a shape rule with a beat,
and the material kinds are fixed *by position* rather than by what the chapter has.

**Change.**
- The last chapter takes a landing first: the book's own conclusion is the one exit that should be
  in the author's voice (Option 2's "answer only on the last chapter" is right here).
- Fill the remaining budget from the chapters with the *weakest* material — fewest candidates, no
  excerpt — then spread the rest.
- Keep the no-two-consecutive-kinds rule.

**Cost.** None. Priority: low; land with 1–3 if it fits in the same test rewrite.

---

## 5. `repetitionCut` is inert on every book that matters; make that visible and cheap

**Measured** (`scripts/ladder-counts.ts` on rung 5 and 4, today): closers 0, thesis 0, formula 0 on
5a/5b/5c; 4 formula flags on 4a at `FORMULA_MIN_CHAPTERS = 5`, of which the worker cuts none at its
own `FORMULA_CUT_MIN_CHAPTERS = 7`. The commit message says why: "the readers' repeated closer is
paraphrase." The pass runs a detection and zero model calls on every recent book.

**Do not extend the detectors toward paraphrase.** A rule tuned until it fires on approved pages
is the thing the drafting gotchas say to remove, not tune. This stays a regression guard for the
verbatim recurrence composed-8/9 had.

**Change.**
- `composedChaptersRepetition.ts:79-82`: emit the "Cutting sentences the book repeats across
  chapters" progress message only when `targets.length > 0`. Today the reader sees a step that does
  nothing on every book.
- One threshold, or two named columns. `FORMULA_MIN_CHAPTERS` (core, 5) and
  `FORMULA_CUT_MIN_CHAPTERS` (worker, 7) mean `ladder-counts` reports formulas the cut would never
  touch. Either export the cut threshold from core and count at both, or print `formula@5` and
  `formula@7`.
- Leave `repetitionCut: []` in `QUALITY_FEATURE_DEFAULTS`. The ladder report must not attribute
  movement to it; note in `ladder-report-2026-09-03.md` that it made zero calls on ladder-6 if that
  is what the run logs show (`generation.composed_chapters.repetition_cut` with `cut: 0`).

---

## 6. Counts should measure what the pipeline did, not what it planned

**Where.** `scripts/ladder-counts.ts:59-63` reads opening forms from `trace.chapters[].forms[0]`
(the form plan), and the authorial-exit column uses `chapterEndsAuthorial(markdown)` with no exit,
whose `!hasProperNoun` reading undercounts the named aphorism the panel quotes ("Iceland made the
feud negotiable; France made it prosecutable" reads as material).

On rung 5 the plan and the pipeline disagreed: 4–5 chapters had `scene` first in the form plan
while the scene call ran on 7–8, because rung 5 gated the call on "previous chapter had none". The
new gate (`composedChaptersPass.ts:565`, `sections[0]?.form === "scene"`) makes them equal by
construction, and the count should still measure the pipeline.

**Change.**
- Read `scene` from the exported reports (`report.scene`) as "scene calls", beside the planned
  opening forms; assert `≤ floor(n × 0.34)` and no two consecutive.
- Add a strict reading of the exit beside the corpus one: "ends on a quotation or a number"
  (`/[“”"]/` or `/\d/` in the last sentence). It is comparable across rungs and does not need the
  exit to be known. Report both so rung 6 vs rung 5 is on one scale.
- Add "epigraph excerpt == exit excerpt" (item 2) and `person` exit count (item 3).

---

## 7. Documentation the gotcha index will ask for

`scripts/check-gotcha-index.mjs` fails `pnpm check` when a directory `CLAUDE.md` and the root
index disagree. Two lines, both under "Drafting and page quality" in the root and in
`packages/core/src/generation/CLAUDE.md`:

- **A chapter's exit is material or silence, never the planner's sentence.** The landing reached
  the writer at 15/15 paste when it was shown; `exitPromptLines` speaks only for `excerpt`, `date`
  and `person`, and the silent-plan test in `composedChapter.test.ts` now carries a `landing` exit.
- **The epigraph and the exit are two documents, or the epigraph yields.** One excerpt quoted at
  the head and the tail of every dossier chapter is a template; `assignChapterExits` excludes the
  epigraph's excerpt and the two rankings differ on purpose.

---

## Order and verification

Land 1 and 2 together as one commit before rung 7 is launched — they change what the writer is
shown, so a rung that mixes them with anything else cannot be attributed. 3 and 4 in the same
commit if the test rewrite is shared; 5 and 6 are script/observability and can ride along.

```bash
pnpm -F @book-maker/core exec vitest run src/generation/chapterExits.test.ts src/generation/composedChapter.test.ts src/generation/chapterApparatus.test.ts
pnpm -F @book-maker/core typecheck
pnpm -F @book-maker/worker typecheck
pnpm exec tsx scripts/ladder-counts.ts --all      # corpus columns unchanged; new columns present
pnpm check
```

Then `dev-set-quality.ts` on the balanced tier, `dev-rerun-book.ts run --reuse-plan cmtjlkn0z0000g8g08zbzxerc --label ladder-7{a,b,c}-exits2`, panel, pairwise vs 5b on chapters 1 and 8.

---

## Reading ladder-6 (running now, none of the above in it)

Pre-register before the panel is read:

| count | expectation | source |
|---|---|---|
| scene calls | ≤ 5 / 15, none consecutive | `report.scene` per chapter |
| assigned `landing` exits | 5 / 15, at chapters 3, 6, 9, 12, 15 | `exits_assigned` log line |
| chapters ending authorial (exit-aware) | ≤ 5 / 15 | `exits_measured` log line, `report.exit.endsAuthorial` |
| landing paste on the five `landing` chapters | expect **high** — item 1 predicts it | appendix method against `trace.json` landings |
| epigraph excerpt == exit excerpt | expect **> 0** — item 2 predicts it | `trace.json` + dossier |
| `repetition_cut` | `cut: 0` | worker log |
| engagement | **holds ≥ 7.0** (rung 5: 7.0; rung 3: 7.22 with 13–15 scenes) | panel |
| slop resistance | report, do not target | panel |
| pattern lists | how many of nine still name a closing aphorism or closing question | panel verdicts |

If engagement falls toward rung 2's 6.67 with scene calls at ≤ 5, the scene was carrying it and
rung 7 puts material on the non-scene chapters (below) rather than restoring scenes. If the
authorial-exit count is ≤ 5 and slop does not move, the exit was not where the remaining pattern
lives and the pairwise on fixed chapters is what says where it does.

---

## Out of scope: rung 7, openings as a payload

Not an amendment to this commit; the next content assignment. For the ~10 chapters per book whose
first section is not `scene` and that have a dossier, put the excerpt or a figure *in the body* as
the first block — a set-off document or a count — instead of (not in addition to) the epigraph.
The same lever as the scene call, aimed at the chapters it does not reach. Decide it from the form
plan (`close-reading` first → document; `catalogue`/`mechanism` first → figure) with the same
positional caps, and do not gate it on `chapterApparatus`. Spec it separately after ladder-6 and
ladder-7 are read.
