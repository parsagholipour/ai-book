# Phase 09 - Generation Progress, Preview, Editing, And Export

## Objective

Complete the core value loop after plan approval: generation progress, preview, light editing/regeneration, and export/share.

## Product Flow

The user should feel that the book is being built step by step:

- Planning.
- Writing.
- Illustrating if enabled.
- Reviewing.
- Preparing exports.
- Ready to preview and share.

## Implementation Tasks

1. Build progress screen:
   - Poll or subscribe to status.
   - Show readable current step.
   - Show progress percent.
   - Show retry option for recoverable failures.
2. Build preview:
   - Cover preview.
   - Text preview.
   - PDF preview or file open action.
   - EPUB availability.
3. Add light editing controls:
   - Regenerate cover.
   - Ask for final polish if entitlement allows.
   - Regenerate a chapter or section only if backend supports it.
   - Keep deeper editing out of v1 if backend support is not ready.
4. Add export/share:
   - Download PDF.
   - Download EPUB.
   - Android share sheet.
   - Clear paid/export lock state if needed.
5. Add failure recovery:
   - Resume failed generation.
   - Retry failed planning/export where supported.
   - Show friendly error messages.

## Acceptance Criteria

- A user can go from approved plan to generated preview.
- A user can see meaningful generation progress.
- A user can export/share PDF or EPUB when entitled.
- Export endpoints are still protected by backend ownership and entitlement.
- Failed generation is recoverable where backend supports it.

## Tests

- Flutter tests for progress states.
- Flutter tests for export locked/unlocked states.
- Backend tests for export entitlement.
- Manual Android test with `MOCK_AI=true`.
- Manual small real-provider test before release.
- Run `flutter analyze`.
- Run `flutter test`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 10 should add Google Play Billing and paywalls around the working value loop. Do not add payment UI before export and credit gates work.
