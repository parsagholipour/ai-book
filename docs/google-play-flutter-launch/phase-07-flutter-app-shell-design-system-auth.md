# Phase 07 - Flutter App Shell, Design System, And Auth

## Objective

Create the Flutter app in `apps/mobile`, build the mobile shell, and connect authentication.

## Flutter Direction

- Use Flutter stable.
- Use Material 3.
- Use a restrained, practical product UI.
- Keep the app simple enough for creators and teachers, not developers.
- Keep API code out of widgets where practical.

## Implementation Tasks

1. Scaffold `apps/mobile`.
2. Configure Android:
   - Package name placeholder.
   - App display name placeholder.
   - Debug build.
   - Release build path documented.
3. Add app foundations:
   - Routing.
   - Theme.
   - API base URL configuration.
   - Secure session storage.
   - Shared error handling.
4. Add auth screens:
   - Sign up.
   - Sign in.
   - Session restore.
   - Logout.
5. Add app shell:
   - Projects tab or home.
   - New book primary action.
   - Account/credits area.
6. Add design basics:
   - Loading states.
   - Empty states.
   - Error states.
   - Offline or network error messaging.

## Acceptance Criteria

- `apps/mobile` exists and builds for Android debug.
- A user can sign up/sign in against local backend.
- Session persists across app restart.
- A user can log out.
- Projects home loads from the mobile API.
- No generation workflow is required in this phase.

## Tests

- Run `flutter analyze`.
- Run `flutter test`.
- Add widget tests for auth gate and navigation.
- Run relevant backend auth tests.

## Handoff Notes For Next Phase

Phase 08 should build the new-book and planning workflow using the product presets from Phase 05.
