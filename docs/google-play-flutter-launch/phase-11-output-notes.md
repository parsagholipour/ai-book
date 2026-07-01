# Phase 11 Output Notes

## Completed

- Added backend-stored moderation reports for generated projects/books and generated image assets.
- Added mobile report endpoints with ownership checks and report rate limits.
- Added local/admin moderation report list and review/update endpoints.
- Added account deletion request storage and mobile endpoint.
- Added mobile project deletion endpoint with job stop attempt and generated storage cleanup.
- Added mobile UI entry points for:
  - reporting AI-generated books,
  - reporting AI-generated visuals,
  - deleting projects,
  - requesting account deletion,
  - viewing privacy, terms, account deletion, support, AI disclosure, and retention notes.
- Added config placeholders for privacy policy, terms, account deletion URL, and support email in backend and Flutter.
- Added rate limits for mobile generation actions, billing verification, reporting, project deletion, and account deletion requests.
- Added safe logging redaction for auth, billing, report, deletion, and review-sensitive fields.
- Simplified sensitive category labels.
- Added Phase 11 legal/policy/Data Safety draft docs and store readiness docs.

## Decisions

- Account deletion is implemented as a deletion request, not immediate irreversible self-service deletion, because billing, safety, moderation, support, fraud-prevention, and compliance records may need retention and legal review.
- Moderation reports keep target snapshots and nullable project/asset/user references so reports remain reviewable after project deletion.
- Child-directed launch positioning remains deferred.
- Paid usage remains bounded by credits/products from Phase 10; no unlimited AI usage was added.
- Provider/model/temperature/generation strategy internals remain hidden from Flutter UI.

## Known Follow-Ups

- Replace placeholder policy/support URLs before any Google Play track submission.
- Legal review privacy policy, terms, retention language, deletion SLA, and sensitive-topic disclaimers.
- Complete Play Console Data Safety and Data deletion forms from `phase-11-legal-policy-assets.md`.
- Connect production error tracking/alerting in Phase 12 and update Data Safety if any SDKs collect additional data.
- Run manual Google Play review checks on a signed internal/closed-test Android build in Phase 12.

## Validation

- `pnpm --filter @book-maker/api test -- src/mobileSafety.test.ts src/mobileProjects.test.ts src/mobileAuth.test.ts`
- `pnpm --filter @book-maker/api typecheck`
- `pnpm --filter @book-maker/db typecheck`
- `flutter test test/projects/safety_privacy_ui_test.dart`
- `flutter test`
- `pnpm test`
- `pnpm typecheck`

## Manual Review Blockers

- Real Google Play policy/Data Safety submission was not completed because this local run cannot access Play Console or production policy URLs.
- Production privacy policy, terms, account deletion URL, support email, Data Safety answers, and store assets still need human/legal review before any Play track submission.
- Production error tracking provider is not selected or wired; Phase 12 must update Data Safety if a monitoring SDK/provider collects additional data.
