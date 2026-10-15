# Projects feature

The largest feature in the app (83 files, ~27k lines): the projects home, the creation chat, the
book screen, the project chat, and the plan surfaces. Layered `data/` → `domain/` → `presentation/`
like every other feature.

`data/` is deliberately thin — `projects_repository.dart`, `creation_repository.dart`,
`export_repair_watch.dart`, `creation_prefs_store.dart`, `offline_library_store.dart`. Riverpod providers live inside those
repository files rather than in a `providers.dart`, so grep for `Provider =` rather than looking
for a file.

## One book is one page

There are no dead-end screens here: never a screen whose only content is a button to the real one.
A book gets a single page whose shape follows its state.

## Watching for a missing export

**That budget belongs to the book, not to the screen, or it is no budget at all.** Watching a
settled book with no PDF is what *queues* the repair, so the watch is a cost: every five-minute
window a watcher is still awake for buys another whole Chromium compile of the same manuscript.
`projectStatusProvider` is `autoDispose` and is rebuilt constantly — the saved-export card
invalidates it every four seconds, the reader on open, the book screen on every edit — so a budget
owned by that stream was handed back in full several times a minute, and its three-second poll ran
for as long as a screen was open. `exportRepairWatchProvider`
(`apps/mobile/lib/features/projects/data/export_repair_watch.dart`) holds one
`ExportRepairWatchBudget` per project *outside* it, deliberately not `autoDispose`, and meters only
the settled-with-no-PDF case: two minutes of watching by wall clock, then five minutes of standing
down, so one "preparing" episode is one repair. Wall clock rather than a poll count, because the
stream half is metered by the same budget and an SSE connection a proxy never closes ticks far
faster than the poll. Standing down never blanks a screen — a rebuilt stream still reads and yields
a status, it just does not start a poll loop — a live book is never metered, and a PDF that was on
disk a moment ago and is gone now is an edit's rebuild, which gets the whole allowance however the
last wait ended. The saved-export card keeps its own allowance because it also watches the EPUB,
which the shared watch deliberately does not. The Word file joins the wait the same way the EPUB
does — only after a download of it was refused `EXPORT_NOT_READY` (`noteExportRequested`), never
on sight — and a status that offers no Word file at all is never awaited for one. A `SUBSCRIPTION_REQUIRED`
refusal is neither: the shared failure reporter opens the paywall and touches no watch, because
nothing is coming.

## The status watch

- **A transient failure never ends the status watch.** `watchProjectStatusWithFallback`
  (`data/project_status_watch.dart`) follows the event stream, then polls; a failed read backs off
  (3, 3, 6, 12, 24, 30 s) and keeps asking, and the screen keeps the last status it had. Before
  2026-10-13 a throw ended the stream, Riverpod's own retry gave up after ~38 s, and live progress
  froze for the rest of the visit. Only before the first status is a failure reported (so a screen
  with nothing can say why), and the watch carries on behind that error. A refusal (4xx, a
  `TypeError` from a changed payload) still ends it.
- **An event stream that broke is reopened; one the server closed is not.** A timeout (45 s with no
  byte, `statusStreamIdleTimeout`), a lost connection or `STATUS_STREAM_SESSION_ENDED` reopens it
  once a poll answers; `STATUS_STREAM_REPLACED`, a clean close while live, or a refusal leaves the
  watch on polling. Three streams in a row that die empty stop being reopened.
- **The watch and the event stream are controllers, never `async*` loops.** A generator waiting
  inside `await for` sees a cancel only at its next `yield`; a status provider disposed between
  events kept its socket — and one of the account's three stream seats — until the server next
  sent a status, which with change-only events and `: ping` comments can be minutes.
- **Back in the foreground, a live or status-less watch is reopened.** `projectStatusProvider`
  listens to `appResumesProvider` (fed by `AppResumeSignal`, started in `main`); a settled book's
  finished watch is left alone.
