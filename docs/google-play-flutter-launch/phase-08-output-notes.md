# Phase 08 Output Notes

## Completed

- Added the Flutter new-book wizard in `apps/mobile` with book type, prompt/title, length preset, quality preset, and a buyer-facing visuals toggle.
- Integrated Flutter project creation with `POST /api/mobile/projects`.
- Added project detail loading and plan actions for:
  - `GET /api/mobile/projects/:id`
  - `POST /api/mobile/projects/:id/plan`
  - `POST /api/mobile/plans/:id/revise`
  - `POST /api/mobile/plans/:id/approve`
- Added plan review UI for title, premise, audience, chapter list, visuals summary, and questions.
- Added guided planning-question UX with one question at a time, suggested answers, custom answers, and skip-as-no-preference behavior.
- Added plain-language plan revision UX using the existing plan revision endpoint.
- Added approval confirmation that shows estimated credits from existing mobile project/billing DTOs before calling the approve endpoint.
- Added a post-approval handoff placeholder only; generation progress, preview, editing, export, and download flows remain unimplemented.
- Updated `apps/mobile/README.md` with Phase 08 local run instructions using `MOCK_AI=true`.

## Decisions

- Planning question answers are not persisted by a separate endpoint in Phase 08. The Flutter UI collects answers locally and submits them as a plain-language revision request, which matches the backend planner's existing revision behavior.
- Flutter estimates approval credits from mobile-safe fields (`targetPages`, `bookType`, `qualityPreset`, `imagesEnabled`) plus `/api/mobile/billing.creditCosts`. It does not expose provider, model, temperature, generation strategy, or queue internals.
- Project detail can refresh after queued plan/revision actions, but Phase 08 does not add a full generation progress screen.

## Local Phase 08 Run

From the repository root:

```sh
pnpm install
pnpm db:generate
docker compose up -d postgres redis
pnpm db:deploy
pnpm db:seed

# terminal 1
MOCK_AI=true pnpm dev:api

# terminal 2
MOCK_AI=true pnpm dev:worker
```

From `apps/mobile`:

```sh
flutter run \
  --dart-define=APP_ENV=local \
  --dart-define=API_BASE_URL=http://10.0.2.2:4001
```

Use the machine LAN IP instead of `10.0.2.2` for a physical Android device.

## Known Follow-Ups

- Phase 09 should replace the handoff placeholder with generation progress, preview, editing, and export/download UX.
- Phase 09 can reuse `projectDetailProvider`, `MobileProjectDetail`, `MobilePlan`, and the existing mobile status/export DTO fields, but should keep download/export actions separate from the Phase 08 approval screen.
- A dedicated backend approval estimate endpoint may be useful later if credit pricing becomes more dynamic than the current mobile DTOs allow.
- Google Play Billing client flows remain Phase 10 work.

## Validation

- `flutter analyze`
- `flutter test`
- `pnpm --filter @book-maker/api test -- src/mobileProjects.test.ts`
