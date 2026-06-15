# Phase 02 - Monorepo And Flutter Architecture Foundation

## Objective

Prepare the repository for a Flutter mobile app while preserving the existing TypeScript backend monorepo.

## Architecture Direction

- Flutter app path: `apps/mobile`.
- Backend remains:
  - `apps/api`
  - `apps/worker`
  - `packages/core`
  - `packages/db`
- Mobile app calls backend APIs.
- Backend owns generation, exports, billing verification, entitlements, and asset authorization.

## Implementation Tasks

1. Document the mobile architecture in `docs/google-play-flutter-launch/mobile-architecture.md`.
2. Decide Flutter package choices:
   - State management.
   - HTTP client.
   - Secure token storage.
   - Routing.
   - Local app configuration.
3. Define environment model:
   - Local API.
   - Staging API.
   - Production API.
4. Decide how API contracts flow to Flutter:
   - Generated OpenAPI client if practical.
   - Otherwise manually typed DTOs with contract tests.
5. Define the intended `apps/mobile` folder structure:
   - `lib/app`
   - `lib/features/auth`
   - `lib/features/projects`
   - `lib/features/billing`
   - `lib/features/account`
   - `lib/shared/api`
   - `lib/shared/ui`
6. Add root documentation or scripts only if needed for later agents.

## Acceptance Criteria

- The repo architecture is documented before Flutter scaffolding.
- Later agents know where Flutter code goes.
- Later agents know how the Flutter app talks to the backend.
- Environment naming is consistent.
- No backend rewrite is proposed.

## Validation

- Run `git status --short`.
- If Flutter is scaffolded in this phase, run `flutter --version` and document the version.
- If no code is scaffolded, confirm documentation-only changes.

## Handoff Notes For Next Phase

Phase 03 should focus on real backend user accounts and auth. Do not rely on the current single password web auth for a Play Store app.
