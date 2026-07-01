# Phase 11 - Safety, Privacy, Compliance, And Store Readiness

## Objective

Prepare the app and backend for Google Play review by adding AI content reporting, privacy controls, account deletion, policy documentation, and store listing readiness.

## Compliance Direction

- The app generates AI content, so it needs user reporting and responsible content handling.
- The backend must enforce safety and ownership.
- Public launch should avoid child-directed claims unless a separate child-safety review is completed.
- Health, finance, legal, and other sensitive categories need careful disclaimers and safer defaults.

## Implementation Tasks

1. AI content reporting:
   - Report generated book.
   - Report generated image.
   - Store moderation report.
   - Add admin/local review path.
2. Safety wording:
   - Keep public wording focused on supported book categories.
   - Add safer defaults for sensitive categories.
   - Add clear AI-generated content disclosure where appropriate.
3. Privacy controls:
   - Account deletion request or self-serve deletion.
   - Project deletion.
   - Data retention rules.
   - Support/contact email.
4. Legal and policy assets:
   - Privacy policy URL.
   - Terms of service URL.
   - AI content policy note.
   - Google Play Data Safety answers.
5. Store readiness:
   - App title.
   - Short description.
   - Long description.
   - Screenshots list.
   - Feature graphic brief.
   - Support links.
6. Reliability and abuse controls:
   - Rate limits for auth and generation.
   - Safe logging.
   - Error tracking plan.
   - Production health checks.

## Acceptance Criteria

- Users can report AI-generated content.
- Users can delete account or request deletion.
- Privacy policy and terms links exist.
- Data Safety answers are documented.
- Sensitive categories have safer wording and defaults.
- The app has enough store assets planned for review.
- Abuse-prone endpoints have rate limits.

## Tests

- API tests for moderation reports.
- API tests for account deletion or deletion request.
- API tests for project deletion.
- API tests for rate limits.
- Manual review of Google Play policy checklist.
- Manual review of Data Safety documentation.
- Run `pnpm test`.
- Run `flutter test`.

## Handoff Notes For Next Phase

Phase 12 should deploy production infrastructure, run beta testing, publish to Google Play tracks, and start measuring the USD 1,000/month path.
