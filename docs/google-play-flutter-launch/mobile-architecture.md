# Mobile Architecture

Phase 02 documents how the Flutter app should enter the existing monorepo. No Flutter scaffold exists yet in this repository, so this is a documentation-only architecture foundation for later phases.

## Current Repo Shape

The existing product is a TypeScript monorepo with these active boundaries:

- `apps/api`: Fastify API. It serves `/api/*`, static generated assets, Swagger UI at `/docs`, and the existing local web build.
- `apps/worker`: BullMQ worker. It owns planning, page generation, image generation, cover generation, review, and export compilation jobs.
- `packages/core`: Shared TypeScript generation logic, product/category schemas, provider adapters, cost helpers, export rendering, and config loading.
- `packages/db`: Prisma schema, generated Prisma client, database connection, and seed code.
- `apps/web`: Existing Vite React web console. It is not the mobile architecture source of truth, but it is useful as a reference for current endpoint behavior.

`apps/mobile` does not exist yet. When created, it should be a Flutter app that calls the Fastify API. It must not import TypeScript packages, access Prisma directly, run generation locally, or become a second backend.

## Architecture Decision

Add Flutter under `apps/mobile` and keep the TypeScript backend in place:

```text
apps/mobile  --->  apps/api  --->  packages/db
      |               |
      |               +------> apps/worker through BullMQ/Redis
      |
      +------ local secure token storage, routing, mobile UI, downloads, share sheet

packages/core stays TypeScript-only backend/shared-server logic.
packages/db stays server-only database access.
```

Backend responsibilities remain server-side:

- user auth and token issuance
- project ownership and asset authorization
- generation, queueing, progress, exports, and cost tracking
- credit and entitlement enforcement
- Google Play purchase verification
- safety, moderation, and report/flag handling

Flutter responsibilities are client-side:

- auth session state and secure token storage
- guided project creation UI
- API calls and polling or event subscriptions
- local form state, optimistic UI where safe, downloads, sharing, and Google Play Billing client flows
- presenting only buyer-facing presets, not provider/model/temperature/queue internals

## Flutter Package Choices

Use these defaults when Phase 07 scaffolds `apps/mobile` unless a later phase documents a reason to change them.

| Area | Choice | Reason |
| --- | --- | --- |
| State management | `flutter_riverpod` | Keeps app state testable and composable without a heavy framework. Use providers/notifiers for auth session, project lists, project detail, billing entitlement state, and feature-level form state. |
| HTTP client | `dio` | Mature interceptors, cancellation, timeouts, file downloads, and good compatibility with generated OpenAPI clients. Configure one shared client in `lib/shared/api`. |
| Secure token storage | `flutter_secure_storage` | Stores access and refresh tokens in Android Keystore/iOS Keychain. Do not store provider keys, billing secrets, or generated book assets as secrets in the client. |
| Routing | `go_router` | Supports declarative routes and auth-aware redirects for signed-out, onboarding, project, billing, and account flows. |
| Local app configuration | Flutter `--dart-define` values parsed by a typed `AppConfig`; no runtime `.env` package by default | API base URLs and environment names should be compile-time build inputs. Client builds must not ship secrets, provider keys, or mutable production config files. |

Recommended supporting packages once code exists:

- `json_annotation`, `json_serializable`, and `build_runner` for manually typed DTOs if OpenAPI generation is not ready.
- `freezed` only where immutable unions materially improve feature state or API models; do not make it mandatory for every object.
- `in_app_purchase` later for Google Play Billing client flows, with all purchase verification enforced by the API.

## Environment Model

Use one explicit mobile environment name everywhere:

- `local`
- `staging`
- `production`

Flutter config should expose:

```dart
enum AppEnvironment { local, staging, production }

class AppConfig {
  final AppEnvironment environment;
  final Uri apiBaseUrl;
}
```

Build-time values:

- `APP_ENV`: one of `local`, `staging`, `production`.
- `API_BASE_URL`: absolute HTTPS URL for staging/production; local may use HTTP.

Local behavior:

- Default `APP_ENV=local`.
- Android emulator API URL should be `http://10.0.2.2:4001`.
- Physical devices should use the developer machine LAN URL, for example `http://192.168.x.x:4001`.
- Local builds may talk to `MOCK_AI=true` backend runs.
- Local debug builds may use HTTP. Release builds must not silently fall back to local URLs.

Staging behavior:

- `APP_ENV=staging`.
- API URL must be a TLS endpoint for the staging deployment.
- Staging should use separate database, Redis, storage, app signing/testing tracks, billing test products, and analytics/project identifiers.
- Staging can run test billing and lower provider limits, but it should exercise real auth, ownership, entitlement, and asset authorization behavior.

Production behavior:

