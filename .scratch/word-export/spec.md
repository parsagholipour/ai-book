# Word (.docx) export, subscribers only

Status: shipped 2026-09-06 (code); unmeasured on a live book

## Why

Every compile produced `book.md`, `book.pdf` and `book.epub`, and the app offered the PDF and EPUB
behind a one-time per-book export unlock. A reader who wants to keep editing a book in Word, or
hand it to an editor, had nothing to download. The Word file is a plan perk: produced for every
book, refused to a free account at the download route.

## Decisions (Parsa, 2026-09-04)

- **Who gets it:** any paid plan (Creator, Pro, Max), through `hasActiveSubscriptionEntitlement`
  — the same helper the manuscript-import route gates on.
- **Export unlock:** the Word download still goes through the per-book `EXPORT_UNLOCK`. The
  subscription gates the *format*; the unlock gates the *book*. A subscriber who unlocked the PDF
  gets the Word file at no further charge.
- **Refusal shape:** 403 `SUBSCRIPTION_REQUIRED`, the import route's code, so shipped apps
  already open the paywall on it. Refused before a byte is read and before a repair is queued.
- Produced on every compile as a best-effort companion like the EPUB (`DOCX_EXPORT_FAILED`
  warning, never a failed compile). Repaired through the export-repair lane, lowest priority after
  PDF and EPUB, with its own `repair-docx-…` window key.
- No Prisma change: files on disk plus `.provenance.json` sidecars.
- Renderer: the `docx` npm package (MIT 9.7.1) over marked@18's lexer, sharp for image sizes,
  WebP/SVG re-encoding and figure rasterisation. No Chromium.
- Fonts named, not embedded (EPUB precedent). Contents is a static list of hyperlinks to chapter
  bookmarks, never a TOC field (Word would ask "update fields?" on every open).
- No operator-console link and no inline rebuild for DOCX; the legacy route's format union only
  widened.

## What shipped

- `packages/core/src/generation/exportFormats.ts`: the registry (`EXPORT_FORMATS`,
  `COMPANION_EXPORT_FORMATS`, filenames, content types, `exportRequiresSubscription`,
  `companionExportFailedIssueCode`). The sweep suffixes, provenance paths, worker pending paths,
  artifact publications, DTO, repair priority and route table all derive from it.
- `docx.ts`, `docxMarkdown.ts`, `docxAssets.ts` (+ `docx.test.ts`, 18 cases): `generateBookDocx`
  mirroring `generateBookEpub`'s signature. A4 with the PDF's 20/18/22/18 mm text block; Heading 1
  per chapter with `pageBreakBefore` and a `chapter-N` bookmark; per-script font attributes
  (`Vazirmatn` cs for Persian, Noto faces elsewhere); RTL paragraphs `bidirectional` and runs
  `rightToLeft`, code LTR; emphasis bold where the script has no italic; only `http`/`https`/
  `mailto` links survive; raw HTML dropped; the compiler's title page and Contents read back into
  fields; figures rasterised through sharp and degraded to the stand-in sentence.
- Worker: `exportArtifacts.ts` (filesystem half, split out of `exportPublication.ts`, generalised
  on `companionsProduced`), `compileExportCompanions.ts` (one table for EPUB and Word: step, retry,
  warning), `compileExportCompanionFailure.test.ts`, `exportArtifacts.test.ts`. Policy identity
  letter `d`; job step `docx` ("Generate Word").
- API: table-driven `routes/exports.ts` with the plan gate, `sendSubscriptionRequired`,
  `missingExportFormat` in registry order, `qualityWithExportsOnDisk` over both companions,
  `requiresSubscription` on every export DTO, invalidation list from the registry, "Making your
  Word file" progress phrase.
- App: nullable `MobileExportSet.docx`, `requiresSubscription`, a Word tile/menu rows/card button
  with a lock and "Upgrade for Word" for a free account (paywall message "Word export is part of
  the Creator plan."), the `SUBSCRIPTION_REQUIRED` arm in the shared export failure reporter,
  `ExportRepairFormat.docx` in the watch (joins only when asked for, like the EPUB), the Word UTI
  for the file opener.
- `scripts/render-book-fixtures.ts --docx` writes a `.docx` beside each fixture PDF.

## Consequence to know about

A book compiled before this shipped has no `book.docx`; its next status read queues one detached
Word repair (no Chromium, no model call, at most one per five-minute window per project) until the
file lands. The app never polls for it.

## Not done

- Operator console link / `GET /api/projects/:id/export/docx`.
- Embedded fonts. Word substitutes when Vazirmatn or Noto are absent; Latin headings named Inter
  fall back to a system sans on most Windows installs.
- Persian footer digits (OOXML has no Persian-digit page format) and Contents page numbers.
- Figure labels in non-Latin scripts: the SVG names the PDF's embedded face, which librsvg cannot
  see. The worker image ships `fonts-noto-core` (Persian/Arabic render in Noto) and no CJK fonts,
  so CJK figure labels may be tofu. The upgrade is rasterising figures through the browser pool.

## Measurement

None on a live book yet. `pnpm render:fixtures --docx <outdir>` then LibreOffice headless
conversion is the smoke test; open `persian-rtl.docx`, `figures.docx` and the CJK fixture in Word
or Google Docs for bidi, Contents links and figure glyphs.
