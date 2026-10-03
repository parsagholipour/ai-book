# Push notifications

While a book is being written, the app shows a quiet notification with a progress bar.
When the book finishes, that notification is replaced by "Your book is ready", or by
"Your book needs attention" if the generation failed. Tapping either one opens the book.

| Piece | Where |
| --- | --- |
| Device registration | `PUT` / `DELETE /api/mobile/push-device` (`apps/api/src/mobile/routes/pushDevice.ts`) |
| The sweep that decides what to send | `apps/api/src/push/bookPushSweep.ts`, every 15 s from `server.ts` |
| Message copy and the FCM request | `apps/api/src/push/bookPushMessages.ts`, `pushSender.ts` |
| Drawing the notification | `apps/mobile/lib/features/notifications/` |
| Tables | `PushDevice`, `ProjectPushState` (migration `000088_push_notifications`) |

## One-time setup (Firebase)

The Android client is registered in **AI-Book-Maker** (`ai-book-maker-63317`), and
its `google-services.json` is included in `apps/mobile/android/app/`. Steps 1–2
below are complete. Crashlytics uses the same configuration; see
[crash reporting](crash-reporting.md). The API sending key is still configured
separately in steps 3–4.

Pushes go through Firebase Cloud Messaging. Without a sending key, the API logs
`push.unconfigured` once at startup and sends nothing. A mobile build made without
the client config still runs, with notifications and their Account row disabled.

1. **Create the Firebase project.** In the [Firebase console](https://console.firebase.google.com),
   add a project. Reusing the Google Cloud project that holds the Play service account is fine.
2. **Register the Android app** with package name `com.tomeza.tomeza` (no SHA-1 needed for
   messaging). Download `google-services.json` into `apps/mobile/android/app/` and commit it.
   It isn't secret: it names the project and ships inside every APK. Its presence is what
   switches on the Google Services Gradle plugin (`android/app/build.gradle.kts`).
3. **Create a sending key.** Go to Project settings → Service accounts → *Generate new private
   key*. The `firebase-adminsdk-…` account it belongs to can already send messages.
   Check that *Firebase Cloud Messaging API (V1)* is enabled under Project settings → Cloud
   Messaging.
4. **Give the key to the API.** In the GitHub environment secret `PRODUCTION_ENV`, set
   `FCM_SERVICE_ACCOUNT_JSON` to the key file's JSON on one line, single-quoted. The API
   sends to the key's own `project_id`; `FCM_PROJECT_ID` overrides that.
5. Ship an app build made with that `google-services.json`. Builds without it never register a
   device, so they are never sent anything.

There is no iOS setup. The iOS target doesn't ship. If it ever does, it needs an APNs key
uploaded to Firebase, a `GoogleService-Info.plist` and the Push Notifications capability. The
server already sends iOS devices only the endings, as alerts the system draws, because iOS has
no progress bar to update.

## Trying it locally

- `MOCK_PUSH` is on by default in development. Every push the sweep would send appears in the
  API log as `push.mock_sent`, with the book, kind, percent and text. This needs a registered
  device, so the app must have been built with `google-services.json` and signed in.
- To deliver to a real phone, set `MOCK_PUSH=false` and `FCM_SERVICE_ACCOUNT_FILE=/path/to/key.json`,
  and run the app against the local API (`make mobile-run`, or the physical-device setup).
  Then start a book and leave the app.

## How it behaves

- **Only a book in `GENERATING` is followed**: a newly approved book, or one whose generation is
  running again. Chat edits, continuations and narration are not announced.
- **Progress** comes from the same status the app's own status stream serializes
  (`loadSerializedProjectStatus`), so the notification shows the app's percent and phrase. A
  progress push goes out when the bar has moved 2 points, when the phrase changed (at most once
  a minute), or every 5 minutes as a keep-alive. The percent never goes backwards. Keep-alives
  stop once nothing has changed for 30 minutes, so a book stuck in `GENERATING` loses its
  frozen bar to the phone's timeout instead of being refreshed forever. The next real change
  brings the bar back.
- **The ending** is sent once, by the sweep that deletes the book's `ProjectPushState` row.
  `COMPLETE` and `REVIEW_REQUIRED` are "ready". `FAILED` is "needs attention", unless the reader
  pressed Stop themselves; then the bar just goes away.
- **Who receives it**: every device whose registering session is still live. Signing out revokes
  the session, which stops that phone's pushes without a separate call. A token FCM reports dead is deleted.
- **On the phone**: progress is low-importance and silent, on its own channel ("Book progress"),
  and disappears after 20 minutes without an update. The ending is high-importance, on a channel
  of its own ("Finished books"), so a reader can silence the bar without losing the alert. A
  message older than the last one shown for that book is dropped, so a late progress update
  can't cover "ready".
- **Permission**: the app asks once, right after the reader approves their first plan, with its
  own sheet before the system prompt. Later changes go through Account → Notifications, which
  opens the system prompt if it was never shown, and the phone's notification settings otherwise.
