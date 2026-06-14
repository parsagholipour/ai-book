# Phase 03 - Flutter MVP App Shell And Auth

## Objective

Create the Flutter Android app inside this repo and connect it to the productized backend authentication and basic account APIs.

## Repository Shape

Add the Flutter app at:

- `apps/mobile`

Do not create a separate repository. Do not move TypeScript backend code into Flutter.

## Flutter App Decisions

- Use Flutter stable.
- Use Material 3.
- Use a simple state-management approach suitable for an MVP, such as Riverpod.
- Use Dio or the standard HTTP client consistently for API calls.
- Store tokens/session secrets with secure storage.
- Keep API models organized in a client layer, not scattered across widgets.

## Implementation Tasks

1. Scaffold `apps/mobile`.
2. Add app configuration:
   - Local API base URL.
   - Staging API base URL.
   - Production API base URL.
   - Build-time environment selection.
3. Build navigation:
   - Auth gate.
   - Sign in/sign up screen.
   - Projects home screen.
   - New book entry screen placeholder.
   - Account/credits placeholder.
4. Implement auth:
   - Sign up or passwordless start flow depending on Phase 02.
   - Sign in.
   - Token/session persistence.
   - Logout.
   - Refresh/recover session on app launch.
5. Implement basic API client:
   - Typed request/response models for auth and user profile.
   - Central error handling.
   - Unauthorized handling that returns to auth.
6. Add visual baseline:
   - App name: `Tomeza`.
   - Clear first screen: user's projects and a primary new-book action.
   - Avoid exposing internal model/provider terms.

## Acceptance Criteria

- `apps/mobile` builds for Android debug.
- User can sign up/sign in against the backend.
- User remains signed in after app restart.
- User can log out.
- App shows an empty projects state after login.
- App has a clean route structure ready for book creation.

## Tests And Validation

- Add Flutter widget tests for auth gate and basic navigation.
- Add API-client unit tests where practical.
- Run `flutter analyze`.
- Run `flutter test`.
- Run `pnpm typecheck` for the TypeScript workspace after any backend contract changes.

## Handoff Notes For Next Agent

Phase 04 should build the actual mobile book workflow on top of this shell. Keep the first workflow narrow and polished.
