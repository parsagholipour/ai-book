# Phase 03 - Backend Multi-User Accounts And Auth

## Objective

Add real account and authentication support to the TypeScript backend so the mobile app can serve multiple users safely.

## Current Context

The current backend has password-based access for a local/private web console. A Google Play app needs individual users, secure sessions, and ownership checks.

## Implementation Tasks

1. Add account models:
   - `User`
   - Auth credential/session tables as needed.
   - Timestamps and status fields.
2. Add authentication endpoints:
   - Sign up.
   - Sign in.
   - Refresh session.
   - Logout.
   - Current user profile.
3. Choose an MVP auth method:
   - Email/password is acceptable for v1.
   - Passwordless email is acceptable if email delivery is already available.
   - Do not make Google login required for v1 unless explicitly chosen.
4. Store mobile sessions safely:
   - Short-lived access token or server session.
   - Refresh token or session renewal mechanism.
   - Revocation on logout.
5. Preserve local/admin access:
   - Keep `WEB_PASSWORD` behavior for local operator console if useful.
   - Clearly separate admin/local auth from mobile user auth.
6. Add rate limits:
   - Sign up.
   - Sign in.
   - Password reset or magic link request if implemented.

## Acceptance Criteria

- A mobile user can sign up and sign in.
- A mobile user can restore a valid session.
- A mobile user can log out.
- Auth failures return mobile-friendly errors.
- Existing local development flow remains documented.
- Sensitive tokens are not logged.

## Tests

- Unit tests for token/session creation and verification.
- API tests for sign up, sign in, current user, refresh, and logout.
- API tests for invalid credentials and expired sessions.
- Rate-limit tests where practical.
- Run `pnpm typecheck`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 04 must attach all projects and generated assets to users. Auth alone is not enough.
