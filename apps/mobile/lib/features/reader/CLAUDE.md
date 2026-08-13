# Reader

The in-app book reader: the PDF viewer, the export cache, highlights, notes and pen markup.

Reader markup is stored device-local and re-anchored by text after a recompile; orphaned marks are
kept but never drawn. Which revision a downloaded file belongs to is not something the URL can say,
so the client is told explicitly — see the provenance rules below, and treat `mismatch` as
"no guess permitted" rather than as a fallback.

## Export provenance on the client

The three states are not
interchangeable on the client: `exact` is a fact, `unknown` (no record — a file published before
any of this) leaves the descriptor standing in exactly as it did before, and `mismatch` (a record
describing other bytes, i.e. the file is being replaced under the read) permits no guess at all —
`CachedExport.revision` is null, no manifest is written, and the next open fetches again. Only an
exact revision may re-anchor markup (`CachedExport.exactRevision`), because that pass rewrites
every mark's revision at once; a stand-in there would have the next pass trust marks it should
re-search. And a cache entry *newer* than the descriptor is not stale, which is what a download
answered by an unseen compile leaves behind — treating it as a miss re-downloads the book the
reader is holding and announces an edit they already have.

## The PDF reader

- **The in-app reader renders the compiled `book.pdf` with pdfrx (PDFium).** `main.dart` must call
  `pdfrxFlutterInitialize()` before `runApp`, and the natives are not available under
  `flutter test` — `BookReaderScreen` takes its viewer through `readerViewerBuilderProvider` so
  tests can stub it. PDF pages do not map to `Page.index`: `generateBookPdf` renders the whole
  book as one HTML flow and lets Chrome paginate it, so nothing separates one `Page` from the
  next. A selection is resolved back to a book page by `ReaderPageLocator` and then named
  explicitly in the chat message, which is what `pageIndexesFromMessage` in
  `apps/api/src/bookEditIntent.ts` reads.
- **The reader places the rendered page before it places the selection.** Matching the selected
  text alone resolves a recurring passage to its *first* copy in the book, which is the wrong page
  whenever the reader is past it. `ReaderPageLocator.spanForPage` probes the PDF page's own
  extracted text — which the reader never selected — for a `Page.index` window, and `locate(...,
  within: span)` then searches only there. A probe matching more than one page is discarded rather
  than trusted, and a null span (the cover, the contents page, anchors that disagree) falls back to
  searching the whole book. Keep null cheap and common: it is the safe answer.
