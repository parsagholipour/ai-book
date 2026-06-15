# Agent Runbook

Use this runbook for every phase in this folder.

## First Actions

1. Read this file.
2. Read `README.md`.
3. Read the current phase file.
4. Read relevant output notes from earlier UX phases.
5. Read `../google-play-flutter-launch/README.md`, `product-spec.md`, and the relevant launch phase output notes.
6. Run `git status --short`.
7. Explore the relevant Flutter code before editing.
8. Make a short implementation plan.
9. Implement only the current phase.
10. Run the validation commands listed in the phase.
11. Leave concise output notes in this folder when the phase changes UX decisions, test coverage, analytics, copy, or handoff assumptions.

## Repository Rules

- Keep the mobile app in `apps/mobile`.
- Keep backend enforcement in TypeScript services.
- Do not move generation, billing verification, ownership checks, or safety enforcement into Flutter.
- Prefer extending existing Flutter feature boundaries:
  - `lib/app`
  - `lib/features/auth`
  - `lib/features/projects`
  - `lib/features/billing`
  - `lib/features/account`
  - `lib/shared/ui`
- Keep API calls in repositories or data layers, not inside presentation widgets.
- Do not add a new UI framework unless a phase explicitly documents the decision.

## UX Rules

- Treat confusion as a product bug.
- Remove or rewrite technical terms before adding explanatory text.
- Use buyer-facing product language instead of backend implementation language.
- Use the same terms for the same concepts everywhere.
- Make irreversible, paid, or expensive actions explicit.
- Keep secondary actions available but visually quieter than the primary next action.
- Design for new users, low-credit users, slow networks, failed jobs, and restored sessions.
- Preserve safety, reporting, privacy, and deletion paths while improving layout.

## Visual And Accessibility Rules

- Use Material 3 and the existing Tomeza theme direction unless the phase changes it deliberately.
- Keep cards at 8px radius or less.
- Use icons in icon buttons and tooltips for unfamiliar controls.
- Support dynamic text without clipping or overlapping.
- Keep tap targets at least 48x48 logical pixels where practical.
- Check light and dark themes.
- Check important screens with text scale increased.
- Add semantics labels where icons, progress, or generated previews need them.

## Phase Completion Standard

A phase is complete only when:

- Its acceptance criteria are met.
- Its listed validation commands have been run, or failures are documented.
- Updated UX decisions are captured in this folder.
- The next phase can start without guessing about unfinished behavior.

## Suggested Output Notes Format

Create `phase-XX-output-notes.md` when useful:

```md
# Phase XX Output Notes

## Completed

- ...

## UX Decisions

- ...

## Known Follow-Ups

- ...

## Validation

- ...
```
