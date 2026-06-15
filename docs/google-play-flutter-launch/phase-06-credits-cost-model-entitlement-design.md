# Phase 06 - Credits, Cost Model, And Entitlement Design

## Objective

Design and implement the backend credit, entitlement, and cost-guardrail layer so the app can reach USD 1,000/month without losing money on AI usage.

## Business Direction

Use a hybrid model:

- Free outline and limited preview.
- One-book export unlock.
- Monthly creator plan with credits.
- Pro plan with more credits and premium features.
- Credit packs for extra books, long books, images, cover regenerations, and voice features.

Do not offer unlimited generation.

## Implementation Tasks

1. Add billing domain models:
   - Product catalog.
   - User entitlement.
   - Credit ledger.
   - Purchase record placeholder.
   - Subscription state placeholder.
2. Define credit costs:
   - Plan generation.
   - Preview generation.
   - Full book generation.
   - Image generation.
   - Cover regeneration.
   - Premium review.
   - Export unlock.
3. Add atomic credit operations:
   - Grant credits.
   - Reserve credits if needed.
   - Spend credits.
   - Refund failed generation where appropriate.
4. Add entitlement checks before enqueue:
   - Project creation if paid.
   - Plan generation if credit-gated.
   - Full generation.
   - Export.
   - Images.
   - Premium mode.
5. Add cost reporting:
   - Estimated cost before generation.
   - Actual provider cost after generation.
   - Margin-oriented summary for admin/local console.

## Acceptance Criteria

- Costly actions have backend gates.
- Credits cannot be spent twice.
- Failed jobs have clear credit behavior.
- A user can see credit balance from a mobile endpoint.
- The credit model supports future Google Play Billing verification.
- Pricing and credit assumptions are documented.

## Tests

- Ledger atomicity tests.
- Insufficient credit tests.
- Entitlement allow/deny tests.
- Failed-job credit handling tests.
- Cost summary tests.
- Run `pnpm typecheck`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 07 can now scaffold Flutter safely because auth, ownership, mobile APIs, and credit visibility are defined.
