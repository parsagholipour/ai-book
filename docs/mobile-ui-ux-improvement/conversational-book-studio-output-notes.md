# Conversational Book Studio Output Notes

This work supersedes the Phase 04 multi-step new-book wizard and folds the Phase 05
plan review/revision/approval flow into the same chat surface. Creating a book is now
one conversation: describe an idea, answer a few tappable follow-ups, build the plan,
review and revise it in place, then approve and start writing.

## Completed

### Backend (`apps/api`, `packages/*`)

- Added a conversational turn engine in `apps/api/src/mobileCreation.ts`:
  - `runCreationTurn(request, options)` returns one Zod-validated `MobileCreationTurn`
    (assistant reply, evolving brief, derived presets, quick replies, at most one
    question, readiness, title/shape suggestions, warnings).
  - `deterministicCreationTurn(...)` reuses the existing lane detection and
    `deterministicAdvisor` so the flow never breaks; AI enrichment via
    `enrichCreationTurnWithAi` is layered on top and falls back to the deterministic
    turn on timeout, error, or thin input.
  - `greetingCreationTurn()` provides the persistent opening message + starter chips.
- Added creation-session endpoints in `apps/api/src/mobileProjects.ts` (rate-limited
  like the advisor):
  - `GET /api/mobile/creation-sessions/active` (resume; runs a turn once the user has
    replied, otherwise returns the greeting).
  - `POST /api/mobile/creation-sessions` (start; returns greeting turn + session).
  - `POST /api/mobile/creation-sessions/:id/messages` (persist message, run turn).
  - `POST /api/mobile/creation-sessions/:id/build` (finalize -> create project +
    auto-queue `PLAN_BOOK`, reusing `finalizeMobileCreationDraft`).
  - Plan refinement/approval reuse the existing `/plans/:id/revise` and
    `/plans/:id/approve` endpoints (no new endpoints).
- Build accepts advanced overrides (`presets`, `language`, `sourceNotes`,
  `optionalDetails`) so advanced-sheet choices are honored at creation.
- Persistence: extended `MobileCreationDraft` payload to `payloadVersion: 3` with a
  `messages[]` transcript while keeping V2 back-compat in the zod schemas; no new table.

### Mobile (`apps/mobile`)

- New domain models: `MobileCreationMessage`, `MobileCreationQuestion`,
  `MobileCreationReadiness`, `MobileCreationTurn`, `MobileCreationSession`,
  `MobileCreationConversationResponse`.
- New repository methods: `resumeConversation`, `startConversation`,
  `sendConversationMessage`, `buildConversation` (with optional language override).
- New `CreationChatController` (Riverpod `Notifier` / `NotifierProvider.autoDispose`)
  holding messages, brief, presets, readiness, busy, and sticky user choices.
- New `creation_chat_screen.dart` mounted at `/books/new`:
  - Transcript with user/assistant bubbles and a typing indicator.
  - Composer with quick-reply chips, the current question rendered as chips + custom
    field, and a source-notes attach sheet.
  - Collapsible live `Book brief` card with `Your choice` badges for manual overrides.
  - Advanced sheet (book type, length, finish/quality, visuals, language, tone).
  - Sticky `Build the plan` CTA gated on `readiness.canBuild`.
  - After build, the generated plan renders in-chat; revise by chatting and approve in
    place (shared credit/paywall/confirm via `plan_approval.dart`), then hand off to
    `/projects/:id/handoff`.
- Retired `new_book_wizard_screen.dart` and `creation_draft_controller.dart`.
- Unified terminology across home/creation/plan surfaces: idea -> Book brief ->
  Build the plan -> Book plan -> Approve & start writing -> Writing -> Exports.

## UX Decisions

- One required input (the idea); the assistant never blocks, and Build is always
  reachable once there is an idea.
- Every question ships 2-4 tappable options plus a custom field, so the basic path is
  mostly taps.
- The conversation is free (fast model, rate-limited); credits are only spent at plan
  generation, full writing, and export, exactly as before.
- Manual advanced selections stay sticky across AI turns instead of being overwritten.
- Provider, model, temperature, queue, credits, and billing language stay out of the
  conversational surface.

## Validation

- `flutter analyze` (apps/mobile): passed, no issues found.
- `flutter test` (apps/mobile): passed, all tests passed (incl. new chat widget tests
  for greeting/quick replies, advanced override `Your choice` badge, and in-chat plan).
- `pnpm --filter @book-maker/api test`: passed, all API tests (incl. new
  `mobileCreation.test.ts` turn-engine unit tests and creation-session endpoint tests
  for start/resume/send/build, completed/unknown session errors, and override mapping).
- `pnpm --filter @book-maker/api typecheck`: passed.
- `pnpm --filter @book-maker/core typecheck`: passed.
- `MOCK_AI`/deterministic path used for tests so turns are stable without a model key.
- A signed-in physical-device walkthrough with the full local API/auth/worker/db/queue
  stack was not run in this session and should still be repeated.

## Known Follow-Ups

- Optional dedicated `CreationSession` table if transcript volume outgrows the draft
  payload.
- Source-material import (file/PDF) remains paste-only by design.
- A future enhancement could stream assistant turns token-by-token for a livelier feel.
