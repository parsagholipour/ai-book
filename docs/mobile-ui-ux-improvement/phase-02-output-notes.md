# Phase 02 Output Notes

## Completed

- Reworked home hierarchy around user state:
  - new users see `Start your first book` with one dominant start action,
  - returning users see projects grouped by recommended next action,
  - books needing input appear before background/in-progress books.
- Added home project next-action mapping for draft, outline-ready, generating, complete/export-ready, and failed projects.
- Rewrote project card status and action copy to avoid backend status/current-action labels.
- Made credits quieter on home by showing available book credits, a short use explanation, and a secondary add-credits action.
- Removed logout from the home app bar and added it to Account under a low-priority Session card.
- Added route-aware project error handling for missing, deleted, or inaccessible project links with a `Back to projects` recovery action.
- Updated unknown route copy to send users back to projects.
- Added widget coverage for:
  - empty home first-project state,
  - mixed-status home sorting and user-facing action labels,
  - light, dark, and increased text-scale home rendering,
  - missing project route recovery.

## UX Decisions

- Home uses client-side presentation mapping for next-action ranking while the backend remains authoritative for project status, generation, ownership, billing, credits, entitlements, and asset access.
- `Book credits` stays visible on home, but reserved/spent/export-unlock metrics were removed from the home summary because they competed with the creative path and sounded internal.
- Returning-user project groups prioritize failed projects, outline review, outline creation, and ready exports before background writing/planning work.
- Project cards show book type, length preset, visuals, pages, and export readiness only when useful for deciding what to open next.
- Missing/deleted/unauthorized project routes intentionally use privacy-preserving language: the app does not distinguish between deleted, moved, or inaccessible books.

## Known Follow-Ups

- Phase 03 should extract shared card, pill, notice, and route-error primitives if the same patterns are needed across plan, progress, billing, and account screens.
- Phase 03 should continue deeper accessibility checks for screen-reader labels and dense card behavior beyond the home render smoke test.
- Phase 05 and Phase 06 should align detail/progress next-action copy with the new home labels.
- Phase 07 should continue credit-language work inside approval, export, and paywall flows.
- A true Android manual pass is still needed once an emulator or device is available.

## Validation

- `flutter analyze` from `apps/mobile`: passed, no issues found.
- `flutter test` from `apps/mobile`: passed, all tests passed.
- Focused home tests: `flutter test test/projects/projects_home_ia_test.dart` passed.
- Practical home visual coverage: widget-rendered home in light theme, dark theme, and 1.5x text scale with no widget exceptions.
- `flutter devices`: no Android emulator or physical Android device was connected. Only Linux desktop and Chrome web targets were available, so a true Android manual home check was not run in this environment.
