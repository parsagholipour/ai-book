# Phase 05 - Plan Review, Revision, And Approval Confidence

## Objective

Make users confident that the plan matches what they want before they spend credits or wait for full generation.

The plan screen should answer: "Is this the right book, what can I change, and what happens if I approve?"

## UX Direction

- Present the plan as an editable creative brief.
- Make open questions feel helpful, not blocking.
- Show revision options near the thing the user wants to change.
- Explain approval as the point where the app starts writing the full book.
- Explain estimated credits before approval.

## Implementation Tasks

1. Improve plan hierarchy:
   - Title and subtitle.
   - Audience.
   - Promise or outcome.
   - Chapter structure.
   - Exercises/checklists/examples where present.
   - Visual direction where enabled.
2. Improve questions:
   - Show one question at a time only when it reduces overload.
   - Let users skip with `No preference` where appropriate.
   - Preserve answered questions while moving between them.
   - Summarize answers before sending a revision.
3. Improve revisions:
   - Offer common revision shortcuts such as tone, audience, length, chapter focus, or visuals when practical.
   - Keep a plain-language custom request path.
   - Show revision status and prevent duplicate requests.
   - Make version changes understandable if prior versions are available.
4. Improve approval:
   - Show what approval will start.
   - Show estimated credits and available credits.
   - Explain whether export is included or still locked.
   - Open paywall only when the user cannot proceed.
   - Navigate to progress after successful approval.
5. Improve sensitive-topic handling:
   - Show safer wording for health, finance, legal, child-directed, or other sensitive topics when detected by existing backend/product data.
   - Do not add unsupported moderation claims.

## Acceptance Criteria

- The plan screen clearly separates book idea, audience, structure, questions, revisions, and approval.
- A user can answer questions, request revisions, and understand when the plan has changed.
- A user knows that approval starts full-book writing and may spend credits.
- Insufficient-credit approval leads to a clear paywall, not a failed action.
- The screen avoids raw plan schema language and backend job terms.

## Tests And Validation

- Widget tests for plan with no questions.
- Widget tests for plan with multiple questions and custom answers.
- Widget tests for revision loading/error states.
- Widget tests for sufficient and insufficient credit approval states.
- Run `flutter analyze`.
- Run `flutter test`.
- Manual walkthrough with one project that needs revision before approval.

## Handoff Notes For Next Phase

Phase 06 should make the post-approval wait, preview, retry, and completion states feel reliable and understandable.
