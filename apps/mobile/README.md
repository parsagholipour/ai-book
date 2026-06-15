# Tomeza Mobile

Flutter app shell for the Google Play launch work. Phase 07 includes authentication, session restore, project list loading, and a credits/account area. Book creation, planning, generation approval, downloads, and Google Play Billing client flows are intentionally not implemented yet.

## Local Tooling

Use Flutter stable. This phase was validated with Flutter `3.44.2` and Dart `3.12.2`.

The app reads build-time config through `--dart-define`:

- `APP_ENV`: `local`, `staging`, or `production`. Defaults to `local`.
- `API_BASE_URL`: absolute API URL. Local Android emulator builds default to `http://10.0.2.2:4001`.

## Run Locally

Start the backend from the repository root:

```sh
pnpm dev:api
```

Run the app from `apps/mobile`:

```sh
flutter run \
  --dart-define=APP_ENV=local \
  --dart-define=API_BASE_URL=http://10.0.2.2:4001
```

For a physical Android device, replace `10.0.2.2` with the development machine LAN IP.

## Android Builds

Placeholder Android package/application ID:

```text
com.tomeza.tomeza
```

Replace it with the final Play Console package name before production release.

Debug APK:

```sh
flutter build apk --debug \
  --dart-define=APP_ENV=local \
  --dart-define=API_BASE_URL=http://10.0.2.2:4001
```

Release APK/AAB path:

```sh
flutter build appbundle --release \
  --dart-define=APP_ENV=production \
  --dart-define=API_BASE_URL=https://api.example.com
```

Release signing is still using the scaffold placeholder debug signing config. Configure a real keystore and production HTTPS API URL before Play Store submission.
