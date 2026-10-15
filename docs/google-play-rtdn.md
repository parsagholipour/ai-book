# Google Play refunds and real-time notifications

The API accepts wrapped Pub/Sub pushes at `POST /api/billing/google-play/rtdn`.
Deploy migration `000090_google_play_refunds` before running the new API. Set:

```dotenv
GOOGLE_PLAY_PACKAGE_NAME=com.tomeza.tomeza
GOOGLE_PLAY_RTDN_AUDIENCE=https://YOUR_API_HOST/api/billing/google-play/rtdn
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=play-rtdn-push@YOUR_PROJECT.iam.gserviceaccount.com
```

The audience must exactly match the push subscription's configured audience. The email is the
service account selected for **push authentication**, which can differ from the Android Publisher
service account. The endpoint checks the Google signature, issuer, expiry, audience, verified email,
and app package. It returns 503 if configuration is incomplete, including in mock billing mode.
Operator cookies and mobile access tokens do not authenticate this endpoint.

**In production all of these are required.** The API refuses to start — and the deploy refuses the
release before it stops the running one — while `GOOGLE_PLAY_PACKAGE_NAME`, the service account
(`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`, a key with `client_email`
and `private_key`), `GOOGLE_PLAY_RTDN_AUDIENCE` or `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` is
missing. Without the first two every purchase answers 503 and Google refunds it after three days;
without the RTDN pair this endpoint answers 503 and refunds never take credits back. The mock
verifier cannot stand in: `MOCK_GOOGLE_PLAY_BILLING` is forced off outside development and test.
The full list of required settings is in [deployment.md](deployment.md#required-settings).

## Connect Google Play

1. Enable the Pub/Sub API in the Google Cloud project and create a topic for Play notifications.
2. Give `google-play-developer-notifications@system.gserviceaccount.com` the Pub/Sub Publisher role
   on that topic.
3. Create a push subscription on the topic pointing to the HTTPS endpoint above. Keep the default
   wrapped JSON payload; leave payload unwrapping off. Enable authentication, select the push service
   account, and set the exact configured audience.
4. Ensure the Pub/Sub service agent
   `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` can mint ID tokens for the push
   account (`roles/iam.serviceAccountTokenCreator` on that account). The person configuring the
   subscription also needs permission to act as the push account.
5. In Play Console, open the app's monetization setup, enable real-time developer notifications,
   and enter the full `projects/PROJECT_ID/topics/TOPIC_ID` name. Enable subscriptions, **all voided
   purchases**, and one-time product events. One-time cancellation events alone do not cover refunds.
6. Send Play Console's test notification. Confirm an HTTP 204 delivery and the API log event
   `google_play.rtdn_processed`. Test a license-test purchase, spend some credits, refund it in Play
   Console, and confirm the purchase becomes `REVOKED` with a negative ledger adjustment.

Keep the existing Android Publisher credentials configured (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or
`GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`). Subscription and one-time state changes are reverified with
Google. Quantity-based partial refunds fetch `purchases.productsv2` to determine the remaining units.
Fully voided purchases use the authenticated notice's token and order ID, including consumed packs.

Google documents the [notification types and refund quantities](https://developer.android.com/google/play/billing/rtdn-reference),
[Play topic setup](https://developer.android.com/google/play/billing/getting-ready#configure-rtdn),
and [authenticated push subscriptions](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Accounting and delivery

- Refunds reverse the actual recorded grant, preserving historical pricing. A 1,000-credit purchase
  spent down to 200 becomes **−800 purchased credits** after its refund. Purchases and welcome credits
  offset that debt as they land in the same pool. A subscription allowance pays it at the next period
  boundary: first the outgoing allowance's remainder the debt was hiding, then the new allowance, so
  a reader who owes 800 starts a 6,000-credit month with 5,200 and the month after with 6,000. A refund
  arriving mid-period leaves the allowance alone until that boundary. The balance is never clamped to
  zero. Ordinary credit reservations enforce the resulting total balance. Previously downloaded books
  cannot be recalled.
- A cumulative reversal is linked to each grant. Repeated deliveries, different Pub/Sub message IDs,
  repeated partial refunds, and a later full refund cannot debit the same value twice. The reversal's
  metadata records each incremental settlement and its balance.
- Refund markers are retained by token hash and order even before a purchase has a local owner.
  Later claims cannot grant a fully refunded purchase. Partial claims grant only the net retained value.
  Raw purchase tokens are not stored in refund markers or logged by this handler.
- Subscription cancellation keeps access until the paid period ends. A refund of the current order
  revokes its subscription benefits and remaining allowance; spent credits become debt. Refunds of
  historical orders leave newer paid periods alone and exclude unused allowance already expired.
- A delayed verification of an older subscription order is ignored before any billing state is
  written. Recorded order grants and period bounds identify stale receipts, preserving the current
  order ID, subscription expiry, entitlement and allowance together. Updates to the current order,
  including cancellation, expiry corrections and expiration, still apply.
- Non-refund state notifications reverify known purchases. Unclaimed purchases are verified when
  the app first submits them. Console test notifications are acknowledged without billing changes.

The endpoint returns 204 after the database transaction commits. Database and Google API failures
return non-2xx responses so Pub/Sub retries. Configure retry backoff, message retention, and alerts for
delivery failures/oldest unacknowledged messages. If using a dead-letter topic, alert and replay its
messages after fixing the cause; do not discard refund notices. Malformed or unauthenticated pushes
are rejected and can also accumulate in the dead-letter topic.

This handles notices delivered after setup. Historical refunds from before RTDN was enabled need
reconciliation using Google's [Voided Purchases API](https://developers.google.com/android-publisher/voided-purchases).

## Switching subscription plans

Deploy the API before the mobile release. Billing responses include the current purchase's SHA-256
hash so the app can match it to the subscription owned by the selected Google Play account. A
missing or mismatched purchase blocks switching and asks the reader to restore purchases.

The app uses Google's `CHARGE_FULL_PRICE` replacement mode: the new plan and its full credit
allowance take effect immediately, Google charges the new plan price, and the value of unused
paid time extends the new subscription. Checkout discloses the immediate charge and credit reset.
The verified `linkedPurchaseToken` retires the previous entitlement and renewal state in the same
transaction as the new grant. A durable retirement marker prevents delayed old receipts from
reactivating the replaced plan or overwriting its replacement's credit allowance.
Historical payments remain in `PurchasePayment`; a replacement does not refund that payment.

Before publishing, use a Play license tester to switch Creator → Max and Max → Creator, including
after restarting the app. Confirm that Play shows one renewing subscription, the app shows the new
plan and allowance, and restoring purchases does not change that allowance. Already-existing
duplicate subscriptions require reconciliation in Google Play; the app blocks further switches
when more than one plan is owned.

## Purchase account binding

Deploy the API before releasing the updated app. Billing responses provide a stable opaque
`purchaseAccountId`; checkout refreshes it for the signed-in account and attaches it to Google
Play as the obfuscated account ID, including subscription replacements. The API compares the
identity returned by Google with the authenticated account before granting or acknowledging.
Pending payments and restored purchases therefore remain bound to the account that opened checkout,
even after logout, an app restart, or a reinstall. A mismatch remains unfinished and asks the reader
to sign into the original account and restore purchases.

Real receipts created by older builds without an account ID can only be restored by their already
recorded owner. Unclaimed legacy receipts require support verification; the API must not let the
current caller assign them to an arbitrary account. Mock billing is exempt from this legacy check.
An updated app connected to an older API blocks checkout until the account identity is available.

Before publishing, test a delayed payment with a Play license tester: start checkout as A, switch
to B, then complete payment. B must receive no credits or plan; signing back into A and restoring
must grant the purchase once. Repeat after restarting the app.

## Payment history and revenue

Deploy migration `000093_purchase_payments` before starting the updated API, then regenerate the
Prisma client. `PurchaseRecord` keeps token ownership and the latest subscription state.
`PurchasePayment` records each verified paid order once, independently of credit grants, so a
renewal adds cash even when its credits are zero, and expiry never removes prior payments.
Restore, cancellation, and catalog price changes preserve the original amount and date.
Subscription receipts without an order ID grant access under the existing rules but do not
create a cash payment: an expiry extension alone is not evidence of a new sale.

The overview total, daily chart, and user cash totals use payment amounts minus cumulative
refunds. A subscription refund names one order; one-time quantity refunds prorate that purchase.
Refunds reduce the original payment's day, matching the dashboard's existing net-history convention.
The paying-user count includes anyone with a positive recorded payment, including expired plans.

Amounts remain **catalog price snapshots**, in the catalog's reporting currency (the launch
catalog is USD); they are not Google settlement reports and do not account for regional prices,
offers, taxes, exchange rates, or store fees. One-time payments use the verified purchase time;
renewals use first verification time because the subscription's `startTime` is its original start,
not the latest renewal. A delayed notification therefore records cash when first observed.

The migration recovers distinct renewal orders and dates from retained credit grants, including
expired purchases, and applies existing refund markers. The historical code did not save per-order
prices, so backfilled amounts use the last recorded catalog price and carry
`amountSource: legacy_catalog_estimate`. Unobserved renewals and old price changes cannot be
reconstructed exactly from this database; reconcile those against Play financial exports.

## Tests

```bash
pnpm -F @book-maker/api test src/googlePlayRtdn.test.ts src/googlePlayBilling.test.ts
pnpm -F @book-maker/api test src/mobile/purchaseAccount.test.ts
pnpm -F @book-maker/db test src/googlePlayRefunds.test.ts
pnpm -F @book-maker/db test src/subscriptionReplacement.test.ts
pnpm -F @book-maker/db test src/subscriptionRestoration.test.ts
pnpm -F @book-maker/db test src/purchasePayments.test.ts
DB_INTEGRATION=true pnpm -F @book-maker/db test src/purchasePayments.integration.test.ts
(cd apps/mobile && flutter test test/billing/subscription_checkout_test.dart)
(cd apps/mobile && flutter test test/billing/purchase_account_test.dart)
DB_INTEGRATION=true pnpm -F @book-maker/db test src/googlePlayRefunds.integration.test.ts
```

The integration suite needs a migrated PostgreSQL database in `DATABASE_URL`. It uses isolated
fixture IDs, cleans them up, and checks concurrent claims/refunds plus transaction rollback.
