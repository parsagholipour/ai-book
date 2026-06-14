# Phase 05 - Monetization, Credits, And Entitlements

## Objective

Add Google Play monetization that can support the first USD 1,000/month revenue target while protecting AI provider margins.

## Business Model

Use a hybrid model:

- Free preview tier.
- One-book purchase or export unlock.
- Monthly subscription with included credits.
- Credit packs for extra books, images, voice, or premium generation.

Do not offer unlimited generation.

## Product Defaults

Suggested first products:

- Free: create outline and limited preview.
- Starter book unlock: one complete short book export.
- Creator monthly: monthly credits for practical ebooks/workbooks.
- Pro monthly: more credits, longer books, images, premium review.
- Credit packs: extra pages, covers, illustrations, voice conversations.

Exact prices can change, but the system should support price changes without code migrations.

## Implementation Tasks

1. Add Google Play Billing integration in Flutter:
   - Query products.
   - Start purchase flow.
   - Handle pending purchases.
   - Restore purchases.
   - Send purchase tokens to backend for verification.
2. Add backend purchase verification:
   - Verify purchase tokens server-side.
   - Store purchase records.
   - Store subscription state.
   - Store entitlement changes.
   - Handle duplicate purchase callbacks safely.
3. Add credits:
   - Credit balance endpoint.
   - Ledger entries for purchase grants, subscription renewals, usage, refunds, admin adjustments.
   - Atomic credit deduction when enqueueing generation.
4. Add pricing and feature gates:
   - Free preview allowed without payment.
   - Full export requires purchase, subscription, or credits.
   - Images, premium review, long books, and voice features require credits or higher tier.
5. Add user-facing account screen:
   - Current plan.
   - Credit balance.
   - Purchase/subscribe actions.
   - Restore purchases.
   - Purchase history summary if practical.

## Acceptance Criteria

- A test user can buy or restore a product through Google Play test billing.
- Backend verifies purchases before granting entitlements.
- Credits cannot be spent twice.
- Generation cannot be started without sufficient entitlement.
- Refund/revocation handling is documented, even if initially manual.
- Current gross-margin assumptions are documented in this folder.

## Tests And Validation

- Backend tests for ledger atomicity.
- Backend tests for entitlement checks.
- Backend tests for duplicate purchase-token handling.
- Flutter tests for paywall states.
- Manual Google Play Billing sandbox test.
- Manual insufficient-credit test from mobile.

## Handoff Notes For Next Agent

Phase 06 must harden the app for Play Store review: data safety, AI content policy, moderation, account deletion, privacy, and production reliability.
