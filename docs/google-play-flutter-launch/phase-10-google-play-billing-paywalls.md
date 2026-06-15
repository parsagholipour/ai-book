# Phase 10 - Google Play Billing And Paywalls

## Objective

Add Google Play Billing, backend purchase verification, and paywalls that unlock credits, subscriptions, and exports without allowing unbounded AI usage.

## Monetization Direction

- Free users can create an outline or limited preview.
- Paid users can unlock exports or buy credits.
- Subscriptions grant recurring credits and feature access.
- Credit packs allow extra usage.
- The backend is authoritative for purchases and entitlements.

## Implementation Tasks

1. Configure Google Play products:
   - One-book unlock.
   - Creator subscription.
   - Pro subscription.
   - Credit pack.
2. Add Flutter billing integration:
   - Query products.
   - Start purchase.
   - Handle pending purchases.
   - Restore purchases.
   - Send purchase token to backend.
3. Add backend verification:
   - Verify purchase tokens with Google.
   - Store purchase records.
   - Grant credits or entitlement after verification.
   - Handle duplicate tokens idempotently.
4. Add subscription handling:
   - Store subscription state.
   - Update entitlements on renewal, cancellation, grace period, or expiry.
   - Document any manual steps if real-time notifications are not yet implemented.
5. Add paywalls:
   - Export unlock.
   - Premium quality.
   - Images.
   - Long book.
   - Credit balance and restore purchases.

## Acceptance Criteria

- Google Play test billing works in a sandbox/internal track.
- Backend verifies purchases before granting credits or entitlement.
- Restore purchases updates backend state.
- Duplicate purchase tokens do not double-grant credits.
- Users can understand why a paywall appears.
- Users can still get free preview value before paying.

## Tests

- Backend purchase verification tests with mocked Google responses.
- Ledger grant/idempotency tests.
- Flutter paywall widget tests.
- Manual test purchase.
- Manual restore purchase.
- Manual pending/failed purchase handling where practical.
- Run `flutter analyze`.
- Run `flutter test`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 11 should harden the app for Google Play review and real users: safety, privacy, compliance, and store readiness.
