# Phase 02 - Information Architecture, App Shell, And Home

## Objective

Make the app feel easy to enter, easy to resume, and hard to get lost in.

The home screen should answer: "What am I making, what needs attention, and what should I do next?"

## UX Direction

- Keep the app work-focused, not marketing-heavy.
- Prioritize the user's active book projects over account mechanics.
- Make `New book` easy to find from home.
- Make project cards show meaningful status and next action.
- Keep credits visible enough to prevent surprise, but not so dominant that the app feels like a wallet.

## Implementation Tasks

1. Review the app shell:
   - AppBar actions.
   - Account access.
   - Logout placement.
   - Home route.
   - Account route.
   - New-book route.
   - Project detail route.
   - Progress route.
2. Improve home hierarchy:
   - Clear headline based on user state.
   - First-project empty state with one primary action.
   - Returning-user resume section.
   - Project list grouped or sorted by next action.
   - Credit summary that links to billing without stealing focus.
3. Improve project cards:
   - Show status in plain language.
   - Show next recommended action.
   - Show book type, length, visuals, and export state only when useful.
   - Avoid backend status labels.
4. Improve account and logout discoverability:
   - Keep account reachable.
   - Move logout away from the main creative path if it competes with core actions.
5. Handle route errors:
   - Missing project.
   - Unauthorized project.
   - Deleted project.
   - Unknown route.

## Acceptance Criteria

- A new user with no projects sees exactly one dominant way to start.
- A returning user can identify the project that needs attention without opening every project.
- Project status cards use user-facing language.
- Credits are visible before paid actions but do not dominate the home screen.
- Account, privacy, support, and logout are findable but not competing primary actions.
- Unknown/missing routes return users to a useful place.

## Tests And Validation

- Flutter widget tests for home empty state.
- Flutter widget tests for project list with mixed statuses.
- Flutter widget tests for route error handling if changed.
- Run `flutter analyze`.
- Run `flutter test`.
- Manually check light theme, dark theme, and increased text scale on home.

## Handoff Notes For Next Phase

Phase 03 should extract or refine shared UI primitives that keep the improved shell consistent across the wizard, plan, progress, billing, and account screens.
