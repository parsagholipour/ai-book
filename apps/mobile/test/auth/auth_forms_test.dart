import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/presentation/auth_code_field.dart';
import 'package:tomeza/features/auth/presentation/auth_screen.dart';
import 'package:tomeza/features/auth/presentation/forgot_password_screen.dart';
import 'package:tomeza/features/auth/presentation/sample_book_screen.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';

import '../app/app_test_fixtures.dart';

Widget _host(Widget home, FakeAuthRepository auth, {List<dynamic>? extra}) {
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(auth),
      sampleBookAvailableProvider.overrideWith((ref) async => false),
      ...?extra?.cast(),
    ],
    child: MaterialApp(theme: buildTomezaLightTheme(), home: home),
  );
}

void main() {
  group('sign in and sign up forms', () {
    testWidgets('an invalid email is flagged when the field is left, '
        'not while it is being typed', (tester) async {
      await tester.pumpWidget(
        _host(
          const AuthScreen(mode: AuthScreenMode.signIn),
          FakeAuthRepository(),
        ),
      );
      final email = find.widgetWithText(TextFormField, 'Email');

      await tester.tap(email);
      await tester.enterText(email, 'not-an-email');
      await tester.pump();
      expect(find.text('Enter a valid email.'), findsNothing);

      await tester.tap(find.widgetWithText(TextFormField, 'Password'));
      await tester.pump();
      expect(find.text('Enter a valid email.'), findsOneWidget);

      // Fixing it clears the message without waiting for another blur.
      await tester.enterText(email, 'reader@example.com');
      await tester.pump();
      expect(find.text('Enter a valid email.'), findsNothing);
    });

    testWidgets('a refused sign in is one inline notice that clears on edit', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const AuthScreen(mode: AuthScreenMode.signIn),
          FakeAuthRepository(signInError: Exception('unused')),
        ),
      );
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

      expect(find.text('Could not sign in'), findsOneWidget);
      expect(find.text('Something went wrong. Try again.'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Password'),
        'another-try',
      );
      await tester.pump();
      expect(find.text('Could not sign in'), findsNothing);
    });

    testWidgets('sign up goes through once both statements are ticked', (
      tester,
    ) async {
      final auth = FakeAuthRepository();
      await tester.pumpWidget(
        _host(const AuthScreen(mode: AuthScreenMode.signUp), auth),
      );
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
      await tester.pump();
      for (final box in tester.widgetList<Checkbox>(boxes)) {
        expect(box.value, isTrue);
      }

      final create = find.widgetWithText(FilledButton, 'Create account');
      await tester.ensureVisible(create);
      await tester.tap(create);
      await tester.pump();
      expect(
        find.text('Accept both statements to create your account.'),
        findsNothing,
      );
    });
  });

  group('password reset', () {
    testWidgets('the resend waits out a cooldown, and the email can be '
        'changed after the code is out', (tester) async {
      final auth = FakeAuthRepository();
      await tester.pumpWidget(
        _host(
          const ForgotPasswordScreen(initialEmail: 'reader@example.com'),
          auth,
        ),
      );
      expect(find.text('Step 1 of 2 · Your email'), findsOneWidget);

      await tester.tap(find.text('Send code'));
      await tester.pumpAndSettle();
      expect(find.text('Step 2 of 2 · Code and new password'), findsOneWidget);
      expect(find.textContaining('Resend code in 0:'), findsOneWidget);

      await tester.pump(const Duration(seconds: 31));
      expect(find.text('Resend code'), findsOneWidget);
      await tester.ensureVisible(find.text('Resend code'));
      await tester.tap(find.text('Resend code'));
      await tester.pumpAndSettle();
      expect(auth.passwordResetRequests, hasLength(2));
      expect(find.textContaining('Resend code in 0:'), findsOneWidget);

      await tester.ensureVisible(find.text('Use a different email'));
      await tester.tap(find.text('Use a different email'));
      await tester.pumpAndSettle();
      expect(find.text('Forgot your password?'), findsOneWidget);
      expect(find.text('Send code'), findsOneWidget);
    });

    testWidgets('an incomplete code is refused beneath the boxes', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const ForgotPasswordScreen(initialEmail: 'reader@example.com'),
          FakeAuthRepository(),
        ),
      );
      await tester.tap(find.text('Send code'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).at(1), '12');
      await tester.enterText(find.byType(TextFormField).at(2), 'BrandNewPass9');
      final reset = find.text('Reset password');
      await tester.ensureVisible(reset);
      await tester.tap(reset);
      await tester.pumpAndSettle();

      expect(
        find.text('Enter the 6-digit code from the email.'),
        findsOneWidget,
      );
    });

    test('a code is read off the clipboard however the mail app copied it', () {
      expect(codeFromClipboardText('123456'), '123456');
      expect(codeFromClipboardText('123 456'), '123456');
      expect(
        codeFromClipboardText('Your code is 482913. It expires soon.'),
        '482913',
      );
      expect(codeFromClipboardText('Order 1234567 shipped'), isNull);
      expect(codeFromClipboardText('12345'), isNull);
      expect(codeFromClipboardText(null), isNull);
    });
  });

  group('sample book', () {
    testWidgets('the sample ends on the one action, loaded or not', (
      tester,
    ) async {
      final file = Completer<String>();
      await tester.pumpWidget(
        _host(
          const SampleBookScreen(),
          FakeAuthRepository(),
          extra: [
            sampleBookFileProvider.overrideWith((ref) => file.future),
            readerViewerBuilderProvider.overrideWithValue(
              (context, ref, controller, params, page) =>
                  const ColoredBox(color: Colors.white),
            ),
          ],
        ),
      );
      await tester.pump();
      expect(find.text('Make my own'), findsOneWidget);

      file.complete('/tmp/sample.pdf');
      await tester.pumpAndSettle();
      expect(find.text('Make my own'), findsOneWidget);
      expect(find.text('Sample unavailable'), findsNothing);
    });

    testWidgets('a failed download offers a retry and keeps the action', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const SampleBookScreen(),
          FakeAuthRepository(),
          extra: [
            sampleBookFileProvider.overrideWith(
              (ref) => Future<String>.error('offline'),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Sample unavailable'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.text('Make my own'), findsOneWidget);
    });
  });
}
