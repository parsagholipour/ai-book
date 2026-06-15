# Phase 09 - Usability Testing, Analytics, And Beta Iteration

## Objective

Validate the improved experience with real users and turn feedback into a repeatable product loop.

The app is not UX-ready because the screens look polished. It is UX-ready when target users can complete the core journey and explain what happened in their own words.

## UX Direction

- Measure confusion directly.
- Prefer small, observed tests over opinions from the team.
- Instrument funnels without collecting private prompt or generated content.
- Triage issues by user harm, conversion impact, and implementation risk.
- Keep improving the first book journey before adding broad new features.

## Implementation Tasks

1. Add or finalize analytics events:
   - sign-up completed
   - first project created
   - book type selected
   - prompt completed
   - plan generated
   - plan question answered
   - plan revision requested
   - plan approved
   - generation started
   - generation failed
   - generation resumed
   - preview viewed
   - paywall viewed
   - purchase started
   - purchase verified
   - export downloaded
   - export shared
   - report submitted
   - support opened
2. Add analytics guardrails:
   - No prompt text.
   - No generated book text.
   - No purchase tokens.
   - No raw personally sensitive content.
   - Environment separation for local, staging, and production.
3. Create a usability test script:
   - Fresh sign up.
   - Create a lead magnet.
   - Revise the plan.
   - Approve generation.
   - Interpret progress.
   - Unlock or understand export.
   - Find report/support/deletion.
4. Define scoring:
   - Completed without help.
   - Needed hint.
   - Failed task.
   - Misunderstood credits.
   - Misunderstood AI generation state.
   - Could explain the next step.
5. Create beta feedback loop:
   - Feedback intake.
   - Weekly issue review.
   - Prioritized UX backlog.
   - Before/after metric notes.

## Acceptance Criteria

- Analytics events cover activation, revision, approval, generation, paywall, purchase, export, support, and failure recovery.
- Event properties are useful but privacy-safe.
- A usability test script exists in this folder.
- Beta feedback has a documented triage process.
- The team can identify the top three UX problems after a test round.

## Tests And Validation

- Unit or widget tests for analytics event calls where practical.
- Manual smoke test that events fire in local/staging debug logging if an analytics provider exists.
- Run `flutter analyze`.
- Run `flutter test`.
- Document any analytics provider, SDK, or Data Safety impact before production.

## Handoff Notes For Later Product Work

After this phase, prioritize improvements based on real user evidence:

- If users fail before creating a plan, improve onboarding and wizard prompts.
- If users revise repeatedly, improve plan quality, question wording, and examples.
- If users approve but abandon progress, improve trust, notifications, and wait states.
- If users view paywalls but do not buy, improve preview quality, paywall timing, or product fit.
- If users buy but do not export/share, improve export readiness and sharing guidance.
