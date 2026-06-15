# Phase 04 - Project Ownership, Assets, And Data Boundaries

## Objective

Make project data, generated books, images, voice assets, and exports safe for multiple mobile users.

## Current Context

The existing database has projects, pages, images, plans, jobs, research, provider logs, and voice data. These must become user-owned before public app launch.

## Implementation Tasks

1. Add ownership:
   - Add `Project.userId`.
   - Add indexes for user project lookup.
   - Migrate existing data to a default local/admin user if needed.
2. Enforce ownership in APIs:
   - Project list.
   - Project details.
   - Plan actions.
   - Generation actions.
   - Export actions.
   - Voice and image asset actions.
3. Secure asset serving:
   - Cover images.
   - Page images.
   - Character reference images.
   - PDF and EPUB downloads.
   - Voice files if exposed later.
4. Add deletion behavior:
   - Delete project.
   - Delete project assets from storage where practical.
   - Preserve required billing/provider logs only if needed and documented.
5. Add account data boundaries:
   - Users cannot discover project IDs belonging to others.
   - Users cannot infer asset paths belonging to others.
   - Admin/local diagnostics must be explicitly protected.

## Acceptance Criteria

- A user cannot read another user's project by ID.
- A user cannot download another user's PDF, EPUB, image, or voice asset.
- Project list returns only the signed-in user's projects.
- Existing worker jobs still process projects correctly after ownership is added.
- Project deletion behavior is documented.

## Tests

- API ownership tests using two users.
- Asset authorization tests using two users.
- Export authorization tests.
- Project deletion tests.
- Worker regression tests for owned projects.
- Run `pnpm typecheck`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 05 should define mobile-friendly APIs and product presets. Do not expose internal generation controls directly to Flutter.
