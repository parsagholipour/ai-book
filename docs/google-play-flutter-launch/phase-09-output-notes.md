# Phase 09 Output Notes

## Completed

- Replaced the Phase 08 approval handoff placeholder with a Flutter `Book progress` screen.
- Added mobile polling for `GET /api/mobile/projects/:id/status` with current action, percent complete, steps, page progress, visual count, friendly failure copy, and retry when the backend reports recovery support.
- Added a mobile-safe recovery endpoint at `POST /api/mobile/projects/:id/resume` that preserves backend ownership checks and reuses existing recoverable job semantics without returning queue/job internals.
- Added generated book preview from mobile project detail:
  - generated page snippets from page markdown,
  - page/cover image DTOs only through bearer-protected mobile asset routes,
  - no raw storage paths or provider/model metadata.
- Added protected PDF/EPUB download and share flow in Flutter using existing mobile export endpoints and backend entitlement/credit enforcement.
- Added `path_provider` and `share_plus` for local export file storage and Android share sheet support.
- Added Flutter widget tests for progress/failure/retry states and locked/unlocked export states.
- Extended API tests for mobile preview DTOs and mobile recovery behavior.

## Decisions

- Full generation approval still grants/uses the backend `EXPORT_UNLOCK` entitlement from Phase 06; Flutter only displays locked/unlocked/export-ready language.
- A locked but available export button calls the existing backend download endpoint. The backend remains responsible for spending export-unlock credits or rejecting insufficient credits.
- Share is enabled only when an export is both available and unlocked.
- Cover/chapter/final-polish regeneration controls were not added to Flutter v1 because there is no mobile-safe, entitlement-aware endpoint for those actions yet.
- Normal mobile DTOs still hide provider, model, temperature, generation strategy, queue, token, and cost internals.
- No Google Play Billing client flow, purchase UI, or Play purchase verification was implemented.

## Local Phase 09 Run

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

Workflow:

1. Sign up or sign in.
2. Create a book from `New`.
3. Generate and approve the plan.
4. Watch `Book progress` for writing, visuals, and export readiness.
5. Preview generated pages when available.
6. Download PDF/EPUB when ready and unlocked; share unlocked files from the export panel.

## Known Follow-Ups

- Phase 10 should add Google Play Billing and paywalls around the already-working credit/export gates.
- Add a dedicated mobile unlock confirmation endpoint later if the product wants a two-step export-credit spend before download.
- Add mobile-safe paid cover regeneration/final polish/chapter regeneration only after backend entitlement and credit semantics are ready.
- Store-ready reporting/flagging, privacy/account deletion, and broader compliance remain later phases.

## Validation

- `flutter analyze`
- `flutter test`
- `pnpm --filter @book-maker/api test -- src/mobileProjects.test.ts`
- `pnpm --filter @book-maker/api typecheck`
- `pnpm test`
