import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/notifications/data/push_device_repository.dart';
import 'package:tomeza/features/notifications/data/push_messaging.dart';
import 'package:tomeza/features/notifications/presentation/book_notifications_offer.dart';

import '../../app/app_test_fixtures.dart';
import 'fake_push_messaging.dart';

/// Pumps a button that runs the offer the way plan approval does.
Future<void> _pumpOffer(
  WidgetTester tester, {
  required FakePushMessaging push,
  FakePushDeviceRepository? devices,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(
          FakeAuthRepository(initialSession: fakeSession()),
        ),
        pushMessagingProvider.overrideWithValue(push),
        pushDeviceRepositoryProvider.overrideWithValue(
          devices ?? FakePushDeviceRepository(),
        ),
      ],
      child: MaterialApp(
        theme: buildTomezaLightTheme(),
        home: Consumer(
          builder: (context, ref, _) => Scaffold(
            body: TextButton(
              onPressed: () => offerBookNotifications(context, ref),
              child: const Text('Approve'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _approve(WidgetTester tester) async {
  await tester.tap(find.text('Approve'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('offered once, after the first book starts; yes asks the '
      'system and files this install', (tester) async {
    final push = FakePushMessaging(currentPermission: PushPermission.notAsked);
    final devices = FakePushDeviceRepository();
    await _pumpOffer(tester, push: push, devices: devices);

    await _approve(tester);
    expect(find.text('Know when your book is ready'), findsOneWidget);
    await tester.tap(find.text('Turn on notifications'));
    await tester.pumpAndSettle();

    expect(push.permissionRequests, 1);
    expect(devices.calls, ['register fcm-token-1 android']);
  });

  testWidgets('"Not now" is remembered, and the system prompt is saved for '
      'Account', (tester) async {
    final push = FakePushMessaging(currentPermission: PushPermission.notAsked);
    await _pumpOffer(tester, push: push);

    await _approve(tester);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(push.permissionRequests, 0);

    await _approve(tester);
    expect(find.text('Know when your book is ready'), findsNothing);
  });

  testWidgets('a reader who already decided is not asked', (tester) async {
    for (final permission in [PushPermission.granted, PushPermission.denied]) {
      final push = FakePushMessaging(currentPermission: permission);
      await _pumpOffer(tester, push: push);
      await _approve(tester);
      expect(find.text('Know when your book is ready'), findsNothing);
    }
  });
}
