import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/app/routing/app_router.dart';
import 'package:tomeza/features/notifications/data/push_messaging.dart';

import '../features/notifications/fake_push_messaging.dart';
import 'app_test_fixtures.dart';

// Book notifications through the whole app: the shell files this install's
// token under whoever signs in, and a tapped notification opens its book —
// even when the tap is what launched the app, or came before anyone signed in.

/// The page on top — a pushed page leaves `currentConfiguration.uri` on the
/// page underneath it.
String _location(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(TomezaApp)),
  );
  return container
      .read(appRouterProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;
}

/// Frames in 100 ms steps: the book screen polls, so it never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Widget _app({
  required FakeAuthRepository auth,
  required FakePushMessaging push,
  FakePushDeviceRepository? devices,
}) {
  return testApp(
    authRepository: auth,
    projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
    billingRepository: FakeBillingRepository(billing: fakeBilling()),
    pushMessaging: push,
    pushDeviceRepository: devices ?? FakePushDeviceRepository(),
  );
}

void main() {
  testWidgets('a tapped notification opens its book above home', (
    tester,
  ) async {
    final push = FakePushMessaging();
    await tester.pumpWidget(
      _app(auth: FakeAuthRepository(initialSession: fakeSession()), push: push),
    );
    await _settle(tester);
    expect(_location(tester), '/home');

    push.tap('book-1');
    await _settle(tester);

    expect(_location(tester), '/projects/book-1');
  });

  testWidgets('the notification that launched the app opens its book once '
      'the session is back', (tester) async {
    final push = FakePushMessaging(launchBook: 'book-1');
    await tester.pumpWidget(
      _app(auth: FakeAuthRepository(initialSession: fakeSession()), push: push),
    );
    await _settle(tester);

    expect(_location(tester), '/projects/book-1');
  });

  testWidgets('a tap before signing in waits for the sign-in', (tester) async {
    final push = FakePushMessaging();
    await tester.pumpWidget(_app(auth: FakeAuthRepository(), push: push));
    await _settle(tester);

    push.tap('book-1');
    await _settle(tester);
    expect(find.text('Welcome back'), findsOneWidget);

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

    expect(_location(tester), '/projects/book-1');
  });

  testWidgets('files the token for the signed-in reader, and the rotated one '
      'when Firebase replaces it', (tester) async {
    final push = FakePushMessaging();
    final devices = FakePushDeviceRepository();
    await tester.pumpWidget(
      _app(
        auth: FakeAuthRepository(initialSession: fakeSession()),
        push: push,
        devices: devices,
      ),
    );
    await _settle(tester);
    expect(devices.calls, ['register fcm-token-1 android']);

    push.rotateToken('fcm-token-2');
    await _settle(tester);
    expect(devices.calls, [
      'register fcm-token-1 android',
      'register fcm-token-2 android',
    ]);
  });

  testWidgets('files nothing for a reader who has not allowed notifications', (
    tester,
  ) async {
    final push = FakePushMessaging(
      currentPermission: PushPermission.notAsked,
    );
    final devices = FakePushDeviceRepository();
    await tester.pumpWidget(
      _app(
        auth: FakeAuthRepository(initialSession: fakeSession()),
        push: push,
        devices: devices,
      ),
    );
    await _settle(tester);

    expect(devices.calls, isEmpty);
    expect(push.permissionRequests, 0);
  });
}
