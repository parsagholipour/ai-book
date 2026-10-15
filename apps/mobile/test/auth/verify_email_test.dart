import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/app/routing/app_router.dart';
import 'package:tomeza/features/auth/data/email_verification_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/verify_email_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../app/app_test_fixtures.dart';

/// The welcome credits wait for a confirmed email: the banner that says so
/// (with the amount the billing payload names), the screen that takes the
/// code, and the landing right after an email sign-up.
void main() {
  MobileBilling billing({String? reason, int? credits, bool pending = true}) {
    return MobileBilling(
      credits: const CreditBalance(
        available: 0,
        reserved: 0,
        lifetimeGranted: 0,
        lifetimeSpent: 0,
      ),
      entitlements: const [],
      products: const [],
      creditCosts: const {},
      freeTier: const MobileFreeTier(welcomeCredits: 1150),
      welcomeCreditsPending: pending,
      welcomeCreditsPendingReason: reason,
      welcomeCreditsPendingCredits: credits,
    );
  }

  final waiting = billing(reason: 'email_unverified', credits: 1150);
  final settled = billing(pending: false);

  Widget app({
    required _SwitchingBilling billingRepository,
    required _FakeEmailVerification verification,
    FakeAuthRepository? auth,
  }) {
    return testApp(
      authRepository:
          auth ??
          FakeAuthRepository(initialSession: fakeSession(emailVerified: false)),
      projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
      billingRepository: billingRepository,
      overrides: [
        emailVerificationRepositoryProvider.overrideWithValue(verification),
      ],
    );
  }

  /// Cold start lands at home once the session is restored (the splash
  /// detour forgets where it was headed), so tests go where they mean to.
  Future<void> open(WidgetTester tester, Widget widget, String location) async {
    await tester.pumpWidget(widget);
    await tester.pumpAndSettle();
    if (location == '/home') return;
    ProviderScope.containerOf(
      tester.element(find.byType(TomezaApp)),
    ).read(appRouterProvider).go(location);
    await tester.pumpAndSettle();
  }

  testWidgets('the library banner names the credits, and verifying settles '
      'them', (tester) async {
    final billingRepository = _SwitchingBilling(waiting);
    final verification = _FakeEmailVerification(
      onConfirmed: () => billingRepository.current = settled,
    );
    await open(
      tester,
      app(billingRepository: billingRepository, verification: verification),
      '/books',
    );

    expect(
      find.text('Verify your email to get your 1,150 free credits.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Verify email'));
    await tester.pumpAndSettle();

    expect(find.text('Verify your email'), findsOneWidget);
    expect(find.textContaining('creator@example.com'), findsOneWidget);
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(verification.sent, 1);
    expect(find.text('Check your email'), findsOneWidget);
    expect(find.textContaining('Resend code in 1:'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField), '123456');
    await tester.pumpAndSettle();

    expect(verification.confirmed, ['123456']);
    expect(
      find.text(
        'Email verified. Your 1,150 welcome credits are in your balance.',
      ),
      findsOneWidget,
    );
    // Back on the library, and the credits have arrived, so the banner goes.
    expect(find.text('Your books'), findsOneWidget);
    expect(find.byKey(const ValueKey('verify-email-banner')), findsNothing);
  });

  testWidgets('a wrong code is said in the server\'s words and keeps the '
      'reader on the code', (tester) async {
    final verification = _FakeEmailVerification(
      confirmError: const ApiException(
        code: 'INVALID_VERIFICATION_CODE',
        message:
            'That code didn\'t work. Check the newest email from Tomeza or send a new code.',
        statusCode: 400,
      ),
    );
    await open(
      tester,
      app(
        billingRepository: _SwitchingBilling(waiting),
        verification: verification,
      ),
      '/account/verify-email?sent=1',
    );

    // Opened with the code already on its way: no send, straight to entry.
    expect(find.text('Check your email'), findsOneWidget);
    expect(verification.sent, 0);
    await tester.enterText(find.byType(TextFormField), '000000');
    await tester.pumpAndSettle();

    expect(find.text('Could not verify your email'), findsOneWidget);
    expect(
      find.textContaining('Check the newest email from Tomeza'),
      findsOneWidget,
    );
    expect(find.text('Check your email'), findsOneWidget);
  });

  testWidgets('the banner shows only while verification is what the credits '
      'wait for, and "not now" puts it away', (tester) async {
    final billingRepository = _SwitchingBilling(
      billing(reason: 'spend_hold', credits: 1150),
    );
    await open(
      tester,
      app(
        billingRepository: billingRepository,
        verification: _FakeEmailVerification(),
      ),
      '/books',
    );
    expect(find.text('Your books'), findsOneWidget);
    expect(find.byKey(const ValueKey('verify-email-banner')), findsNothing);

    // The hold lifts nothing the reader can do; verification is theirs.
    billingRepository.current = waiting;
    ProviderScope.containerOf(
      tester.element(find.byType(TomezaApp)),
    ).invalidate(billingProvider);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('verify-email-banner')), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('verify-email-banner')),
        matching: find.byType(IconButton),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('verify-email-banner')), findsNothing);
  });

  testWidgets('an email sign-up opens on the code its account was mailed, '
      'and "not now" walks on', (tester) async {
    final verification = _FakeEmailVerification();
    await open(
      tester,
      app(
        auth: FakeAuthRepository(signUpEmailVerified: false),
        billingRepository: _SwitchingBilling(waiting),
        verification: verification,
      ),
      '/home',
    );
    await tester.ensureVisible(find.text('Create account'));
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'CorrectPass123',
    );
    final boxes = find.byType(Checkbox);
    await tester.ensureVisible(boxes.first);
    await tester.tap(boxes.first);
    await tester.tap(boxes.last);
    final create = find.widgetWithText(FilledButton, 'Create account');
    await tester.ensureVisible(create);
    await tester.tap(create);
    await tester.pumpAndSettle();

    expect(find.text('Check your email'), findsOneWidget);
    expect(find.textContaining('reader@example.com'), findsOneWidget);
    expect(
      find.text('Verify your email to get your 1,150 free credits.'),
      findsOneWidget,
    );
    // Sign-up already mailed the first code.
    expect(verification.sent, 0);

    await tester.ensureVisible(find.text('Not now'));
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(find.text('Check your email'), findsNothing);
    expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
  });

  group('the creation-chat home', () {
    testWidgets('says the credits wait on the email, and Verify opens the '
        'code', (tester) async {
      await open(
        tester,
        app(
          billingRepository: _SwitchingBilling(waiting),
          verification: _FakeEmailVerification(),
        ),
        '/home',
      );

      expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
      final banner = find.byKey(const ValueKey('verify-email-banner'));
      expect(banner, findsOneWidget);
      expect(
        find.text('Verify your email to get your 1,150 free credits.'),
        findsOneWidget,
      );

      await tester.tap(
        find.descendant(of: banner, matching: find.text('Verify email')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Verify your email'), findsOneWidget);
    });

    testWidgets('shows nothing once nothing waits on the email', (
      tester,
    ) async {
      await open(
        tester,
        app(
          billingRepository: _SwitchingBilling(settled),
          verification: _FakeEmailVerification(),
        ),
        '/home',
      );

      expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
      expect(find.byKey(const ValueKey('verify-email-banner')), findsNothing);
    });
  });

  group('asking for a code too soon', () {
    ApiException tooSoon(Duration wait) => ApiException(
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Try again soon.',
      statusCode: 429,
      retryAfter: wait,
    );

    TextButton resendButton(WidgetTester tester) => tester.widget<TextButton>(
      find.descendant(
        of: find.byKey(const ValueKey('verify-email-resend')),
        matching: find.byType(TextButton),
      ),
    );

    testWidgets('a resend the server refuses waits out its Retry-After, '
        'counting down', (tester) async {
      final verification = _FakeEmailVerification(
        sendError: tooSoon(const Duration(seconds: 125)),
      );
      await open(
        tester,
        app(
          billingRepository: _SwitchingBilling(waiting),
          verification: verification,
        ),
        '/account/verify-email?sent=1',
      );
      // Sign-up's own minute runs out first.
      await tester.pump(const Duration(seconds: 61));
      await tester.pumpAndSettle();
      expect(find.text('Resend code'), findsOneWidget);

      await tester.tap(find.text('Resend code'));
      await tester.pumpAndSettle();

      expect(find.text('Could not send a new code yet'), findsOneWidget);
      expect(find.text('Resend code in 2:05'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNull);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Resend code in 2:04'), findsOneWidget);

      await tester.pump(const Duration(seconds: 124));
      await tester.pumpAndSettle();
      expect(find.text('Resend code'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNotNull);
    });

    testWidgets('a first send refused for the day holds Send code for the '
        'hours the server named', (tester) async {
      final verification = _FakeEmailVerification(
        sendError: tooSoon(const Duration(hours: 3, minutes: 5)),
      );
      await open(
        tester,
        app(
          billingRepository: _SwitchingBilling(waiting),
          verification: verification,
        ),
        '/account/verify-email',
      );

      await tester.tap(find.text('Send code'));
      await tester.pumpAndSettle();

      expect(verification.sent, 0);
      expect(find.text('Could not send the code yet'), findsOneWidget);
      expect(find.text('Send code in 3 h 05 min'), findsOneWidget);
      final send = tester.widget<FilledButton>(
        find.descendant(
          of: find.byKey(const ValueKey('verify-email-send')),
          matching: find.byType(FilledButton),
        ),
      );
      expect(send.onPressed, isNull);
    });
  });

  group('what a confirmed code says arrived', () {
    Future<void> confirm(WidgetTester tester, MobileBilling after) async {
      final billingRepository = _SwitchingBilling(waiting);
      final verification = _FakeEmailVerification(
        onConfirmed: () => billingRepository.current = after,
      );
      await open(
        tester,
        app(billingRepository: billingRepository, verification: verification),
        '/account/verify-email?sent=1',
      );
      await tester.enterText(find.byType(TextFormField), '123456');
      await tester.pumpAndSettle();
    }

    testWidgets('a grant the network cap refused is said plainly', (
      tester,
    ) async {
      // Settled, and nothing granted: the address had had its share.
      await confirm(
        tester,
        MobileBilling(
          credits: const CreditBalance(
            available: 0,
            reserved: 0,
            lifetimeGranted: 0,
            lifetimeSpent: 0,
          ),
          entitlements: const [],
          products: const [],
          creditCosts: const {},
        ),
      );

      expect(
        find.text(
          'Email verified, but no free credits could be added to this '
          'account. Free credits go to a limited number of new accounts on '
          'each network.',
        ),
        findsOneWidget,
      );
      expect(find.text('Email verified.'), findsNothing);
    });

    testWidgets('a grant the spend hold keeps says it will come', (
      tester,
    ) async {
      await confirm(tester, billing(reason: 'spend_hold', credits: 1150));

      expect(
        find.text(
          'Email verified. Your free credits are on hold while Tomeza is '
          'very busy, and will reach your balance on their own.',
        ),
        findsOneWidget,
      );
    });

    test('nothing promised before is nothing to report after', () {
      expect(
        verifiedEmailMessage(
          MobileBilling(
            credits: const CreditBalance(
              available: 0,
              reserved: 0,
              lifetimeGranted: 0,
              lifetimeSpent: 0,
            ),
            entitlements: const [],
            products: const [],
            creditCosts: const {},
          ),
        ),
        'Email verified.',
      );
      expect(
        verifiedEmailMessage(null, expectedCredits: 1150),
        'Email verified.',
      );
    });
  });
}

class _SwitchingBilling extends FakeBillingRepository {
  _SwitchingBilling(this.current);

  MobileBilling current;

  @override
  Future<MobileBilling> getBilling() async => current;
}

class _FakeEmailVerification implements EmailVerificationRepository {
  _FakeEmailVerification({this.onConfirmed, this.confirmError, this.sendError});

  final VoidCallback? onConfirmed;
  final Object? confirmError;

  /// Thrown by the next send, then forgotten.
  Object? sendError;
  int sent = 0;
  final confirmed = <String>[];

  @override
  Future<EmailVerificationSent> sendCode() async {
    final error = sendError;
    if (error != null) {
      sendError = null;
      throw error;
    }
    sent += 1;
    return const EmailVerificationSent(email: 'creator@example.com');
  }

  @override
  Future<AuthUser> confirm(String code) async {
    confirmed.add(code);
    final error = confirmError;
    if (error != null) throw error;
    onConfirmed?.call();
    return fakeSession().user;
  }
}
