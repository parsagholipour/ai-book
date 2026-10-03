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
  spent down to 200 becomes **−800 purchased credits** after its refund. Future purchases and grants
  offset that debt; the balance is never clamped to zero. Ordinary credit reservations enforce the
  resulting total balance. Previously downloaded books cannot be recalled.
- A cumulative reversal is linked to each grant. Repeated deliveries, different Pub/Sub message IDs,
  repeated partial refunds, and a later full refund cannot debit the same value twice. The reversal's
  metadata records each incremental settlement and its balance.
- Refund markers are retained by token hash and order even before a purchase has a local owner.
  Later claims cannot grant a fully refunded purchase. Partial claims grant only the net retained value.
  Raw purchase tokens are not stored in refund markers or logged by this handler.
- Subscription cancellation keeps access until the paid period ends. A refund of the current order
  revokes its subscription benefits and remaining allowance; spent credits become debt. Refunds of
  historical orders leave newer paid periods alone and exclude unused allowance already expired.
- Non-refund state notifications reverify known purchases. Unclaimed purchases are verified when
  the app first submits them. Console test notifications are acknowledged without billing changes.

The endpoint returns 204 after the database transaction commits. Database and Google API failures
return non-2xx responses so Pub/Sub retries. Configure retry backoff, message retention, and alerts for
delivery failures/oldest unacknowledged messages. If using a dead-letter topic, alert and replay its
messages after fixing the cause; do not discard refund notices. Malformed or unauthenticated pushes
are rejected and can also accumulate in the dead-letter topic.

This handles notices delivered after setup. Historical refunds from before RTDN was enabled need
reconciliation using Google's [Voided Purchases API](https://developers.google.com/android-publisher/voided-purchases).

## Tests

```bash
pnpm -F @book-maker/api test src/googlePlayRtdn.test.ts src/googlePlayBilling.test.ts
pnpm -F @book-maker/db test src/googlePlayRefunds.test.ts
DB_INTEGRATION=true pnpm -F @book-maker/db test src/googlePlayRefunds.integration.test.ts
```

The integration suite needs a migrated PostgreSQL database in `DATABASE_URL`. It uses isolated
fixture IDs, cleans them up, and checks concurrent claims/refunds plus transaction rollback.
