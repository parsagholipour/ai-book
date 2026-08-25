import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/shared/ui/app_components.dart';

void main() {
  testWidgets('returns values with the requested type', (tester) async {
    int? result;

    await tester.pumpWidget(
      _sheetTestApp(
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () async {
              result = await showAppActionSheet<int>(
                context,
                builder: (sheetContext) => ListTile(
                  title: const Text('Choose seventeen'),
                  onTap: () => Navigator.of(sheetContext).pop(17),
                ),
              );
            },
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open sheet'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose seventeen'));
    await tester.pumpAndSettle();

    expect(result, 17);
  });

  testWidgets('barrier dismissal completes with null', (tester) async {
    String? result = 'not completed';
    var completed = false;

    await tester.pumpWidget(
      _sheetTestApp(
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () async {
              result = await showAppBottomSheet<String>(
                context,
                builder: (_) => const SizedBox(
                  height: 120,
                  child: Center(child: Text('Dismissible sheet')),
                ),
              );
              completed = true;
            },
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open sheet'));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(20, 20));
    await tester.pumpAndSettle();

    expect(completed, isTrue);
    expect(result, isNull);
  });

  testWidgets('keeps sheet contents inside every safe-area edge', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    const safePadding = EdgeInsets.fromLTRB(24, 48, 32, 34);

    await tester.pumpWidget(
      _sheetTestApp(
        safePadding: safePadding,
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () => showAppBottomSheet<void>(
              context,
              builder: (_) => const SizedBox(
                key: ValueKey('safe-content'),
                width: double.infinity,
                height: 800,
              ),
            ),
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open sheet'));
    await tester.pumpAndSettle();

    final content = tester.getRect(find.byKey(const ValueKey('safe-content')));
    expect(content.left, greaterThanOrEqualTo(safePadding.left));
    expect(content.top, greaterThanOrEqualTo(safePadding.top));
    expect(content.right, lessThanOrEqualTo(400 - safePadding.right));
    expect(content.bottom, lessThanOrEqualTo(800 - safePadding.bottom));
    expect(tester.takeException(), isNull);
  });

  testWidgets('preserves keyboard insets for sheet content', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    const keyboardInset = 260.0;

    await tester.pumpWidget(
      _sheetTestApp(
        viewInsets: const EdgeInsets.only(bottom: keyboardInset),
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () => showAppBottomSheet<void>(
              context,
              builder: (sheetContext) => Padding(
                padding: EdgeInsets.only(
                  bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
                ),
                child: const TextField(
                  key: ValueKey('keyboard-field'),
                  decoration: InputDecoration(labelText: 'Sheet field'),
                ),
              ),
            ),
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open sheet'));
    await tester.pumpAndSettle();

    final field = tester.getRect(find.byKey(const ValueKey('keyboard-field')));
    expect(field.bottom, lessThanOrEqualTo(800 - keyboardInset));
    expect(tester.takeException(), isNull);
  });

  testWidgets('general sheets allow long lists to scroll', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 600);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      _sheetTestApp(
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () => showAppBottomSheet<void>(
              context,
              builder: (_) => ListView.builder(
                key: const ValueKey('long-list'),
                itemExtent: 56,
                itemCount: 40,
                itemBuilder: (_, index) =>
                    ListTile(title: Text('List row $index')),
              ),
            ),
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open sheet'));
    await tester.pumpAndSettle();
    expect(find.text('List row 39'), findsNothing);

    await tester.scrollUntilVisible(
      find.text('List row 39'),
      400,
      scrollable: find.descendant(
        of: find.byKey(const ValueKey('long-list')),
        matching: find.byType(Scrollable),
      ),
    );

    expect(find.text('List row 39'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('action sheets remain scrollable with large text', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 600);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      _sheetTestApp(
        textScale: 2,
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () => showAppActionSheet<int>(
              context,
              builder: (sheetContext) => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var index = 0; index < 12; index++)
                    ListTile(
                      title: Text('Action with a descriptive label $index'),
                      subtitle: const Text('Supporting action details'),
                      onTap: () => Navigator.of(sheetContext).pop(index),
                    ),
                ],
              ),
            ),
            child: const Text('Open actions'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open actions'));
    await tester.pumpAndSettle();

    final scrollView = find.descendant(
      of: find.byType(BottomSheet),
      matching: find.byType(SingleChildScrollView),
    );
    expect(scrollView, findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Action with a descriptive label 11'),
      500,
      scrollable: find.descendant(
        of: scrollView,
        matching: find.byType(Scrollable),
      ),
    );

    expect(
      tester.getRect(find.text('Action with a descriptive label 11')).bottom,
      lessThanOrEqualTo(600),
    );
    expect(tester.takeException(), isNull);
  });
}

Widget _sheetTestApp({
  required Widget child,
  EdgeInsets safePadding = EdgeInsets.zero,
  EdgeInsets viewInsets = EdgeInsets.zero,
  double textScale = 1,
}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    builder: (context, appChild) {
      final mediaQuery = MediaQuery.of(context);
      return MediaQuery(
        data: mediaQuery.copyWith(
          padding: safePadding,
          viewPadding: safePadding,
          viewInsets: viewInsets,
          textScaler: TextScaler.linear(textScale),
        ),
        child: appChild ?? const SizedBox.shrink(),
      );
    },
    home: Scaffold(body: Center(child: child)),
  );
}
