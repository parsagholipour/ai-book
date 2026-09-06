# Figures: charts and flow diagrams in composed books

Status: shipped 2026-09-04 (code); unmeasured on a live book

## Why

Long non-fiction books routinely need a figure — a chart of the numbers the text discusses, or a
flow diagram of a procedure — and the generator had none: the only non-prose element a page could
carry was an AI-drawn illustration, billed per image and useless for data. The constraint (Parsa,
2026-09-02): the writer must not pay for this in focus. The composed-chapters rerun loop had shown
twice that a prescription shown in every chapter becomes a tic, and that deterministic gates fire on
approved pages.

## Decisions (Parsa, 2026-09-02)

- Composed chapters only. The per-page writer tolerates and preserves figure blocks (chat rewrites,
  continuation) and never produces them.
- The author's knowledge is allowed: numbers may come from the notes, the chapter's prose, or a
  well-known public record; `source` names which; an estimate says so in `caption`.
- Not only statistics: `bar`, `line`, `pie` charts and a `flow` diagram of steps and decisions.

## What shipped

- `packages/core/src/generation/figures/`: `figureSpec.ts` (zod, limits: strings clip; counts and
  value magnitude (`FIGURE_LIMITS.value`, 1e15) are hard; canonical one-line JSON),
  `figureBlocks.ts` (find, stand-in, strip/reinsert by anchor, validate, word equivalent),
  `figureSvgCharts.ts`, `figureSvgFlow.ts` (layered layout, back edges down a channel),
  `figureSvgShared.ts` (validated 4-colour palette, locale digits, RTL text), `figureHtml.ts`
  (`expandFigureFences`), `figureEligibility.ts` (`usesFigures`), `figurePrompt.ts` (every sentence a
  model sees).
- Form plan: `chapterSectionSchema.figure`, `capFigures`, rule + key only when eligible.
- Compose: syntax and one example of the planned kind only in a figured chapter; budget minus 140
  words per figure; words counted on prose only.
- Worker: `composedFigures.ts`; after compose, `validateFigureFences` drops an unreadable or
  unterminated block, a block over the planned count, and — when a kind was planned — a valid
  block of the wrong kind; survivors are re-serialised to the canonical line; strip before the
  edit, reinsert before the cut; finalize on figure-free drafts, restore before staging; chat
  rewrite keeps the figure unless the request names it; a replan adherence revise holds or keeps
  the same way.
- Render: `pdf.ts` (after anchors, before font subset) and `epub.ts` (before marked). Inline styles;
  no CSS change. Fixture `figures` in `scripts/render-book-fixtures.ts`.
- Gate `figures` (composed, Chapter form plan, free), default on every tier.
- Fence-blind seams: `pagesLocalQa`, `manuscriptQuality`, `manuscriptReviewPacks`, `readerChapters`
  (figure fences only; a language-tagged listing is page text), `chapterIntegrity`, `manuscriptRead`,
  `describeChapterPages`, `chapterTail`, `projectChat`, `voiceCharacters`, `voiceCharacterProfile`,
  `compileExportChapterReview` (chapter-transition excerpts; figure fences only),
  `editAdherence` / `reviewAppliedBookEdit` (stand-ins unless the instruction names the figure,
  same keep-unless-named as chat; markdown, not a later-pass `pageDraftSummary` site).
  Later-pass summaries go through `pageDraftSummary` (`toPriorPageContext`, `lookup_page`,
  `compactPageMap`, `compactPriorPages`, continuation `recentPageSummaries`, chapter-review `pageSummaries`,
  voiceCharacters summaries, voiceCharacterProfile summaries, manuscriptReviewPacks neighbor
  summaries). A chat rewrite keeps the figure unless the
  request names it — including a title of three or more characters quoted as a whole phrase.

## Not done

Per-page writer producing figures; cycle/timeline kinds; RTL-mirrored geometry (labels are RTL, axes
stay left-to-right); figure numbering; a source check by the manuscript read; a preview of the block
in the app's Edit Mode (the raw block shows in the text field, like an image line).

## Measurement

Run one balanced analytical book and read the run log for `figure_dropped` events; judge the data
honesty of the charts and the flow layout by eye before turning the gate on for `fast`.

## First live book (2026-09-04, cmtm328uj000x19jy5k3pbnva, "Algorithms That Still Matter", balanced, CUSTOM → analytical-history, 24 pages)

- Eligible, gate on, the planner was shown the rule in both its calls. It assigned one figure in
  eight chapters (chapter 2, a bar chart of operation counts) under a rule that said "most sections
  carry none". Rule reworded to invite a figure wherever the material is quantitative or procedural;
  cap raised from half the chapters to three in four (`figureCapFor`).
- The writer wrote the block. The validator dropped it: `unit: Too big: expected string to have <=24
  characters` (run log event `figure_dropped`). Strings are now clipped with an ellipsis instead of
  refused; counts stay hard, and so does a value's magnitude (`FIGURE_LIMITS.value`, 1e15) — clipping
  a value draws a different chart, and a number that size belongs in a larger unit. `Number.MAX_VALUE`
  used to parse as valid and sent `niceTicks` into an infinite loop; the tick generator is bounded on
  its own now (`figureSvgShared.ts`), because a spec can be built directly. The chart it wrote
  (10,000 → 1,000,000 records, linear scan against a hash lookup) needs a log axis, so `scale: "log"`
  was added and named in the writer's rule.
- Code: three fences, all tagged `text`, plus thirteen indented code lines; highlight.js maps `text`
  to plaintext, so nothing was coloured although the highlighter works (the `rich-blocks` fixture's
  `js` fence renders coloured). `codeBlockRules` now tells a book about code to tag fences with the
  language and never indent code; the editor is told to keep fences byte for byte. The EPUB has no
  highlighter at all (marked@18, no highlight.js) — a known, separate gap.
- Not yet re-run after these changes.

## Rerun on the same plan (2026-09-04, cmtm3tyi400005jg03cjlh08s, "[figures-1]", 7 min, 43 calls, $0.156 vs 49 / $0.170)

- Planner: 3 figures in 8 chapters — chapter 2 a bar chart of operation counts, chapter 5 a flow
  "Choosing a graph procedure", chapter 6 a flow "Release-window scheduler construction". All three
  written, kept, and placed after the paragraph introducing them; no stand-in leaked; no figure
  where nothing was quantitative or procedural.
- Code: 2 `python` fences (coloured in the PDF), 6 `pseudocode` fences (plain, as intended), zero
  indented code outside a fence.
- Rendering defects found by looking, fixed the same night: tick labels clipped at the margin
  (compact ticks + adaptive margin), a 35-character unit overlapping the top tick (unit row), a
  linear axis over six decades (auto log at a 1000:1 ratio), diamond labels broken mid-word
  (whole-word wrap), edges into one node drawn as one line and layer-skipping edges running through
  boxes (spread attach points, bowed skip edges), a 14-layer chain spilling the A4 content block
  (`MAX_FLOW_HEIGHT` 720; nodes scale to fit rather than a min-width that overflows). The book's
  chart and graph flow are now in the `figures` fixture.
- Harness: `dev-rerun-book.ts` takes the designed cover by default (`--cover ai` to draw one); this
  run's AI cover had completed 35 s after launch, before the instruction arrived.
