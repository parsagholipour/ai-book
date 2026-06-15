# Phase 03 Output Notes

## Completed

- Added database-backed mobile accounts with `User`, `UserPasswordCredential`, and `MobileSession`.
- Added `/api/mobile/auth/signup`, `/api/mobile/auth/signin`, `/api/mobile/auth/refresh`, `/api/mobile/auth/logout`, and `/api/mobile/auth/me`.
- Preserved the existing `WEB_PASSWORD` cookie flow for the local/operator web console under `/api/auth/*`.
- Added mobile-friendly auth errors shaped as `{ error: { code, message } }`.
- Added sign-up and sign-in rate limits in the API process.
- Added API and service tests for password hashing, token/session creation and verification, sign up, sign in, current user, refresh, logout, invalid credentials, expired/revoked sessions, and rate limits.

## Decisions

- MVP mobile auth uses email/password.
- Mobile sessions use opaque short-lived access tokens and refresh tokens. The database stores SHA-256 token hashes only, and refresh rotates both tokens.
- No new auth environment variables are required. `WEB_PASSWORD` remains web-console-only and is not mobile user auth.

## Known Follow-Ups

- Phase 04 must attach projects, generated book exports, images, voice assets, jobs, and provider logs to users or enforce user ownership through project boundaries.
- Existing project and asset routes are still legacy/operator routes until Phase 04 adds ownership checks.
- Phase 05 can build on the route-level schemas added for the mobile auth endpoints when generating the client contract.

## Validation

- `pnpm db:generate`
- `pnpm typecheck`
- `pnpm test`