- **`MobileProjectStatus` compares by its payload.** Two statuses decoded from the same JSON are
  `==`, so a resent status notifies no one and the creation chat no longer rebuilds its transcript
  once a second. A status built in code has no payload and keeps identity.
- **`PollingStateMixin` holds its timer while nobody can see it** — under a pushed route (its
  `TickerMode` is off) or with the app in the background — and reads once at once on return.
  `isPolling` stays true while held.

## The library offline

- **What the phone keeps for being offline is what the server sent, and only the signed-in
  account's.** An offline cold start opens with the account the phone holds (`apps/mobile/CLAUDE.md`,
  "Sessions"), but the library and every book's status lived only in memory, so a reader on a plane
  could reach none of the books and narrations already downloaded (launch review, 2026-10-13).
  `OfflineLibraryStore` (`data/offline_library_store.dart`, files under `tomeza_offline/`) keeps
  the last library `projectsProvider` read and, per book, the last status `projectStatusProvider`
  read that offers a PDF — the descriptor the reader opens a downloaded file against. Both are
  written as the server's own JSON (`MobileProjectSummary.payload`, `MobileProjectStatus.payload`)
  and read back by the same parsers, never rebuilt from fields; a status is rewritten only when the
  PDF it names changes (revision, size, URL, page-map digest), not on every progress step.
  `AuthController._forgetAccount` clears it on every logout and lost session, so the account an
  offline start opens is the one these files are about, and `epoch` fences writes the old account
  still had in flight. A deleted book's status goes with it (`forgetProject`). Every method
  swallows its own failures: the copy is a convenience, never a failure an online screen shows.
- **Offline is the server out of reach, never a server error.** `isOfflineFailure` is
  `NETWORK_ERROR` or a gateway's 502/503/504 — narrower than the session restore's
  `cannotReachServer` (any 5xx), because here the answer decides whether a screen says "you're
  offline". A 500 is reported as before. On such a failure `projectsProvider` answers with the
  kept library and records when it was saved in `OfflineLibraryMarker` (a plain object, like
  `ProjectSnapshotCache`, because the list's type is shared by every screen that shows a book).
  The library then shows `OfflineLibraryNotice` ("You're offline", as of when, and Try again),
  polls every 30 s to reconnect instead of at a live book's pace, and a book that was running when
  the copy was saved says "Last seen being written" with no percentage and no moving bar — the
  copy's progress is a memory, never shown as work happening now. A downloaded book still opens
  straight into the reader. `test/projects/offline_library_test.dart`,
  `test/projects/offline_library_screen_test.dart`, `test/auth/offline_library_sign_out_test.dart`.

## Waiting for the long lane

- **A waiting book is told how many books are ahead of it, counted in the order the long lane
  really runs.** The server sends a count (`waitingInLine.booksAhead`, read into
  `MobileProjectStatus.booksAheadInLine`) and the words are the app's — `waitingInLineLabel`:
  "Waiting in line — 2 books ahead of yours", "Starting soon" at zero, nothing when the book is
  not waiting. `WaitingInLineNote` draws it under the book's progress (`GenerationProgressOverviewCard`
  on the book page, `ChatOperationProgressCard` in the chat) as a calm line, never a notice:
  nothing is wrong and nothing needs doing. It moves on its own — the hourglass turns over every
  few seconds and a new count rises into place — because a book sitting at 0% with a still line
  reads as stuck. The counting rule is the server's (`apps/api/src/mobile/CLAUDE.md`). A refusal to
  start one more book than the account may have (`BOOKS_IN_PROGRESS_LIMIT`) needs nothing here:
  every door shows the server's sentence through `userFacingError`.

## Quoting credits in the app

