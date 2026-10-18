# Mobile app

The Flutter app — this is the product. ~228 files under `lib/`, ~111 test files under `test/`.

```
lib/app/       app shell, routing, theme
lib/shared/    api client, auth token store, design system, feedback widgets
lib/features/  projects · reader · characters · billing · voice · audiobook · auth · account
```

Every feature is layered `data/` → `domain/` → `presentation/`. Riverpod providers live inside the
repository files in `data/`, not in a separate `providers.dart`.

`main.dart` must call `pdfrxFlutterInitialize()` before `runApp`.

## Checks

`pnpm check` does **not** cover Dart — `apps/mobile` is not a pnpm workspace and `.oxlintrc.json`
ignores it. If you touched anything here, run `pnpm check:mobile` (or `make mobile-analyze` and
`make mobile-test`) as well. The 900-line file-size budget *does* apply to `.dart`, via
`node scripts/check-file-sizes.mjs`.

The pdfrx natives are unavailable under `flutter test`, which is why `BookReaderScreen` takes its
viewer through `readerViewerBuilderProvider` — so tests can stub it.

## Book notifications

`lib/features/notifications/` draws the server's book pushes (see `docs/push-notifications.md`).
Firebase is optional per build: without `android/app/google-services.json` the Gradle plugin is
not applied, `FirebasePushMessaging.initialize()` returns null, `pushMessagingProvider` stays null,
and every piece of the feature, the Account row included, switches itself off. Tests get that
null by default; pass a `FakePushMessaging` to `testApp()` to exercise it.

- **Every push is drawn by Dart, and usually in an isolate with no app around it.**
  `firebaseBackgroundMessageHandler` runs on a fresh isolate for a backgrounded or closed app,
  so whatever it needs is set up again there. That is why the per-book ordering guard is a
  file (`FileBookPushLedger`), not memory.
- **A book has one notification slot**, `bookNotificationId` (FNV-1a over the id, never
  `String.hashCode`). The ending cancels the bar and then posts, so it alerts as new rather than
  updating a bar that only alerts once.
- **A resource named only from Dart is listed in `res/raw/tomeza_keep.xml`, or a release build
  deletes it.** Flutter's Gradle plugin shrinks resources in release, and the shrinker cannot read
  Dart strings: `AndroidInitializationSettings('ic_stat_tomeza')` and audio_service's button
  drawables were stripped from the 2026-10-03 AAB, `initialize()` failed with `invalid_icon`, and
  push switched itself off for every release install while debug builds worked. The file is not
  named `keep.xml` because google_sign_in ships one and an app file of that name replaces it.
  `test/features/notifications/notification_icon_resources_test.dart` checks the icon is listed;
  verify a release build with `aapt2 dump resources`, not `unzip -l` (release paths are shortened).
- **A tapped notification opens its book only once there is a session.**
  `PushNotificationsWatcher` holds the book until auth settles, then pushes `/projects/<id>`
  after a frame, and asks for that frame itself. Read the top page from
  `currentConfiguration.last.matchedLocation`: a pushed page leaves `currentConfiguration.uri`
  on the page underneath it.

## Purchases

- **The Play purchase stream has one owner, and it lives as long as the session, not the paywall.**
  `PlayPurchaseProcessor` (`lib/features/billing/data/play_purchase_processor.dart`) is the only
  listener; `BillingPurchaseWatcher` (`app/app.dart`) starts it at sign-in or session restore,
  stops it at sign-out, and asks Play for owned purchases again on resume (at most once a minute).
  Controllers subscribe to its events and never to Play. Before, the only listener was the
  autoDispose paywall controller, so a slow-card payment that cleared with the app closed, a
  process killed under Play's sheet, or a verify call lost to a flaky network was never sent to the
  server — nothing acknowledged it and Play refunded it three days later, after the user had paid.
  A purchase is finished (acknowledged/consumed) only after the server recorded it, and a pending
  one is sent to the server unfinished so Google's notification has an owner when it clears.
  **Play answers a cancel or an error with no purchase list as one update whose `productID` is
  `''`** (`in_app_purchase_android` `_getPurchaseDetailsFromResult`), so that answer settles the
  checkout this app opened, never a product named by the update — keyed by the update, the real
  SKU stayed pending and every purchase was locked until the app was killed.
