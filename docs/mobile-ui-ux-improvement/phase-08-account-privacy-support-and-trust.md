# Phase 08 - Account, Privacy, Support, And Trust

## Objective

Make trust and control visible without turning account settings into a wall of legal text.

Users should know where to get help, how AI content is handled, how to report problems, and how deletion works.

## UX Direction

- Account should be a trust center, not a dumping ground.
- Support paths should be obvious when generation, billing, export, or deletion fails.
- Privacy and terms links must look actionable.
- Deletion wording must be honest about retained billing, safety, moderation, abuse-prevention, and support records.
- AI disclosure should be clear but not scary.

## Implementation Tasks

1. Improve account layout:
   - Profile/session summary if available.
   - Credits or plan summary if useful.
   - Support.
   - Privacy and terms.
   - AI-generated content disclosure.
   - Data retention.
   - Project deletion guidance.
   - Account deletion request.
2. Improve support paths:
   - Make support email/link tappable.
   - Surface support from non-recoverable errors.
   - Include project/account context only through backend-approved support flow if later implemented.
3. Improve policy links:
   - Open privacy policy.
   - Open terms.
   - Open account deletion URL.
   - Handle placeholder or missing production URLs before Play submission.
4. Improve report flows:
   - Keep report book and report visual available near generated content.
   - Use clear reason labels.
   - Confirm report receipt.
   - Avoid collecting excessive free-text content.
5. Improve deletion flows:
   - Project deletion confirmation.
   - Account deletion request confirmation.
   - Clear status and next step after request.

## Acceptance Criteria

- A user can find support, privacy, terms, AI disclosure, report controls, project deletion, and account deletion.
- Links and emails are actionable where the platform supports it.
- Deletion and retention wording is accurate and consistent with backend behavior.
- Report flows use user-facing reasons and confirm successful submission.
- Account settings do not compete with the main creation workflow.

## Tests And Validation

- Widget tests for account trust sections.
- Widget tests for account deletion request dialog.
- Widget tests for report dialog labels and success state if changed.
- Run `flutter analyze`.
- Run `flutter test`.
- Manual review of policy/support placeholders before any Play track submission.

## Handoff Notes For Next Phase

Phase 09 should validate the full experience with analytics, beta testers, and a prioritized iteration loop.
