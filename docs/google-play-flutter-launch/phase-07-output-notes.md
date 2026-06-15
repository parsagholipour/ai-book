# Phase 07 Output Notes

## Completed

- Scaffolded the Flutter app in `apps/mobile` with Android and iOS template output.
- Added Material 3 app foundation with routing, theme, build-time `APP_ENV` / `API_BASE_URL` config, shared Dio API client, secure token storage, and shared loading/error/empty states.
- Implemented mobile auth UX for sign up, sign in, session restore, token refresh, and logout against `/api/mobile/auth/*`.
- Added authenticated app shell with a projects home screen loading `/api/mobile/projects`.
- Added account/credits area loading `/api/mobile/billing`.
- Added a New book primary action placeholder only; no planning, generation approval, download, or billing client workflow was implemented.
- Added widget tests for signed-out auth routing, sign-up navigation, and signed-in home shell navigation.
- Documented local run commands and Android debug/release build notes in `apps/mobile/README.md`.

## Decisions

- Placeholder Android application ID is `com.tomeza.tomeza`.
- Placeholder Android display name is `Tomeza`.
- Local Android emulator builds default to `http://10.0.2.2:4001`; physical devices should pass a LAN API URL with `--dart-define=API_BASE_URL=...`.
- Debug Android manifest permits cleartext traffic for local HTTP. Production/staging app config requires HTTPS.
- Flutter DTOs are handwritten for the current mobile API shapes rather than generated from OpenAPI in this phase.

## Known Follow-Ups

- Phase 08 should build the new-book and planning workflow using the Phase 05 product presets.
- Replace `com.tomeza.tomeza` with the final Play Console package name before production.
- Configure real release signing before Play Store submission; the scaffold still uses debug signing for release builds.
- Google Play Billing client flows, generation approval/download flows, report/flag flows, and account deletion remain later-phase work.

## Validation

- `flutter analyze`
- `flutter test`
- `flutter build apk --debug --dart-define=APP_ENV=local --dart-define=API_BASE_URL=http://10.0.2.2:4001`
- `pnpm --filter @book-maker/api test -- src/mobileAuth.test.ts`
- `pnpm --filter @book-maker/api test -- src/mobileProjects.test.ts`
