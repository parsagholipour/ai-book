import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/routing/exit_confirmation.dart';

void main() {
  late List<MethodCall> platformCalls;

  setUp(() {
    platformCalls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          platformCalls.add(call);
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  testWidgets('a back press with a page to pop never asks', (tester) async {
    await tester.pumpWidget(_testApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Open second'));
    await tester.pumpAndSettle();
    expect(find.text('Second'), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.text('Close Tomeza?'), findsNothing);
    expect(find.text('Home'), findsOneWidget);
    expect(_exitCalls(platformCalls), isEmpty);
  });

  testWidgets('staying keeps the app open', (tester) async {
    await tester.pumpWidget(_testApp());
    await tester.pumpAndSettle();

    final popped = tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Close Tomeza?'), findsOneWidget);

    await tester.tap(find.text('Stay'));
    await tester.pumpAndSettle();
    await popped;

    expect(find.text('Home'), findsOneWidget);
    expect(_exitCalls(platformCalls), isEmpty);
  });

  testWidgets('confirming closes the app', (tester) async {
    await tester.pumpWidget(_testApp());
    await tester.pumpAndSettle();

    final popped = tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    await tester.tap(find.text('Close app'));
    await tester.pumpAndSettle();
    await popped;

    expect(_exitCalls(platformCalls), hasLength(1));
  });
}

/// `SystemNavigator.pop()` is what actually closes the app.
Iterable<MethodCall> _exitCalls(List<MethodCall> calls) =>
    calls.where((call) => call.method == 'SystemNavigator.pop');

Widget _testApp() {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => context.push('/second'),
              child: const Text('Open second'),
            ),
          ),
          appBar: AppBar(title: const Text('Home')),
        ),
      ),
      GoRoute(
        path: '/second',
        builder: (context, state) =>
            Scaffold(appBar: AppBar(title: const Text('Second'))),
      ),
    ],
  );

  return MaterialApp.router(
    routerDelegate: router.routerDelegate,
    routeInformationParser: router.routeInformationParser,
    routeInformationProvider: router.routeInformationProvider,
    backButtonDispatcher: ConfirmExitBackButtonDispatcher(
      router.routerDelegate.navigatorKey,
    ),
  );
}