The Effort picker quotes the **plan now** and a **writing rate**, not one blended total
(`estimatePlanGenerationCredits` and `_writingCreditsPerPage` in `creation_chat_sheets.dart`):
planning is charged when Build starts, the page count is still "auto" while a reader is choosing
effort, and images are a separate switch priced per image (`_imageCredits`). Folding any of
those together would make one number answer for independent choices. The Build button itself
does not show that planning price; Account, Terms, and Effort settings do. The writing rate is the
whole quote for a book with *no* generated images divided by its pages, so the rates still
compare the way the later approval bill will.
The app **re-implements both formulas in Dart** (`estimatePlanGenerationCredits` and
`estimateProjectCredits` in `project_models.dart`, which mirror `planGenerationCreditCost` and
`tierPrice` in `tierCreditRate`, `domain/credit_rates.dart`) and there is no server quote route to fall back on, so the two
must move together — which is why both sides spell their totals out in tests rather than
deriving them from the price table. The app picks its tier off the project DTO's
`qualityPreset`, which `qualityPresetForProject` fills in from the tier when the mobile echo is
missing; do not add a `modelTier` field beside it, because the mobile responses' leak guard
rejects any wire key containing "model".

**A book's quote carries no export line, for anyone.** A book is one charge, taken at plan
approval, and once it is written its files download free (2026-10-15). Until then a paid reader's
quote carried the 150-credit export unlock and a free reader's did not (`exportUnlockIncluded`,
`bookPriceIncludesExportUnlock`); both are gone, and `estimateProjectCredits` mirrors core's
`estimateFullBookCreditCost`, which has no `EXPORT_UNLOCK` line at all. The server still sends
`creditCosts.exportUnlock` (as 0) and the app never reads it, so even a price list that stored 150
adds nothing. A children's story is a picture book, quoted `pictureBookIllustrationCount` pictures
(`min(pages, 12)`: a picture on every page, never past 12) and described that way in the
illustrations switch. `book_quote_test.dart` spells the totals out against core's
`freeBookQuote.test.ts`.

## Taking a book's file out

