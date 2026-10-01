import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';

import '../features/sharing/fake_book_share_repository.dart';
import 'app_test_fixtures.dart';

// "Make a book like this" through the whole app: the platform hands the
// router `tomeza://remix/<slug>` exactly as Android delivers it, and whoever
// is or is not signed in ends up in the chat the link asked for.

const _prefill = 'A short story like “The Lighthouse Cat”, about ';

/// Delivers [location] the way the engine does when Android opens the app on
/// a link: a `pushRouteInformation` on the navigation channel.
Future<void> _openLink(WidgetTester tester, String location) async {
  final message = const JSONMethodCodec().encodeMethodCall(
    MethodCall('pushRouteInformation', <String, Object?>{
      'location': location,
      'state': null,
    }),
  );
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/navigation',
    message,
    (_) {},
  );
}

/// Frames in 100 ms steps: a focused composer's cursor never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('a signed-out reader is asked to sign in, then lands in the '
      'remix chat', (tester) async {
    final shares = FakeBookShareRepository(remix: lighthouseCat());
    await tester.pumpWidget(
      testApp(authRepository: FakeAuthRepository(), shareRepository: shares),
    );
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);

    await _openLink(tester, 'tomeza://remix/abc123');
    await tester.pumpAndSettle();

    // Nothing is fetched for someone who cannot use it yet.
    expect(find.text('Welcome back'), findsOneWidget);
    expect(shares.remixSlugs, isEmpty);

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

    expect(shares.remixSlugs, ['abc123']);
    expect(find.byType(CreationChatScreen), findsOneWidget);
    expect(find.text(_prefill), findsOneWidget);
  });

  testWidgets('a signed-in reader goes straight from the link to the chat', (
    tester,
  ) async {
    final shares = FakeBookShareRepository(remix: lighthouseCat());
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(initialSession: fakeSession()),
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
        shareRepository: shares,
      ),
    );
    await tester.pumpAndSettle();

    await _openLink(tester, 'tomeza://remix/abc123');
    await _settle(tester);

    expect(shares.remixSlugs, ['abc123']);
    expect(find.text(_prefill), findsOneWidget);
  });
}
