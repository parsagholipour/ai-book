# Phase 04 - Mobile Book Creation, Progress, And Export

## Objective

Implement the core mobile product loop: create a book project, generate or revise a plan, approve generation, monitor progress, preview the result, and export/share the finished book.

## Product Flow

The mobile user should not see technical controls. The flow should feel like:

1. Choose book type.
2. Describe the book.
3. Pick length and quality preset.
4. Review the generated plan.
5. Answer or skip plan questions.
6. Approve generation.
7. Watch progress.
8. Preview and export/share.

## Implementation Tasks

1. Projects home:
   - List current user's projects.
   - Show project status, progress, and last updated time.
   - Add empty state with a new-book action.
2. New book wizard:
   - Book type: guide, workbook/study guide, short story.
   - Title and optional author name.
   - Prompt/description.
   - Length preset: short, standard, extended.
   - Quality preset: fast, balanced, premium.
   - Optional images toggle if entitlement allows it.
3. Plan review:
   - Show title, premise, audience, chapter list, and estimated output.
   - Let user request a plan revision in plain language.
   - Show plan questions one at a time.
   - Let user approve the plan.
4. Generation progress:
   - Poll or subscribe to project status.
   - Show readable steps: planning, writing, illustrating, reviewing, exporting.
   - Show failure and retry states.
   - Do not show raw queue/job internals by default.
5. Preview:
   - Show generated cover if available.
   - Show readable text preview.
   - Show PDF preview or download link when available.
6. Export/share:
   - Download PDF and EPUB.
   - Use Android share sheet.
   - Gate exports according to entitlement or credits.

## Backend Alignment

- Use mobile DTOs from Phase 02.
- Keep internal generation strategy/model/provider details server-side.
- All ownership and entitlement checks must happen on the backend.
- Mobile may show estimated credit cost, but the backend is authoritative.

## Acceptance Criteria

- A user can complete a short book from mobile from creation through export.
- A user can revise a plan before approving it.
- A user can recover from failed generation with a visible retry action.
- Export links work only for the owner.
- Mobile UI never asks normal users to choose provider/model/temperature.

## Tests And Validation

- Flutter widget tests for new-book wizard validation.
- Flutter tests for project progress states.
- Backend API tests for the exact mobile workflow.
- Manual Android debug test with `MOCK_AI=true`.
- Manual Android debug test with real providers on a small/cheap project before release.

## Handoff Notes For Next Agent

Phase 05 should add payments only after this free/core workflow works reliably. Monetization should wrap working value, not hide an unfinished product.
