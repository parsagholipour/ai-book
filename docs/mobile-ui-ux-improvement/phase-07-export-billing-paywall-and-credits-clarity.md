# Phase 07 - Export, Billing, Paywall, And Credits Clarity

## Objective

Make the paid/export moment transparent, understandable, and fair.

Users should know what a credit buys, why a paywall appeared, what product fits their need, and what happens after payment or restore.

## UX Direction

- Explain value before price.
- Explain the specific lock before showing products.
- Keep Google Play billing states in user language.
- Avoid unlimited-usage promises.
- Show success, pending, cancellation, declined, restore, and unavailable states clearly.

## Implementation Tasks

1. Improve credit language:
   - Define credits in product terms.
   - Explain available, reserved, spent, and export unlocks only where needed.
   - Avoid ledger/accounting terms in normal UI.
2. Improve export panel:
   - Explain PDF vs EPUB.
   - Show locked/unlocked state per format.
   - Explain why download/share is disabled.
   - Show post-download/share success state.
3. Improve paywall context:
   - Use the trigger reason: export unlock, insufficient credits, premium quality, images, long book, or adding credits.
   - Show what the selected purchase unlocks.
   - Prefer one recommended product when context is specific.
4. Improve product tiles:
   - Clear product names.
   - Price from Google Play when available.
   - Benefits in concrete book outcomes.
   - Subscription renewal/cancellation language where required.
5. Improve billing states:
   - Google Play unavailable.
   - Product missing.
   - Pending purchase.
   - Purchase canceled.
   - Purchase declined.
   - Verification failed.
   - Restore found purchases.
   - Restore found nothing.
6. Keep backend authoritative:
   - Flutter must never grant credits locally.
   - Flutter must wait for backend verification before marking purchase value as available.

## Acceptance Criteria

- Users understand why they are being asked to pay.
- Users understand what a credit or subscription gives them without reading policy docs.
- Locked export controls point to a useful unlock path.
- Billing failure, pending, restore, and unavailable states are understandable.
- No UI suggests unlimited generation, unlimited images, or client-side purchase trust.

## Tests And Validation

- Widget tests for paywall trigger contexts.
- Widget tests for store unavailable and missing product states.
- Widget tests for pending, error, canceled, and restored purchase messages.
- Widget tests for locked/unlocked export actions.
- Run `flutter analyze`.
- Run `flutter test`.
- Manual billing sandbox testing when Play Console credentials and test track are available.

## Handoff Notes For Next Phase

Phase 08 should make account, support, privacy, AI disclosure, reporting, and deletion easy to understand and easy to find.