- **A plan is priced at its base plan, and an intro offer is sold only by the id the server names.**
  Android lists a subscription once per base plan and offer, each priced at its own first phase, so
  keying them by product id let whichever came last set the price.
  `storeProductFromDetails` (`google_play_billing_client.dart`) keeps the base plan's price and
  each discounted offer apart (trials dropped); `introOfferFor` picks the one the billing payload
  names (`introOfferId`, from core's `SUBSCRIPTION_INTRO_OFFERS`, which the server also prices
  payments by), and the purchase goes through that offer's details, whose token is what Play
  charges. Play lists only offers the account is eligible for. Every surface shows the offer
  through `planPriceLine` or with a "Then … / month" line: an offer price is never shown without
  the price it renews at.
  The intro period grants fewer credits than the plan (`introOfferCredits` in the billing payload,
  4,000 for Creator's), so a surface that states the intro's credits states that number:
  `planCreditsLine` ("4,000 credits the first month, then 6,000 / month") wherever a plan's credits
  sit beside its price — by the month for every plan, the yearly one too ("The yearly plan's
  grant", below). `intro_credits_test.dart`.
- **A downgrade is deferred to the renewal date, and Play answers it with no purchase.** A switch to
  a lower tier, or to a shorter term of the same one (`isPlanDowngrade`,
  `google_play_billing_client.dart`, a mirror of the server's tiers and periods), goes through
  `ReplacementMode.deferred`; every other switch stays `chargeFullPrice`. Charged in full, a
  downgrade forfeited what was left of the bigger allowance the reader had already paid for. Play
  answers a deferred change with a success and no purchase list, which the plugin turns into the
  productless placeholder; that used to read as "Google Play did not return a purchase token." The
  store client marks it `planChangeDeferred` under the plan switched to, and
  `PlayPurchaseProcessor._settleDeferredChange` runs a pass over owned purchases — the token Play
  issued is there, filed under the old plan and unacknowledged, and must be recorded now or Play
  refunds it — then settles the checkout as verified with what the server said (or, if Play has not
  surfaced the token yet, the billing as it stands). A purchase delivered under the old plan's id
  with a new token while that switch is open is relabelled to the plan switched to. The billing
  payload's `plan.pendingChange` says what the reader moves to and when; until then `productSku` is
  the plan being run out (`packages/db/CLAUDE.md`). `subscription_checkout_test.dart`,
  `plan_switch_test.dart`. Nothing was bought today, so the result says when the switch happens
  ("Your plan switches to Creator on Wed, Nov 4.", from the verify's `scheduledChange` or the
  payload's `pendingChange`; the dialog is titled "Plan change scheduled"), the checkout's small
  print for a downgrade says it starts at renewal, and the paywall and the plan card show
  `billingPlanChangeLine` in place of "Renews" — as do the account hub's subtitle and the overview
  card, through `paidPlanNextLine` (`account_billing_copy.dart`), so no account surface says
  "Renews" beside a scheduled switch. When Play accepted the change but neither the owned pass nor
  a billing read can confirm it, the processor publishes `PlayPurchaseNotVerified(paid: true)`
  with `playPlanChangeNotConfirmedMessage` ("Google Play accepted your plan change. Restore
  purchases…"): a message, never an error, because nothing failed. `purchase_messages_test.dart`.
- **A price Play did not send is shown as missing, never as the server's catalog price, and the
  surface that is missing it carries the retry.** Play answers a failed product query, or one for a
  product not yet active in Play Console, by leaving products out. The paywall then drew every
  plan "Unavailable" over a disabled "Temporarily unavailable" with no reason and nothing to press,
  each row printed the server's USD price as if Play had quoted it, and a thrown query failed the
  whole load as "Could not load purchase options". `BillingController.load` now keeps the catalog
  when only Play's half fails; `BillingPurchaseState.unpricedAmong` names what it left out;
  `BillingStorePricesNotice` says "Couldn't load prices from Google Play" (or that some did not)
  with a Retry that calls `load()`, and every checkout bar — paywall, export and long-book offers —
  turns its button into "Try again" while the chosen product has no price. There is no
  `fallbackPrice` any more; an unpriced row shows `billingPriceUnavailable`.
  `store_prices_retry_test.dart`.
- **A payment Play took is never reported as a failed one, and a pass nobody started draws
  nothing.** A verify that fails for any reason but a refusal (`_refuses`) after Play settled the
  purchase is `PlayPurchaseNotVerified(paid: true)` with `playPaymentNotRecordedMessage` — "Your
  payment went through … tap Restore purchases" — shown as a message, not an error; it was "Check
  your connection and try again." to someone just charged. A plan Play holds for an account with no
  plan on record is told to restore it, not to "sync before switching". A background pass
  (`background: true`, the resume and sign-in reconciliation) neither holds a purchase surface's
  buttons nor writes its message: it used to spin every paywall button and, on failure, leave
  "Restoring purchase with the backend." on screen. Its failure is shown only when a checkout here
  is waiting on that product. `purchase_messages_test.dart`.
- **Every verify reports what Play charged the buyer, when this process knows.** The store client
  remembers the first pricing phase of the details each checkout bought (an intro offer's when it
  went through one) and every pack price it has seen, and attaches micros and currency to the
  purchase update; the processor sends them as `localPriceMicros` / `localCurrency`. A subscription
  bought before this process started is left unpriced — which phase it is in is Play's to say — and
  Google's recurring price fills a full-price renewal on the server. Analytics only.
  `billing_repository.dart` sends the pair only whole and well formed, and an order id only when it
  is non-empty (`apps/api/src/mobile/CLAUDE.md`, "A blank order id is no order id").
- **A checkout's outcome is told to the growth funnel by the processor, once; its start by the
  controller that asked.** `purchase_started` (SKU, intro or not, the paywall it came from) and the
  failures before Play's sheet opens (`store_unavailable`, `account_unavailable`, `launch_failed`)
  are sent from `BillingController.buy`; Back (`purchase_cancelled`) and Play's error, already-owned
  and token-less answers, and a purchase the server refuses for good (`purchase_failed`) are sent
  from `PlayPurchaseProcessor`, because every open controller hears each `PlayPurchaseEvent` and
  reporting there counted one checkout once per surface. A restore or a background pass is never a
  checkout. A completed purchase sends nothing: the server's payment row is the record. The
  `surface` is the caller's `buy(…, surface:)` when given, else the last paywall
  `paywallViewReporterProvider` saw within half an hour (`PaywallTriggerMemory`) — so a new purchase
  surface that does not open through `showBillingPaywall` should name its trigger. Send and forget
  (`purchase_funnel_reporter.dart`); a test with fake billing sends nothing.
  `test/billing/purchase_funnel_test.dart`.

## Install attribution

- **The install referrer is read once per install, reported once, and its share's remix offered
  once; the raw referrer never leaves the phone.** A reader who taps "Make a book like this" on a
  shared page without the app goes to Play, and the `tomeza://remix/<slug>` link is gone by the time
  the app opens; Play keeps the share page's `referrer` (`utm_source=share&utm_content=<slug>`) for
  the install. `InstallReferrer.kt` reads it through the Play Install Referrer library
  (`com.android.installreferrer:installreferrer`, channel `tomeza/install_referrer`), and
  `InstallAttributionTracker` (`lib/features/attribution/`) is driven by `InstallRemixWatcher`,
  which `app.dart`'s builder mounts beside the router. It used to be called from the first frame of
  `ProjectsHomeScreen`, which no route built after `/home` became the creation chat, so nothing was
  ever reported or offered while its test, mounting a stand-in home, passed (launch review,
  2026-10-15). The watcher acts once per signed-in, online session (an offline session waits for
  the server), a frame after home becomes the top page with nothing over it (top
  `matchedLocation` is `/home` and the root navigator cannot pop). The tracker asks Play at most
  three times per install (only an unreachable service is asked again), keeps the `utm_` fields
  normalised and a share slug that looks like one (`parseInstallReferrer`), posts
  `install_attributed` once from whichever account is signed in (a 400 is not retried), and hands
  the slug out exactly once, after which the watcher offers the existing remix route in a
  dismissible sheet. A page opened over home before Play answered leaves the slug untaken until
  home is on top again. All of it lives in one file (`tomeza_attribution/install_referrer.json`),
  so a relaunch never asks Play again or offers twice, and every failure is skipped silently. Off
  Android (`Platform.isAndroid`, so `flutter test` on a desktop host reads nothing) it does
  nothing; `testApp()` always overrides the tracker with a referrer-less one.
  `test/features/attribution/install_remix_offer_test.dart` mounts the real app, so it fails if the
  wiring goes missing again.

## Sessions

- **A dead session signs the reader out; it never leaves them on error screens.** A password reset
  on another device revokes every session, a deletion request is carried out a day later, and a
  refresh response lost on a flaky network makes the client reuse a rotated refresh token past the
  server's 30 s grace, which revokes the whole session. Before 2026-10-12 nothing told the app: the
  client cleared its tokens, the router still saw a session, and every screen failed with "Sign in
  again to continue." until the reader found Account → Log out. `ApiClient.onSessionLost` now fires
  wherever the client gives a session up (`_loseSession`): any auth refusal from the refresh route,
  a refresh token past its expiry, an empty store, or `SESSION_REVOKED` / `ACCOUNT_DISABLED` from
  any request. `INVALID_SESSION` and `SESSION_EXPIRED` on an ordinary request are *not* final: they
  mean only that the access token was rotated by a racing refresh or ran out, and the refresh that
  follows decides. The check, the store clear and the callback run in one turn under the
  generation fence, so an old account's late failure cannot sign out the next one, and a network
  error never fires it. `AuthController.sessionLost` runs logout's local cleanup and raises the
  one-shot `signedOutNoticeProvider` that the sign-in screen takes in `initState`; it ignores a
  call while no session is on screen (`asData` is null during a restore, sign-in or logout), so it
  needs no listener and none of Riverpod 3's `AsyncData(isLoading)` re-deliveries reach it. Logout
  and session loss both delete the FCM token and take the book notifications down
  (`PushRegistrar.signOut`), because the server stops pushing only to a session it saw end; and
  logout does not wait for the server's revoke. Tests: `test/auth/session_lost_test.dart`,
  `test/auth/session_refresh_race_test.dart`.
- **A token's expiry is the server's clock, so every test of it is made on the server's clock.**
  `MobileSessionTokens.deviceClockAhead` is measured when tokens arrive, from the response's
  `accessTokenExpiresIn` against the time the request left, and stored as `deviceClockAheadMs`
  beside the four fields older builds read. A phone 15 minutes fast used to see each new token as
  due: every request refreshed first, and `apiAuthHeadersProvider` re-read itself once a second
  for as long as a picture was on screen, rotating the token each time. Against a server that does
  not send the lifetime the device clock is trusted as before, and `minHeaderRenewal` (30 s,
  under the 45 s refresh margin) is what keeps that from looping. `test/auth/clock_skew_test.dart`
  counts the refreshes over a simulated minute.
- **A cold start that cannot reach the server opens the session the phone holds, offline; only a
  refusal signs the reader out.** `restoreSession` rethrew the network error from `/auth/me` and the
  router held every route at the splash's "Connection problem", so someone on a plane could open
  none of the books and narrations already on their phone (launch review, 2026-10-13). The token
  store now keeps the account beside the tokens (`tomeza.mobile.user.v1`, written by every session
  the server issues and every online restore, cleared with the tokens), and a restore whose failure
  is `cannotReachServer` (`NETWORK_ERROR`, or a 5xx a gateway or a struggling server answered)
  returns that copy as an `AuthSession(offline: true)` — with `legalAcceptanceRequired` off, since
  the terms gate only refuses writes and nothing can be written offline. With no copy (an install
  last run by a build that did not keep one) the error still reaches the retryable splash.
  `OfflineSessionNotice` (`app.dart`'s builder) draws a strip on every screen while the session is
  offline. `AuthController` asks the server again after 5, 10, 20, 40 and then every 60 s, and at
  once on resume: a confirmed session replaces the offline one, a refusal (the restore has cleared
  the tokens) goes through `sessionLost` — the rule above — and anything else waits for the next
  step; a sign-in, logout or session loss in between wins. What works offline is what the screens
  can show from this phone: the library (the last list the server sent), every book downloaded to
  the reader, and every narration chapter downloaded to the player — see "The library offline"
  in `lib/features/projects/CLAUDE.md`, and the offline entries in the reader and audiobook
  CLAUDE.md files. Everything else shows its own retryable error until the server answers.
  `test/auth/offline_restore_test.dart`, `test/app/auth_gate_navigation_test.dart`.
- **A cold start opened on a screen lands on that screen after the detour, and only a cold start
  does.** Every launch passes the splash while the session is restored, then maybe sign-in or the
  updated terms, and the landing after them was always home — only a remix link was remembered —
  so a link to `/books` or `/projects/<id>` opened the app and lost itself (launch review,
  2026-10-13). The router's `detour` now records any other in-app location in `PendingLocation`
  (`lib/features/auth/data/pending_location.dart`; `isReturnLocation` skips the gates, home, remix
  links and anything with a scheme), and every landing asks one function, `landingLocation`: the
  pending remix first, then that location, then home. The redirect's `landing()`, the terms
  screen's Agree and Not now, and the verify-email screen's walk-on all use it, and the terms
  screen reads it *before* awaiting the acceptance, because the accepted session refreshes the
  router, whose landing can arrive first. The redirect only peeks (it may run twice for one
  navigation); a `routerDelegate` listener calls `settle()` once a page that is not a detour
  (`isDetourPath`) is committed with a session, which clears it and stops anything later in the
  run being remembered — so a logout, a lost session or a terms change mid-run still lands at
  home rather than putting the next account on the last one's screen. In memory only: a cold
  start's detour is one run (a remix also survives the process, see `PendingRemix`). Push taps
  have their own path (`PushNotificationsWatcher`, above). `test/app/cold_start_deep_link_test.dart`.
- **An email sign-up opens on its code, and the credits it waits for are named by the server.**
  The welcome grant waits for a verified email (`apps/api/CLAUDE.md`). Sign-up mails the first code,
  so `AuthController.signUp` remembers `verifyEmailAfterSignUpProvider` before the session lands and
  the router's `landing()` sends that account to `/account/verify-email?sent=1`, which clears it on
  open (a plain object, peeked by the redirect, like `PendingRemix`). Nothing is behind the screen:
  "Not now" walks on. "Verify your email to get your N free credits" shows only while the billing
  payload's `welcomeCreditsPendingReason` is `email_unverified`, with N from
  `welcomeCreditsPendingCredits` — never a constant (`verifyEmailCreditsLine`).
  **A reader asked for credits while free ones wait on their email is offered the email first.** A
  free account's first chat message costs a credit, so a sign-up whose code went to spam met the
  credit paywall with 1,250 credits unclaimed, and the only way back was a dismissible banner on
  the library (launch review C5, 2026-10-15). `VerifyEmailCreditsLead` now heads every surface that
  asks for credits — `BillingOffers` whenever it opens on a shortfall (the message send, plan
  approval, a 402) or shows the one-time packs, the message-allowance sheet when the balance is
  short, and Build's "Not enough credits" warning (`creation_credit_warning.dart`, where Verify
  closes the warning and abandons that build) — with the prices or answers still beneath it; plan
  browsing is not nagged. Its Verify closes the
  sheet before pushing the screen (`openVerifyEmail`), so coming back lands on the page underneath,
  which reads the refreshed billing. The account card's Verify leads with Upgrade stepped down
  beneath it, and `VerifyEmailBanner` (dismissible for the run) sits on the library and on the
  creation-chat home, hidden while the keyboard is up. A confirmed code refreshes the billing (the
  read that settles the grant) and says what came of it (`verifiedEmailMessage`): the credits in the
  balance, a spend hold that will pay them later, or — when the screen had been promised credits
  and the settled grant paid none (the per-network cap) — that none could be added; "Email
  verified." alone is only for nothing promised. It marks the session verified only after the
  screen has popped, because a session change refreshes the router and a refresh landing mid-pop
  rebuilt the screen instead of leaving it. A refused send (429) holds Send/Resend for the
  `Retry-After` the server named (`ApiException.retryAfter`, hours and minutes past an hour), never
  a guessed minute. `test/auth/verify_email_test.dart`, `test/billing/verify_email_credits_lead_test.dart`.

## Release signing

- **A release build is signed with the upload key or not built at all.** `android/app/build.gradle.kts`
  used to fall back to the debug key whenever `android/key.properties` was missing, so
  `flutter build appbundle` succeeded and wrote a bundle Play rejects; the only AAB ever built
  (2026-10-03) was debug-signed (launch review, 2026-10-13). Now every task that writes a signed
  release artifact (`assembleRelease`, `bundleRelease`, `packageRelease`, `signReleaseBundle`,
  `installRelease`, flavored or not) fails when the task graph is ready, before anything compiles,
  and names what is missing; the release `signingConfig` is null rather than debug, so a task the
  check missed writes an unsigned file, never a debug-signed one. A local `flutter run --release`
  on a machine without the key opts in with `-P allowDebugSigning=true` (flutter passes `-P` to
  Gradle) or `ORG_GRADLE_PROJECT_allowDebugSigning=true`; never for a build meant for Play. Two
  more release inputs fail loudly instead of degrading: `make mobile-build-release` refuses to run
  without `GOOGLE_SIGN_IN_CLIENT_ID` (a build without it hides Google sign-in), and an `APP_ENV`
  that names no environment throws at startup instead of becoming `local`, which in a release
  build meant the emulator host and the fake store (`AppEnvironment.parse`,
  `test/app/app_config_test.dart`). A blank `APP_ENV` still means the build mode's default.

**Creating the upload key (once).** Keep the keystore outside the repo and back it and its
password up in a password manager. `android/.gitignore` already ignores `key.properties`, `*.jks`
and `*.keystore`.

```sh
mkdir -p ~/keys
keytool -genkeypair -v -keystore ~/keys/tomeza-upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias upload
```

`apps/mobile/android/key.properties` (a PKCS12 keystore, keytool's default, has one password, so
both password lines are the same; `storeFile` is resolved from `android/`, so give it absolute):

```properties
storePassword=<the keystore password>
keyPassword=<the same password>
keyAlias=upload
storeFile=/home/<you>/keys/tomeza-upload.jks
```

**Building the Play bundle.** Bump `version:` in `pubspec.yaml` first (docs/deployment.md,
"Releasing an app update"), then:

```sh
make mobile-build-release GOOGLE_SIGN_IN_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
keytool -printcert -jarfile apps/mobile/build/app/outputs/bundle/release/app-release.aab
```

The certificate printed must be the upload key's (`CN=` whatever you entered), never
`CN=Android Debug`. Check the notification icon survived shrinking too (`aapt2 dump resources`,
under "Book notifications" above).

**Play App Signing (once, in Play Console).** New apps must use it: Google keeps the key that signs
installs, and the upload key only proves an upload is yours.

1. Create the app for package `com.tomeza.tomeza`, open Test and release → Testing → Internal
   testing, create a release, accept Play App Signing with a Google-generated app signing key,
   and upload the AAB above. Play records its certificate as the upload key.
2. Test and release → App integrity → App signing: copy the **app signing key certificate**
   SHA-1 and SHA-256, and the **upload key certificate** SHA-1.
3. Google sign-in: add Android OAuth clients for `com.tomeza.tomeza` with the app signing SHA-1
   (installs from Play) and the upload SHA-1 (a release installed locally), besides debug
   (`docs/google-sign-in.md`, step 3). Without the app signing one, Google sign-in fails for every
   Play install while every local build works.
4. Firebase (`android/app/google-services.json`): add the same SHA-1 and SHA-256 to the Android app
   in the Firebase console.
5. A lost or leaked upload key is replaceable: App integrity → App signing → "Request upload key
   reset", with a new key's certificate (`keytool -export -rfc -keystore <new>.jks -alias upload
   -file upload_certificate.pem`). The app signing key never leaves Google.

## Feature-level invariants

- `lib/features/projects/CLAUDE.md` — the export-repair watch budget, credit quoting, the
  `part`-file creation chat.
- `lib/features/reader/CLAUDE.md` — the PDF reader, page location, and what the client may do with
  an export's provenance.
- `lib/features/audiobook/CLAUDE.md` — playback, the listening position, and what `playing` means.
- `lib/features/studio/CLAUDE.md` — the Writing Studio editor: hidden bold/italic marks and the caret.

## What the app mirrors from the server

These have no compiler tying them to their server-side twin, so they must be changed on both sides
at once:

- **The credit formula.** `estimateProjectCredits` in
  `lib/features/projects/domain/project_models.dart` re-implements `tierPrice` from
  `packages/core/src/billing.ts`, and there is no server quote route to fall back on. Both sides
  spell their totals out in tests rather than deriving them from the price table, deliberately.
  So does the picture book's picture count (`pictureBookIllustrationCount`, core's
  `pictureBookIllustrationCap`). A book's quote has no export line for anyone since 2026-10-15
  (`lib/features/projects/CLAUDE.md`, "Quoting credits in the app"); `creditCosts.exportUnlock`
  is still sent, as 0, and never read.
- **The yearly plan's grant.** Creator yearly is billed once a year and granted 6,000 credits every
  month (`packages/db/CLAUDE.md`), so every surface shows a plan's credits by the month —
  `planCreditsLine` says "6,000 credits every month, billed yearly", and "About N books a month"
  counts one month's grant. `MobileBillingProduct.creditsPerGrant` is that month's grant, read
  from the server's `products[].monthlyCreditAmount` (6,000 for the yearly plan, a monthly plan's
  own amount, null for a pack) — the one source of it; a server from before the field is read as
  `creditAmount / 12` for a yearly plan. `creditAmount` stays what one payment buys in all (72,000
  for the year), which is what value per price compares. **A refill date is the allowance's.**
  For a yearly subscriber `allowance.resetsAt` is the end of this month and `plan.renewsAt` the end
  of the paid year, so every surface that says when credits arrive reads `resetsAt` ("resets …" on
  the plan card and plan screen; `creditsRefillLine` beside "Renews …" on the account overview),
  never `renewsAt`. `billing_offered_plans_test.dart`, `plan_books_line_test.dart`,
  `test/account/credits_refill_line_test.dart`.
- **The question pickers.** `answerKind` (`choice` / `multi` / `open`) is declared by the server and
  obeyed by four pickers; fewer than two options is `open` whatever the model said. A `multi`
  answer travels as one line.
- **The chat plain-text parser.** `chatMessagePlainText` in
  `lib/features/projects/domain/chat_markdown.dart` is the twin of
  `chatMessagePlainText` in `apps/api/src/chatMessagePlainText.ts`; they must
  move together. Both sides spell the shared fixtures out in tests.
- **The ISBN label.** `isbnWithoutLabel` in `lib/features/book_matter/domain/book_matter.dart`
  copies `withoutIsbnLabel` in `apps/api/src/mobile/bookMatterEdits.ts` (and core's
  `normalizeIsbn` for the chat): a leading "ISBN", "ISBN-10" or "ISBN-13" comes off before the
  24-character limit is counted, and the 10/13 is the label's only when no digit follows it
  ("ISBN 1040123457" keeps its 10). The Title & credits ISBN field strips it as it is pasted.
- **The plan-perk sentences.** `voiceCallsPlanMessage` and `audiobooksPlanMessage` repeat the
  sentences the server's 403 `SUBSCRIPTION_REQUIRED` carries for calls and narration
  (`apps/api/src/mobile/planPerks.ts`); the voice controller maps that code to `planRequired`, which
  ends a call on the plans instead of "Call again". Both entry points read "paid" as
  `hasCreatorSubscription`, the server's `hasActiveSubscriptionEntitlement`.
- **The paywall triggers.** `PaywallTrigger` in
  `lib/features/billing/data/paywall_view_reporter.dart` spells the closed list
  `PAYWALL_TRIGGERS` in `apps/api/src/productEventNames.ts` accepts; the server refuses any other
  word, so a new trigger lands on both sides. `showBillingPaywall` reads the trigger off what it was
  passed (long book, export, shortfall) unless the caller names one, and every purchase started in
  that sheet reports it as its `surface`. `first_book` is the one-time first-book offer; the
  console's two label maps (`GrowthFunnel.tsx`, `GrowthMonetization.tsx`) name it too.
- **The checkout failure classes.** `PurchaseFailureReason` in
  `lib/features/billing/data/purchase_funnel_reporter.dart` spells `PURCHASE_FAILURE_REASONS` in
  `apps/api/src/productEventNames.ts`; the server refuses any other word.
- **The series wire.** `BookSeriesMode` (`lib/features/projects/domain/book_series.dart`)
  spells core's `SERIES_CHOICE_MODES` (`continuation`, `inspired`, `standalone`), which
  `PUT …/creation-sessions/:id/series` and the start body's `series` accept; the session's
  `series` is read by `MobileCreationSeries.fromJson`. An unknown mode reads as no answer, so a
  newer server's mode reopens the offer rather than drawing a wrong one, and a server that sends
  no `series` simply shows none. The answer's `seriesPresets` (`MobileCreationSeriesAnswer`) is
  adopted only for the settings the reader has not chosen (`adoptSeriesFormat`), then every format
  setting counts as chosen, as after a remix. An answer in flight is `isBusy`: it moves the
  session's revision, so a message or a Build sent beside it would be refused as stale.
- **The install referrer.** `parseInstallReferrer` reads what `playStoreUrl` in
  `apps/api/src/mobile/shares/sharePage.ts` writes (`utm_source=share&utm_content=<slug>`), checks
  the slug against `SHARE_SLUG_PATTERN`, and normalises each field to the server's
  `INSTALL_ATTRIBUTION_TOKEN_PATTERN`. Every share link already shared carries the old spelling, so
  renaming either key on the server strands those installs' remixes.
- **Audiobook prices are *not* mirrored any more.** Narration is billed by the words read aloud, which
  only the server counts, so the narrator sheet shows `GET …/audiobook/quote` rather than computing
  `audiobookBase + audiobookPerPage × pages` itself.
- **Job progress steps** are *not* mirrored — the app renders whatever the server serializes, and
  greps for job-type names in `lib/` return nothing. Keep it that way.
- **Prices are not hardcoded** anywhere in the app; they arrive in the billing payload. Keep that
  too.
- **The book-push wire.** `BookPush.fromData` in
  `lib/features/notifications/domain/book_push.dart` reads the FCM data that
  `apps/api/src/push/bookPushMessages.ts` writes: `kind`, `projectId`, `sentAt`, `title`, `body`
  and `percent`, all strings. An unknown kind is ignored, so the server may add one; a renamed
  key or kind silences every installed build. The notification text is the server's, like
  progress steps.
- **The session wire.** `_sessionEndingCodes` in `lib/shared/api/api_client.dart` names
  `SESSION_REVOKED` and `ACCOUNT_DISABLED` as `apps/api/src/mobileAuth.ts` spells them, and
  `MobileSessionTokens.fromJson` reads `accessTokenExpiresIn` from its `authSessionResponse`. A
  renamed code strands readers on error screens again; a dropped lifetime brings back the
  fast-clock refresh churn (see "Sessions" above).
- **The email-verification wire.** `AuthUser.emailVerified` and the billing payload's
  `welcomeCreditsPendingReason` (`email_unverified` / `spend_hold`) and
  `welcomeCreditsPendingCredits` are read as `apps/api/src/mobileAuth.ts` and
  `apps/api/src/mobile/billingSerializer.ts` write them; `EMAIL_ALREADY_VERIFIED` is read as done.
  An absent `emailVerified` reads as verified and an absent reason as no prompt, so an older server
  never sends a reader to a screen it cannot serve. A 429's wait is the `Retry-After` header in
  seconds that `sendRateLimitError` (`apps/api/src/rateLimit.ts`) writes — the body names none — read
  by `retryAfterFromHeader` in `api_client.dart`; a missing or HTTP-date header falls back to a
  minute.
- **The waiting-line wire.** `MobileProjectStatus.fromJson` reads `waitingInLine.booksAhead`
  as `apps/api/src/mobile/projectStatusSerializers.ts` writes it; the count is the server's and the
  words are the app's (`waitingInLineLabel`). A missing key is a book that is not waiting, so an
  older server simply shows no line.
- **The time-left wire.** `MobilePlanningProgress.fromJson` and `MobileGenerationProgress.fromJson`
  read `estimatedSecondsLeft` as `apps/api/src/mobile/projectStatusSerializers.ts` writes it:
  seconds left, never a clock time, and the words are the app's (`formatTimeLeft`). A missing,
  null or non-numeric value is no estimate, so an older server shows no line. See "Time left" in
  `lib/features/projects/CLAUDE.md`.
- **The status-stream wire.** `statusStreamEnding` in
  `lib/features/projects/data/project_status_watch.dart` reads the `event: error` codes
  `apps/api/src/mobile/routes/status.ts` sends: `STATUS_STREAM_SESSION_ENDED` (the token the stream
  opened with ran out, about every fifteen minutes — reopened, never a sign-out),
  `STATUS_STREAM_REPLACED` (a newer stream of the account took its seat — the watch polls instead,
  or two screens would evict each other forever), `PROJECT_NOT_FOUND`; `STATUS_STREAM_ERROR` ends
  nothing. `statusStreamIdleTimeout` (45 s) counts on the server sending *something* — a changed
  status or a `: ping` comment — at least every 15 s; it is applied to the raw bytes, below the
  comment filter. A heartbeat that resends an unchanged status is dropped by the watch
  (`MobileProjectStatus` compares by its payload). See "The status watch" in
  `lib/features/projects/CLAUDE.md`.
- **The book-update wire.** `MobileProjectChatMessage.bookUpdateRevision` reads a reply's
  `bookUpdate.contentRevision` as `apps/api/src/mobile/bookUpdateMetadata.ts` writes it, and
  compares it with the status's `exports.pdf.revision` (the project's revision at that read). A
  missing key is a reply that rebuilt nothing, so an older server simply draws no book row. See
  "A free change's reply ends with the book" in `lib/features/projects/CLAUDE.md`.
- **The app-update wire.** `AppBuild.headers` and the 426 `APP_UPDATE_REQUIRED` body are read by
  `apps/api/src/appUpdates.ts`. Every installed build keeps the spelling it shipped with, so the
  server keeps answering the old one — see "App updates" in `apps/api/CLAUDE.md`.

<!-- gotcha-index: pointer-only -->