- **A written book's PDF and EPUB open, share and download in one tap; only the Word file keeps a
  lock, and it is a plan's, never credits.** There used to be a per-book export unlock: every
  surface that took a file out asked "Unlock for 150 credits?", a free reader met an offer sheet of
  plans beside a one-book credit unlock, and a short balance opened the credits paywall — on the
  book page, the actions menu, the saved-export card, the reader (an older server served it through
  the download route) and the share sheet's full share. That unlock is gone (2026-10-15), and so is
  every flow behind it (`confirmProjectExportUnlock`, `offerProjectExportUnlock`,
  `BillingExportCreditUnlock`, the reader's "Unlock to read"). `MobileExportAvailability` no
  longer reads `unlocked`, `creditsRequired` or `planIncludesUnlock`, which the server still sends
  as `true`/`0`/`false` for installed builds, and `BookShareBook` no longer reads `exportUnlocked`
  or `exportUnlockCredits`; a share request no longer sends `acceptExportUnlock`. So nothing can
  draw a lock or a price on a PDF or EPUB, whatever an older server says. The Word file is the one
  format gate (`requiresSubscription`): a free account sees it locked, and a tap opens the plan
  offer (`openProjectExportPlanOffer`, the export offer sheet with plans only); the server's 403
  `SUBSCRIPTION_REQUIRED` on the download opens the same offer. `export_direct_download_test.dart`
  feeds the old locked fields and taps straight through; `reader_no_lock_test.dart` opens a book an
  older server calls locked.
- **A free reader's first finished book is offered a plan once, unasked.** The book page calls
  `offerPlanForFirstBook` (`first_book_offer.dart`) after the frame its status first reads complete:
  only for a book Tomeza wrote, only to an account with no plan, and only the first time on this
  phone for that account (`FirstBookOfferStore`, a device-local file keyed by the billing payload's
  `purchaseAccountId`, marked before the sheet opens and read as "shown" when it cannot be read).
  The sheet (`BillingFirstBookOffer`) celebrates the book, lists what a plan adds, offers the plans
  through the paywall's own purchase lifecycle (trigger `first_book`), and "Keep reading for free"
  leads back to the book. What a plan adds is what a plan really adds — monthly credits, longer
  books, no monthly cap on illustrated books, the Word file, voice calls and audiobooks — never
  downloads, which every book has. `first_book_offer_test.dart`.

## The creation chat

- **The Flutter creation chat screen is one library split with `part` files**
  (`creation_chat_screen.dart` plus `creation_chat_*.dart`). Part files have no imports of their
  own; add imports to the parent. This keeps the `_Private` widgets private. The @-mention
  affordance (`creation_chat_mentions.dart`) derives its state from the composer text alone —
  clearing the composer clears the mentions — and one strip serves both chat stages because the
  composer does.
- **Two operator switches bound a new book, and both ride the billing payload.**
  `paidMaxBookPages` is the longest book any plan writes: past it nothing is offered — the page
  presets, the page-count sheet's options and a typed count all stop there, and a length the chat
  settled on past it is offered at the ceiling before Build charges anything. It is never a lock,
  because no plan unlocks it; the server's `BOOK_LENGTH_UNAVAILABLE` is a sentence, not the
  long-book offer (`pageLimitFromError` keys on `PAGE_LIMIT_EXCEEDED`). Lengths between the free cap
  and the ceiling keep the lock and the long-book offer. `ultraTierEnabled` false hides Ultra from
  the Effort picker (`qualityPresetOptionsFor`), and a carried-over Ultra choice (a remix, a draft
  made while it was on) is built at Extra polish (`startableQualityPreset`); an existing book's tier
  is never rewritten. Unknown billing hides nothing — an older server sends neither switch and the
  server rules on the request anyway (422 `QUALITY_TIER_UNAVAILABLE`). Build awaits billing rather
  than peeking, since nothing on that screen has to be watching it.

## Chat bubbles are light markdown

**A chat reply is light markdown on both sides of the wire, and neither side may forget the other.**
Every assistant bubble — the creation interview, the post-generation book chat and the
project chat — goes through `ChatMessageText` (`presentation/chat_message_text.dart`). The
prompts that write those replies (`creationTurnMessages` in `apps/api/src/mobileCreation.ts`,
the grounded answer in `apps/api/src/mobile/groundedAnswer.ts`) ask for **bold**, numbered
and bulleted lists, and a blank line between paragraphs. The parser in
`domain/chat_markdown.dart` also renders italic, headings, quotes, fenced code, `http(s)`
links and the server's `[source:…]` citation tokens — research-fallback summaries arrive
as real markdown, and a model may emit extra constructs. A prompt that forgets the markup
makes the model number lists by hand, and a bubble that draws a plain `Text` shows the
asterisks. A user's own message is drawn verbatim (`markdown: false`) — people type asterisks.

Two chat-shaped rules differ from CommonMark on purpose: a newline inside a paragraph is a line
break, because the deterministic server messages use newlines that way; and a flush-left line
after a list item is a new paragraph, not a lazy continuation, because "9. Falklands War\nCasualty
figures are…" is a list and then a sentence. Whatever the parser does not recognise stays
literal, so an unbalanced `**` or a `_` inside a title is shown rather than eaten. **The parser
has no escape syntax** — a backslash prints as a backslash — so the server keeps reader text it
quotes literal with invisible marks instead (`chatMarkdownLiteral` in
`apps/api/src/chatMarkdownLiteral.ts`): U+FEFF either side of every `*` and `_`, which both
parsers' `trim` treat as space so no emphasis opens, and U+2060 after every bracket and before a
line that would open a block. A change to the emphasis or block rules has to keep those working,
and both plain-text twins drop the two marks, so a copy or a preview carries none.

Wherever a message is shown as *text* rather than a bubble — the reply quote
(`ChatReplyTarget.from`), the long-press Copy, the drawer's one-line preview and the reply
excerpt the server stores (`chatMessagePlainText` in `apps/api/src/chatMessagePlainText.ts`) —
assistant markup is stripped first, keeping list markers so a quoted list still reads as one;
a user's own text stays as typed. The bubble is also laid out in the direction of the
message's first strong character (`chatTextDirection`), so a Persian reply in an English UI
reads from the right with its list markers on the right.
