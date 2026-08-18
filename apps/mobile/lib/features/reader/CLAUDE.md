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
reader is holding and announces an edit they already have. That hit must still refuse the
descriptor's numbering unless its downloaded digest matches the stored map's digest: a repair can
replace a PDF at the same revision and size, and writing either map onto the other bytes would stick
after status catches up. The digest remains useful even for `unknown` provenance — it identifies
the exact bytes — but only an exact revision may re-anchor markup.

**One manifest per cached file, and no manifest write may fail the call that made it.** The entry
is about one format's bytes — their revision, digest, size and permanent cover-skip stamp — so it
is named after them (`book.pdf.manifest.json`) rather than kept as one `manifest.json` the two
formats overwrite in turn. The old project-wide name is still read, and still cleared when the file
it described is replaced, for the PDF alone: it is the only export this cache has ever been asked
for. And the write is bookkeeping about bytes that are already on disk and already readable, so a
full or read-only volume must not turn a finished download — or a cache hit stamping cover-skip
onto one — into a failure the reader sees instead of a book. A stamp that could not be stored still
holds for the open that established it; the next open asks the same map again.

## The PDF reader

- **The in-app reader renders the compiled `book.pdf` with pdfrx (PDFium).** `main.dart` must call
  `pdfrxFlutterInitialize()` before `runApp`, and the natives are not available under
  `flutter test` — `BookReaderScreen` takes its viewer through `readerViewerBuilderProvider` so
  tests can stub it. PDF pages do not map to `Page.index`: `generateBookPdf` renders the whole
  book as one HTML flow and lets Chrome paginate it, so nothing separates one `Page` from the
  next. A selection is resolved back to a book page by `ReaderPageLocator` and then named
  explicitly in the chat message, which is what `pageIndexesFromMessage` in
  `apps/api/src/bookEditIntent.ts` reads. Navigation, bookmarks and `chatReaderContext.pdfPage`
  stay physical pdfrx pages. **A sheet number belongs to one file, so it may only be sent with
  that file's digest.** `mappingRevisionFor` authorizes the model-space half — fetching the
  manuscript, resolving a `pageIndex` — and a resolved index survives anything, because it names a
  page of the book rather than a sheet of one compile of it. The physical fallback a selection
  falls back to when the locator resolves nothing is gated separately, on `mappedPdfDigestFor`:
  it travels only when the map in force was measured from the open file, and it carries that
  digest so `modelPageForReaderContext` can make the same check against whatever has published
  since this screen last read the status. Revision equality survives a same-revision repair —
  the new map is stamped with the revision the open file already has — while the pages under
  those sheet numbers do not, so a stale sheet would have been translated through the
  replacement's map. No digest on either side sends no sheet at all; the printed number the
  message itself speaks is what routes then. Displayed numbers — the scroll bubble, the bottom bar, Contents
  sheet, bookmark labels, annotation subtitles, selection labels and composed chat copy — skip
  the cover when the **open file** skips it (`CachedExport.hasCoverPage`, via
  `displayedHasCoverPage`). That stamp is taken from the map that described these bytes when
  they were filed, never from a later compile's flag: after publish `hasCoverPage` on status
  follows the new map, and keying chrome off "revisions disagree" would force physical numbers
  onto a still-open version-2 PDF whose footer already skips the cover. Mapping already refuses
  the offered compile when the open file's exact revision disagrees with it (`mappingRevisionFor`).
  During EDITING the server keeps the previous map, so an unstamped cache can still take the
  flag when that older map's digest matches the older open file; after publish a different digest
  must not. "Does the map in force still describe these bytes"
  is one predicate — `coverPageMapDescribes` in `domain/reader_models.dart` — and every place
  that depends on the answer asks it: the chrome fallback, the stamp `ReaderView` writes onto
  the open document, both cache paths, and the digest a selection sends with a physical sheet
  (`mappedPdfDigestFor`). Add a caller, not a fifth spelling. Every caller hands it the downloaded PDF digest and the status's atomic
  `pdfPageNumbering` identity. `contentRevision` is carried for provenance and for EDITING's behind
  map, but digest equality is the cover gate: same-revision repairs are different files.
  `CachedExport`'s constructor drops a `hasCoverPage` that arrives without a digest, which is also
  what un-freezes stamps older builds wrote into pre-digest manifests. Missing identity on either
  the map or file stays on physical numbering; no revision/status fallback is permitted.
  Physical page 1 then labels as "Cover", not
  "Page 1". Version-1 maps report the flag false, so chrome keeps physical numbers matching
  those PDFs' footers. Absent the flag, chrome shows physical numbers, matching chat not
  translating — the path for books compiled before the map. A failed measurement of a new
  PDF still records the flag, so chrome can match a footer that already skips the cover.
  Recovered Contents rows store physical `Page $page` titles;
  `displayedTitle` converts at display time, so a post-publish chrome fallback cannot leave a
  printed label next to a physical trailing number.
- **The reader places the rendered page before it places the selection.** Matching the selected
  text alone resolves a recurring passage to its *first* copy in the book, which is the wrong page
  whenever the reader is past it. `ReaderPageLocator.spanForPage` probes the PDF page's own
  extracted text — which the reader never selected — for a `Page.index` window, and `locate(...,
  within: span)` then searches only there. A probe matching more than one page is discarded rather
  than trusted, and a null span (the cover, the contents page, anchors that disagree) falls back to
  searching the whole book. Keep null cheap and common: it is the safe answer.
