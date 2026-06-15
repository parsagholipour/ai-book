# Phase 08 - Mobile Book Creation And Planning Workflow

## Objective

Build the first useful mobile workflow: create a book project, generate a plan, answer planning questions, revise the plan, and approve it for generation.

## User Flow

1. Tap new book.
2. Choose book type.
3. Enter title and prompt.
4. Choose length and quality.
5. Create project.
6. Generate or view plan.
7. Answer guided questions.
8. Ask for a plan revision if needed.
9. Approve plan.

## Implementation Tasks

1. Build new-book wizard:
   - Book type selection.
   - Prompt and title.
   - Length preset.
   - Quality preset.
   - Images toggle only if allowed.
2. Add project creation API integration.
3. Build plan review screen:
   - Plan title.
   - Premise.
   - Audience.
   - Chapter list.
   - Illustration summary if present.
4. Build plan questions UI:
   - One question at a time.
   - Suggested answers.
   - Custom answer.
   - Skip where allowed.
5. Build plan revision UI:
   - Plain-language revision request.
   - Revision history if available.
6. Build approve action:
   - Confirm estimated credits or entitlement if required.
   - Call approve endpoint.
   - Navigate to progress.

## Acceptance Criteria

- A signed-in user can create a project from Flutter.
- A plan can be generated or displayed in Flutter.
- A user can answer planning questions.
- A user can request a plan revision.
- A user can approve the plan.
- UI uses product language, not internal backend language.

## Tests

- Flutter widget tests for wizard validation.
- Flutter tests for plan state rendering.
- API integration tests for project creation and plan actions.
- Manual local run with `MOCK_AI=true`.
- Run `flutter analyze`.
- Run `flutter test`.

## Handoff Notes For Next Phase

Phase 09 should handle generation progress, preview, editing, and exports after plan approval.