- `APP_ENV=production`.
- API URL must be a production TLS endpoint.
- No `MOCK_AI`, no local fallback, no debug auth bypass, and no test billing products.
- Backend must enforce ownership, credits, entitlements, safety, and asset access regardless of what the Flutter client sends.

The current backend already uses `PUBLIC_API_URL` for server-generated asset URLs and defaults the local API to `http://localhost:4001`. Flutter should use its own `API_BASE_URL` build value instead of reading backend `.env` files.

## API Contract Flow

Preferred direction: generated OpenAPI client.

The API already registers `@fastify/swagger` and serves docs at `/docs`, but current routes mostly parse Zod schemas inside handlers instead of declaring route-level OpenAPI request/response schemas. That means generated client output is not yet reliable enough to treat as the mobile contract.

Target contract flow for Phase 05:

1. Add or generate route-level OpenAPI schemas for mobile-facing endpoints in `apps/api`.
2. Export a stable OpenAPI document from the API, for example `openapi.json`.
3. Generate a Dart client into `apps/mobile/lib/shared/api/generated`.
4. Configure the generated client to use `dio`.
5. Keep generated code isolated from handwritten repositories/services.

Fallback direction: manually typed DTOs with contract tests.

If generated OpenAPI is not practical for the first mobile API slice, define handwritten request/response DTOs in `apps/mobile/lib/shared/api/dto` and back them with contract tests:

- API-side tests should use Fastify injection to produce representative JSON fixtures for mobile-facing endpoints.
- Flutter tests should decode those fixtures into DTOs and fail on incompatible shape changes.
- Contract fixtures should cover success and expected error payloads.
- DTOs should describe mobile-safe product presets, project summaries, status/progress, export availability, auth session, entitlements, and account data. They should not expose raw provider/model/temperature controls to normal mobile users.

The backend remains the source of truth in both approaches. Flutter types are a client projection of API contracts, not a copy of Prisma models.

## Intended `apps/mobile` Structure

When Flutter is scaffolded, use this structure:

```text
apps/mobile/
  android/
  ios/
  lib/
    main.dart
    app/
      app.dart
      bootstrap.dart
      config/
        app_config.dart
      routing/
        app_router.dart
      theme/
        app_theme.dart
    features/
      auth/
        data/
        domain/
        presentation/
      projects/
        data/
        domain/
        presentation/
      billing/
        data/
        domain/
        presentation/
      account/
        data/
        domain/
        presentation/
    shared/
      api/
        api_client.dart
        auth_token_store.dart
        dto/
        generated/
      ui/
        components/
        feedback/
        layout/
```

Feature boundaries:

- `lib/app`: bootstrapping, global providers, router, theme, environment config, and app-level error handling.
- `lib/features/auth`: sign-in, registration, token refresh/logout, and auth state. This must target Phase 03's real mobile auth, not the current single shared web password cookie.
- `lib/features/projects`: project list/detail and later prompt-to-plan, plan revision, preview, progress, export, and sharing workflows.
- `lib/features/billing`: Google Play Billing client integration, purchase state UI, and calls to backend verification/entitlement endpoints.
- `lib/features/account`: profile, settings, account deletion, privacy/support/report paths, and signed-in user metadata.
- `lib/shared/api`: `dio` setup, auth interceptors, API repositories, DTOs or generated OpenAPI client, error mapping, and download helpers.
- `lib/shared/ui`: reusable UI components and visual design primitives that are not feature-specific.

Avoid creating cross-feature shortcuts directly to API endpoints from presentation widgets. Feature `data` layers should call shared API clients, feature `domain` should expose mobile concepts, and feature `presentation` should own Riverpod state plus widgets.

## Root Scripts And Docs

No root scripts are needed in Phase 02 because there is no Flutter scaffold yet. After `apps/mobile` exists, later agents may add a small `apps/mobile/README.md` and optional root convenience scripts only if they do not confuse the existing `pnpm` TypeScript workflow.

The root `pnpm-workspace.yaml` already includes `apps/*`. Flutter does not need to be a pnpm package unless a later agent adds TypeScript tooling around contract generation.

## Phase 03 Handoff

Phase 03 should build real backend user accounts and mobile-safe auth before Flutter auth screens are implemented.

Key constraints for Phase 03:

- Do not rely on the current `WEB_PASSWORD` cookie auth for the Play Store app.
- Add account/user ownership boundaries before exposing mobile project APIs.
- Design token issuance and refresh so Flutter can store tokens with `flutter_secure_storage`.
- Keep auth, ownership, entitlement, and asset authorization in `apps/api` and `packages/db`; do not move them into Flutter.
- If OpenAPI schemas are touched while adding auth, start shaping them toward the Phase 05 generated-client path.

## Validation Notes

- `git status --short` was run before editing and showed pre-existing launch-plan doc changes from outside this phase.
- No Flutter code was scaffolded in Phase 02, so `flutter --version` was not required.
- This phase made documentation-only changes.
