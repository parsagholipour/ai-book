# Phase 10 Output Notes

## Completed

- Added Google Play Billing client integration in Flutter with `in_app_purchase`:
  - queries backend-configured SKUs from Google Play,
  - starts one-time credit purchases as consumables,
  - starts Creator/Pro subscriptions,
  - listens to purchase updates,
  - handles pending, failed, canceled, purchased, and restored states,
  - sends purchase tokens to the backend before finishing/consuming purchases.
- Added buyer-focused paywall UI for:
  - credit balance and credit packs,
  - one-book export credits,
  - Creator monthly and Pro monthly subscriptions,
  - locked export downloads,
  - insufficient-credit full generation approval.
- Added backend Google Play verification plumbing:
  - verifies one-time products through Android Publisher `purchases.products.get`,
  - verifies subscriptions through Android Publisher `purchases.subscriptionsv2.get`,
  - stores purchase records with hashed purchase tokens,
  - stores subscription state,
  - grants credits only after a grantable verified response,
  - keeps pending/canceled purchases non-granting.
- Added ledger idempotency for Google Play grants:
  - duplicate one-time purchase tokens use one grant key,
  - duplicate subscription verification for the same period/order uses one grant key,
  - duplicate tokens cannot double-grant credits.
- Added bounded Pro monthly product metadata. No unlimited usage was introduced.
- Kept provider/model/temperature/generation-strategy internals out of the Flutter UI.
- Kept existing backend ownership, credit, entitlement, and export enforcement as the source of truth.

## Product SKUs

- `tomeza.one_book_export`: one standard export credit, one-time consumable credit grant.
- `tomeza.creator_monthly`: subscription, 3 standard export credits per verified billing period.
- `tomeza.pro_monthly`: subscription, 6 standard export credits per verified billing period.
- `tomeza.credit_pack_1`: one extra standard export credit, one-time consumable credit grant.
- `tomeza.credit_pack_2`: two extra standard export credits, one-time consumable credit grant.

## Local And Test Billing Setup

- Backend environment:
  - `GOOGLE_PLAY_PACKAGE_NAME`: Android package name configured in Play Console.
  - `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: service account JSON with Android Publisher access.
  - `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`: alternative file path for the same JSON.
  - `GOOGLE_PLAY_ACCESS_TOKEN`: optional short-lived local/test token override.
- Flutter:
  - Run from `apps/mobile` with the usual API defines:
    `flutter run --dart-define=APP_ENV=local --dart-define=API_BASE_URL=http://10.0.2.2:4001`
  - Google Play Billing product queries require an Android build/package that matches the Play Console app.
  - Automated Flutter tests use a fake store client and do not require Play Console access.
- Play Console:
  - Create matching one-time products/subscriptions with the SKUs above.
  - Add license testers.
  - Publish an internal or closed testing build for real purchase and restore validation.
  - Use Play Billing test cards for approved, declined, and pending purchase flows.

## Decisions

- One-time credit products are treated as consumables in Flutter and are finished/consumed only after backend verification succeeds.
- Subscriptions grant bounded recurring credits for each verified billing period/order; they also store `CREATOR_PLAN` or `PRO_PLAN` entitlements for account state.
- Pending Google Play purchases are recorded as pending but do not grant credits until Google reports a purchased/active grantable state.
- Real-time developer notifications are not implemented in Phase 10. Until RTDN is added, subscription renewal/cancellation state is refreshed when the app verifies purchases during purchase or restore.

## Known Follow-Ups

- Configure real Play Console products, license testers, service account access, and an internal testing build.
- Manually test sandbox purchase, restore, pending approval, pending decline, subscription renewal, cancellation, and grace-period transitions.
- Add RTDN ingestion later so subscription renewals, cancellations, holds, and expirations update without relying on app restore/open.
- Phase 11 should continue with safety, privacy, compliance, and store-readiness work. Phase 10 did not add report/flag, privacy, account deletion, or store-review copy.

## Validation

- `flutter analyze`
- `flutter test`
- `pnpm --filter @book-maker/api test -- src/googlePlayBilling.test.ts src/mobileProjects.test.ts`
- `pnpm --filter @book-maker/db test -- src/billing.test.ts`
- `pnpm --filter @book-maker/api typecheck`
- `pnpm --filter @book-maker/db typecheck`
- `pnpm test`
- `pnpm typecheck`

## Manual Testing Blocker

- Real Google Play sandbox/manual testing was not run because this local environment does not include Play Console product configuration, a signed/internal-track Android build, license tester opt-in, or Android Publisher service account credentials.

## References Checked

- Android Developers: Google Play Billing integration.
- Android Developers: server backend integration and purchase lifecycle.
- Android Developers: Google Play Billing testing with license testers and pending purchases.
- Flutter `in_app_purchase` package documentation for product queries, purchase stream, completing purchases, and restore behavior.
