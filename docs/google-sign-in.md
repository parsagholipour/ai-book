# Google sign-in

The Flutter app offers **Continue with Google** on both authentication screens.
Google proves identity; the API issues the same bearer/refresh sessions as email
authentication. The React operator console keeps its separate password login.

## Google project and Android setup

1. Configure the app's consent screen in Google Cloud / Google Auth Platform.
   If the OAuth app is in testing, add the Google accounts used for testing.
2. Create a **Web application** OAuth client. Its client ID is the server audience;
   no client secret or redirect URI is needed for this native ID-token flow.
3. In the same Google project, create Android OAuth clients for package
   `com.tomeza.tomeza` with each signing certificate's SHA-1: local debug,
   locally installed release, and the **Play App Signing** certificate for
   installs from Google Play. The upload certificate alone does not cover Play installs.
4. Set `GOOGLE_SIGN_IN_CLIENT_ID=<web-client-id>.apps.googleusercontent.com`
   in the API's `.env` (or production environment secret).
5. Install dependencies, migrate, and restart/rebuild the API:

   ```sh
   pnpm install
   pnpm db:generate
   pnpm db:deploy
   ```

   Migration `000089_google_sign_in` adds a nullable unique Google subject to
   `User`; existing accounts and passwords are preserved. Docker's dependency
   volumes need `make deps` or a rebuild after the dependency change.
6. Pass that **same Web client ID** to Flutter, for example:

   ```sh
   make mobile-run GOOGLE_SIGN_IN_CLIENT_ID=123-example.apps.googleusercontent.com
   make mobile-build-release GOOGLE_SIGN_IN_CLIENT_ID=123-example.apps.googleusercontent.com
   ```

   Or use `--dart-define=GOOGLE_SIGN_IN_CLIENT_ID=...` with `flutter run/build`.
   Make does not load the API `.env` automatically. Without this build setting,
   the Google button is hidden; without the server setting the route returns 503.

Google sign-in does not require Firebase Authentication or a service-account
key. The existing Firebase messaging configuration is independent. Providing
the server client ID explicitly also avoids requiring `google-services.json`
just for authentication.

## iOS

Create an iOS OAuth client for the app's bundle ID in the same Google project.
Pass `--dart-define=GOOGLE_SIGN_IN_IOS_CLIENT_ID=<ios-client-id>` as well as the
Web client ID above. Register the iOS client's **reversed client ID** in
`ios/Runner/Info.plist` under `CFBundleURLTypes` → `CFBundleURLSchemes`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>CFBundleURLSchemes</key>
    <array><string>com.googleusercontent.apps.YOUR_IOS_CLIENT_ID</string></array>
  </dict>
</array>
```

Use the actual reversed ID supplied by Google. Merge with any existing URL
types. The button is hidden on iOS until both client IDs are supplied. Web and
desktop Flutter builds do not expose this native flow.

## Account behavior

- New Google users accept the Terms/Privacy Policy and age/guardian statement
  before any account is created, including when starting from **Sign in**.
  Names and email addresses come only from the server-verified Google token.
- New accounts get the same IP/country welcome-credit claim as email signup.
  Later Google sign-ins and account linking do not create another claim.
- Existing email/password users confirm their Tomeza password once to connect
  Google. An email match alone never links accounts. Forgot password remains
  available for recovery, including setting a password on a Google-created account.
- Future sign-ins use Google's stable subject ID, so a changed Google email
  does not move the identity to a different Tomeza account. The app retains
  the original account email. Disabled accounts cannot sign in.
- Account deletion clears the Google subject as well as the password and
  sessions. Cancelling Google's chooser or the signup/link dialog creates no session.
- The API verifies token signatures, issuer, audience, expiry, and verified
  email through `google-auth-library`; Google ID tokens are never stored.
  Passwords, Google tokens, and app tokens must not be logged.

## Verification

Automated API tests use locally signed tokens and a substituted certificate
lookup to exercise the actual Google verification library without a Google
account. Flutter tests substitute the native account chooser and cover login,
signup consent, linking, cancellation and errors.

For the live check, install a build signed with a registered certificate on an
Android device/emulator with Google Play services. Try a new account, sign out,
sign back in, connect an existing password account, and dismiss the chooser.
A real OAuth client configuration and a device are required for that check.

References: [Google backend verification](https://developers.google.com/identity/sign-in/android/backend-auth),
[Flutter Android setup](https://pub.dev/packages/google_sign_in_android),
[Flutter iOS setup](https://pub.dev/packages/google_sign_in_ios).
