# Tomeza Mobile

Flutter app for the Google Play launch work. Phase 09 includes authentication, project list loading, credits, guided book creation, plan generation/revision/approval, generation progress, generated page preview, recovery, and protected PDF/EPUB download/share. Google Play Billing client flows are intentionally not implemented yet.

## Local Tooling

Use Flutter stable. This phase was validated with Flutter `3.44.2` and Dart `3.12.2`.

The app reads build-time config through `--dart-define`:

- `APP_ENV`: `local`, `staging`, or `production`. Defaults to `local`.
- `API_BASE_URL`: absolute API URL. Local Android emulator builds default to `http://10.0.2.2:4001`.

## Run Locally

Start the local dependencies and backend from the repository root:

```sh
pnpm install
pnpm db:generate
docker compose up -d postgres redis
pnpm db:deploy
pnpm db:seed

# terminal 1
MOCK_AI=true pnpm dev:api

# terminal 2
MOCK_AI=true pnpm dev:worker
```

Run the app from `apps/mobile` in another terminal:

```sh
flutter run \
  --dart-define=APP_ENV=local \
  --dart-define=API_BASE_URL=http://10.0.2.2:4001
```

For a physical Android device, replace `10.0.2.2` with the development machine LAN IP.

Phase 09 local workflow:

1. Sign up or sign in with an email/password account.
2. Tap `New`.
3. Choose book type, prompt/title, length, finish, and visuals.
4. Create the project, then open `Create book plan`.
5. Review the plan, answer questions, send revisions, and approve when ready.
6. Watch `Book progress` for writing, visuals, export readiness, and recoverable failure actions.
7. Preview generated pages as they become available.
8. Download PDF/EPUB when the backend reports the export is ready and unlocked; use `Share` for Android's share sheet after unlock.

The local backend and worker should both run with `MOCK_AI=true` for this workflow.

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
