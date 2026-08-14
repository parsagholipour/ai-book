# Book generation

The pipeline that turns a plan into a printed book: planner and pages, markdown assembly, the PDF
and EPUB renderers, covers, the browser pool, character reference sheets, and the export
provenance/temp-file machinery.

Most of this directory is only reachable from the worker, but it is *in core* because two processes
compile a book — the worker at the end of generation, and the API when it rebuilds a missing export
inline. Anything that decides how a book looks or what a file contains must live here, or the two
sides will disagree about the same book. That has happened: the citation map was duplicated once
and the same book's Sources list named Google or the publisher depending on which side rendered it.

## The invariants below are unusually load-bearing

This directory holds the code that produced most of this project's worst incidents — a password
file printed into a PDF, a Chromium leak that survived shutdown, a stylesheet bump that silently
re-typeset every book ever compiled. The rules are not style preferences; each one is an outage
that already happened.

Before changing anything that affects typesetting or page breaks, use the `verify-pdf-typography`
skill. Rendering the fixture corpus is the only way to see what a change does — `pdfDocument.test.ts`
asserting a sha256 is the alarm, not the check.

## Reading the source of a cover

Read the cover's source through `coverArtSourceFor` (`coverSource.ts`), never `includeCover`
directly. That resolver is what keeps the quote, the dispatch gate and the handler agreeing, and
what lets rows written before the field existed price identically.

## Tests

Colocated. `pdf.test.ts` skips six cases when poppler-utils (`pdftotext`, `pdfinfo`, `pdffonts`,
`pdftoppm`) are absent; `browserProcess.test.ts` skips on win32; `exportTempSweep.test.ts` skips as
root. Both render test files must call `closeSharedBrowser()` in `afterAll` — a live `Browser`
holds the event loop open and vitest will never exit.

## Index

