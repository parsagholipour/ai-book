import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/launch/app_startup.dart';

void main() {
  testWidgets(
    'paints launch before startup and enters the app as soon as ready',
    (tester) async {
      final initialized = Completer<Widget>();
      var calls = 0;
      await tester.pumpWidget(
        AppStartup<Widget>(
          builder: (app, _) => app,
          initialize: () {
            calls++;
            expect(find.text('Opening Tomeza'), findsOneWidget);
            return initialized.future;
          },
        ),
      );

      expect(find.text('An Idea.\nA book of your own.'), findsOneWidget);
      expect(calls, 1);
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Opening Tomeza'), findsOneWidget);
      expect(calls, 1);

      initialized.complete(
        const MaterialApp(home: Scaffold(body: Text('Ready'))),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Ready'), findsOneWidget);
      expect(find.text('Opening Tomeza'), findsNothing);
      expect(calls, 1);
    },
  );

  testWidgets('keeps the platform initial link for the real router', (
    tester,
  ) async {
    tester.platformDispatcher.defaultRouteNameTestValue =
        'tomeza://remix/original';
    addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
    final initialized = Completer<bool>();
    await tester.pumpWidget(
      AppStartup<bool>(
        initialize: () => initialized.future,
        builder: (_, location) {
          expect(location, isNull);
          expect(
            tester.platformDispatcher.defaultRouteName,
            'tomeza://remix/original',
          );
          return const MaterialApp(initialRoute: '/', home: Text('Ready'));
        },
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Opening Tomeza'), findsOneWidget);
    initialized.complete(true);
    await tester.pump();
    await tester.pump();
    expect(find.text('Ready'), findsOneWidget);
  });

  testWidgets('hands a link received during startup to the real router', (
    tester,
  ) async {
    final initialized = Completer<bool>();
    await tester.pumpWidget(
      AppStartup<bool>(
        initialize: () => initialized.future,
        builder: (_, location) =>
            MaterialApp(home: Text(location ?? 'No link')),
      ),
    );
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      'flutter/navigation',
      const JSONMethodCodec().encodeMethodCall(
        const MethodCall('pushRouteInformation', {
          'location': 'tomeza://remix/arrived-during-startup',
        }),
      ),
      (_) {},
    );
    expect(find.text('Opening Tomeza'), findsOneWidget);
    initialized.complete(true);
    await tester.pump();
    await tester.pump();
    expect(find.text('tomeza://remix/arrived-during-startup'), findsOneWidget);
  });

  testWidgets(
    'startup failures leave a recovery message and report the error',
    (tester) async {
      final initialized = Completer<Widget>();
      await tester.pumpWidget(
        AppStartup<Widget>(
          initialize: () => initialized.future,
          builder: (app, _) => app,
        ),
      );
      initialized.completeError(StateError('Platform initialization failed'));
      await tester.pump();
      expect(tester.takeException(), isA<StateError>());
      await tester.pump();
      expect(find.text('Couldn’t start Tomeza'), findsOneWidget);
      expect(
        find.text('Please close the app and open it again.'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
