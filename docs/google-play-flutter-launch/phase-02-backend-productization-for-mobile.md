# Phase 02 - Backend Productization For Mobile

## Objective

Turn the existing local/single-user backend into a mobile-product backend that supports real users, ownership, app-safe authentication, quotas, and stable mobile-facing APIs while preserving the current TypeScript monorepo structure.

## Current Context

The current API already exposes projects, planning, generation, exports, runtime metadata, voice providers, and assets. It currently has simple password-based web auth suitable for local/private use. The database has project, page, plan, image, job, provider log, and voice-related models, but no full user/account/subscription domain yet.

## Key Backend Decisions

- Keep Fastify in `apps/api`.
- Keep BullMQ worker in `apps/worker`.
- Keep Prisma in `packages/db`.
- Keep generation and schema logic in `packages/core`.
- Add product/account concepts to the existing backend rather than creating a separate backend service.
- Mobile users must only access their own projects and assets.
- All paid or costly actions must pass entitlement and quota checks before jobs are enqueued.

## Implementation Tasks

1. Add account ownership:
   - Add `User` model.
   - Add `Project.userId`.
   - Add indexes for user project lookup.
   - Migrate existing local projects to a default/admin user if needed.
2. Replace mobile-facing auth:
   - Add email/password or passwordless email auth.
   - Use short-lived access tokens plus refresh tokens, or secure server sessions compatible with Flutter.
   - Keep the existing `WEB_PASSWORD` flow only for local/admin console if still useful.
3. Add mobile-safe project APIs:
   - `GET /api/mobile/projects`
   - `POST /api/mobile/projects`
   - `GET /api/mobile/projects/:id`
   - `GET /api/mobile/projects/:id/status`
   - `POST /api/mobile/projects/:id/plan`
   - `POST /api/mobile/plans/:id/revise`
   - `POST /api/mobile/plans/:id/approve`
   - Export endpoints that verify ownership before serving files.
4. Add entitlement and cost guardrails:
   - Add `CreditLedger` or equivalent.
   - Add per-action estimated credit cost before generation.
   - Block generation if the user has insufficient credits or plan entitlement.
   - Log actual provider cost as already supported by provider call logs.
5. Add app-facing DTOs:
   - Hide raw provider/model details from normal mobile users.
   - Replace technical generation settings with product presets: `fast`, `balanced`, `premium`.
   - Return user-readable progress and next actions.
6. Add API contract generation:
   - Prefer OpenAPI output from Fastify if already available.
   - Document how Flutter clients should consume generated or manually typed contracts.
   - Keep DTO names stable and versionable.

## Acceptance Criteria

- A real mobile user can sign up/sign in.
- Every project belongs to a user.
- A signed-in user cannot read or export another user's project.
- Project creation accepts product-level presets instead of raw internal model settings.
- Costly actions are denied when the user lacks credits or entitlement.
- Existing web/operator console still works for local development or is explicitly adjusted with documentation.

## Tests

- Unit tests for auth token/session verification.
- API tests for project ownership boundaries.
- API tests for insufficient credits.
- API tests for successful project creation and planning enqueue.
- Regression tests for existing export endpoints.
- Typecheck all packages with `pnpm typecheck`.
- Run backend tests with `pnpm test`.

## Handoff Notes For Next Agent

Phase 03 should create the Flutter app skeleton only after mobile auth and DTOs are stable enough to integrate against.