- [Covers](#covers)
- [PDF typesetting and the render transport](#pdf-typesetting-and-the-render-transport)
- [Export provenance and scratch files](#export-provenance-and-scratch-files)
- [Chapter apparatus](#chapter-apparatus)
- [Library characters](#library-characters)

## Covers

- **Declining the cover buys a designed one, it does not remove the cover.** `includeCover` only
  ever answered "did a model draw this", so `coverArtSourceFor` (`packages/core/src/generation/
  coverSource.ts`) resolves `false` to `"design"`: the book gets a cover from the 50-entry catalog
  in `coverDesigns.ts` for free, picked by `selectCoverDesign` from the title, premise, audience
  and category. **Read the source through that resolver, never `includeCover` directly** — it is
  what keeps the quote, the dispatch gate and the handler agreeing, and what lets rows written
  before the field existed price identically. Only `"none"` means no cover, and only the operator
  console sets it. A design supplies just the *artwork layer*: `renderCoverPng` still typesets the
  real title with the OFL fonts, which is why nothing downstream — the `cover.jpg` path, the PDF
  cover page, the EPUB `cover-image`, the app's `coverImage` — needed a single change. The design's
  own `template` wins over the book type's `coverTemplate`, because a design was authored as a
  whole. `shouldGenerateCharacterReferences` gates on `=== "ai"` for the same reason a designed
  cover writes `costUsd: 0`: neither may spend on a cover nobody was charged for, and a bundled
  cover left unpriced would land in the Costs tab's `unratedCalls` bucket, which means *understated*
  spend.
- **Two things decide whether a cover design reads, and neither is visible in the code.** Each
  template darkens the half its text panel sits in — science and business blacken the *top*,
  kids/fiction/romance the *bottom* — so a motif that centres its subject where the type goes is
  simply invisible; that is what `FOCUS_BY_TEMPLATE` in `coverDesignArtwork.ts` exists for. And
  every mark is seen through that scrim, so painting in `ground` at low opacity disappears. Render
  the catalog with `pnpm covers:preview` and look at the contact sheet before trusting a palette or
  a motif change. Seeding is off the design id, not the project, so re-rendering a book keeps its
  cover.

## PDF typesetting and the render transport

- **The book is typeset against md-to-pdf's stylesheets, but nothing else of md-to-pdf's remains.**
  `generateBookPdf` no longer calls `mdToPdf()`. `pdfDocument.ts` deep-imports its `getHtml` and
  `defaultConfig` (the package has no `exports` map) so the markdown still goes through
  **marked@4.3.0** with `langPrefix: 'hljs '` — rendering it with this repo's own marked@18 instead
  changes heading ids, email mangling and loose/tight list `<p>` wrapping, which moves every page
  break in every book ever compiled. Everything md-to-pdf used to supply by *default* is now pinned
  by hand in `BOOK_PDF_OPTIONS` and `buildBookPdfDocument`: the `30/40/30/20mm` margins,
  `page_media_type: 'screen'`, and the cascade markdown.css → github.css → ours, which
  `RTL_OVERRIDES` in `pdfCss.ts` exists to undo the first sheet of. **The text block is set by
  `pdfCss.ts`, not by those margins** — `bookPdfCss` writes `@page { margin: 20mm 18mm 22mm }`, and
  Chrome honours that over the CDP parameters, so `BOOK_PDF_OPTIONS.margin` is measurably inert
  (identical page count and line width at 30/40/30/20mm, at 1 cm, and omitted). It is pinned for the
  day that `@page` rule is removed, and asserted by equality rather than through a render, because no
  render can see it. The dependency is pinned to an **exact** version and `pdfDocument.test.ts`
  asserts both stylesheets' sha256, because a bump is otherwise a silent re-typeset. When a digest
  fires, render the fixture corpus with `pnpm render:fixtures` (`scripts/render-book-fixtures.ts`,
  seven books covering both directions, CJK, illustrations, a cover and the dense Contents) on each
  side and diff them with `--compare`, which checks `Pages` first;
  byte-comparing PDFs proves nothing, since `/CreationDate`, `/ID` and font-subset ordering differ
  run to run. The old side is rendered by `--baseline <ref>`, never by stashing: it plants a
  throwaway worktree at that ref and copies the *current* harness in, because the change under test
  is routinely the one that adds the corpus, the `render:fixtures` script and the `packages/core`
  exports the harness imports — and because the fixtures are the control, a ref carrying its own
  copy of them would report its text as layout drift. Borrowed `node_modules` are this tree's, so a
  digest that fired *because* the `md-to-pdf` pin moved needs `--install` for the baseline to be
  rendered by the version it is being compared against. A page-count guard only works on **continuous prose**: a fixture with forced
  `page-break` divs pins its own count and reports the same number whatever the stylesheet says.
- **Chrome reads the book off disk; nothing crosses CDP.** The assembled HTML is written to
  `.book-render-<uuid>.html` inside `IMAGE_STORAGE_DIR` and opened with `page.goto('file://…')`, so
  the book's relative asset paths (`projectId/filename`) resolve to the real illustrations exactly as
  they did against md-to-pdf's static server. That is what killed the 174 s and 382 s exports: they
  lived in `addStyleTag`/`addScriptTag`, which take **no timeout**, and a legacy illustrated book
  shipped a ~27 MB `JSON.stringify`'d image map through one. Fonts must stay `data:` URIs — a
  `file://` `@font-face` src from a `file://` document is blocked by Chrome's opaque-origin rules.
  The temp file is not web-reachable: `/assets/images/:projectId/:filename` is a two-segment param
  route, not a static mount.
  **What that transport costs is the origin's protection, so the renderer carries an allowlist.**
  A page opened from `file://` may load `file://` subresources, and a manuscript is user text —
  imports arrive as raw prose, an exact-replacement edit writes literal text into a page, and
  markdown passes raw HTML through. `<iframe src="file:///etc/passwd">` in chapter one printed the
  server's password file into the exported PDF, reproducibly, and `/proc/self/environ` would have
  printed its provider keys; the HTTP-origin renderer this replaced refused that for free.
  `renderResourcePolicy.ts` intercepts every request the render makes and permits four things: the
  document this render wrote, `data:` (the fonts), `about:blank`, and non-dot files under the
  compiled project's own image directory — which is why `generateBookPdf` now takes a `projectId`,
  standing in for the `sendOwnedProjectAsset` check the file transport dropped. Everything else is
  aborted, **including `http(s)`**: an iframe of `169.254.169.254` prints the instance's cloud
  credentials the same way, and no legitimate book resource is remote. Interception covers
  navigations, frames, images, CSS `url()` and anything a script starts later, which is why it is
  the control and `stripEmbeddedDocuments` (`pdfDocument.ts`, which deletes
  `iframe`/`object`/`embed`/`frame`/`script`/`link`/`base`/`meta http-equiv` from the assembled
  HTML) is only the second lock. That strip runs on the *rendered* HTML, never the markdown, so a
  book about HTML keeps its `<iframe>` examples — marked has already escaped everything in a code
  fence by then. It is verified by rendering the seven-book fixture corpus with the policy off and
  on and diffing: pixel-identical, so the allowlist refuses nothing a real book asks for.
  **The same disclosure had a second door in the EPUB.** Both exports turn
  `/assets/images/<projectId>/<filename>` into a path on disk, and they did it with a copy of the
  resolver each; the filename group matches slashes, and only the PDF's copy checked containment, so
  `![x](/assets/images/p/../../../../etc/passwd)` packaged a server file into the reader's download.
  There is now one `resolveBookImageAsset` (`bookImageAssets.ts`), which decodes before it resolves
  (`%2F..%2F` is a separator) and returns null unless the result is exactly
  `<IMAGE_STORAGE_DIR>/<projectId>/<filename>` — the shape the HTTP route serves.
  **`<projectId>` there means *this* book's, which is a second option and not a wildcard.** Storage
  is shared, so containment only ever said "some project's illustration": a manuscript naming
  `/assets/images/<another-project>/page-3.png` — and manuscripts are user text — read another
  reader's artwork out of it. The PDF survived that by accident, because the renderer's
  `assetRoot` allowlist is already scoped to the compiled project; the EPUB reads the file itself
  and packaged it into the download, with no renderer anywhere to refuse it. So the resolver takes
  an optional `projectId` and compares it against the *resolved* first segment (after decoding, so
  `proj-1/..%2Fproj-2` is `proj-2`), `generateBookEpub` and `generateBookPdf` both pass theirs, and
  the PDF's markdown rewrite refuses what its renderer would have aborted anyway. Omitting it keeps
  the whole storage directory in scope, which is only right for a book belonging to no project —
  `scripts/render-book-fixtures.ts`.
- **One Chromium, many pages — and the reset paths are the point.** `browserPool.ts` is the only
  place that launches a browser (`generateBookPdf` and `renderCoverPng` both go through
  `withRenderPage`). It holds a `Promise<Browser>`, not a `Browser`, and clears it on `disconnected`
  *and* on launch rejection under a **generation counter**, so a stale event cannot evict a newer
  browser. The semaphore is **2**, deliberately below worker concurrency
  (`max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)`, 4 by default, env-tunable to 32, with no
  separate compile lane) — four large books in one Chromium is an OOM that takes all four down.
  Recycling after 50 renders **retires** the browser rather than closing it: it stops handing out
  pages and closes once its own last page comes back. Closing inline is only possible when no other
  render is in flight, and with the semaphore at 2 a busy worker always has one — so a close-now rule
  fires only when the pool is idle, which is exactly when recycling does not matter. That is why the
  count lives on the lease and not in a global.
  A disconnect is retried **once, inside `withRenderPage`**, so both callers get it: sharing a
  browser is what turned one crash from "fails the job that owned it" into "fails every render in
  flight", and the cover is where that bites hardest — `renderCoverPng` runs *outside*
  `generateCover`'s artwork fallback, and `GENERATE_COVER` is not in `DERIVATIVE_GENERATION_JOBS`, so
  an unretried disconnect there marks a finished, fully paid book FAILED and refunds
  `FULL_BOOK_GENERATION` because some unrelated compile crashed Chromium. One retry is the whole
  budget — `compile-export` gets no BullMQ-level retry, which would re-run final QA and re-spend real
  credits — and it is skipped when `closeSharedBrowser()` was what took the browser away, or a
  shutdown would launch a replacement and hold the process open. A watchdog timeout is not
  disconnect-shaped and is never retried. Anything passed to `withRenderPage` must therefore be safe
  to run twice. "Disconnect-shaped" means **`TargetCloseError` and nothing else**: puppeteer throws
  that from every path where the far end went away, and its parent `ProtocolError` is the generic CDP
  failure — including the protocol *timeout*, which would pay its whole budget twice. Matching the
  parent covered no case the child did not.
  **A render is leased a browser context, not a page, because the page is not what the manuscript
  is confined to.** `stripEmbeddedDocuments` deletes `<script>` but not the `onerror` on an `<img>`
  whose source `renderResourcePolicy` just refused — that handler is script a manuscript gets to
  run, and one `window.open` from it was a page the pool never leased, never counted against the
  semaphore and never closed. Verified surviving into later renders, still fetching, with no
  interception on it: interception is installed per page, so a page the document opened for itself
  has none. `renderOnce` therefore closes the whole `BrowserContext`, which takes the popups, the
  workers and the storage with it, and `discardStrayTargets` closes any target the content opens on
  sight — watching the *context*, so a popup opened by a popup is caught too, and so a
  `setInterval(window.open)` cannot pile up tabs for the watchdog's whole 90 seconds. What neither
  can stop is the *first* request of each opened window: Chrome reports a target once it exists, by
  which time its navigation is on the wire (`--block-new-web-contents` does not refuse it —
  measured). Closing that needs the document unable to run script at all, i.e. stripping inline
  `on*` handlers in `pdfDocument.ts`.
  Every close is **once and bounded**: a wedged renderer's `close()` never settles, so a
  second attempt would hang the exact case the watchdog exists to unstick. The outcome is acted on
  rather than discarded, and `"failed"` is not `"timeout"` — a rejected close means the target was
  already gone, while one that never settles is a renderer still holding a process. The latter
  **retires** the browser on *every* path, success included: ignoring it on the success path leaked
  pages into a long-lived Chromium (the pool's own accounting said they were gone) for up to fifty
  renders. Retiring rather than closing outright is what reclaims them without failing every render
  sharing that browser.
  **Retiring is a promise to reclaim, so a lease outlives every close it is waiting on.** The
  browser's own `close()` is no more bounded than the context's — puppeteer's CDP path sends
  `Browser.close` and then awaits the process's `exit` event with no deadline of its own — so
  dropping the lease and fire-and-forgetting that promise left a Chromium nothing in the process
  had a handle on: invisible to the idle sweep, to `closeSharedBrowser()`, and to anyone reading
  the code, but not to the container's memory. A lease is now `live`, `retired` or `closing` and
  leaves `leases` only when its reclaim settles, which is bounded end to end: five seconds for
  `close()`, then `terminateBrowserProcess` (`browserProcess.ts`) SIGKILLs the process *group*,
  then two seconds for the exit. The group — the negative pid — is what takes the renderers and
  the zygote with it, and it cannot name this process's own group by accident, because a group id
  is always its leader's pid and that pid belongs to our child. The exit check before it is the
  safety property, not an optimisation: a pid is ours only until Node reaps it, which is exactly
  when `exitCode`/`signalCode` stop being null. What survives even that is recorded rather than
  forgotten — `browserPoolStatus().abandonedProcesses`, which both `shutdown()`s log, and which a
  process that finally dies drops off. `closeSharedBrowser()`
  is wired into both apps' `shutdown()`, both render test files' `afterAll`, and `pnpm covers:preview`
  — a live `Browser` holds the event loop open, so without it vitest never exits. It is bounded for
  the same reason it is awaited in a signal handler: one wedged renderer used to hang the shutdown
  that was supposed to release it, until the supervisor's own SIGKILL left that Chromium reparented
  to init. Never `browser.process()?.unref()`; that orphans Chromium — killing it is the opposite,
  and the only thing that reclaims one. Production reaps it with tini
  (`ENTRYPOINT`), dev with compose `init: true`, because PID 1 is a shell that does not reap — and
  budget **two** pooled browsers in production, one per process.
  **Trapping SIGHUP is part of that wiring, not housekeeping.** Puppeteer's own handlers are off,
  so its only remaining net is an unconditional `process.on("exit")` — which a signal Node does not
  handle never reaches. A hangup (a closed terminal, an `ssh` drop, systemd reload) used to kill the
  API or worker mid-flight and leave Chromium alive, reparented to init and reaped by nobody, so
  both entry points and `scripts/start-production.sh` trap `HUP` alongside `INT`/`TERM`. Registering
  a third signal is also why the two `shutdown()`s are now once-only: a hangup is routinely followed
  by a TERM from the same supervisor. `scripts/tsx-dev.mjs` forwards a hangup as **SIGTERM**,
  because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans the app holding
  the browser.

- **The page map is measured from the published PDF's own bytes, and measuring must move nothing.**
  The numbers a reader can see — the pdfrx indicator, the printed footer, the Contents column — are
  physical PDF pages, and nothing about a model page says where it lands: pages join on a single
  newline, so adjacent pages routinely share one paragraph. `compileBookMarkdownWithPageAnchors`
  therefore returns, beside the byte-identical `book.md`, one destination name per model page — the
  existing `chapter-N` for a chapter opener, `bp-N` plus a markdown offset otherwise — and the PDF
  render injects markers into **its own copy only** (`pdfPageAnchors.ts`): an empty inline
  `<span id>` glued to plain content, an HTML comment line before block syntax, a span *inside* a
  quote or list line when one container straddles the boundary — and no marker at all inside a
  straddling table, where a comment ejects the following rows as pipe text and a span shifts the
  cells, so that page stays unanchored and the whole map fails soft instead. Each shape is measured
  against marked@4.3.0 to leave the rendered blocks identical, and manuscript-authored `bp-*` ids
  are renamed at equal byte length so user text cannot point a destination somewhere else.
  **`chapter-*` needs the same guard and cannot take the same shortcut, because the compiler writes
  those ids itself.** Chrome resolves a link against the first element wearing a name, so a page that
  merely *reads* like a chapter opener outranks the real one — and that misplaces the Contents link,
  the number rewritten into its row and the reader's fallback outline as well as the map, since
  `buildBookPdfPageMap` only refuses a *decreasing* run of anchors and a stolen destination landing
  in order still yields a full map of the wrong pages. A manuscript reaches the name two ways, so
  there are two renames. In the markdown, `<a id="chapter-2"></a>` is what an author writes for a
  chapter of their own — markdown has no attribute syntax and it is the name anyone would pick, which
  is why the compiler picked it too; nothing in the bytes tells the two apart, so
  `compileBookMarkdownWithPageAnchors` records `existingIdOffset` for each anchor it writes,
  `chapterAnchorMarkup` is the shape both sides agree on, and every *other* tag holding the name is
  renamed — never one inside a fenced block, where it is printed as code rather than rendered. If a
  single recorded offset does not hold its anchor, **nothing** is renamed: a chapter that lost its id
  takes its Contents link with it, which is worse than a stolen destination. After the render,
  `neutralizeRenderedReservedIds` catches what no offset could — `## Chapter 2` is handed
  `id="chapter-2"` by marked's own slugger, an id that exists on neither side of the markdown — and
  renames every reserved id except the renderer's own two marks, the compiled `<a id="chapter-N"></a>`
  (recognised by the heading that must follow it) and the injected empty `<span>`. Names match
  *whole*, so a heading slugging to `chapter-2-the-return` keeps its id and the links to it.
  `placeBookPageAnchorIds` then moves
  every marker onto a box with extent (the following block, the following inline element, the first word), because a
  zero-height marker at a fragmentation boundary lands its destination a page early — the same
  incident `liftChapterAnchorsOntoHeadings` exists for. A `display:none` nav of internal links
  makes Skia emit `/Dests` at all (ids alone emit nothing; hidden links add no annotations, no
  layout — measured). `extractPdfNamedDestinations` (`pdfPageMap.ts`) reads the names back out of
  the rendered bytes through the classic xref, and `buildBookPdfPageMap` turns starts into
  inclusive ranges, deciding shared boundary pages by the anchor's y against the top-margin band.
  **Failure anywhere returns `undefined`, and no compile may fail, publish differently, or retry
  over the map** — a book without one simply keeps the old model-index chat behaviour. When the
  book prints a Contents, its rows' numbers — which the markdown could only write as model indexes
  — are rewritten to the measured chapter pages and the document rendered once more, re-measured,
  and re-checked once: the printed column and the footer now count the same pages. **Replacing
  `book.pdf` without that measured pass must clear the column.** A detached repair whose
  recompile does not byte-match the published `book.md` renders those published bytes with no
  plan — no markers, no Contents reprint — and the reprint exists because digit width moves
  breaks, so "same manuscript" is not the same pagination. A stale map mistranslates chat
  targets onto the unreprinted file; no map is the graceful path the failure rule already
  names. Keep anchor ids
  ASCII `[a-z0-9-]` (PDF name escaping never applies) and keep the injection out of `book.md`,
  whose bytes are the provenance sha, the EPUB input and the reader-chapter fingerprint.

## Export provenance and scratch files

- **A download says which compile answered it, because the URL cannot.** Every compile of a book is
  published over `book.pdf`, so the availability descriptor the app fetched with is a claim about
  what that URL held when the status was read — and the download most likely to be answered by a
  *newer* compile is the retry after an `EXPORT_NOT_READY`, which is the app being told a compile is
  landing. The app files those bytes under a `contentRevision` three times over (the reader cache,
  the "your edits are in" banner, every highlight and bookmark it stamps), so a stale descriptor made
  all three agree on the wrong book. Sizes cannot separate them: a presentation reprint, a re-applied
  edit and an undo all produce a book of exactly the same length. So every publication records the
  sha256 of what it installed beside it (`book.pdf.provenance.json`), under the revision it claimed
  — `publishCompiledExports` in the worker and `publishRebuiltExport` in the API, both inside the
  transaction that already holds the row lock, after the renames, and never fatally: a book on disk
  must not be failed and refunded because a hundred bytes of metadata could not be written.
  `readPublishedExport` (`packages/core/src/generation/exportProvenance.ts`) then resolves the bytes
  it read against that record and the mobile route answers with `X-Export-Provenance` and
  `X-Export-Content-Revision`. **The record is read on both sides of the file read**, because a
  publication landing in between moves the file and the record independently as far as the reader is
  concerned; a digest identifies one file, so either read may confirm, and only when neither does is
  the read tried again. **Nothing consults the project row to label bytes** — a row read after a file
  read describes whatever compile is current now, which is the same mistake one layer down, and an
  edit moves the row minutes before the compile that publishes for it.
**Every scratch name in that scheme is built in one module, and swept by age from the same one.**
A publication renders to `.book-<uuid>.{md,pdf,epub}`, parks each predecessor at
`.book-superseded-<uuid>.<ext>` while it moves in, and a PDF render writes `.book-render-<uuid>.html`
into the image store; every one of them is removed by a `finally`, which covers a thrown render, a
lost claim and a failed publication — and covers nothing at all when the process does not get to
run it. A SIGKILL, an OOM kill or an evicted container leaves the file for as long as the volume
lives, invisible until storage fills. `exportTempSweep.ts` (`packages/core`) both *names* them —
`pendingExportTempPath`, `supersededExportToken`, `renderDocumentTempPath`, used by
`exportPublication.ts`, `pdf.ts` and the API's inline rebuild — and collects them, because a writer
whose name drifts out of the sweep's pattern strands files nothing recognises and nothing fails.
The collection is **age-based only, never a startup wipe**: a rolling deploy runs two workers, the
API renders into the same project directories, and `make up` and `pnpm dev` share one storage
directory, so "this process just started, therefore nothing here is live" is false in every
deployment here. Quiet time is the only signal, which is why the minimum age is clamped up to
`EXPORT_TEMP_MIN_AGE_FLOOR_MS` whatever the config says and defaults to six hours against a window
that is really seconds — the file is written and published back to back. Nothing else is a
candidate: the patterns demand the prefix, the literal `randomUUID()` token shape and the writer's
extension, and the scan requires a regular file at both the dirent and an `lstat` and removes it
with `unlink`, so a symlink wearing a scratch name is skipped rather than followed. The timestamp
is read **twice**, on either side of a decision the whole directory scan could otherwise sit in,
and `ctime` counts alongside `mtime` because a writer can backdate one and not the other; ENOENT is
not an error but the other end of the race working. `startExportTempCleanup`
(`apps/worker/src/runtime/`) is the only thing that runs it — one collector reaches every orphan
because the volume is shared, and the sweep is age-based rather than ownership-based precisely so
it can clean up after the *other* process. It is bounded (an entry budget, a per-root cap and a
resume cursor) and single-flight, and `shutdown()` stops it **before** `worker.close()`: a scan
holds an open directory handle and has no job to finish, so it is cancelled through the signal it
checks between entries and awaited, rather than left running into `prisma.$disconnect()`.

## Chapter apparatus

- **A book only earns the word "Chapter" by being long enough to need it.** The planner is told to
  make its chapter targets sum to exactly `targetPages`, so a three-page book gets three one-page
  chapters — a good *writing* scaffold, three distinct beats, and an absurd thing to print as
  "Chapter 1" over three paragraphs plus a Contents page costing a quarter of the PDF.
  `chapterPresentationFor` (`packages/core/src/generation/markdown.ts`) sizes the apparatus to the
  finished book instead: `chapters` (numbered headings + Contents), `sections` (the titles alone,
  no Contents — the default style becomes `title_only`), or `none`. Read it off the partition that
  is *about to be printed*, never off `plan.chapters`, which is why one test now covers both the
  plan's chapters and model-written reader chapters — the plan-side guard it replaced had a floor
  of four chapters, so a three-page book cut into three could never trip it. An explicit
  `mediaSettings.chapterHeadingStyle` still outranks all of this; only the default is sized.
  The narrator asks the same question through `narratedChapterLabel`
  (`apps/worker/src/handlers/generateAudiobookSupport.ts`) and drops the spoken label — but it must
  never re-partition, because `chapter-<n>.mp3` and the READY-skip that resumes a failed narration
  are keyed on chapter index.

## Library characters

- **A library character reaches a book by copy and by name, never by foreign key.** The
  account-wide `LibraryCharacter` table is the user's; at build time the active branch's
  @-mentions are snapshotted into `mediaSettings.mobile.characters`
  (`libraryCharacterSnapshotsForBuild` in `apps/api/src/mobile/creationBuild.ts`), and everything
  downstream — the planner guidance in `planner.ts`, the prompt block in
  `composeMobileProjectPrompt`, the reference-sheet seeding — reads that copy off the input
  snapshot. The plan schema strips unknown keys, so the **verbatim name** is the only link from a
  plan character back to its portrait: `matchLibraryCharacter`
  (`packages/core/src/generation/libraryCharacters.ts`) tries folded exact equality then
  **whole-token** containment, and a rename by the planner degrades to an unseeded sheet, never an
  error. Both halves of that are scars. Everything is compared through `foldCharacterName` (NFD
  then strip marks, drop ZWNJ/ZWJ/bidi, fold Arabic kaf/yeh onto Persian, fold Arabic-Indic
  digits) because a Persian name saved from one keyboard and echoed by a model trained on the
  other was two different names; and containment is whole-token because sub-token matching put one
  reader's saved face on a character they never saved — `Sam` seeded `Sam's Mother`, `Luna` seeded
  `Luna-Bear`, and ZWNJ is category `Cf`, so the old `[^\p{L}\p{N}]` boundary read `علی‌رضا` as a
  word break and matched a library `علی`. An **ambiguous** containment resolves to null: a missing
  seed is a character drawn from prose, a wrong one is a stranger wearing the reader's face, and
  only one of those is recoverable by reading the book. Deleting
  a character deletes rows and files but no book state; a seeding pass that finds the portrait
  file gone skips it silently, which is the deletion-safety valve. Character files live at
  `IMAGE_STORAGE_DIR/characters/<userId>/` — never swept, unreachable from the project asset
  route and the render allowlist — and every path to them resolves through
  `libraryCharacterDiskPath`, which returns null for anything but exactly `<userId>/<fileName>`.
- **A character's look lives in pixels, so it has to be written down or the planner invents one.**
  `LibraryCharacter.description` is who the character is — free text the reader writes, routinely
  carrying no appearance at all ("she's a great wife and future mother") — while what they *look
  like* existed only in the portrait, which the planner is a text model and never sees. Told to
  reuse a character it could not picture, it invented a look, wrote it into
  `illustrationPlan.characterReferencePrompts` and every page prompt, and **that text beat the
  reference images attached beside it**: a woman in a black hijab was rendered as a bare-headed
  child in a ponytail, on a page whose prompt did not even use her name. So there is an
  `appearance` column, read off the picture by the same bounded vision call the photo upload
  already makes, snapshotted beside the name, and printed by `libraryCharacterPromptBlock` as its
  own labelled line under its own budget — truncating a look is not a shorter sentence, it is a
  licence to finish the outfit. `libraryCharacterAppearanceRule` then says the only two honest
  things: with an appearance recorded, reuse it word for word; **without** one, write no hair,
  age, build, headwear or clothing anywhere and refer to the character by name only, because the
  picture is attached to the image calls and invisible to the writer. "Invent something
  consistent" is the instruction that caused this.
- **Nothing used to check that the planner obeyed, and now one pass does.**
  `reconcilePlanLibraryCharacters` (`packages/core/src/generation/planLibraryCharacters.ts`) runs
  after **every** plan parse — `createPlanningPackage` and `revisePlanningPackage` both — and
  renames a matched character back to the verbatim name, restores the library's own description
  over the schema placeholder (`"Recurring character in the plan."`, `schemas/plan.ts`), sets
  `visualRules` from the recorded appearance or leaves them empty, re-appends a snapshot character
  the plan dropped, and collapses two entries that resolve to one snapshot. It is what turns
  translation, rename, near-duplicate and invented-twin from silent wrong output into a no-op.
  Revision needed it most: `mobileLibraryCharacterGuidance` was called from the initial planner
  **only**, and `revisePlanningPackage` serialized no `userInput` and no `mediaSettings` at all, so
  any "make it shorter" after approval re-decided the saved character against nothing. Arrays merge
  as atomic replacements, so whatever came back won.
