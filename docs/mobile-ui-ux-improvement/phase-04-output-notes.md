# Phase 04 Output Notes

## Completed

- Rebuilt book creation around Creation Studio V3: `Type idea or tap example` -> `Review suggested recipe` -> `Create project and draft plan`.
- Replaced the old mobile wizard form with a three-screen easy path:
  - Start: one required idea field, examples, and collapsed optional details.
  - Recipe: editable lane-specific recipe fields and optional `Change book shape`.
  - Review: plain-language summary, likely shape, visuals, credit estimate, warnings, and create consequence.
- Added easy-first draft payload support with `payloadVersion: 2`, `rawIdea`, `optionalDetails`, `sourceNotes`, `detectedLane`, `recipe`, `selectedPresets`, and `advisorSnapshot`.
- Updated the deterministic mobile advisor so minimal ideas produce complete defaults:
  - `Bedtime story for 5 year olds` becomes a children’s story recipe.
  - Lead magnets become short practical guides.
  - Workbooks/client tools become guided practice formats.
  - Vague nonfiction becomes a practical guide.
  - Vague fiction becomes a short story when story language is present.
- Kept V2 structured-brief draft compatibility so older active drafts can still resume.
- Preserved source notes privately in mobile creation metadata for planning while keeping raw notes out of mobile project cards and DTO summaries.
- Kept generation, billing, ownership, credits, entitlements, safety, and asset access authoritative on the backend.
- Updated mobile widget tests and API tests for the V3 easy path, child/family story metadata, review summary, source notes, manual edits, final create-and-plan, and large-text rendering.

## UX Decisions

- The default path requires only one short idea. Missing details never block creation.
- Examples are concrete and mixed by use case: children’s story, lead magnet, workbook, and adult short story.
- Extra inputs stay collapsed by default: source notes, title/author, must-include details, and tone.
- The recipe screen uses lane-specific labels instead of forcing every book through generic “audience” language:
  - Children’s story: age, read-aloud feel, main character, theme, ending feel.
  - Adult story: reader vibe, character, conflict, ending.
  - Lead magnet/practical guide: ideal reader, reader win, next step.
  - Workbook/client tool: learner, skill, exercises, practice outcome.
- Advanced settings are under `Change book shape`; book type, size, finish, and visuals are editable without becoming the default path.
- Visuals are described as a cover plus selected supporting visuals, not unlimited images.
- Final creation says exactly what happens: this creates a project and starts a draft plan the user can revise.

## Known Follow-Ups

- A signed-in physical-device walkthrough should still be repeated with the local API, auth, worker, database, and queue stack running.
- Draft resume currently returns to the recipe screen when a saved recipe exists; a future enhancement could persist the exact last screen.
- Future source-material work can add file/PDF import, but this phase intentionally keeps source material paste-only.
- Phase 05 should continue into plan review confidence without redesigning generation recovery, paywalls, analytics, privacy, or backend authority.

## Validation

- `flutter analyze` from `apps/mobile`: passed, no issues found.
- `flutter test` from `apps/mobile`: passed, all tests passed.
- Focused wizard tests: `flutter test test/projects/wizard_validation_test.dart` passed.
- API typecheck: `pnpm --filter @book-maker/api typecheck` passed.
- Core typecheck: `pnpm --filter @book-maker/core typecheck` passed.
- DB typecheck: `pnpm --filter @book-maker/db typecheck` passed.
- Focused mobile API tests: `pnpm --filter @book-maker/api test -- src/mobileProjects.test.ts` passed.
- Core schema tests: `pnpm --filter @book-maker/core test -- src/schemas/book.test.ts` passed.
- Prisma generation: `pnpm db:generate` passed.
- Realistic lead magnet, workbook, child story, and adult short story walkthrough coverage was exercised through widget tests. A true manual device walkthrough was not run because the local API/auth/worker/database/queue stack was not started in this session.
