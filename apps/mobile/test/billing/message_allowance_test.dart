import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/message_allowance_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/domain/message_allowance.dart';
import 'package:tomeza/features/billing/presentation/message_allowance_banner.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'billing_export_offer_harness.dart' show loadExportOfferFonts;

class ResetRepository implements MessageAllowanceRepository {
  int calls = 0;
  MessageAllowance? quote;
  Object? error;
  @override
  ApiClient get apiClient => throw UnimplementedError();
  @override
  Future<void> reset(MessageAllowance allowance) async {
    calls++;
    quote = allowance;
    if (error != null) throw error!;
  }
}

MessageAllowance allowance({
  int remaining = 0,
  bool enabled = true,
  int price = 0,
}) => MessageAllowance(
  used: 50 - remaining,
  limit: 50,
  remaining: remaining,
  creditsPerMessage: price,
  resetEnabled: enabled,
  resetCredits: 50,
  resetsAt: DateTime.utc(2099, 9, 11),
  resetToken: '2099-09-10:0:50',
);

MobileBilling billing(MessageAllowance? allowance, {int credits = 100}) =>
    MobileBilling(
      credits: CreditBalance(
        available: credits,
        purchased: credits,
        reserved: 0,
        lifetimeGranted: credits,
        lifetimeSpent: 0,
      ),
      entitlements: const [],
      products: const [],
      creditCosts: const {},
      messageAllowance: allowance,
    );

Future<void> mount(
  WidgetTester tester, {
  MessageAllowance? value,
  ResetRepository? repository,
  int credits = 100,
  double scale = 1,
  bool dark = false,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    RepaintBoundary(
      key: const ValueKey('message-preview'),
      child: ProviderScope(
        overrides: [
          billingProvider.overrideWith(
            (ref) async => billing(value, credits: credits),
          ),
          messageAllowanceRepositoryProvider.overrideWithValue(
            repository ?? ResetRepository(),
          ),
        ],
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildTomezaLightTheme(),
          darkTheme: buildTomezaDarkTheme(),
          themeMode: dark ? ThemeMode.dark : ThemeMode.light,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: const Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: MessageAllowanceBanner(),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> capture(WidgetTester tester, String name) async {
  const directory = String.fromEnvironment('MESSAGE_ALLOWANCE_SCREENSHOTS');
  if (directory.isEmpty) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey('message-preview')),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(loadExportOfferFonts);

  testWidgets('a send refreshes an exhausted allowance restored elsewhere', (
    tester,
  ) async {
    var reads = 0;
    var sent = false;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          billingProvider.overrideWith((ref) async {
            reads++;
            return billing(allowance(remaining: reads == 1 ? 0 : 50));
          }),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) {
                return Column(
                  children: [
                    const MessageAllowanceBanner(),
                    TextButton(
                      onPressed: () async {
                        sent = await ensureMessageAllowance(context, ref);
                      },
                      child: const Text('Send'),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send'));
    await tester.pumpAndSettle();
    expect(sent, isTrue);
    expect(reads, 2);
    expect(find.text('Reset for 50 credits'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('double tapping Send during allowance refresh submits once', (
    tester,
  ) async {
    var reads = 0;
    var sent = 0;
    final refreshed = Completer<MobileBilling>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          billingProvider.overrideWith((ref) {
            reads++;
            return reads == 1
                ? Future.value(billing(allowance()))
                : refreshed.future;
          }),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) {
                return Column(
                  children: [
                    const MessageAllowanceBanner(),
                    TextButton(
                      onPressed: () async {
                        if (await ensureMessageAllowance(context, ref)) sent++;
                      },
                      child: const Text('Send'),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send'));
    await tester.pump();
    await tester.tap(find.text('Send'));
    await tester.pump();
    expect(sent, 0);
    refreshed.complete(billing(allowance(remaining: 50)));
    await tester.pumpAndSettle();
    expect(sent, 1);
    expect(reads, 2);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('reads server message prices and quota without client defaults', () {
    final parsed = MessageAllowance.fromJson({
      'used': 10,
      'limit': 150,
      'remaining': 140,
      'creditsPerMessage': 3,
      'resetEnabled': false,
      'resetCredits': 75,
      'resetToken': '2026-09-10:2:150',
      'resetsAt': '2026-09-11T00:00:00.000Z',
    });
    expect(parsed.remaining, 140);
    expect(parsed.creditsPerMessage, 3);
    expect(parsed.resetEnabled, isFalse);
    expect(parsed.resetsAt.isUtc, isTrue);
  });

  testWidgets('shows remaining messages and the current per-message price', (
    tester,
  ) async {
    await mount(tester, value: allowance(remaining: 42, price: 3));
    expect(
      find.text('42 of 50 messages left · 3 credits/message'),
      findsOneWidget,
    );
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(find.textContaining('3 credits per message.'), findsOneWidget);
    expect(find.textContaining('(your local time)'), findsOneWidget);
    expect(find.text('Reset for 50 credits'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'requires explicit confirmation and posts the displayed quote once',
    (tester) async {
      final repository = ResetRepository();
      await mount(tester, value: allowance(), repository: repository);
      await tester.tap(find.text('Reset'));
      await tester.pumpAndSettle();
      await capture(tester, 'message-limit-light');
      await tester.tap(
        find.widgetWithText(FilledButton, 'Reset for 50 credits'),
      );
      await tester.pumpAndSettle();
      expect(repository.calls, 0);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repository.calls, 0);
      await tester.tap(
        find.widgetWithText(FilledButton, 'Reset for 50 credits'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm reset'));
      await tester.pumpAndSettle();
      expect(repository.calls, 1);
      expect(repository.quote!.resetToken, '2099-09-10:0:50');
      expect(repository.quote!.resetCredits, 50);
      expect(
        find.text('Message allowance reset. You can continue chatting.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('offers a credit purchase when the reset is unaffordable', (
    tester,
  ) async {
    await mount(tester, value: allowance(), credits: 20, dark: true);
    await tester.tap(find.text('Reset'));
    await tester.pumpAndSettle();
    expect(find.text('Balance: 20 credits'), findsOneWidget);
    expect(find.text('Add credits to reset'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Reset for 50 credits'),
      findsNothing,
    );
    await capture(tester, 'message-limit-dark-shortfall');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('explains disabled resets and fits large text on a phone', (
    tester,
  ) async {
    await mount(tester, value: allowance(enabled: false), scale: 2);
    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Credit resets are unavailable'),
      findsOneWidget,
    );
    expect(find.text('Confirm reset'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('shows a changed-price error without buying another reset', (
    tester,
  ) async {
    final repository = ResetRepository()
      ..error = const ApiException(
        code: 'MESSAGE_QUOTE_CHANGED',
        message: 'Review the updated reset price.',
      );
    await mount(tester, value: allowance(), repository: repository);
    await tester.tap(find.text('Reset'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Reset for 50 credits'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm reset'));
    await tester.pumpAndSettle();
    expect(repository.calls, 1);
    expect(find.text('Review the updated reset price.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'remains compatible with billing payloads without message allowance',
    (tester) async {
      await mount(tester);
      expect(find.text('Details'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
