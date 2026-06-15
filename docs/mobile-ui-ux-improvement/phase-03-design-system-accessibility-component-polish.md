# Phase 03 - Design System, Accessibility, And Component Polish

## Objective

Turn one-off screen styling into reusable, accessible UI patterns so later UX improvements feel consistent and are easier to test.

## UX Direction

Tomeza should feel practical, calm, and trustworthy. The visual system should support long-form work, payment decisions, and AI progress without looking like a developer dashboard.

## Implementation Tasks

1. Audit the current theme:
   - Color contrast.
   - Typography hierarchy.
   - Button sizes.
   - Card styling.
   - Input styling.
   - Light and dark theme behavior.
2. Add or refine shared components in `apps/mobile/lib/shared/ui`:
   - Screen scaffold or page layout wrapper.
   - Section header.
   - Choice tile.
   - Status badge.
   - Metric or summary chip.
   - Primary action panel.
   - Loading, empty, and error states.
   - Confirmation dialog pattern.
   - Inline notice/banner.
3. Improve accessibility:
   - Semantics labels for icon-only actions.
   - Progress labels that screen readers can understand.
   - Touch targets at least 48x48 logical pixels where practical.
   - Text scale support for common screens.
   - No clipped, overlapping, or truncated critical text.
4. Replace duplicated local components where the shared component is clearly better.
5. Keep component changes scoped; do not redesign every screen in this phase.

## Acceptance Criteria

- Shared UI components cover the most repeated patterns without hiding feature-specific logic.
- Key buttons, icons, progress, and generated-media controls have accessible labels where needed.
- The app remains usable with larger text on auth, home, wizard, plan, progress, billing, and account screens.
- Light and dark themes have acceptable contrast for primary text, buttons, notices, and error states.
- No screen loses core functionality due to component extraction.

## Tests And Validation

- Add focused widget tests for shared loading, empty, error, choice, status, or notice components that are introduced.
- Run existing Flutter widget tests.
- Run `flutter analyze`.
- Run `flutter test`.
- Manually inspect key screens at increased text scale.

## Handoff Notes For Next Phase

Phase 04 should use the shared components to make first-run guidance and the new-book wizard clearer.
