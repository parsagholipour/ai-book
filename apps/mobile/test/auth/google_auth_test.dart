import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/data/google_sign_in_client.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/auth/presentation/auth_screen.dart';
import 'package:tomeza/features/auth/presentation/sample_book_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../app/app_test_fixtures.dart';

class _GoogleClient implements GoogleSignInClient {
  _GoogleClient({this.token = 'google-token', this.error, this.pending});
  final String? token;
  final Object? error;
  final Completer<String?>? pending;
  int calls = 0;

  @override
  Future<String?> authenticate() async {
    calls++;
    if (error != null) throw error!;
    return pending != null ? await pending!.future : token;
  }
}

class _GoogleRepository extends FakeAuthRepository {
  _GoogleRepository({this.signup = false, this.link = false, this.error});
  final bool signup;
  final bool link;
  final Object? error;
  final List<({String token, bool terms, bool age, String? password})> calls =
      [];

  @override
  Future<AuthSession> signInWithGoogle({
    required String idToken,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
    String? password,
  }) async {
    calls.add((
      token: idToken,
      terms: termsAccepted,
      age: ageGuardianAttested,
      password: password,
    ));
    if (error != null) throw error!;
    if (signup && (!termsAccepted || !ageGuardianAttested)) {
      throw const ApiException(
        code: 'GOOGLE_SIGNUP_REQUIRED',
        message: 'Accept terms.',
      );
    }
    if (link && password == null) {
      throw const ApiException(
        code: 'GOOGLE_LINK_REQUIRED',
        message: 'Confirm password.',
      );
    }
    if (link && password != 'correct-password') {
      throw const ApiException(
        code: 'INVALID_CREDENTIALS',
        message: 'That password is incorrect.',
      );
    }
    return fakeSession(email: 'google@example.com');
  }
}

Future<ProviderContainer> _pump(
  WidgetTester tester,
  _GoogleRepository repository, {
  _GoogleClient? client,
  AuthScreenMode mode = AuthScreenMode.signIn,
  double textScale = 1,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(repository),
        googleSignInClientProvider.overrideWithValue(client),
        sampleBookAvailableProvider.overrideWith((ref) async => false),
      ],
      child: MaterialApp(
        theme: buildTomezaLightTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: AuthScreen(mode: mode),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return ProviderScope.containerOf(tester.element(find.byType(AuthScreen)));
}

Future<void> _google(WidgetTester tester) async {
  final button = find.widgetWithText(OutlinedButton, 'Continue with Google');
  await tester.ensureVisible(button);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'unconfigured builds keep email auth without a broken Google button',
    (tester) async {
      await _pump(tester, _GoogleRepository());
      expect(find.text('Continue with Google'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
    },
  );

  for (final mode in AuthScreenMode.values) {
    testWidgets('Google signs in from $mode without filling the email form', (
      tester,
    ) async {
      final repository = _GoogleRepository();
      final container = await _pump(
        tester,
        repository,
        client: _GoogleClient(),
        mode: mode,
      );
      await _google(tester);
      expect(repository.calls.single.token, 'google-token');
      expect(
        container.read(authControllerProvider).value?.user.email,
        'google@example.com',
      );
      expect(find.text('Enter a valid email.'), findsNothing);
    });
  }

  testWidgets('cancelling the chooser does not call the API or show an error', (
    tester,
  ) async {
    final repository = _GoogleRepository();
    final container = await _pump(
      tester,
      repository,
      client: _GoogleClient(token: null),
    );
    await _google(tester);
    expect(repository.calls, isEmpty);
    expect(container.read(authControllerProvider).value, isNull);
    expect(find.text('Could not sign in'), findsNothing);
  });

  testWidgets(
    'new Google users explicitly accept both statements and reuse the verified token',
    (tester) async {
      final repository = _GoogleRepository(signup: true);
      final client = _GoogleClient();
      final container = await _pump(
        tester,
        repository,
        client: client,
        textScale: 1.6,
      );
      await _google(tester);
      final create = find.widgetWithText(FilledButton, 'Create account');
      expect(tester.widget<FilledButton>(create).onPressed, isNull);
      final boxes = find.descendant(
        of: find.byType(AlertDialog),
        matching: find.byType(Checkbox),
      );
      await tester.ensureVisible(boxes.first);
      await tester.tap(boxes.first);
      await tester.pump();
      expect(tester.widget<FilledButton>(create).onPressed, isNull);
      await tester.ensureVisible(boxes.last);
      await tester.tap(boxes.last);
      await tester.pump();
      await tester.ensureVisible(create);
      await tester.tap(create);
      await tester.pumpAndSettle();
      expect(repository.calls.last.terms, isTrue);
      expect(repository.calls.last.age, isTrue);
      expect(client.calls, 1);
      expect(container.read(authControllerProvider).value, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('cancelling signup consent creates no session', (tester) async {
    final repository = _GoogleRepository(signup: true);
    final container = await _pump(tester, repository, client: _GoogleClient());
    await _google(tester);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(repository.calls, hasLength(1));
    expect(container.read(authControllerProvider).value, isNull);
  });

  testWidgets(
    'linking asks for the existing password and lets a reader correct a wrong one',
    (tester) async {
      final repository = _GoogleRepository(link: true);
      final container = await _pump(
        tester,
        repository,
        client: _GoogleClient(),
      );
      await _google(tester);
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Tomeza password'),
        'wrong',
      );
      await tester.tap(find.text('Connect and sign in'));
      await tester.pumpAndSettle();
      expect(find.text('That password is incorrect.'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Tomeza password'),
        'correct-password',
      );
      await tester.tap(find.text('Connect and sign in'));
      await tester.pumpAndSettle();
      expect(repository.calls.last.password, 'correct-password');
      expect(container.read(authControllerProvider).value, isNotNull);
    },
  );

  testWidgets('server and native errors leave email sign-in usable', (
    tester,
  ) async {
    final repository = _GoogleRepository(
      error: const ApiException(
        code: 'INVALID_GOOGLE_TOKEN',
        message: 'Google sign-in could not be verified.',
      ),
    );
    await _pump(tester, repository, client: _GoogleClient());
    await _google(tester);
    expect(find.text('Google sign-in could not be verified.'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign in'))
          .onPressed,
      isNotNull,
    );
    await _pump(
      tester,
      _GoogleRepository(),
      client: _GoogleClient(
        error: const ApiException(
          code: 'GOOGLE_SIGN_IN_FAILED',
          message: 'Google sign-in is unavailable.',
        ),
      ),
    );
    await _google(tester);
    expect(find.text('Google sign-in is unavailable.'), findsOneWidget);
  });

  testWidgets(
    'pending Google sign-in disables email submission and duplicate taps',
    (tester) async {
      final pending = Completer<String?>();
      final client = _GoogleClient(pending: pending);
      await _pump(tester, _GoogleRepository(), client: client);
      await tester.tap(
        find.widgetWithText(OutlinedButton, 'Continue with Google'),
      );
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign in'))
            .onPressed,
        isNull,
      );
      expect(client.calls, 1);
      pending.complete(null);
      await tester.pumpAndSettle();
      expect(find.text('Continue with Google'), findsOneWidget);
    },
  );
}
