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
- **A tapped notification opens its book only once there is a session.**
  `PushNotificationsWatcher` holds the book until auth settles, then pushes `/projects/<id>`
  after a frame, and asks for that frame itself. Read the top page from
  `currentConfiguration.last.matchedLocation`: a pushed page leaves `currentConfiguration.uri`
  on the page underneath it.

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
- **The question pickers.** `answerKind` (`choice` / `multi` / `open`) is declared by the server and
  obeyed by four pickers; fewer than two options is `open` whatever the model said. A `multi`
  answer travels as one line.
- **The chat plain-text parser.** `chatMessagePlainText` in
  `lib/features/projects/domain/chat_markdown.dart` is the twin of
  `chatMessagePlainText` in `apps/api/src/chatMessagePlainText.ts`; they must
  move together. Both sides spell the shared fixtures out in tests.
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
- **The app-update wire.** `AppBuild.headers` and the 426 `APP_UPDATE_REQUIRED` body are read by
  `apps/api/src/appUpdates.ts`. Every installed build keeps the spelling it shipped with, so the
  server keeps answering the old one — see "App updates" in `apps/api/CLAUDE.md`.

<!-- gotcha-index: pointer-only -->
