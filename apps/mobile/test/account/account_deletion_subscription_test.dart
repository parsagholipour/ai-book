import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/account/presentation/account_privacy_screen.dart';

/// The server now cancels the Google Play subscription when it carries out a
/// deletion (best effort), so the card no longer tells the reader to do it.
void main() {
  testWidgets('deleting the account says it cancels the Play subscription', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: AccountPrivacyControls(
              config: AppConfig(
                environment: AppEnvironment.local,
                apiBaseUrl: Uri.parse('http://10.0.2.2:4001'),
                privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
                termsOfServiceUrl: Uri.parse('https://example.com/terms'),
                accountDeletionUrl: Uri.parse(
                  'https://example.com/delete-account',
                ),
                supportEmail: 'support@example.com',
              ),
              onRequestDeletion: () async {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(
      find.textContaining(
        'Deleting your account also cancels your Google Play subscription.',
        skipOffstage: false,
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('Google Play › Subscriptions', skipOffstage: false),
      findsOneWidget,
    );
    expect(
      find.textContaining('does not cancel', skipOffstage: false),
      findsNothing,
    );
  });
}
