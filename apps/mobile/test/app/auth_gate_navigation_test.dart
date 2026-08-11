import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/domain/legal_gate.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'app_test_fixtures.dart';

void main() {
  testWidgets('auth gate routes signed-out users to sign in and sign up', (
    tester,
  ) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));

    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    await tester.ensureVisible(find.text('Create account'));
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(find.text('Create your account'), findsOneWidget);
    expect(find.text('I already have an account'), findsOneWidget);
  });

  testWidgets('authenticated users land on the book chat', (tester) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(initialSession: fakeSession()),
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
    expect(find.text('A kids book'), findsOneWidget);
    expect(find.text('Create your account'), findsNothing);
  });

  testWidgets('existing users agree to updated terms with one tap', (
    tester,
  ) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          initialSession: fakeSession(legalAcceptanceRequired: true),
        ),
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('The terms have been updated'), findsOneWidget);
    // Re-acceptance is one tap: the age attestation from signup is not
    // re-collected, so no checkboxes stand between the reader and the app.
    expect(find.byType(Checkbox), findsNothing);

    final agreeButton = find.widgetWithText(FilledButton, 'Agree and continue');
    await tester.ensureVisible(agreeButton);
    await tester.tap(agreeButton);
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text('The terms have been updated'), findsNothing);
  });

  testWidgets('not now lets the reader keep reading until a write is refused', (
    tester,
  ) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          initialSession: fakeSession(legalAcceptanceRequired: true),
        ),
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
      ),
    );
    await tester.pumpAndSettle();

    final notNowButton = find.widgetWithText(OutlinedButton, 'Not now');
    await tester.ensureVisible(notNowButton);
    await tester.tap(notNowButton);
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text('The terms have been updated'), findsNothing);

    // A 428 on any write clears the dismissal through this provider; drive it
    // directly and the router must walk the reader back to the gate.
    final container = ProviderScope.containerOf(
      tester.element(find.byType(TomezaApp)),
    );
    container.read(legalGateDismissedProvider.notifier).reset();
    await tester.pumpAndSettle();

    expect(find.text('The terms have been updated'), findsOneWidget);
  });

  testWidgets('signup legal attestations start unchecked and are required', (
    tester,
  ) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Create account'));
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    final checkboxes = tester.widgetList<Checkbox>(find.byType(Checkbox));
    expect(checkboxes, hasLength(2));
    expect(checkboxes.every((checkbox) => checkbox.value == false), isTrue);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'CorrectPass123',
    );
    final createButton = find.widgetWithText(FilledButton, 'Create account');
    await tester.ensureVisible(createButton);
    await tester.tap(createButton);
    await tester.pump();

    expect(
      find.text('Accept both statements to create your account.'),
      findsOneWidget,
    );
  });

  testWidgets('restore network errors stay on a retryable splash screen', (
    tester,
  ) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          initialSession: fakeSession(),
          restoreError: const ApiException(
            code: 'NETWORK_ERROR',
            message: 'Check your connection and try again.',
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Connection problem'), findsOneWidget);
    expect(find.text('Check your connection and try again.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Welcome back'), findsNothing);
  });

  testWidgets('failed sign in keeps the email field filled', (tester) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          signInError: const ApiException(
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect.',
            statusCode: 401,
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'wrong-password',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();

    final emailField = tester.widget<TextFormField>(
      find.widgetWithText(TextFormField, 'Email'),
    );
    expect(emailField.controller?.text, 'reader@example.com');
    expect(find.text('Email or password is incorrect.'), findsOneWidget);
  });
}

