---
name: verify-pdf-typography
description: Use when a change could move a page break in an exported book — a failing sha256 assertion in packages/core/src/generation/pdfDocument.test.ts ("still resolves md-to-pdf's markdown.css unchanged", "still resolves highlight.js' github theme unchanged"), a failing page-count assertion in pdf.test.ts, or any edit to `pdfCss.ts`, `pdfDocument.ts`, `BOOK_PDF_OPTIONS`, the `@page` margins, `bookPdfCss`, the export fonts, or the pinned `md-to-pdf` / `marked` versions. The procedure is `pnpm render:fixtures` with `--baseline <ref>`, `--compare` and `--install`, over the seven-book fixture corpus in scripts/render-book-fixtures.ts. Reach for it on "the css digest test is failing", "can I bump md-to-pdf", "did this change the layout", "update the stylesheet hash", or "the page count test says 9 but I get 10".
---

# Verifying book typography did not drift

The digests and the recorded page count are tripwires, not the check. They tell you *something*
moved; only a render of the fixture corpus on both sides tells you what. Never update a digest or a
page count without doing the render first.

Why the pipeline is pinned the way it is — the deep imports into `md-to-pdf`, the exact-version pin,
what `BOOK_PDF_OPTIONS` is for given Chrome ignores it — is in
[`packages/core/src/generation/CLAUDE.md`](../../../packages/core/src/generation/CLAUDE.md).

## Prerequisites

- **poppler-utils** — `pdfinfo` and `pdftoppm`. `--compare` shells out to both, and the page-count
  test in `pdf.test.ts` and the font/text tests skip themselves without them, so a green local run
  proves less than you think on a machine that lacks them.
- **An installed tree.** `--baseline` lends the worktree *this* checkout's `node_modules`; it aborts
  with `nothing installed to lend the baseline — run 'pnpm install', or pass --install`.

## Procedure

```bash
# 1. the old side, rendered by the old code, in a throwaway worktree
pnpm render:fixtures --baseline HEAD output/book-fixtures-before

# 2. the new side, from the working tree
pnpm render:fixtures output/book-fixtures-after

# 3. the verdict
pnpm render:fixtures --compare output/book-fixtures-before output/book-fixtures-after
```

Add `--install` **whenever the change moves a dependency pin** — the `md-to-pdf` version is the one
that matters, and a fired stylesheet digest usually means exactly that:

```bash
pnpm render:fixtures --baseline HEAD~1 output/book-fixtures-before --install
```

`--install` runs `pnpm install --frozen-lockfile` against the ref's own lockfile inside the
worktree. Slow, and needs the network the first time. Without it the baseline renders against the
*new* dependency version, which silently answers "no drift" to the only question you asked.

Defaults if you omit the output directory: `output/book-fixtures` for a plain render,
`output/book-fixtures-before` for `--baseline`. `--compare` exits non-zero when anything drifted, so
it can gate a commit.

Read `scripts/render-book-fixtures.ts` before improvising: the flag parsing is hand-rolled
(`--install` is filtered out first, then `--compare` / `--baseline` are matched positionally) and
the corpus is the `FIXTURES` array near the top — seven books covering both text directions, CJK,
illustrations, rich blocks, a cover-first layout and a dense fifteen-chapter Contents.

## Reading the comparison

Per fixture, in this order:

1. **`Pages:` from `pdfinfo`** — checked first and short-circuits everything else. `PAGE COUNT n ->
   m *** DRIFT ***` is the cheapest and most conclusive signal that margins or the base stylesheet
   moved.
2. **Raster page size** at 100 dpi. A page whose raster changed dimensions is reported as
   `PAGE SIZE` drift and is deliberately *not* measured — rows missing from the bottom are never
   visited, and a removed column shifts every row against its neighbour, so the fraction would stop
   describing the layout.
3. **Differing pixels** on same-size pages, with an 8/255 per-channel tolerance because antialiasing
   is not layout. Worst page reported: `> 0.5%` counts as drift, `> 0.02%` prints `(minor)`, below
   that `identical`.

## Traps

- **Byte-comparing PDFs proves nothing.** `/CreationDate`, `/ID` and font-subset ordering differ run
  to run. That is why the harness rasterises.
- **A page-count guard only works on continuous prose.** The `pdf.test.ts` fixture runs twelve
  chapters of unbroken body text on purpose. An earlier version ended each chapter with
  `<div class="page-break"></div>`, which pinned the count to the chapter count and returned the
  same number whatever the stylesheet said. If you add a fixture with forced breaks, it reports its
  own structure, not the typography.
- **`BOOK_PDF_OPTIONS.margin` is measurably inert.** `bookPdfCss` writes `@page { margin: 20mm 18mm
  22mm }` and Chrome honours that over the CDP parameters — identical page count and line width at
  30/40/30/20mm, at 1cm, and omitted entirely. It is pinned for the day the `@page` rule is removed,
  and `pdfDocument.test.ts` asserts it by **equality**, not through a render, because no render can
  see it. Do not "fix" that test by rendering.
- **The baseline worktree borrows the current harness.** `--baseline` copies *this* file over the
  one the ref carries, on purpose: the change under test is routinely the one that adds the fixture
  corpus, the `render:fixtures` script and the `packages/core` exports the harness imports. The
  fixtures are the control, so a ref carrying its own copy of them would report its own text as
  layout drift. The corollary is that the harness must keep importing `packages/core` *dynamically*
  and typing it by hand — a static named import of an export the old checkout lacks is a link error
  thrown before a line of the script runs.
- **A stashed baseline cannot work** for the same reason, and `git stash -u` takes the harness with
  it. Use `--baseline`.

## Only then, update the tripwire

When the corpus comes back clean and the change is intentional:

- Digests: `MARKDOWN_CSS_SHA256` / `HIGHLIGHT_CSS_SHA256` at the top of
  `packages/core/src/generation/pdfDocument.test.ts`. Recompute with
  `sha256sum` over the paths `bookPdfBaseStylesheetPaths()` resolves (they come out of
  `md-to-pdf`'s own `require`, not this tree's).
- Page count: the `expect(…).toBe("9")` in `packages/core/src/generation/pdf.test.ts`.

Record what the comparison said in the commit message — the next person to see the digest fire
needs to know whether the last bump re-typeset anything.

```bash
pnpm --filter @book-maker/core test -- pdfDocument pdf   # the tripwires
pnpm check                                               # everything else
```
