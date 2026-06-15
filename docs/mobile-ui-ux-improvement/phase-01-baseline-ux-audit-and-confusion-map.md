# Phase 01 - Baseline UX Audit And Confusion Map

## Objective

Create a shared understanding of the current mobile experience, where users are likely to get confused, and which UX outcomes later phases must improve.

This phase may include small copy fixes only when they are obvious and low risk. Its main deliverable is a concrete audit and measurement plan.

## Starting Context

The Flutter app already has:

- Auth screens.
- Projects home.
- New-book wizard.
- Project detail and plan review.
- Guided plan questions and revision request.
- Generation progress.
- Generated book preview and export panel.
- Billing paywall and restore purchases.
- Account, privacy, support, reporting, and deletion entry points.

## Implementation Tasks

1. Map current routes and screens:
   - `/auth/sign-in`
   - `/auth/sign-up`
   - `/home`
   - `/books/new`
   - `/projects/:id`
   - `/projects/:id/handoff`
   - `/account`
2. Walk the app as these user states:
   - brand-new signed-out user
   - new signed-in user with no projects
   - user with a draft project and no plan
   - user with a plan awaiting answers
   - user with insufficient credits
   - user with generation running
   - user with failed generation
   - user with export ready
3. Create a confusion map covering:
   - unclear labels
   - too many competing actions
   - missing next steps
   - unclear credit or billing language
   - stale or ambiguous progress
   - dead-end empty/error states
   - hidden support, privacy, or report paths
4. Create a UX metrics plan:
   - sign-up completed
   - first project created
   - plan generated
   - question answered
   - revision requested
   - plan approved
   - generation completed
   - paywall viewed
   - purchase started
   - purchase verified
   - export downloaded/shared
   - generation retry used
   - report/support/deletion opened
5. Add a screen-audit document in this folder.
6. Identify the smallest test gaps for later phases.

## Acceptance Criteria

- A `screen-audit.md` or equivalent audit file exists in this folder.
- Every current route has an owner, purpose, primary action, empty/loading/error state notes, and confusion risks.
- The top UX risks are prioritized for Phases 02-08.
- The analytics plan avoids collecting prompt text, generated book text, purchase tokens, or sensitive user content.
- Later phases can start from a concrete list of screens and problems.

## Tests And Validation

- Run `flutter analyze` from `apps/mobile` if Flutter is available.
- Run `flutter test` from `apps/mobile` if Flutter is available.
- Manually walk the main journeys with local or mock backend data where practical.
- Document any validation that cannot be run.

## Handoff Notes For Next Phase

Phase 02 should use the audit to simplify navigation, home, project status, and first visible next actions.
