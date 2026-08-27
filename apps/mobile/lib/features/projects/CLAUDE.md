# Projects feature

The largest feature in the app (83 files, ~27k lines): the projects home, the creation chat, the
book screen, the project chat, and the plan surfaces. Layered `data/` → `domain/` → `presentation/`
like every other feature.

`data/` is deliberately thin — `projects_repository.dart`, `creation_repository.dart`,
`export_repair_watch.dart`, `creation_prefs_store.dart`. Riverpod providers live inside those
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
which the shared watch deliberately does not.

## Quoting credits in the app

The Effort picker quotes the **plan now** and a **writing rate**, not one blended total
(`estimatePlanGenerationCredits` and `_writingCreditsPerPage` in `creation_chat_sheets.dart`):
planning is charged when Build starts, the page count is still "auto" while a reader is choosing
effort, and images are a separate switch priced per image (`_imageCredits`). Folding any of
those together would make one number answer for independent choices. The writing rate is the
whole quote for a book with *no* generated images divided by its pages, so the rates still
compare the way the later approval bill will.
The app **re-implements both formulas in Dart** (`estimatePlanGenerationCredits` and
`estimateProjectCredits` in `project_models.dart`, which mirror `planGenerationCreditCost` and
`tierPrice` in `_tierCost`) and there is no server quote route to fall back on, so the two
must move together — which is why both sides spell their totals out in tests rather than
deriving them from the price table. The app picks its tier off the project DTO's
`qualityPreset`, which `qualityPresetForProject` fills in from the tier when the mobile echo is
missing; do not add a `modelTier` field beside it, because the mobile responses' leak guard
rejects any wire key containing "model".

## The creation chat

- **The Flutter creation chat screen is one library split with `part` files**
  (`creation_chat_screen.dart` plus `creation_chat_*.dart`). Part files have no imports of their
  own; add imports to the parent. This keeps the `_Private` widgets private. The @-mention
  affordance (`creation_chat_mentions.dart`) derives its state from the composer text alone —
  clearing the composer clears the mentions — and one strip serves both chat stages because the
  composer does.
