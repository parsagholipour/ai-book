# Mobile API

Everything under `/api/mobile` — the surface the Flutter app uses. This is the product; the
operator API in `../routes/` is not.

It is also the largest directory in the repo (115 files, ~39k lines, 60% of the API), so the
invariants below are grouped. Read the group that covers what you are touching.

## Adding a route

1. Put the handler in the matching group under `routes/`, or add a group and call it from
   `../mobileProjects.ts`.
2. Body validation: a Zod schema in `schemas.ts`. If the route is documented, add the parallel
   JSON-schema fragment there too — Fastify's OpenAPI output uses that copy, and there is no
   generator, so the two drift unless changed together.
3. Response shape: a DTO type in `dto.ts`, returned with `satisfies`.
4. Auth: `requireMobileAuth(request, reply)` and bail when it returns null.
5. Anything priced goes through the credit reserve/commit/refund flow in `@book-maker/db/billing`
   — see the `add-priced-operation` skill, and close the loop on the failure path too.

Route groups are registered **directly on the same Fastify instance**, not via `fastify.register`,
so they share one encapsulation context — the `application/octet-stream` parser registered there
covers the attachment upload routes. Moving to `register` would break that.

## Serializers are the API contract

The three `project*Serializers.ts` modules decide what the app sees: summary/detail metadata,
status/progress/recovery, and plan/image/asset/export artifacts. `projectSerializers.ts` is only a
compatibility façade. Provider names, model ids, raw queue state and internal error text stay out
of mobile responses; the `serialize*` functions in the owning modules and
`sanitizePublicChatMetadata` in `projectChat.ts` enforce that. Widen them deliberately, not by
spreading a row. Note the leak guard rejects any wire key containing "model", which is why the app
reads a `qualityPreset` rather than a `modelTier`.

## A finished book prices every edit as a proposal first

Nothing is reserved or written until Apply, which is what makes the chat router safe to default
aggressively: a wrong guess is one Cancel away. Several invariants below depend on that property —
do not add an edit path that charges or writes before the card is confirmed.

## Tests

`*.test.ts` here share `testing/mobileApiHarness.ts` (fixtures and record factories). Add to it
rather than duplicating per suite.

`testing/mobileApiMocks.ts` must import **only** `vitest`. Its factories run inside `vi.mock(...)`,
so importing anything that transitively reaches a mocked module deadlocks the registry — the suite
hangs rather than failing, which is slow to diagnose.

Its `$transaction` mock rolls nothing back — there is no store to roll back — so it **accounts**
instead: each interactive transaction records the options it was handed, the writes issued through
the `tx` client it handed out, and whether the callback threw, and `survivingWrites()` reads those
back as the statements a database would still hold. That is how a rollback claim is asserted here
(`characterWriteRollback.test.ts`). Attribution is by client rather than by wall clock on purpose:
a callback reaching for the imported `prisma` instead of its `tx` lands on no record and is
reported as surviving, which is the escape a rollback-capable mock could not simulate.

## Index

