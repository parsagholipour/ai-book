# Mobile crash reporting

The Android app (`com.tomeza.tomeza`) uses Firebase Crashlytics in project
`ai-book-maker-63317` (**AI-Book-Maker**). Its Firebase app ID is
`1:295152663457:android:2a520377328fa51b13a9e0`.

[Open Crashlytics](https://console.firebase.google.com/project/ai-book-maker-63317/crashlytics).

## What is configured

- `apps/mobile/android/app/google-services.json` identifies the registered Android
  app. This is client configuration that ships in the APK, not an administrator
  credential. Keep it in source control so release builds use the same project.
- The Crashlytics Gradle plugin supplies the native build ID and uploads release
  R8 mapping files. The Flutter package supplies the Crashlytics SDK.
- `initializeCrashReporting()` runs before PDF, audio, and notification startup.
  It installs handlers for Flutter framework errors and uncaught asynchronous
  errors. Reporting failures are consumed so they cannot recursively report
  themselves or block app startup.
- Native crash collection is enabled from process startup in release builds.
  Debug/profile builds disable collection by default. For a diagnostic build,
  use `--dart-define=CRASHLYTICS_ENABLED=true`.
- Reports carry `app_environment` from `APP_ENV`. The SDK includes app version,
  build, device/OS details, exception, and stack trace. No account identifiers,
  book content, or API payloads are deliberately attached by this integration.
- Push notifications reuse the same Firebase app. Their server-side sending
  credentials remain a separate setup described in [push notifications](push-notifications.md).
- Builds without Firebase configuration remain usable with reporting disabled.
  iOS registration is deferred because that target does not ship.

Google Analytics is not enabled. Automatic Analytics breadcrumb logs therefore
are not collected. The implementation follows the
[Firebase Flutter setup guide](https://firebase.google.com/docs/crashlytics/flutter/get-started).

## Verify delivery

Verified on 2026-10-03 with an Android 15 emulator: all three deliberate errors
(native crash, Flutter framework error, and uncaught async error) appeared in the
Firebase dashboard for version `1.0.0` (build `1`). These are test events, not
customer crashes.

Use a disposable Android emulator or test device. The dedicated entry point
does not load the product UI or authenticate a user. It deliberately crashes
once and stores a local marker; use a fresh installation to repeat that crash.

From `apps/mobile`:

```sh
flutter build apk --debug --target tool/crashlytics_smoke.dart \
  --dart-define=APP_ENV=staging --dart-define=CRASHLYTICS_ENABLED=true
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb shell am start -n com.tomeza.tomeza/.MainActivity
# After the intentional native crash, launch again to upload the report.
adb shell am start -n com.tomeza.tomeza/.MainActivity
```

The second launch also reports `Tomeza Crashlytics verification: Flutter framework`
and `Tomeza Crashlytics verification: uncaught async`. Restart again if needed
to flush pending reports, then allow a few minutes for the dashboard to update.
Filter on `verification_run=true` to identify these deliberate test events.
Never distribute the smoke-test APK. Rebuild the normal app afterward.

Normal release builds need no reporting flag. If a release adds `--obfuscate`
or `--split-debug-info`, upload its Dart symbols before distribution:

```sh
firebase crashlytics:symbols:upload \
  --app=1:295152663457:android:2a520377328fa51b13a9e0 path/to/symbols
```
