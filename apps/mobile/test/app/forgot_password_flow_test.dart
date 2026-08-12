import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'app_test_fixtures.dart';

void main() {
  testWidgets('forgot password walks from sign-in to a signed-in session', (
    tester,
  ) async {
    final authRepository = FakeAuthRepository();
    await tester.pumpWidget(
      testApp(
        authRepository: authRepository,
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);

    // The email already typed on the sign-in form rides along.
    await tester.enterText(
      find.byType(TextFormField).at(0),
      'reader@example.com',
    );
    await tester.ensureVisible(find.text('Forgot password?'));
    await tester.tap(find.text('Forgot password?'));
    await tester.pumpAndSettle();

    expect(find.text('Forgot your password?'), findsOneWidget);
    expect(find.text('reader@example.com'), findsOneWidget);

    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();

    expect(authRepository.passwordResetRequests, ['reader@example.com']);
    expect(find.text('Check your email'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).at(1), '123456');
    await tester.enterText(find.byType(TextFormField).at(2), 'BrandNewPass9');
    await tester.ensureVisible(find.text('Reset password'));
    await tester.tap(find.text('Reset password'));
    await tester.pumpAndSettle();

    // The reset response is a session: the reader is inside the app, not back
    // on the sign-in form.
    expect(authRepository.lastResetCode, '123456');
    expect(find.text('Welcome back'), findsNothing);
    expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
  });

  testWidgets('a rejected code shows the server message and stays put', (
    tester,
  ) async {
    final authRepository = FakeAuthRepository(
      resetPasswordError: const ApiException(
        code: 'INVALID_RESET_CODE',
        message: 'That code is not valid anymore. Request a new one.',
        statusCode: 400,
      ),
    );
    await tester.pumpWidget(testApp(authRepository: authRepository));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Forgot password?'));
    await tester.tap(find.text('Forgot password?'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextFormField).at(0),
      'reader@example.com',
    );
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(1), '000000');
    await tester.enterText(find.byType(TextFormField).at(2), 'BrandNewPass9');
    await tester.ensureVisible(find.text('Reset password'));
    await tester.tap(find.text('Reset password'));
    await tester.pumpAndSettle();

    expect(
      find.text('That code is not valid anymore. Request a new one.'),
      findsOneWidget,
    );
    expect(find.text('Check your email'), findsOneWidget);
  });
}
