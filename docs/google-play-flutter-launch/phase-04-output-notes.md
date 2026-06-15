# Phase 04 Output Notes

## Completed

- Added required `Project.userId` ownership with indexes for user-scoped project lookup.
- Added project, plan, export, image asset, voice asset, voice character, voice conversation, status, event, and deletion authorization through project ownership.
- Replaced direct static image and voice serving with ownership-aware `/assets/images/:projectId/:filename` and `/assets/voice/:projectId/:filename` routes.
- Added `DELETE /api/projects/:id` for owned projects.
- Preserved local/operator access through the existing `WEB_PASSWORD` cookie flow while keeping mobile bearer sessions separate.

## Decisions

- Legacy and local/operator projects are assigned to a deterministic local admin user: `local-admin@ai-book-maker.local`.
- The Phase 04 migration creates or updates that user, backfills existing `Project` rows, then makes `Project.userId` required.
- Local/operator requests without a mobile bearer token operate as the local admin user. Mobile bearer requests operate as the signed-in mobile user.
- Cross-user project, export, image, and voice asset requests return `404` so project IDs and asset paths are not discoverable.

## Project Deletion Behavior

- Deleting a project first attempts to stop queued/active generation jobs.
- The project row is then deleted, letting project-owned rows cascade according to Prisma/database relations.
- Project storage folders are deleted on a best-effort basis from:
  - `BOOK_STORAGE_DIR/:projectId`
  - `IMAGE_STORAGE_DIR/:projectId`
  - `VOICE_STORAGE_DIR/:projectId`
- Provider call logs are retained for cost/provider diagnostics. Database delete rules clear project/job references where applicable.

## Known Follow-Ups

- Phase 05 should shape mobile-friendly project APIs and presets on top of these ownership checks instead of exposing current operator-level controls directly.
- Account deletion and formal data export/delete policy can build on the same ownership boundary in later compliance phases.

## Validation

- `pnpm db:generate`
- `pnpm typecheck`
- `pnpm test`