- [Billing surfaces](#billing-surfaces)
- [The edit chat router](#the-edit-chat-router)
- [Export repair and the quality verdict](#export-repair-and-the-quality-verdict)
- [Free presentation edits](#free-presentation-edits)
- [Characters](#characters)
- [Voice and audiobook routes](#voice-and-audiobook-routes)

## Billing surfaces

- **Cancelling belongs to Google Play; the app's job is to say what it costs and then re-ask.**
  A real subscription can only be cancelled in the Play subscription centre, so
  `billing_cancel_sheet.dart` states what the reader keeps and what free grants, hands over via
  `playSubscriptionsLauncherProvider`, and then offers `POST /api/mobile/billing/subscription/refresh`
  — which re-verifies the stored `purchaseToken` on demand. Without that the app would keep saying
  "renews" for weeks, because the hourly sweep only re-verifies when `nextCreditGrantAt <= now`,
  i.e. at period end. `plan.cancelAtPeriodEnd` is `status === "CANCELED" || autoRenewing === false`
  — Play reports auto-renew off well before it moves the subscription — and when it is true
  `renewsAt` is null and `endsAt` carries the date, so no surface can call an ending plan renewing.
  `POST /api/mobile/billing/subscription/cancel` really cancels, but **only** under
  `MOCK_GOOGLE_PLAY_BILLING` (`plan.canCancelInApp` tells the app which button to draw): the mock
  verifier always answers ACTIVE, so a dev account that ever bought a plan could otherwise never
  see the free tier again. `endSubscriptionNow` nulls `purchaseToken` for that reason — leaving it
  would let the next refresh or sweep resubscribe you. Restore purchases in a debug build is how
  you get back to Creator for the next run.
- **The free tier's illustrated-book limit has two claiming doors — plan approval and the chat
  `add_image` Apply.** `POST /api/mobile/plans/:id/approve` claims the `UsageCounter` slot for a
  generation planned with images (403 `IMAGE_LIMIT_REACHED` when it is gone — never a silent
  downgrade to text-only), and the chat `add_image` Apply claims one when it is about to make a
  *text-only* book illustrated — only then, and only when the recomputed cost is above zero: an
  already-illustrated book spent its slot at approve (or at a prior `ADD_IMAGE`, which the
  predicate counts even after an undo), and a zero-priced image writes no ledger entry to carry
  the claim, so a failure would leak the slot for good. Either claim is stamped onto the
  reservation as `metadata.imageQuota`, so `refundCreditLedgerEntry` hands the slot back on every
  failure path without each of them knowing about quotas — which is why the confirmed `/resume`
  retry lane, which re-charges a failed attempt, also re-claims: for a `FULL_BOOK_GENERATION`
  retry priced with interior images, and for an `IMAGE_GENERATION` retry whose payload carries
  `imageInsertion`, through the same `addImageQuotaLimit` decision the original Apply used.
  **Known, pre-existing gap:** a chat replan copy carrying `illustrationsEnabled` generates an
  illustrated book through the worker's self-approval, with no approve step and no claim.
- **Chat replies never name a credit price.** The number travels as
  `metadata.creditsCharged` (queued work) or `metadata.editProposal.credits` (a proposal), and the
  app draws it as the tappable badge in `credit_cost_badge.dart` — one place that also explains what
  credits buy and that failures are refunded. `stripCreditAnnouncement` in
  `apps/api/src/mobile/projectChat.ts` removes the old sentence from transcripts written before
  that, so a new priced reply that writes the price into its text would say it twice.

## The edit chat router

- **The edit chat gets one clarifying question per request, and it is enforced three times.**
  A second question is a loop the user cannot escape: a `scope` clarification whose scope is
  `"none"` is satisfied by no reply, so "just add" is met with the same question forever. Once
  `findPendingScopeClarification` reports an open `scope` clarification that the new message
  neither answers nor cancels, `apps/api/src/mobile/routes/projectChat.ts` merges the stored
  request with the follow-up (`messageWithFollowUp`) and sets `clarifyExhausted`. That flag drops
  `clarify` from the router's action enum (`decideActionsFor`), *skips* the
  `BOOK_EDIT_CONFIDENCE_THRESHOLD` demotion — which would otherwise turn the hesitant decision
  straight back into the question — and finally `forcedDecision` coerces any surviving `clarify`
  into a whole-book `page_rewrite`. All three are needed: the prompt covers the model, the
  coercion covers a router timeout and the model-free heuristics, whose catch-all is a clarify.
  Defaulting this aggressively is safe **only** because a completed book prices every edit as a
  proposal card first — nothing is reserved or written until Apply, so a wrong guess is one Cancel
  away. For the same reason the confidence demotion never applies to the proposal-gated edit kinds
  on a finished book (`PROPOSAL_GATED_EDIT_KINDS`): a propose_edit's `assistantMessage` is written
  as a *confirmation* of the edit, so a demoted one replied "I'll rewrite the final page…" with no
  Apply card and no question — a dead end escaped only by insisting. The card is the confirmation,
  so a hesitant or pageless edit flows to `proposeBookEdit` (which resolves quoted targets or asks
  the one real "which page?" question), and `forcedDecision` widens a still-pageless edit to
  `all_pages` once the budget is spent rather than letting that question fire a second time.
  Every `clarify` records `clarification: "scope"` even when the model reports `"none"`
  (`intentFromDecideAction`), because that is what makes `handleProjectChatIntent` store the
  resumable `pendingEdit`; "fixing" that tautology strands the next turn with a bare fragment.
  `bookEditIntent.ts` splits into `bookEditMessage.ts` (reading a message: pages, quotes, scope,
  languages — a leaf), `bookEditHeuristics.ts` (the model-free classifier) and
  `bookEditRouterPrompt.ts` (the action list, the decide schema and the prose — everything the
  model is *told*, as opposed to how its answer is read), which is why those import types back
  from it but never values.
- **The chat speaks the printed page numbers, and the model indexes never reach the reader.**
  A reader saying "page 10" means the number on the PDF page in front of them — the printed
  footer, the Contents column and the pdfrx chrome, which skip the cover sheet — while every
  internal target is a model `Page.index`. Stored map ranges are physical (cover = PDF page 1);
  `printedPageForPdfPage` / `pdfPageForPrintedPage` convert, gated on map version: version 1
  stays on physical numbering (those PDFs counted the cover), version 2+ skips the cover.
  The translation is `Project.pdfPageMap`: measured at publish time from the rendered
  bytes by both publishers, stamped with the revision they claimed, and read through
  `bookPageMapForProject`
  (`apps/api/src/bookPageNumbering.ts`), which refuses a map from any other revision — except
  during EDITING, when the new PDF has not been published yet and the reader is still looking at
  the file that map describes. Dropping it there would make a typed "page 12" fall back to a
  model index while printed page 12 is still on screen; selection-composed edits already send
  `pageIndex`, so they never hit this. On the way in, `pageIndexesFromMessage` and friends
  resolve spoken numbers through the map — an edit target landing on furniture (Contents,
  Sources — the cover has no printed number) resolves to **nothing** rather than to whichever
  model page shares the number, while read/placement targets take the nearest page of prose —
  and the router model is given each page's `readerPages`
  plus the furniture ranges and told to return model indexes. **Told, and then checked**: a
  decision whose page channels name exactly the printed numbers the message speaks is the
  signature of a model that copied instead of translating, so `modelPagesForCopiedPrintedPages`
  re-reads them through the map before `intentFromProposeEdit` builds the intent — the same
  refusal to trust the model that `withDeterministicContentTarget` already makes for
  `show_content`. It stays deliberately narrow: a translated index (one the message never
  mentions) and a printed number that holds no prose keep the router's own answer. Spoken
  numbers include the same page-words the length parser already knows, so "صفحه ۵" is a
  copy just as much as "page 5". **The parser has to read the whole list or the guard cannot
  fire**: it once took only the first number after the word, so "edit pages 3, 5 and 7" spoke `{3}`
  against a router that named `{3,5,7}`, the set comparison failed, and three *printed* numbers
  were used as model indexes — the wrong three pages, with the card rendering them back through
  `displayPages` so the confirmation looked right. The comparison stays an **equality** rather than
  a containment: a router that translated correctly can also answer a subset of the numbers spoken
  (an index that happens to equal one of them), and translating that a second time moves the edit
  to a page nobody named. **A number the router had to compute is invisible to the guard, so
  nothing may ask it to compute one**: the structural anchor was once specified as "one less than
  the named page" when the reader says *before*, and a decremented number is exactly the signature
  of a model that translated — so the guard declined, the printed anchor was consumed as a model
  index, and "add a page before page 10" opened the gap after model page 9. The router now names
  the page itself with `structuralAnchorPosition` beside it, and `anchorPageIndexFromDecision`
  (`bookEditDecision.ts`) takes the step afterwards, in model pages, off whichever end of the
  translated span the side calls for. **Which end is one rule with two readers**, so it lives in
  `anchorModelPageIndex` (`bookEditMessage.ts`) rather than beside either of them: a printed sheet
  routinely holds several short model pages — one ending on it, one wholly inside it, one starting
  there — and `structuralIntentFromDecision` borrows the model-free recogniser's anchor whenever
  the router named none. The recogniser resolved that sheet to a *single* page, the first one to
  start on it (`primaryModelPageForPdfPage`), so "add a page after page 10" opened the gap past the
  sheet or in the middle of it depending only on whether the router had filled the channel.
  On the way out, every proposal card,
  queued reply and operation card renders through a `ReaderPageNumbering`
  (`mobile/bookEditCopy.ts`, `mobile/editOperationCopy.ts`), and **the way out has two ends of the
  span as well**: `displayPage` is the number a reader calls a model page by, `displayPageEnd` is
  the last sheet it prints on, and every "after page N" — the insert chip's `afterReaderPage`, the
  proposal bubble, the move destination, the applied insert's card — is the *end*, because that is
  the sheet the new or moved pages actually follow. Printing the start named a sheet before where
  the prose lands on any page long enough to span two, which is the same widening
  `anchorModelPageIndex` takes `Math.max` over on the way in. **A place the card cannot name is
  left out of the sentence rather than approximated, and there are two ways to fail to name one.**
  `displayPageEnd` answers a page the map has never seen with the model index, which is the right
  degradation inside a *list* of pages — dropping one out of "pages 3 and 4" is worse — and the
  wrong one where the number stands alone as a place, because "after page 8" is read as a printed
  number and names a sheet holding something else; `printedPageEnd` is that same end answering
  `undefined` instead, and the applied insert's card drops the clause on it. The other way is the
  anchor itself: that card derives it as the first page the apply *wrote*, less one, which is
  `insertAfterIndex` only while the whole run is in the book. A resumed delivery drafts just the
  recorded ids the book still holds (`stampDescribesBook` resumes on a partial survival on purpose;
  `refundUnwrittenEditPages` hands back the rest), so `insertedPagesLocation` compares the stamp's
  `insertedPageIds` against the pages written and names only the count when they disagree — one
  less than the first survivor is a page of the insert itself or the gap another left, and neither
  has a sheet in the map that was measured before either existed. The two placements the *request*
  settles outright are read from it and not from the pages: `0` survives the resolver's clamp and
  `null` is clamped to the last page, so "the front" and "the end" are true of every delivery.
  The operation DTO reports that settlement as `creditsRefundedAmount`; `creditsRefunded` is true
  only when the cumulative reversal covers the whole charge. The app shows both the net kept amount
  and the returned portion for a partial delivery rather than striking through the gross price.
  **Before Apply the placement is resolved once and every surface reads that one answer.**
  `structuralPlacementOf` (`mobile/structuralPageEdits.ts`) answers `front` | `after` a printed page
  | `end` | `unnamed`, and the three rules live only there: an insert's landing page is the
  resolver's clamped `insertAfterIndex` while a move's is the request's own anchor — a plan that is
  not an insert carries `insertAfterIndex: 0`, so a move reading it would send every page to the
  front of the book — the number is the anchor's `printedPageEnd`, and `unnamed` covers both a
  delete, which puts its pages nowhere, and a destination the map cannot place. Each surface keeps
  only its own words for it: `structuralProposalSummary` the sentence, `structuralCardBlock` the
  wire, `MobileEditProposal.pageLabel` the chip. They used to resolve it separately and had already
  drifted — the wire fields were gated on `action === "insert"`, so "Move page 3 after page 5" was
  drawn beside a chip naming no destination at all, and both halves read the anchor through
  `displayPageEnd`, which hands back the model index for a page an earlier, not-yet-recompiled edit
  added. The block sends `atFrontOfBook`/`afterReaderPage` beside the resolved `placement` because
  shipped app builds read those two, and a proposal lives on the chat message: a card written before
  `placement` existed is still read by inferring one from them
  (`MobileStructuralPlacement._placementFrom`, `project_chat_models.dart`).
  The DTOs carry a separate
  `readerPageNumbers` array — `affectedPageIndexes` stay model indexes on purpose, because the
  Edit-Mode deep links and the worker payloads navigate by them. A selection composed in the
  reader sends its resolved model page as structured `readerContext` (authoritative over parsing
  its own text, whose visible number is now the printed page). When its local locator resolved
  nothing, that context falls back to the **physical pdfrx sheet** — and a sheet number belongs to
  one file, so it travels with that file's `pdfDigest` and
  `modelPageForReaderContext` translates it only against a map measured from those exact bytes.
  The revision is not enough on either side: a repair republishes the same `contentRevision` over a
  new PDF and stamps the new map with it, so the revisions still agree while sheet 7 of the file
  still open is a different page from sheet 7 of the file the map now describes. Missing identity —
  a legacy map with no digest, an older app that sends none — refuses the sheet rather than
  guessing; the message's own printed numbers still route as they always did. The resolved
  `pageIndex` is unaffected either way, because a model page is a page of the manuscript rather
  than a sheet of one compile of it. **No translatable map means the
  old chat behaviour exactly**: books compiled before the map, or whose measurement failed, keep
  model-index parsing and copy byte for byte, which is also the graceful path for every test and
  every legacy transcript. Measurement failure is not a blank column: new PDFs always skip the
  cover in CSS, so the compile still records cover-skip numbering (`hasCoverPage` on status)
  and chrome matches the footer. Status exposes that flag together with the stored numbering's
  own `contentRevision` and `pdfDigest` as `pdfPageNumbering`; the app compares the digest with the
  downloaded bytes before using it. The project revision is not a substitute — EDITING keeps a
  behind map deliberately, and a repair may replace PDF bytes at the same revision and size.
  Legacy maps missing either stamp expose no numbering identity and the app stays physical. Chat
  stays on model indexes because a stub has no ranges.
- **Changing *which* pages a book has is its own edit, and it used to be a whole new project.**
  `restructure_pages` covers insert, delete and move; which one it was rides
  `structuralEdit` on the intent and the operation's classifier, so the dozen lists that switch on
  a kind gained one arm rather than three. It is a **fork of `apply-book-edit`**
  (`handlers/restructurePages.ts`), not a job type: everything a new type would buy already covers
  `APPLY_BOOK_EDIT`, and a new one needs entries in eight cross-workspace lists that do not
  typecheck against each other. Before it existed the request had nowhere to land — the router
  prompt calls a length change `structural`, and the model-free battery in
  `classifyWithDegradedHeuristics` matched `add|remove|delete|new (a) chapter|section|page` — so
  "add 3 pages after page 10" became a `book_replan`, which forks a **second `Project` row** and
  regenerates the book, priced as a whole book. Both halves had to be narrowed; fixing only the
  regex leaves the live path exactly as it was. Two things about it are load-bearing:
  it **forks before `affectedPagesForIntent`** in both `proposeBookEdit` and `queueChatBookEdit`,
  because that resolver filters against pages which *currently exist* and a page about to be
  created is not one — reaching it, an insert is answered "which page or exact phrase should I
  edit?" and never gets a card at all; and `anchorPageIndex` is `number | null` where **`0` is the
  front of the book and `null` is "no place named"**, an insert appending for the second and a move
  refusing it. Deleting and reordering call no model, so both are **free**, the same reasoning that
  prices `move_image` and `remove_image` at zero — only `pagesBilled` (an insert's new pages) is
  charged, at the rate a continuation pays. `resolveStructuralPageEdit`
  (`packages/core/src/generation/pageRestructure.ts`) is the one resolver the quote and the job both
  run, and it refuses rather than throws: a delete that would empty the book or leave a `Chapter`
  row with no pages settles for free with a sentence naming what is in the way.
  **Its caps are its own, and nothing upstream may clamp a request down to them.** A request the
  resolver refuses is answered free, in prose naming the real limit ("I can add up to 10 pages at a
  time"); the same request quietly narrowed on the way in is a card, a price and a charge for an
  edit nobody asked for, with the pages that were dropped mentioned nowhere. `bookEditDecision.ts`
  used to `Math.min` the router's `structuralPageCount` against `MAX_INSERTED_PAGES`, and
  `structuralPageCount`'s zod bound *was* that cap — which reaches the model as `maximum`, so a
  router asked for twelve pages answered ten — while the model-free recogniser clamped nothing at
  all: one message, "add 12 pages after page 10", got a ten-page insert through the router and a
  free refusal through a router outage. Both bounds are now well above the cap and only the
  resolver reads it. The floor on that same line is a different rule and stays: it is what turns a
  router that named no count, and a borrowed recognition that is not an insert, into the one page
  "add a page" means.
  **The stored `structuralEdit` is the Apply's whole instruction, so an Apply that lost it settles
  for free instead of defaulting.** `structuralEditFromMetadata` drops a stored edit that no longer
  parses rather than half-reading it, and `structuralEditForProposal`'s one-page-append default
  belongs to the *proposal* side, where nothing is reserved and the card is one Cancel away. Read on
  the Apply it turned a confirmed "Remove page 2" into a priced append at the end of the book —
  under the quote ceiling on any card that quoted more than one page, so it charged — and left the
  free ones bouncing back as a brand-new proposal for an edit nobody asked for.
  **It is reviewed from its stamp, because it snapshots nothing.** `changesAvailable` counted
  `PageEditSnapshot` rows, and a structural edit writes none — it rewrites no page, and a removed
  page's snapshot would cascade away with the page it describes — so the app's only review
  affordance was switched off for the one edit that moves whole pages, and the Flutter screen's
  `restructure_pages` arm could not be reached at all. `editChangesAvailable`
  (`mobile/projectChat.ts`) asks `hasBookEditUndoRecord`, which reads
  `classifier.structuralApplication` beside the count — the
  same stamp `operationCanUndo` and the worker's redelivery fence rest on: written in the
  transaction that shifted the indexes, erased by the rollback, so its presence *is* "this edit
  changed the book's shape". A delivered no-op (`structuralSkipped`) returns before the shift and
  carries no stamp, so it stays unreviewable for the same reason it stays un-undoable.
  `loadEditChanges` then answers with **no page diffs** — there is no before and after to show —
  and the two word totals its own record can account for: the removed pages ride the stamp whole,
  the inserted ones are `Page` rows the drafting pass wrote. **The live progress card said the
  opposite of that same fact**: sharing `APPLY_BOOK_EDIT`'s step keys means sharing its reader copy,
  so the step the worker spends shifting page indexes was announced as "Saving a version to undo".
  The worker's own step title is right and unusable — `advanceJobStep` puts it in
  `GenerationJob.message`, which these serializers never forward — so `editProgress.ts` keeps the
  words and picks them per `structuralEdit.action` (falling back on `intentKind`), the same payload
  discriminator the admin operations map reads.
- **The model-free recogniser fires only when the verb's object *is* the page.** `bookEditStructure.ts`
  runs third in `classifyWithDegradedHeuristics`, ahead of the replan battery and with no image or
  patch recogniser in front of it (image requests have no regex fast path by design), so whatever it
  claims is what an outage turns the request into. Its delete and move patterns used to allow twenty
  arbitrary characters between the verb and the page word, which reads "a page word nearby" — and
  nearby is where a reader writes what the page *holds*: "remove the picture on page 3" was answered
  with "I'll remove that page and renumber the rest of the book", as were the title, the last line
  and the photo on a page, and "move the picture on page 3 to after page 5" moved the page. So the
  object is now a closed grammar — determiner, qualifiers, then a page the message **names** —
  composed from the same list sources `pageIndexesFromMessage` reads (`NAMED_PAGE_LIST_SOURCE`), with
  the exceptions written down rather than approximated: a trailing noun means the page was a locator
  ("add page numbers", "delete page 3's picture"), a shortening clause is a rewrite ("cut page 3 down
  to half"), and a negation is not a request. Targets come from the matched clause, never the whole
  message, so "delete page 3, it repeats page 7" removes one page. **Fixing that pattern alone makes
  things worse, which is why the other half moved with it**: `negativeMediaPreferenceFromMessage`
  matches "remove … picture" anywhere, so what falls through lands on `structural` and quotes a whole
  rebuild *with illustrations switched off* — that reading is now gated on the request naming no page
  (`bookWideReplanSettings`), and a page-scoped picture request degrades to `clarify`, which is the
  landing the model-free path was designed to give it.
- **Undoing a structural edit moves the book to a different plan version, and the recompile has to
  follow it there.** `undoLastBookEdit` is handed a `project` read before its transaction, and
  every other undo can queue its recompile against that row's `currentPlanId`. A structural one
  cannot: applying it approved a `PlanVersion` of its own, and when that version is still current
  `revertStructuralPageChange` deletes it inside the same transaction — so the id in hand names a
  plan that is gone by the time the compile runs. If a continuation has since advanced the plan,
  the revert keeps and reconciles that later version instead, because it also keeps the pages the
  continuation appended; restoring the pre-structural plan would make the page set and plan
  disagree. The revert returns whichever version is current afterwards and the recompile names
  that; the compatibility/refusal policy and the `null` case are in `packages/db/CLAUDE.md`. This
  is not a compile that merely fails: it owns the book's outcome, so its throw marked a finished,
  delivered book FAILED and refunded the generation — the most expensive possible result of a
  free undo.
  It also runs under `PAGE_RESTRUCTURE_TRANSACTION_OPTIONS`, the ceiling the apply side names,
  because it replays that work backwards in one transaction — the raw index shifts, both
  `PlanVersion` writes, then every snapshot on top — and Prisma's 5 s default aborts that midway
  on a long book — the very edit that was allowed 30 s to make the shape cannot be given back
  under 5 s, and the reader's Undo just errors.
- **Moving and removing a picture are free, and neither is a page edit.** `move_image` and
  `remove_image` are their own intent kinds and their own `BookEditOperationKind`s, priced at 0 in
  `bookEditCreditCost` and applied by `apply-book-edit`'s layout fork
  (`apps/worker/src/handlers/applyImageLayout.ts`) with no generation at all. Routing them as page
  rewrites is the expensive mistake this exists to stop — the router prompt says so in as many
  words, and the plan stage demotes both to `answer` because a book with no pages has no pictures.
  **And a status poll may read which fork an apply took, because the kind is written before the
  job exists.** `createOpenBookEditOperation` (`editOperationClaims.ts`) inserts the row with its
  `kind` and only then opens the transaction that enqueues, all four `APPLY_BOOK_EDIT` sites follow
  that order and put `operationId` on the payload, and nothing anywhere updates `kind` — so the
  value a poll reads mid-flight is the value `applyBookEdit` will fork on. That is what lets
  `projectPageCounts.ts` answer "is a page rewrite owed" at the granularity the truth lives at:
  `JOB_PAGE_REWRITE_SCOPE` in `packages/core` must say `always` for `APPLY_BOOK_EDIT`, because the
  leaf cannot make a database read, and a picture move is an apply that rewrites nothing. Left
  coarse, a reader moving a picture watched a delivered 200-page book count down to 197/200 and its
  Pages step re-open for the length of a free edit, then snap back — and a stalled operation row
  held it there. The refinement only ever *narrows* the coarse answer, and every unknown it meets —
  no `operationId`, a missing row, a kind this build does not know — answers "owed", because
  under-reporting a finished book is the failure it exists to stop.
  **A replacement is the one image edit whose undo has to move a record as well as a file.** Move
  and remove never redraw, so the row's `metadata.copyrightRewrite` still describes the pixels it
  always did; replacing a picture puts different pixels behind the same `ImageAsset` id, and the
  worker records the outgoing render's provenance on `classifier.previousAsset.generation` for this
  revert to merge back (`withImageRenderProvenance`, core). Restoring `path` without it left the
  *replacement's* claim standing over a picture drawn before anyone asked — the false kind, and a
  false one is worse than none. Merged onto the row read inside the transaction rather than written
  whole, because `keeperToken` and its siblings on that document decide illustration ownership.
  All four enqueue sites also stamp `PRE_EDIT_PROJECT_STATUS` from that same pre-transaction
  project row before changing it to EDITING. The worker cannot reconstruct COMPLETE versus
  REVIEW_REQUIRED after commit, so text rewrite, image insertion, image layout and restructure
  payloads all carry the settled status their own no-op/failure exits may restore.
  **Positioning inside a page is markdown-only, and that is forced rather than chosen**:
  `compileBookMarkdown` prints a page's `ImageAsset` hero above the prose *always*, and a
  chat-added picture has no `ImageAsset` row at all — `applyImageInsertion` writes a file and a
  markdown line and nothing else. So "below the text" demotes a hero to an inline line and clears
  `Page.imagePrompt`, "to the top" of a hero is already true and reports itself as such, and an
  inline line just moves within its own page's markdown — landing *after* a leading ATX heading,
  never before it, because `sanitizePageMarkdown` only strips that heading while it is still line
  one. There is no way to promote an inline picture into a hero, because there is no row to
  promote.
**The card's count is the confirmation, so Apply may not widen it.** The proposal resolves the
whole set through `listReplaceableBookImages` and pins it as `imageLayout.targets`; Apply
re-resolves *those* one by one and never re-runs the scope query, so a picture added between the
card and the tap is not swept into an edit the reader never saw. A layout edit that finds
nothing writes `classifier.layoutMissing` with a reason: the worker cannot write a chat message,
so `layoutSkipSummary` in `mobile/editOperationCopy.ts` is where the queued reply's promise gets
corrected, and no Undo is offered for those rows — they write no snapshot, so the shared undo
predicate below refuses them where `undoLastBookEdit` would otherwise revert the *previous*
edit instead.

- **Undo is offered only for an edit the undo would actually revert, and that is one predicate.**
  `canUndoBookEdit` (`mobile/manualEdits.ts`) is the whole rule: APPLIED, an undoable kind, not
  already undone, and carrying the record the undo restores from — `PageEditSnapshot` rows for
  anything that rewrote text or moved a picture, the `structuralApplication` stamp for an edit that
  changed which pages the book has. The card's button (`operationCanUndo`), the picker inside
  `undoLastBookEdit` and "See changes" (`editChangesAvailable`, which is the record half,
  `hasBookEditUndoRecord`, on its own) all read it. A row one of them says yes to and another skips
  is not a harmless no-op Undo: the picker takes the newest row *with* a record, so the reader taps
  Undo on this edit's card and the edit before it is reverted, under this one's confirmation
  sentence. The three used to be written out separately, and the card's copy enumerated the ways a
  record can be missing — `classifier.layoutMissing`, then `classifier.structuralSkipped` — which
  is how the two shapes that carry no marker at all were missed: a structural apply whose
  `rollbackStructuralChange` erased the stamp while the `updateMany` flipping the row APPLIED →
  FAILED afterwards is `.catch()`ed away, and an exact-mode edit whose skipped pages had their
  snapshots deleted (`applyBookEdit`). Ask for the record rather than for the absence of a marker,
  and the next shape is covered too. The snapshot count is the one thing the predicate cannot fetch
  itself, so a caller that did not select `_count` reads as zero and the button goes missing —
  which is the degraded state worth having.
  **The picker asks it a second time inside its own transaction, under the operation row's write
  lock**, the way `settleSkippedRestructure` does on the worker side — the row moves in the window
  the picker's read opens. The reader taps Undo while a structural apply is still drafting; the
  drafting dies, `rollbackStructuralChange` puts the pages back, erases `structuralApplication` and
  writes `structuralRolledBackAt`, and the row goes FAILED (or stays APPLIED, because that flip is
  `.catch()`ed). The undo then ran `revertStructuralPageChange` a *second* time over an
  already-restored book — deleting a `newPlanVersionId` that is gone, re-approving the base plan —
  and wrote `{ ...pre-rollback classifier, undoneAt }` back over the rollback's own record, putting
  the stamp back and dropping `structuralRolledBackAt`. So the transaction opens with a conditional
  `updateMany` claiming the still-APPLIED row (its count is the status half), re-reads the
  classifier under that lock, and asks `canUndoBookEdit` again before anything else is written —
  including the project's EDITING/`contentRevision` bump, which now comes after the claim rather
  than before it, so a refused undo leaves no revision behind and nothing to recompile. A refusal
  answers "nothing to undo" rather than falling through to the next row: the picker takes the
  newest row *with* a record, so falling through reverts the edit before this one under this one's
  confirmation. It also settles two undos racing each other — the second waits on the lock, then
  reads its own `undoneAt`.
  A structural delete can leave one live snapshot and park another from the same older multi-page
  operation. `_count.archivedSnapshots` is therefore part of that predicate too: any archived row
  makes the older operation incomplete and neither reviewable nor undoable. Structural Undo restores
  those rows under their original operation ids before its own `undoneAt` lands, so the next Undo in
  the chain sees the older edit whole again. If the delete instead becomes permanent, the archive's
  plain key outlives retirement of the structural operation and keeps that partial history hidden.

## Export repair and the quality verdict

- **The mobile export routes never render.** A missing `book.pdf` used to be compiled inside the
  Fastify handler — an unbounded Chromium render, with no dedupe, on a route the app hits from the
  reader, the saved-export card and the actions menu. It is reachable in the window a user edit
  opens (`invalidateCompiledProjectExports` deletes the files, `queueUserEditExportRecompile` queues
  the rebuild a moment later). `mobile/routes/exports.ts` now queues that compile and answers 404
  `EXPORT_NOT_READY`. **Watching the status queues it too, and that is the path that matters**: every
  download surface gates on `export.available` — the card's button is disabled and reads "Preparing
  PDF", the reader shows "still being written", the actions menu the same — so a book whose exports
  never came back is never able to *reach* the download route, and the repair there would sit
  unreachable behind the very condition it exists to fix. Both status surfaces call it when the
  **PDF** is missing, and the *stream* is the one the app uses: `projectStatusProvider` subscribes to
  `GET …/status/events` and falls back to polling `GET …/status` only when the stream ends while the
  book is still live. A settled book yields one event and the client returns, so a hook that lived
  only on the poll route never ran for the case it was written for — and the saved-export card's
  four-second refresh invalidates the provider, which re-subscribes to the stream rather than
  polling. The stream re-reads the project row at that moment (`ensureExportRepairQueuedFor`) because
  a connection opened during generation was opened against a status, plan and revision that have
  since moved. **Both formats use a bounded retry budget.** The EPUB was once left out on the grounds
  that its own download route repaired it on demand; it cannot, because the button that reaches that
  route is disabled for exactly as long as the file is missing, so an EPUB-only outage was
  unrecoverable until some unrelated edit bumped the revision. Both formats use a coarse five-minute
  window, with EPUB retaining a format-specific `repair-epub-{revision}-{window}` key so it can get
  a dedicated attempt after a PDF repair completes without producing one. That keeps a burst of
  status reads to one repair while ensuring a transient conversion failure does not permanently
  spend the manuscript revision's key. The hook belongs on that per-project
  route and not in `serializeExportSet`, which the project *list* shares; from there one poll would
  queue a compile per listed book. The file is **read before the unlock is spent**, and the bytes it hands back are
  the ones already in memory — `stat`, charge, then read left a window where that same edit could
  delete the file mid-charge and answer 404 with the reader's credits gone. The entitlement is per
  project and idempotent, so nothing was double-charged and a retry did deliver, but the first unlock
  still settled against nothing. What it queues is a **repair**, and it must
  not borrow the edit recompile's normalized revision-and-policy dedupe key: `enqueueGenerationJob` returns any
  existing row for a key and only re-dispatches one still QUEUED, so the moment that row goes
  COMPLETED or FAILED the key is spent and every later repair for that revision enqueues *nothing*.
  An edit deletes the exports *before* queueing its recompile, so a recompile that failed would
  otherwise leave a book with no files, a terminal key, and an app polling "preparing" forever.
  `exportRepairDedupeKey` carries a coarse five-minute window instead — enough to collapse a burst
  from the reader, the card and the actions menu through the unique index, and to stop a permanently
  failing compile turning a four-second poll into a job per poll. Collapsing with a compile that is
  genuinely in flight is done by reading the job's **state** (`QUEUED`/`ACTIVE`), which holds
  whatever key that compile used — and that read runs in the **same Serializable transaction as the
  insert**, because the unique index cannot collapse the two formats against each other. Their keys
  differ by design, so a status read finding the PDF missing and an EPUB download landing in the same
  millisecond both saw nothing pending and both queued a whole compile of one manuscript: two
  Chromium renders holding both of the browser pool's slots, and two reader-chapter calls, to rebuild
  one file. Serializable refuses the loser's insert, which lands in the same catch as any other
  failure — the caller was answering "not ready" regardless, and by its next poll the winner's job is
  the pending one everyone stands down for. Only these transactions run serializable, so nothing the
  worker is doing to those rows can be aborted by one. **The pending compile is half the decision;
  the file is the other half, and it is re-read inside that same transaction, after the job read.**
  Every caller arrives having already observed a missing file — the download route read it, both
  status surfaces stat it through `serializeExportSet` — and a compile that finishes in between is
  invisible to the job read, so the repair ordered a whole second compile of a book that already had
  its file. The two together have no gap only in that order: a publication renames the artifact into
  place strictly before the row that made it stops being QUEUED/ACTIVE (`publishCompiledExports`
  renames inside its own transaction; the worker marks COMPLETED after the handler returns), so a
  compile still working is caught by the read and one that finished is caught by the stat. Presence
  is the whole predicate — the same one every download surface calls availability — and the
  provenance record beside the file is deliberately neither read nor written here: `unknown` is an
  old file that downloads fine, and `mismatch` means a publication is landing under the read, which
  is the last moment to start a compile. Nothing in the decision takes the project row lock, so it
  can neither deadlock with a publication nor queue a polled request behind one. The repair payload also carries
  `DETACHED_FROM_PROJECT_LIFECYCLE`, and that flag is load-bearing: `compile-export` is two different
  jobs wearing one name. The compile at the end of generation owns the book's outcome and must fail
  it; a compile queued later to rebuild a missing file owns nothing. Without the flag the second kind
  took the first kind's path — `markFailed` flips a COMPLETE project to FAILED, and
  `refundFailedProjectCredits` walks the payload's `planId` to the book's own `GENERATE_BOOK` charge
  and refunds it, so it is not even the vague "latest FULL_BOOK_GENERATION" fallback. `compile-export`
  has no BullMQ retry, so one watchdog timeout on a repair was enough to mark a delivered, paid book
  failed and give the credits back. The flag is checked per *job* rather than per job name for
  exactly that reason; `DERIVATIVE_GENERATION_JOBS` is the wrong granularity here.
  **Two places settle a stopped run's charge, and both have to ask.** The worker's is
  `jobOwnsProjectLifecycle` in `runtime/jobLifecycle.ts`; the API has a whole parallel
  implementation in `stopProjectGenerationJobs` (`apps/api/src/queue.ts`), which every stop and
  *both* delete routes go through. There a repair falls into `settleLegacyStoppedJobs`'s
  attempt-less bucket, `BOOK_RUN_JOB_TYPES` contains `COMPILE_EXPORT`, and the payload's `planId`
  leads to the same `GENERATE_BOOK` charge — so deleting a finished book whose PDF had gone missing
  refunded the purchase, because the status poll had queued a repair a moment earlier. The filter
  that builds `legacyJobs` excludes detached rows for that reason; they are stopped like anything
  else, they just settle nothing. **The charge is only half of what a stop must not touch**: the
  same function's project write was unconditional, so stopping a repair marked the finished book
  FAILED — terminal, because `ensureExportRepairQueued` only queues for COMPLETE and
  REVIEW_REQUIRED and `canRecoverGenerationJob` refuses detached rows, so neither the self-repair
  lane nor either resume route could move it back. It is guarded on the *status* rather than on
  what was stopped (`SETTLED_PROJECT_STATUSES`), because a book reaches those two only by being
  finished while real in-flight work is GENERATING or EDITING — so an unstarted edit or a narration
  stopped on a finished book leaves it finished too, and nothing that should fail a run stopped
  failing it. The operator console draws Stop for any QUEUED or ACTIVE job, which a repair is.
  **A stopped continuation restores only while its durable job is still QUEUED.** Enqueue moves the
  settled book to EDITING before the worker sees it, so QUEUED proves that transition is the only
  mutation and the payload's pre-edit status is safe to restore. ACTIVE cannot identify a phase:
  `continueBook` may still be outlining, or it may already have atomically installed its extended
  plan and chapters and partially drafted the appended pages, including page-owned semantic state.
  The API does not own enough of that handler's snapshot to compensate it safely, so Stop leaves an
  ACTIVE continuation's project FAILED even though Apply can restore after its publication lease is
  revoked. That FAILED status is the barrier that prevents a partial append reading as delivered if
  the worker's best-effort rollback is interrupted. APPLIED remains a different durable fact: Stop
  excludes that job from terminalization and refund so its idempotent publication handoff can finish.
  Keep the APPLIED query on the full pre-edit job set even though the immediate-restore filter treats
  ACTIVE Continue differently; repeated Stop then sees no newly claimable work in either branch.
  **Not failing the project is not the same as not being reported as its failure**, and the reading
  side has to ask too. A FAILED repair row is still a FAILED row, so it reached `failureMessage` in
  `mobile/projectStatusSerializers.ts` — the app's `hasFailure`, which is `BookStage.needsAttention` — and
  painted `generationProgress`'s finish step red on a COMPLETE book, permanently and with nothing the
  reader could do. Worse, `canRecoverGenerationJob` accepted it, so `/resume` (either route) would
  requeue it *and set the project GENERATING*, which the flag then stops anything moving back out of.
  `canRecoverGenerationJob` now lives once, in `mobile/generationRecovery.ts`: `routes/projects.ts`
  and `projectStatus.ts` each carried a copy, which is both how a guard like this ends up on one
  path only and how `retryAvailable` can promise a retry that would queue nothing — the status read
  and the resume write have to give the same answer about the same row.
  For operations: a repair that *fails* does block the next one, but only for the rest of its window
  — the window is wall-clock aligned rather than measured from the attempt, so the wait is anywhere
  from a moment to five minutes and never longer. That expiry is the whole difference from the
  non-windowed compile-intent key it replaced, which went terminal and stayed there. The symptom to look for is
  a `GenerationJob` whose `dedupeKey` contains `repair-` sitting FAILED while the project's exports
  are missing; it re-attempts on its own. Note the app gives up watching first: its budget is two
  minutes against a window of up to five, so a book can stop saying "preparing" before the next
  repair is even queued. The two numbers are deliberately unmatched — the watch bounds pointless
  polling, the window bounds pointless compiles, and a repair that keeps failing is a broken book
  that polling faster would not fix.
  **A FAILED row the book has already retried is not the book's current trouble.** Retry leaves the
  old `GenerationJob` FAILED. `failureMessage` is the app's `hasFailure`, which is
  `BookStage.needsAttention` even while project status is PLANNING or GENERATING, so a leftover
  `PLAN_BOOK` after the reader clicked retry kept the plan error on screen after the retry had
  already succeeded. `canRecoverGenerationJob` is the resume question against the current plan, not
  this one — a completed retry of the same page is still "recoverable" in that sense.
  `laterJobSupersedesOwningFailure` is the reporting filter: a later QUEUED, ACTIVE or COMPLETED row
  that itself owns the project outcome, for the same work, replaces the leftover. Planning is one
  family; `GENERATE_BOOK` and an owning `COMPILE_EXPORT` match by type; fan-out jobs match by
  `pageId` / cover; edits (`APPLY_BOOK_EDIT`, `CONTINUE_BOOK`, `REPLAN_BOOK`) match by `operationId`.
  A detached repair wearing `COMPILE_EXPORT` is not a retry of the generation compile, and another
  page (or another edit) completing must not hide work that is still failed. Both reporting surfaces
  read it through `findCurrentOwningFailure`.
**Staying silent about the status is only half of it; the report still has to be ignored on the
way out.** A repair writes its own `qualityReport` — deterministic checks alone, since
`skipFinalReview` asks no model anything — and both readers took the newest compile that had one,
so rebuilding a missing PDF erased every chapter-coherence and final-QA warning the book had
earned, along with the `affectedPageIndexes` the quality card's "Fix page N" button is built from.
Nothing brought them back: the next repair erased them again. **Who owns the verdict is a column,
not a scan.** `GenerationJob.ownsQualityVerdict` is written from type + payload where the row is
born — `jobOwnsQualityVerdict` in `packages/core/src/jobScope.ts`, applied in
`enqueueGenerationJob` and `enqueueWorkerJob` beside the `contentRevision` those two already
promote — and `loadProjectQualityReport` (`apps/api/src/mobile/qualityVerdict.ts`) is the one rule
both `projectStatus.ts` and `mobile/projectSummarySerializers.ts` read through: newest owning compile
that *has* reported. That last clause closes the detail serializer's older habit of showing
"pending" for as long as any compile was in flight — the column is set at creation, so a queued
or running compile owns a verdict it has not written and must not blank the card.
It is a column because the two exclusions are payload flags and negating a JSON-path predicate in
SQL drops every row whose payload lacks the key — which is all of them but the flagged ones. So
both readers used to filter in JS over whatever window they held (eight compiles in the detail
serializer, twenty-five jobs *of any type* in the status builder), and job churn — a repair every
five minutes, an audiobook, a burst of image retries — pushed the owning compile out of reach.
The verdict then did not degrade, it vanished, because `normalizeProjectQuality` reads nothing as
`pending`. **The second non-owner is a presentation-only recompile**
(`PRESENTATION_ONLY_RECOMPILE`, set only by `applyPresentationPreference`): the Sources list and
the chapter-heading style change how the book is printed, not one character of `Page.markdown`, so
their deterministic-only report is a *worse* statement about the same manuscript rather than a
newer one. `skipFinalReview` cannot make that call — an edit's own recompile sets it too, and a
manual edit, an undo or `applyBookEdit` really did rewrite prose, so those keep the verdict on
purpose: findings about text the reader just replaced may not outlive it, and nothing runs full QA
on a finished book again. Migration `000040_quality_verdict_owner` backfills the column from the
payloads already stored; presentation reprints predate their flag and stay owners, so no
historical row changes meaning. The one issue that survives all this is `EPUB_EXPORT_FAILED`, and it must:
it describes a *file*, the repair that rebuilds it is exactly the detached compile nobody is
listening to, and a book whose EPUB is now on disk may not keep saying the export failed. So
`qualityWithExportsOnDisk` drops it against `serializeExportSet`'s availability — disk beats a
historical job row — and nothing else, because every other issue is about prose no later compile
of the same manuscript can have fixed.

## Free presentation edits

- **The Sources list at the end of a book is not page text.** `compileBookMarkdown` builds it from
  the project's `ResearchSource` rows on every export, so no page edit can remove it — routed as
  one it charges for rewriting pages that never held it and then recompiles the section straight
  back. "Remove the sources" is a `back_matter` intent instead
  (`apps/api/src/bookEditBackMatter.ts` recognises it, the router has a matching `back_matter`
  edit target): free, it sets `mediaSettings.includeSources` on the project and queues the same
  recompile undo uses. Read that flag with `includeSourcesPreference` from the **project row**,
  never from a plan version's `inputSnapshot`, or toggling it would need a replan to take effect.
  **The chat may only offer what the compile will print**, which is not the same as "the project has
  research": `formatResearchCitation` drops every row without a URL, so a book holding only
  URL-less grounding summaries has no list to remove and none that turning the flag on could make
  appear — it used to answer "Done, the sources list is back", bump `contentRevision` and recompile
  an identical book. `hasReaderFacingSources` is the compiler's own citation builder asked as a
  question, which is what keeps the two from drifting.
- **Chapter headings are not page text either, and the word "Chapter" is stored nowhere.**
  `formatChapterHeading` (`packages/core/src/generation/markdown.ts`) synthesizes `Chapter N: Title`
  at export time from a label table, and its sibling `cleanChapterTitle` *strips* that prefix back
  off a stored title so it cannot be doubled — so the word is in no `Page.markdown` and not even in
  `Chapter.title`. "Don't say Chapter, just the title" is a `chapter_heading` intent
  (`apps/api/src/bookEditChapterHeading.ts`, matching router edit target): free, it sets
  `mediaSettings.chapterHeadingStyle`/`chapterHeadingLabel` and queues the same recompile. Both
  recognisers return **before** `normalizeIntentForStage`, which is load-bearing — `forcedDecision`
  turns any unresolved request into a whole-book `page_rewrite`, and that is what once quoted 960
  credits to rewrite twelve pages that would have recompiled the identical heading.
  `applyPresentationPreference` (`apps/api/src/mobile/presentationEdits.ts`) is the shared mechanism
  for both: one `mediaSettings` field plus a recompile, no `BookEditOperation`, no ledger entry. The
  preference/EDITING/revision update and the undispatched `COMPILE_EXPORT` row are one database
  transaction; only after it commits does the API push that row to BullMQ. A crash in the handoff
  therefore leaves the durable row for `reconcileUndispatchedGenerationJobs`, never a committed
  presentation revision with no policy source for worker recovery. **Free does not mean
  lifecycle-free:** when another project job is open, `routes/projectChat.ts` saves either
  presentation request through `busyEditReply` and resumes it after that owner settles. Letting it
  pass the busy gate makes its transaction meet an ordinary edit's `EDITING` with no presentation
  predecessor to supply the settled-status fallback; guessing one would let the reprint steal that
  edit's lifecycle and quality policy.
- **A verified exact replacement is free, and the verification is what makes it safe.**
  `locallyPatchedPage` was always model-free, but the choice between it and a two-model-call page
  rewrite was made per page *at apply time* and never reached pricing, so a `local_patch` was billed
  `25 + 10/page` either way. `planExactReplacement` (`apps/api/src/mobile/exactReplacementPreview.ts`)
  now computes the result up front: pages that do not contain the text are dropped from the
  operation, the real before/after lines ride on `editProposal.preview`, and the quote is 0. The job
  then carries `mode: "exact"`, which forbids the model fallback — a page that stopped matching is
  skipped, never rewritten, because nothing was charged for rewriting it. Matching goes through
  `hasExactMatch` in `packages/core/src/generation/exactReplacement.ts`, never `String.includes`:
  candidate pages are selected case-insensitively in SQL, so a literal check disagreed with the
  search that chose them. When the literal text appears on no page, the replacement falls back to
  `preserveCase` rather than to a rewrite ("replace rabbit with fly" about a book that writes
  "Rabbit").

## Characters

The library routes split by what they write, not by which noun is in the path.
`routes/characters.ts` owns the record and its prose — the list, create, PATCH, delete — which is
the lane that claims sibling rows and shares one client budget. `routes/characterImages.ts` owns
every route that moves the two picture pointers: the photo upload, the priced portrait job, the
byte GETs, and the retained history behind them. They register on one Fastify instance, so the
`application/octet-stream` parser covers the upload wherever its file sits.

Mentions split the same way — by what the code does to a row, not by the noun in it.
`libraryMentionRows.ts` holds the readings of a row that is already stored and touches no client:
`libraryMentionRefs` (the wire list), `claimingNames` (who may hold a span of prose) and
`survivingMentionIds` (what an old client's edit leaves behind). `libraryMentionGraph.ts` reads the
library by id and walks the links behind a tapped cast. `libraryMentionLinks.ts` is the outgoing
write — the complete link set one description owns, and the two constants that keep its `deleteMany`
and its `createMany` naming the same kinds. `libraryMentionRewrites.ts` is the incoming direction:
every *other* description, claimed as a set under the target's own `FOR UPDATE`, when that target is
renamed or deleted. The readings are one file because of the one-candidate-set rule below — a span
the write binds has to be one all three of them can still find.

- **A per-book character list is a copy, and it says which library character it is a copy of.**
  `VoiceCharacter` rows (the "Talk to characters" cast, the only per-book character list the app
  has) are built one-for-one from `plan.characters`, so a saved character reached the sheet as a
  same-named twin with a planner-written description and an avatar re-drawn from that description.
  `VoiceCharacter.libraryCharacterId` is that link — resolved through `matchLibraryCharacter` at
  extraction, deliberately **not** a foreign key, because a book outlives the library row it was
  made from. `loadVoiceCast` is also scoped to the approved plan version: the "do we have a cast
  already" guard counts by `planVersionId` while the read did not, so a continuation or replan
  appended a second cast and listed the same character twice. Do **not** delete superseded
  `VoiceCharacter` rows to fix that — `VoiceCall` and `VoiceCallEvent` cascade from them, so it
  would erase paid call history and the transcripts `voiceCallHistory.ts` reads back as memory.
- **`photoPath` is not a reference; `portraitPath` is, and the upload decides which one an image
  becomes.** The snapshot writes `portraitFile` on `portraitStatus === "READY"` alone, so a photo
  that never became a portrait reached no book at all — the app showed the reader their own face on
  every character surface while the book invented one. `PUT /:id/photo` now makes one bounded, free
  vision call (`characterPhotoVision.ts` in core, `readCharacterPhoto` in `mobile/`) that answers
  two things at once: a `suggestedDescription`, and whether the upload is a photograph or already an
  illustration. An illustration is **adopted** — the same optimized bytes written a second time
  under the portrait name, `portraitSource: ADOPTED_UPLOAD`, no job, no ledger entry — so the
  reader's own artwork is the character verbatim, with no redraw to drift through. A photograph is
  not, and the ask is the existing priced portrait button: `canAdoptCharacterPhoto` demands a
  confident **single-subject** illustration and reads `"unknown"` as a photograph, because a
  mis-adopted face becomes the authoritative design source for every page render with no model in
  the loop, while a mis-classified drawing costs one redraw. The verdict is stored rather than
  recomputed (`photoKind`), and `serializeLibraryCharacter.usedInBooks` is *literally* the snapshot
  writer's condition, so no surface can promise a look the build will not carry. The suggestion is
  offered and never applied — it is screened through `assessCurrentContentRestrictions` like any
  user text, since a photo's visible text reaches the model, and it is dropped rather than failing
  the upload. Every *vision* failure here (no vision key, a refusal, a timeout) stores the photo and
  answers 200; `CHARACTER_PHOTO_VISION_BUDGET_MS` is not optional, because the Gemini client sets no
  request timeout and Fastify sets none either. The one non-200 exit after the writes is a character
  deleted mid-upload, and it is a 404: the handler's first read is deliberately the lean
  `ownedCharacter` (it wants a name and an id, and joining the mention graph in front of a
  multi-second vision call bought nothing), so the row it would once have fallen back to predates
  every write the handler just made and would have answered `hasPhoto: false` for the picture it
  had just stored. `DELETE /:id/photo` is a **pointer clear and nothing else** now — it nulls
  `photoPath`, `photoKind` and `suggestedDescription` and leaves every reference and every byte
  where they are. It used to unlink the file and drop an *adopted* reference with it, on the
  grounds that the reader had swapped the picture out; retaining every version made that untrue —
  the artwork is still in the strip and still what the books draw — and the app calls the per-image
  delete instead, so the route stays only for clients already in the wild. An upload never lands on
  a READY generated portrait or on a row an open portrait job owns — silently, because an upload is
  not a portrait request.
- **A portrait start's prompt inputs are part of its command identity, never a test it is refused
  on.** `assertMatchingCommand` refuses a known `commandKey` whose stored `requestFingerprint` or
  `quotedCredits` moved, so where the fingerprint sits decides what a retained `requestId` can do:
  folded *into* the key, the same request replays onto one attempt and one charge while a moved
  input mints a key nothing has used and draws what the reader is now asking for; sat *beside* it,
  the same move is a 409. Beside it the fingerprint could never protect a live job anyway — a
  second tap while the portrait is QUEUED or GENERATING is refused by `PORTRAIT_OPEN_STATUSES` well
  before the ledger — so it only ever fired on a *settled* attempt, which is exactly where "start
  the new drawing" is the answer. It carried `hasPhoto`, and then `appearance`, and
  `storeCharacterPhotoUpload` moves `photoPath` and `appearance` together: the server writing a
  look the reader never touched turned Redraw into a permanent dead button, because
  `character_profile_screen.dart` clears `_portraitRequestId` only inside the try after a start it
  saw succeed, so the retained id could only 409 again until the screen was disposed. `cost` is in
  the key for the same reason — it is the other value the refusal is made on, and prices are
  operator-editable and re-read every 15s.
- **A mentioned character's sheet rides the stored edit request, never the routed text.** In the
  finished-book chat the sheets become `characterContext`, carried on `PendingEditState` (so a
  clarify → confirm → Apply chain keeps it) and appended only where the request reaches a model:
  the `APPLY_BOOK_EDIT`/`CONTINUE_BOOK`/`REPLAN_BOOK` payloads and the plan-revision message
  (`requestWithCharacterContext` in `editOperations.ts`). The bare message is what
  `classifyProjectChatMessage`, `affectedPagesForIntent` and `exactReplacementFromMessage` read —
  a sheet inside it would move page targeting — and the visible transcript and proposal card stay
  as typed. **"The payload" means every string in it the model will see, and one of them is not
  the request**: `applyBookEdit.ts` *substitutes* a `perPageInstructions` entry for the whole
  request on the page it names, so composing the sheets onto `request` alone rewrote the pages the
  reader actually named — "make page 3 funnier and page 7 shorter" — with no idea who the mentioned
  character is, while every unnamed page in the same edit had the sheet.
  `pageInstructionsWithCharacterContext` composes the payload copy of those entries; the ones on
  the intent stay bare, because that is what the card shows and what the resumable pending state
  rebuilds from. In the creation chat mentions are message-level `{id, name}` refs, so
  `activeThreadPayload` branch-filters them for free, and every turn re-reads the live rows so a
  library edit propagates; the build snapshot is the moment that stops. Where a *typed* `@name`
  ends is `isLibraryMentionNameCharacterAt` in core, which the build sweep calls rather than
  keeping its own copy, and its `\p{M}` is deliberate: it is the exact
  opposite of what `foldCharacterName` does with combining marks one package over, because a
  word-boundary test needs the mark that a spelling-fold has to drop. Both halves are argued
  together in `packages/core/src/generation/CLAUDE.md`; neither may be narrowed to agree with the
  other. The boundary rule is spelled twice — those core helpers, and the Dart composer's
  `_nameCharacter` — and the two only
  move together, because a token the composer refuses and the build sweep then binds is an
  invisible cast member. The rows themselves are read through `expandLibraryCharacterGraph`, which
  follows durable description links of `targetKind` CHARACTER outward from the mentioned
  characters: every explicitly tapped character always reaches the model, the ten-cap bounds
  only the linked expansion behind them, Location/Other edges on the same join are ignored, and
  the mention routes derive their 404 from its `missingIds` instead of a second read.

- **A character PATCH re-reads its own row under the claim, because the claim only asserts the
  name.** `claimCharacterRow` guards the rename race and nothing else, so everything the handler
  derived from the pre-transaction `ownedCharacter` snapshot — the description, and the link set
  `libraryMentionRefs` read off it — was still the request's own stale copy. Two devices editing
  one character was enough: a `{mentionedCharacterIds}` PATCH read `description`, a `{description}`
  PATCH from elsewhere committed first, the claim passed because the *name* never moved, and
  `body.data.description ?? character.description` wrote the old prose back over the new. The
  transaction now opens with a `findFirst` on its own row under `libraryMentionInclude` and drives
  the update, `replaceLibraryMentions`, `survivingMentionIds` and `rewriteIncomingLibraryMentions`
  off that `live` read; a row that moved out from under it raises `CharacterRowMovedError` and
  retries. The outer read survives for the 404 and for the name the claim asserts, and nothing
  else — and that is now a `select`, `characterClaimSubject`, so the compiler is what refuses the
  next attempt to read prose off the stale snapshot rather than a comment asking nobody to. The asymmetry was the tell: `claimedMentionSource` already went to lengths to re-read every
  *other* character under the claim, and the route never re-read itself.
- **The text a character write screens is the text it stores, and the text the request typed is
  refused before anything is claimed — so each route screens twice.**
  `enforceContentRestrictions` ran on the outer snapshot, which stopped being what gets stored the
  moment the update was driven off `live`: a PATCH carrying only `mentionedCharacterIds`
  canonicalizes and writes `live.description` — prose saved on another device that this request
  never passed through the screener. So the assessment runs on the row the `update` is about to
  leave behind: the merge of `live` and the patch, screened under the claim but *before*
  `rewriteIncomingLibraryMentions` and `replaceLibraryMentions`, with the canonicalized prose
  re-screened only when canonicalization actually moved the string.
  **That is the only screen that can read those strings, and it is the wrong place for the refusal
  almost every refused request earns.** Held there alone, a description nothing was ever going to
  store first claimed the row, claimed every character whose description mentions it — up to 99 —
  rewrote the ones that moved and rolled all of it back, with every other character write on that
  account queued behind the lock window for the length of it; create paid for the row and its whole
  link set the same way. So both routes screen what the body carries *before* the transaction
  opens and screen the stored row inside it: the door answers the reader's own prose, the inner one
  answers everything the reader never typed. The door alone did not settle it, because the prose
  it cannot see is exactly the prose that was paying that bill — a PATCH refused on a description
  saved from another device kept claiming the 99 and rolling them back until the inner screen moved
  ahead of the rewrites. Moving it also put the ladder in `sendCharacterWriteError` back the way it
  is written: a request that is both content-refused and too long for a sibling's description now
  answers the 422 rather than the `CHARACTER_MENTION_TOO_LONG` 409 the rewrite used to raise on the
  way past. Neither is redundant and neither is the other's
  fallback — `characterContentScreen.test.ts` records **which string** each screen was given,
  because canonicalization is case-only and `assessContentRestrictions` lowercases, so the verdict
  cannot tell the two orderings apart and would not until a rule stops being case-blind.
  `name` is reasoned about field by field rather than screened as a blanket copy: the claim asserts
  it, so the screened name and the stored one are the same string by construction, and `appearance`
  and `fields` are only ever written from the body. What the transaction cannot do is *answer*:
  `assessContentRestrictions` is synchronous but the operator flag behind it is a query on another
  pool connection, so `copyrightRestrictionsEnabled` is read before the transaction opens rather
  than while it holds up to 99 sibling row locks — and awaited *beside* the route's own read in one
  `Promise.all`, because neither needs the other and both are charged against the client budget
  below. A refusal throws `ContentRestrictedError` — which rolls the mention writes back with it
  and leaves the 422 to the catch, where every other answer on this route is written. That class
  lives beside the screen in `apps/api/src/contentRestrictions.ts` and carries the whole refusal, so
  the wire `code` is derived once by `contentRestrictionCode`; the route never spells one. **`POST`
  held the rule wrongly for longer**: it screened `request.body` and then stored whatever
  `replaceLibraryMentions` canonicalized — a case-only respelling that today's case-blind rules
  cannot tell apart, which is exactly why nothing caught it and why the ordering is worth pinning
  rather than arguing. Both routes read the rule out of `characterContentScreen.ts`
  (`characterContentText` + `assertCharacterContentAllowed`), which also owns the throw. On create
  the row and its links are written *before* the inner screen — a mention needs a source row to hang
  off — so the rollback is what keeps a refusal from leaving half a character behind, the same thing
  it does for PATCH's sibling descriptions.
  **A refusal's `reason` reaches the reader only if the route's 422 schema names it.** —
  fast-json-stringify drops what the response schema omits, which is how all three character
  surfaces came to answer `{code, message}` while `enforceContentRestrictions` was building three
  fields. `contentRestrictedError` in `apps/api/src/contentRestrictions.ts` is that declaration —
  beside `sendContentRestricted` rather than with the other OpenAPI fragments in `mobile/schemas.ts`,
  because the body and the schema that lets it out only work together.
- **Both mention-rewriting transactions claim every source in one statement, and the timeout that
  survives their ceiling is a 503, not a conflict.** `LIBRARY_CHARACTER_LIMIT_PER_USER` is 100, so
  up to 99 characters can name one target, and `rewriteIncomingLibraryMentions` /
  `unlinkIncomingLibraryMentions` used to issue a claim, a re-read and a write per source — around
  300 serial round trips at the cap, 81 measured for thirty sources, inside Prisma's default
  5-second interactive transaction, which a perfectly valid rename could exhaust while holding a
  row lock on all 99 of them. They now cost **five statements, whatever the library holds**: the
  target's own `FOR UPDATE` below, then `incomingMentionSources` reads the set,
  `claimCharacterRows` claims it in a single row-locking `SELECT` whose tuples still name every row
  by id, owner and the name the read found — a short row count is a row that moved and raises
  `CharacterRowMovedError`, exactly as the per-row `false` did — and the same query then runs again
  under the claim, because a source's own links
  can only move under its own claim, so the re-read that keeps a concurrent PATCH from being
  overwritten is a set operation too. A row in only one of the two reads is skipped rather than
  written: one this transaction never claimed is the whole thing the claim exists to stop, and one
  that no longer links here has no link for the rename to follow. The fifth is the write itself:
  one `UPDATE … FROM unnest($ids::text[], $descriptions::text[])` carrying a description per row
  whose text actually moved — the idiom `claimCharacterRows` already uses, adopted because that
  write was the last of the three costs that still grew with the library, awaited once per changed
  row while all 99 were locked. The count is pinned in `libraryMentionRewrites.test.ts`, which is
  where it went when the mention suites split, because nothing about the result of either function
  says how many statements it took. `CHARACTER_MENTION_TRANSACTION_OPTIONS` is therefore
  `{ timeout: 10_000, maxWait: 5_000 }` rather than the `{ 30_000, 10_000 }` the loop needed — the
  shape `PAGE_RESTRUCTURE_TRANSACTION_OPTIONS` uses one package over, and a lock window before it
  is a budget: it is how long one rename can make every other character edit on that account wait,
  and it has to stay under the app's 20-second default receive timeout (`api_client.dart`, which
  these routes do not raise) or the 503 below is written after the device has already given up.
  **A ceiling on one transaction is not a ceiling on a request: the delete runs its lane twice,
  and the patch pays for two reads before it opens one.** The delete
  runs its lane twice — claim, then a stale-claim retry — so the pair shares
  `CHARACTER_WRITE_CLIENT_BUDGET_MS` through `characterRetryTransactionOptions(elapsedMs)`
  (`characterWriteBudget.ts`), which
  hands the retry what the first attempt left rather than a second full window. `PATCH /:id` opens
  one transaction and asks that same function what is left, because what it spends first comes out
  of the same 20 s: `characterClaimSubject` and `copyrightRestrictionsEnabled()`, the latter read
  out there precisely so it is not read while the transaction holds up to 99 sibling row locks.
  Sized against the ceiling alone it still opened the full 15 s behind them. Those two are now one
  `Promise.all` — neither needs the other, and two waits for a pool connection is exactly what the
  budget is spent on under the pressure it was written for. **The clock itself starts before
  `requireMobileAuth`, on every route that asks the function anything**: `characterWriteLane.ts`
  starts timed lanes before it calls the auth guard and exposes both elapsed time and fresh
  transaction options to the route body. The session lookup is a `MobileSession` query, a pool
  acquisition under that same pressure, so a lane started after it
  reported `elapsedMs ≈ 0` for seconds it had already spent and opened the full ceiling behind
  them. Reading the per-transaction ceiling as a per-request one is what put the 503 past the
  budget it was chosen to fit inside.
  **A budget too small to commit in buys no window at all.** `CHARACTER_RETRY_FLOOR_MS` used to be
  a clamp — a window under it was widened back up to the floor — and a clamp is the one arithmetic
  that can put the lane back over the budget everything above holds it to: a first attempt that
  spent its whole 15 s leaves 3 s, floored to 4.5 s, so the delete answered at ~19.5 s *plus* the
  liveness read, past the 18 s `CHARACTER_WRITE_RESERVE_MS` was sized to leave and at or over the
  app's 20 s receive timeout. Both halves of the floor's trade were being paid at once: a window too
  small for the claim and the unlink to commit in, **and** a `CHARACTER_EDIT_BUSY` written to a
  device that had already shown a bare network error. So `characterRetryTransactionOptions` returns
  `null` there and the route answers `sendCharacterWriteBusy` itself — the same 503, arriving while
  someone is still reading. It also makes the bound inductive rather than approximate: every window
  it hands out is what is left or less, so `elapsed + window` cannot pass the budget for any attempt
  of either lane.
  The status matters as much: P2028 is deliberately **not** in `isRetryableTransactionConflict`,
  because that predicate means "you lost a race, send it again now" and answering a timeout that
  way just burns another window — and P2028 also covers "transaction already closed", which is no
  race at all. `isTransactionTimeout` routes it to `sendCharacterWriteBusy`, a 503
  `CHARACTER_EDIT_BUSY` the app already surfaces through `_mapDioException` with no Dart change.
  **Three routes send that 503 and only two carry the ceiling.** `POST /api/mobile/characters`
  keeps Prisma's 5-second default on purpose: the ceiling exists to pay for work that grows with
  the library, and creation has none — it writes the row, one bounded read of the mentioned ids,
  the link set and the canonicalized description, a fixed handful of statements whatever the
  library holds. A wider window would buy that nothing and cost it something, because the ceiling
  is also how long a stalled attempt keeps its pool connection and the new row's lock. What
  creation did need is the *answer*: a `P2028` there used to fall through as a 500 for a character
  the reader typed correctly, so `isTransactionTimeout` is checked on that path too, above the
  `P2002` name-clash branch — a clash is something they have to fix and a timeout is not.
  **And it is checked there because there is one ladder and one catch, not three.**
  `sendCharacterWriteError` (`characterWriteConflicts.ts`) is every answer a failed character
  write gives, in one order — refusal, mention error, timeout, conflict, `P2002` — and
  `characterWriteLane.ts` calls it around the route body, returning when it answered and rethrowing
  what it does not recognise. The three old catches had drifted in every direction three copies
  allow: create knew the timeout rung and not the conflict one, delete neither the refusal nor the
  mention one, and only patch asked `namesMentionPrimaryKey` whether its `P2002` really named the
  library's own unique. The rung that matters next is the mention one —
  LOCATION and OTHER share `LibraryMention` with the cast (`REPLACED_MENTION_KINDS`), so a refusal
  taught to one catch would have answered 500 from the other two. The ladder imports the pure
  timeout/conflict classifiers from `characterWriteBudget.ts` and the Prisma/driver traversal plus
  LibraryMention predicates from `libraryMentionConstraintErrors.ts`; row locks and moved/lost-claim
  errors live separately in `characterRowClaims.ts`, so neither `libraryMentionRewrites.ts` nor
  `characterPhotoWrites.ts` reaches through the response module.
- **A wire code owns one sentence, and it lives with the code rather than at the call site.** The
  app snackbars `error.message` verbatim, so a reader who meets one wall from three gestures is
  told three different things about one state — which is what `PORTRAIT_IN_PROGRESS` had become:
  five sites (promote, the per-image delete, the portrait route's status guard and its own
  `PortraitInProgressError`, and `DELETE /:id` on a live claim) spelling three sentences, because
  the constant extracted during the route split was private to `routes/characterImages.ts` and the
  record route could not reach it. `sendPortraitInProgress` and `sendCharacterImageChanged` sit
  beside `sendCharacterEditConflict` and `sendCharacterWriteBusy` in `characterWriteConflicts.ts`
  for the same reason the ladder does: both route groups answer a character conflict, so the answer
  belongs to neither of them. The noun follows the **app's** vocabulary rather than the column's —
  `character_reference_copy.dart` says *illustration* wherever it addresses a reader, and
  `referenceWanted` calls "generate portrait" the secondary framing — while `portrait` stays in the
  wire code, the columns and the internal error class, because a shipped client recognises the code
  and renaming one buys nothing. And the sentence says what to do next: the block lifts when the
  job settles, so "try again when it finishes" is the whole recovery where "is already being drawn"
  is a snackbar nobody can act on.
- **An unreadable body is recognised by the parser that refused it, never by a bare 400.**
  `sendUnreadableBodyError` is installed as a route-level `errorHandler`, and Fastify calls that for
  every error the route's handler and hooks throw — not only for a body the content-type parser
  could not read. Keyed on `statusCode === 400` alone it rewrote *any* of them into
  `VALIDATION_ERROR` "That request could not be read.", so a domain error from `startGenerationAttempt`
  or `dispatchGenerationJob` on `POST /:id/portrait` reached the reader as a malformed body, with its
  own code and message gone and nothing logged — the handler never called `reply.send`. The predicate
  is now the parser's: a 400 whose `code` starts `FST_ERR_CTP_`, **or** whose error object is
  `request.raw.errored` — the one genuine parser failure with no CTP code, because `rawBody`'s
  `onEnd` stamps 400 onto whatever the payload stream threw (a client hanging up mid-body arrives as
  `ECONNRESET`). `request.body === undefined` is not the discriminator it looks like: a bodyless POST
  with no `content-type` reaches the handler the same way, and the portrait route reads
  `request.body ?? {}`, so that test would rebuild the bug on the route that motivated the fix. The
  400 gate is deliberate — `FST_ERR_CTP_BODY_TOO_LARGE` is 413 and `FST_ERR_CTP_INVALID_MEDIA_TYPE`
  is 415, no route installing this declares either, and translating them would answer "that photo is
  too big" with "could not be read". Those two still reach the app in Fastify's own
  `{statusCode, error, message}` shape rather than the mobile envelope.
- **One candidate set decides who owns a span, and the source's own name is not in it.** A
  description is scanned whole and the longest name wins a nested span, so the names in play at
  write time and at rename time have to be one set — or a span bound by one is invisible to the
  other. They were not: `claimingNames` added the source's own name, which the write never had. A
  character called "Luna Vega" linked to a "Luna", describing herself as "@Luna Vega is my hero and
  @Luna is my friend", bound both spans to Luna at save; renaming Luna to Nova then handed `[0,10)`
  to the longer "Luna Vega" and left it — "@Luna Vega is my hero and @Nova is my friend" — and
  deleting Luna left "@Luna Vega" naming nobody, inside text no later scan can reach, which is the
  exact failure the whole-set scan exists to prevent. `claimingNames` was the outlier, not the
  write: the editor resolves a description against the library **minus the character being edited**
  (`excludeCharacterId` in `library_mentions.dart`), so teaching the write side to bind the source's
  own name instead would make the server answer 400 "the description no longer contains @Luna" for
  a token the app is highlighting as Luna — a save the reader cannot fix. Write,
  `survivingMentionIds`, rename and delete now all read the description's own links through
  `libraryMentionCharacterRefs`.

- **A mention a save gives up takes its `@` with it, because the row it was bound to is the only
  record of where the marker sits.** `replaceLibraryMentions`' `deleteMany` clears the rows a new
  description no longer names, and a `deleteMany` over prose that keeps the token leaves an `@Mina`
  naming nobody — permanently, since every later scan is driven by the rows that statement just
  removed. `generationDescription` (`@book-maker/db`) then finds its name list and the surviving
  rows the same length, strips *by name*, and hands the raw token to the planner brief
  (`creationBuild.ts`) and to `buildLibraryCharacterPortraitPrompt`, which is the one place a UI
  token must never reach. Deleting a character already strips its markers out of every other
  description (`unlinkIncomingLibraryMentions`); dropping one out of your own is the same event
  from the other end and gets the same answer — the marker goes, the reader's own spelling stays as
  ordinary prose. Nothing upstream can stand in for it, because
  `{mentionedCharacterIds: []}` carries no description at all and so there is no edit to have taken
  the tokens out. **The strip runs before the canonicalizing scan and is handed the survivors as
  `siblings`**, so the two passes cannot disagree about a span: one pass over dropped ∪ kept keeps
  "@Luna Vega" as Vega's and takes only the "@Luna" beside it, and once a dropped name has no `@`
  left the kept set really is the whole candidate set for the prose that remains. Stripping after
  canonicalizing is the same two scans asking different questions of one span — a longer dropped
  name would take the marker off a link this write is *storing*. The one set the single scan cannot
  bind is refused rather than read a second way: a kept target whose only token is the prefix of a
  dropped name ("@Luna Vega" kept as Vega, sent as Luna) comes back `missing` and answers 400
  `INVALID_CHARACTER_MENTION`, where binding it to the nested span is the bug the whole-set scan
  exists to prevent. No shipped client can send such a set — the editor resolves against the whole
  library, longest name first — and the derived path cannot either, since `survivingMentionIds`
  selects from the same rows under the same names. The read that finds the dropped targets is the
  one `mentionLinksAlreadyStored` was already taking; it moved ahead of the validating scan because
  the drop decides what that scan is handed, so a refused save pays one indexed read inside a
  transaction that rolls back anyway.

- **A mention row's kind is required, and one that arrives without it is nobody.** Location and
  Other share `LibraryMention` with the cast, so the kind is the only thing separating a character
  from a place — and `isCharacterMention` used to read a missing `targetKind` as CHARACTER. That
  was safe only while CHARACTER was the sole kind: a narrower `select` that forgets the column
  turns a location into a cast member, which earns it a reference sheet and puts it in front of the
  planner as a person. Nothing made the compiler say so, and `incomingSourceSelect` had to be
  widened by hand to prove it. `LibraryMentionRow.targetKind` is therefore **required** — an
  omitting `select` no longer compiles — and the runtime answer for a row that gets past the type
  anyway is *not a character*, never the other way round. `claimingNames` takes the shared
  `LibraryMentionRows` for the same reason: the hand-rolled copy of that shape it used to declare
  was laxer than the real one, so it would have swallowed the error at the one call site that had
  to see it. `packages/db/src/libraryMentions.test.ts` pins the type with a `@ts-expect-error` that
  fails the build if the field goes optional again. What the kind still cannot buy is a **name**:
  `LibraryMention_target_arc` forces `targetCharacterId IS NULL` for both other kinds and there is
  no table to join in their place, so `libraryMentionNames` and `libraryMentionCharacterRefs`
  return the same rows today, `generationDescription` leaves a marker it cannot name where the
  reader put it, and `libraryMentionRefs` withholds such a row rather than shipping it with an
  empty name. Those joins landing in `libraryMentionInclude` is the one change that lifts all four.

- **A claim that writes a row's own value back does not lock it against being mentioned, so the
  mention rewrite takes the `FOR UPDATE` itself.** `claimCharacterRow` and `claimCharacterRows` both
  assert a row by writing a column it already holds, and Postgres escalates an `UPDATE` to
  `FOR UPDATE` only when a key column's value **actually changes** — `heap_update` compares old
  against new, it does not read the `SET` list. Measured against the dev database: with
  `SET name = name` held open, a concurrent `LibraryMention` insert naming that row **succeeds**;
  with `SET name = 'Anita'` it blocks. So both claims take `FOR NO KEY UPDATE`, which is exactly the
  mode `FOR KEY SHARE` — the lock an FK check takes — was designed not to wait behind. That left
  `claimedMentionSources` deriving its whole source set from an unlocked read, and claiming *nothing
  at all* when that read came back empty: a DELETE could see no mentions, a concurrent PATCH could
  commit `"Best friends with @Ana."` plus its link row, and the delete's cascade would then take
  that row away and leave `@Ana` in another character's stored prose with nothing behind it —
  dangling permanently, in text nothing will scan again, naming somebody nothing can now identify.
  `lockMentionTarget` takes a real `SELECT … FOR UPDATE` on the target before the snapshot read, so
  no transaction can *begin* mentioning it while the rewrite holds it; that is what turns the empty
  short-circuit from "nobody had committed one yet" into "nobody mentions this, and nobody can
  start to". Both lanes go through `claimedMentionSources`, so the rename window closes in the same
  place. The cost is priced and accepted: the lock order is target-then-sources while a PATCH of a
  source claims itself first, so two writes over the same pair can deadlock — Postgres detects it,
  reports `40P01`, and `isRetryableTransactionConflict` already answers that as a retryable 409. A
  detected collision the app re-sends, in exchange for a marker nothing can repair.

- **A lock is not a write, and a claim that writes stamps a clock from before it waited.**
  `claimCharacterRows` was an `UPDATE` writing each row its own `userId` back, and taking an
  explicit `data: { updatedAt: new Date() }` out of it fixed nothing, because **`@updatedAt` is
  stamped when Prisma *builds* the statement, not when Postgres runs it**: it compiles to
  `UPDATE … SET "userId" = $1, "updatedAt" = $2` and binds `$2` from the client's clock before the
  query is sent. Measured: a claim issued at `T` and blocked 4.0 s on a real row lock wrote
  `T + 20 ms`. A claim is the one statement here that routinely waits, so a rename claiming 99
  siblings stamped `t0`, queued behind a PATCH of sibling B that committed `t1 > t0`, and landed
  `t0` over it — and that column is not bookkeeping, `character_avatar.dart` spends it as the
  portrait URL's `v=` cache-buster, so the device kept bytes it already had and a portrait replaced
  in that window stayed stale until something else edited B. It is now a
  `SELECT … FOR NO KEY UPDATE`, which gives both things the claim actually wanted — the row lock,
  and a predicate re-evaluated once the lock is granted — while touching nothing.
  `FOR NO KEY UPDATE` and not `FOR UPDATE`, deliberately: it is the mode the `UPDATE` already took,
  and the stronger lock would start blocking the `FOR KEY SHARE` of every `LibraryMention` insert
  against claims that do not conflict with them. The comparison is row-wise —
  `("id", "userId", "name") IN (SELECT * FROM unnest(…))` — because matched column by column a
  character renamed into a name another row of the same claim was read under satisfies every term
  and is reported as a row this claim holds; `[userId, name]` is unique so it takes two renames to
  arrange, and the window is ten seconds. Measured on the statement as written: the borrowed-name
  set matches zero rows where the column-wise spelling matches both.

- **A mention target deleted mid-write is a 404, not a stack trace.** `mentionedTargets` reads its
  targets with no lock, so one deleted between that read and the `createMany` below it violates
  `LibraryMention_targetCharacterId_fkey` — SQLSTATE 23503, Prisma `P2003`. `sendCharacterWriteError`
  recognised `ContentRestrictedError`, `LibraryMentionError`, `P2028`, `40P01`, the CHECKs and
  `P2002` and nothing else, so the route rethrew and a whole character save was lost to a 500 — for
  an ordinary concurrent-delete race whose answer, `CHARACTER_NOT_FOUND` with `mentionedTargets`'
  own sentence, was already implemented one rung up. The rung sits below the typed
  `LibraryMentionError` (that one knows *which* id went and reads no constraint name to find out)
  and above `P2002`; the three constraint rungs are disjoint by SQLSTATE, so their order among
  themselves is grouping rather than precedence. It fires on a `LibraryMention…_fkey` constraint
  name, or on `23503`/`P2003` that also mentions `LibraryMention` — both FKs on that table point at
  `LibraryCharacter`, so any 23503 naming it *is* a character that went away, while
  `LibraryCharacter_userId_fkey` stays a 500. Note the shape this reads: on Prisma 7.8 with
  `@prisma/adapter-pg` the SQLSTATE arrives under `meta.driverAdapterError.cause`, and every rung
  that needs it reads one `constraintErrorText` (`libraryMentionConstraintErrors.ts`) — the single
  record of where an adapter
  puts a SQLSTATE, which `characterPhotoWrites.ts` borrows for its own deleted-character rung
  rather than keeping a second copy. It was three copies of that traversal, and one of them was
  not a copy: `namesMentionCheckConstraint` read `meta.code` and `meta.column_name` and never
  walked the adapter cause at all, so a CHECK reported the way a foreign key is reported was
  invisible to it. The shared text is the union of what the three read, so no predicate narrowed;
  the CHECK rung widened onto the shape it had been blind to.

- **Where two answers are told apart by one exact test and one piece of prose, the prose speaks
  last.** `isTransactionTimeout` sits above the conflict rung and falls back to matching
  `/transaction already closed|expired transaction/i` over any error's `message`, so a wrapper error
  quoting that phrase while reporting a serialization failure was answered `CHARACTER_EDIT_BUSY`
  ("try again in a moment") instead of `CHARACTER_EDIT_CONFLICT` ("open it again and retry") — the
  two sentences this module exists to keep apart. Two narrowings, neither of them a tighter phrase
  (the fallback exists for shapes nobody can enumerate, so anchoring the prose only moves the
  guess): `isRetryableTransactionConflict` is asked after the exact `P2028` test and **wins**,
  because every test it makes is exact; and an error carrying any `code` other than `P2028` never
  reaches the string at all, because a coded error has already said what it is.

- **A create tells the link writer it is new, and only the read is allowed to believe it.**
  `mentionLinksAlreadyStored` exists because the common save changes prose and no links, and
  re-writing an unchanged link set is two statements for nothing — but that is a PATCH property. On
  `POST /characters` the `sourceCharacterId` was created moments earlier in the same transaction, so
  the query can only ever return zero rows: a round trip inside the transaction holding the new
  row's lock, decided by the length check alone. `replaceLibraryMentions` therefore takes
  `sourceCreatedInThisTransaction`, and only the **read** is skipped — the `deleteMany` still runs.
  A wrongly-passed flag that skips the read still performs a correct full replace; one that skipped
  the delete would hit `createMany` on its own primary key. Absent is the safe default.

- **A route's declared statuses are what its own handler can reach in the shared ladder, never the
  ladder's full set of rungs.** Routing three catches through one `sendCharacterWriteError` means
  the ladder can answer things a given route never declared: `DELETE /characters/:id` declared
  `{401, 404, 409, 503}` while the ladder could hand it a 400 or a 422, and none of the three
  declared the 429 `hitAuthenticatedLimit` emits. Fastify falls back to the default serializer so
  no field is dropped, but `/docs` then documents a set the handler does not have — the same class
  of mismatch the `contentRestrictedError` schema work exists to close. The maps are now audited per
  route against what that handler can actually throw, which cuts both ways: DELETE gained the 429
  and deliberately **not** the 400 or 422, because it screens no content and writes no
  `LibraryMention` row, so neither has a statement in that lane to come out of. Declaring a refusal
  a route cannot give is the same lie as omitting one it can.

  The picture routes in `routes/characterImages.ts` are audited to the same standard, and every
  gap there ran the one way — a rung the handler reaches and the map left out. All four rationed
  ones — promote, the per-image delete, the photo upload, the portrait — omitted the 429 their
  limiters emit, and `PUT /:id/photo` and `POST /:id/portrait` omitted the 400 they send
  themselves. The other five gained nothing: the four byte-and-list reads and the legacy
  `DELETE /:id/photo` ration nothing and refuse nothing past the 404 they already declared. The
  portrait route is also where the fallback stops being free. It documents a body, so ajv used to
  answer a short `requestId` before the handler ran — and Fastify cannot push its own
  `{ statusCode, error, message }` through a declared `mobileAuthError`, so naming the 400 turned
  that reply into a 500 (`FST_ERR_FAILED_ERROR_SERIALIZATION`). Declaring a status means owning
  every reply served at it: the route now carries `attachValidation: true` like every other mobile
  route with a documented body, which leaves the zod parse as the only gate and its
  `VALIDATION_ERROR` as the only 400.

## Voice and audiobook routes

- **A voice call's audio never reaches the server.** The app opens its own socket to Gemini with
  an ephemeral token the API mints, so the only transcript we have is the one the app uploads —
  in batches, on the heartbeat it is already sending, because the captions on screen are a capped
  display buffer and a call that dies with the app never sends an end. It lands in
  `VoiceCall.transcript`, and `apps/api/src/mobile/voiceCallHistory.ts` reads the last calls back
  into the next one's system instructions. That is *memory, not resumption*: every call is a fresh
  session, and the prompt says so in as many words. Uploads are at-least-once, so the append drops
  the overlap when a retried batch arrives twice.
- **Restarting a failed narration resumes it; that is a property of the route, not the worker.** The
  worker has always skipped READY chapters, but `POST /api/mobile/projects/:id/audiobook` used to
  delete and recreate the `Audiobook` row every time, so the skip never had anything to skip. It now
  reuses a FAILED row when the voice and `contentRevision` still match — any other change is a
  different audiobook and starts clean. The dedupe key names the run being resumed, because reusing
  the audiobook id alone would match the failed job's row and enqueue nothing at all.
