# Phase 06 - Generation Progress, Preview, And Recovery

## Objective

Make AI generation feel trustworthy while users wait, and make failures recoverable without panic.

The progress screen should answer: "What is happening, can I leave, what is ready, and what should I do if something fails?"

## UX Direction

- Show a step timeline, not only a percentage.
- Use human-readable work labels.
- Do not imply exact timing unless the app can support it.
- Let the user refresh, leave, or resume without losing trust.
- Treat failed generation as a recoverable state when backend supports retry/resume.

## Implementation Tasks

1. Improve progress overview:
   - Current step.
   - Completed steps.
   - Upcoming steps.
   - Percent progress when available.
   - Last updated time if useful.
2. Improve waiting states:
   - Explain that the user can leave and return if that is true.
   - Avoid stale spinner-only states.
   - Handle slow or temporarily unavailable network.
3. Improve preview:
   - Cover preview.
   - Text preview hierarchy.
   - Image preview and image unavailable states.
   - AI-generated content disclosure where appropriate.
   - Report controls without making normal browsing feel alarming.
4. Improve failure recovery:
   - Friendly explanation.
   - Retry/resume when available.
   - Support route when not recoverable.
   - No duplicate retry actions while busy.
5. Improve export readiness handoff:
   - Separate `book still generating`, `preview ready`, `exports preparing`, `exports locked`, and `exports ready`.

## Acceptance Criteria

- A user can understand the generation state without reading backend status values.
- The screen distinguishes running, waiting, failed, retryable, complete, locked, and ready states.
- Preview content is readable and resilient to missing images or partial data.
- Report controls remain available for generated books and visuals.
- Retry/resume paths are clear and disabled while busy.

## Tests And Validation

- Widget tests for running, complete, failed retryable, failed non-retryable, and export-ready states.
- Widget tests for image loading/error/unavailable states if touched.
- Widget tests for locked and unlocked export handoff if touched.
- Run `flutter analyze`.
- Run `flutter test`.
- Manual local run with `MOCK_AI=true`.

## Handoff Notes For Next Phase

Phase 07 should focus on export, credits, product choice, paywall clarity, restore purchases, and post-purchase success states.
