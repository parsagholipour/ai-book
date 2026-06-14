# Phase 06 - Compliance, Safety, Privacy, And Reliability

## Objective

Prepare the app and backend for Google Play review and real users by adding required safety, privacy, abuse prevention, and operational reliability features.

## Compliance Principles

- The backend is responsible for enforcing safety and ownership.
- The app must make reporting, account control, and data handling clear.
- AI-generated content must be moderated enough to satisfy store policy and protect users.
- Child-directed positioning should be avoided for launch unless a dedicated child-safety review is completed.

## Implementation Tasks

1. AI content safety:
   - Add report/flag action for generated books and images.
   - Add backend moderation records.
   - Add admin/review workflow, even if initially basic.
   - Remove or rename public-facing `less censored` wording.
   - Add safer category defaults for health, finance, children, and sensitive topics.
2. Privacy and account controls:
   - Add account deletion request or self-serve deletion.
   - Add data export or explain why not available at launch.
   - Add privacy policy URL.
   - Add terms of service URL.
   - Add support/contact email.
3. Data safety:
   - Document collected data: account info, prompts, generated content, purchases, diagnostics.
   - Document data sharing with AI providers and payment verification services.
   - Document deletion retention rules.
4. Reliability:
   - Add production health checks.
   - Add structured logging for API and worker.
   - Add generation failure categorization.
   - Add retry limits and user-visible retry flows.
   - Add rate limits for auth, project creation, and generation actions.
5. Security:
   - Verify asset endpoints require ownership.
   - Ensure cookies/tokens are secure in production.
   - Store secrets only in environment variables or hosting secret stores.
   - Review CORS and mobile API access.

## Acceptance Criteria

- App has report/flag flow for AI-generated content.
- App has account deletion flow or documented request flow.
- Privacy policy, terms, and support links exist and are reachable.
- Google Play Data Safety answers can be filled from documentation.
- API and asset endpoints enforce user ownership.
- Abuse-prone endpoints have rate limits.
- Production logs are useful without storing sensitive prompts in unnecessary places.

## Tests And Validation

- API tests for report/flag creation.
- API tests for account deletion or deletion request.
- API tests for asset authorization.
- API tests for rate-limited endpoints.
- Manual review of Google Play AI-generated content policy requirements.
- Manual review of Data Safety form answers against implemented behavior.

## Handoff Notes For Next Agent

Phase 07 should only begin once the app can plausibly pass Play review and safely serve real users.
