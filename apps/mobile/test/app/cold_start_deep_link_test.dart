import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/app/routing/app_router.dart';
import 'package:tomeza/features/auth/data/pending_location.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';

import 'app_test_fixtures.dart';

// A cold start opened on a screen — `/books`, `/projects/<id>` — passes the
// splash while the session is restored, and maybe signing in or the updated
// terms after it. The landing after those detours was always home: only a
// remix link was remembered, so every other link opened the app and then
// lost itself.

String _location(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(TomezaApp)),
  );
  return container
      .read(appRouterProvider)
      .routerDelegate
      .currentConfiguration
      .uri
      .toString();
}

/// Frames in 100 ms steps: a book screen polls, so it never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// The app as `main` builds it when the platform handed it [location] while
/// it was starting (`AppStartup` → `initialAppLocationProvider`).
Widget _coldStart(String location, FakeAuthRepository auth) {
  return testApp(
    authRepository: auth,
    projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
    billingRepository: FakeBillingRepository(billing: fakeBilling()),
    overrides: [initialAppLocationProvider.overrideWithValue(location)],
  );
}

Future<void> _signIn(WidgetTester tester) async {
  await tester.enterText(
    find.widgetWithText(TextFormField, 'Email'),
    'reader@example.com',
  );
  await tester.enterText(
    find.widgetWithText(TextFormField, 'Password'),
    'CorrectPass123',
  );
  await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
  await _settle(tester);
}

void main() {
  testWidgets('a signed-in reader opened on the library lands on it after '
      'the splash', (tester) async {
    await tester.pumpWidget(
      _coldStart('/books', FakeAuthRepository(initialSession: fakeSession())),
    );
    await tester.pumpAndSettle();

    expect(_location(tester), '/books');
    expect(find.byType(BookLibraryScreen), findsOneWidget);
  });

  testWidgets('a book link keeps its query through the splash', (tester) async {
    await tester.pumpWidget(
      _coldStart(
        '/projects/project-1/read?page=3',
        FakeAuthRepository(initialSession: fakeSession()),
      ),
    );
    await _settle(tester);

    expect(_location(tester), '/projects/project-1/read?page=3');
  });

  testWidgets('a signed-out reader signs in, then lands on the book they '
      'opened', (tester) async {
    await tester.pumpWidget(
      _coldStart('/projects/project-1', FakeAuthRepository()),
    );
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);

    await _signIn(tester);

    expect(_location(tester), '/projects/project-1');
  });

  testWidgets('the updated terms come first, and the link after them', (
    tester,
  ) async {
    await tester.pumpWidget(
      _coldStart(
        '/books',
        FakeAuthRepository(
          initialSession: fakeSession(legalAcceptanceRequired: true),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('The terms have been updated'), findsOneWidget);
    expect(find.byType(BookLibraryScreen), findsNothing);

    final agree = find.widgetWithText(FilledButton, 'Agree and continue');
    await tester.ensureVisible(agree);
    await tester.tap(agree);
    await tester.pumpAndSettle();

    expect(_location(tester), '/books');
    expect(find.byType(BookLibraryScreen), findsOneWidget);
  });

  testWidgets('"Not now" on the terms also walks on to the link', (
    tester,
  ) async {
    await tester.pumpWidget(
      _coldStart(
        '/books',
        FakeAuthRepository(
          initialSession: fakeSession(legalAcceptanceRequired: true),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final notNow = find.widgetWithText(OutlinedButton, 'Not now');
    await tester.ensureVisible(notNow);
    await tester.tap(notNow);
    await tester.pumpAndSettle();

    expect(_location(tester), '/books');
  });

  testWidgets('signing out and back in later lands at home, not where the '
      'last account was', (tester) async {
    await tester.pumpWidget(
      _coldStart('/books', FakeAuthRepository(initialSession: fakeSession())),
    );
    await tester.pumpAndSettle();
    expect(_location(tester), '/books');

    final container = ProviderScope.containerOf(
      tester.element(find.byType(TomezaApp)),
    );
    await container.read(authControllerProvider.notifier).logout();
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);

    await _signIn(tester);

    expect(_location(tester), '/home');
  });

  group('PendingLocation', () {
    test('keeps an in-app screen and nothing the detour passes through', () {
      for (final gate in [
        '/splash',
        '/auth/sign-in',
        '/auth/sign-up',
        '/legal/acceptance',
        '/update-required',
        '/sample-book',
        '/account/verify-email',
        '/home',
        '/remix/abc123',
        'tomeza://remix/abc123',
        'https://tomeza.app/books',
      ]) {
        final pending = PendingLocation()..remember(Uri.parse(gate));
        expect(pending.location, isNull, reason: gate);
      }

      final pending = PendingLocation()
        ..remember(Uri.parse('/projects/p1/edit?pageIndex=4'));
      expect(pending.location, '/projects/p1/edit?pageIndex=4');
    });

    test('remembers nothing once the run has reached the app', () {
      final pending = PendingLocation()..remember(Uri.parse('/books'));
      pending.settle();
      expect(pending.location, isNull);

      pending.remember(Uri.parse('/account'));
      expect(pending.location, isNull);
    });
  });
}
