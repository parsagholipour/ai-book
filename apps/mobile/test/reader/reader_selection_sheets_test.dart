import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_actions.dart';

/// Opens [sheet] the way the reader does and returns what it popped with.
Future<T?> openSheet<T>(WidgetTester tester, Widget sheet) async {
  T? result;
  var opened = false;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              opened = true;
              result = await showModalBottomSheet<T>(
                context: context,
                isScrollControlled: true,
                builder: (_) => sheet,
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  expect(opened, isTrue);
  return result;
}

void main() {
  testWidgets('the rewrite sheet returns the instruction and tears down cleanly', (
    tester,
  ) async {
    // Disposing the field's controller when the sheet's future completes —
    // rather than when the sheet unmounts — pulls it out from under a TextField
    // that is still on screen animating away, and the framework trips on the
    // half-dismantled subtree. A widget test fails on that assertion, so
    // running the whole flow is the guard.
    await tester.pumpWidget(const SizedBox());
    late String? captured;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                captured = await showModalBottomSheet<String>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) =>
                      const ReaderInstructionSheet(excerpt: 'The rabbit ran.'),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Rewrite this passage'), findsOneWidget);
    expect(find.text('The rabbit ran.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Make it warmer.');
    await tester.tap(find.text('Send to book chat'));
    await tester.pumpAndSettle();

    expect(captured, 'Make it warmer.');
    expect(find.text('Rewrite this passage'), findsNothing);
  });

  testWidgets('the replace sheet starts from the excerpt and needs both terms', (
    tester,
  ) async {
    late ({String from, String to})? captured;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                captured = await showModalBottomSheet<({String from, String to})>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) =>
                      const ReaderReplacementSheet(excerpt: 'Rabbit'),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // The passage is prefilled as the term to replace.
    expect(find.widgetWithText(TextField, 'Rabbit'), findsOneWidget);

    // Submitting with no replacement keeps the sheet open rather than sending
    // a patch that would do nothing.
    await tester.tap(find.text('Send to book chat'));
    await tester.pumpAndSettle();
    expect(find.text('Replace text'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Rabbit'), 'Rabbit');
    await tester.enterText(find.byType(TextField).last, 'Hare');
    await tester.tap(find.text('Send to book chat'));
    await tester.pumpAndSettle();

    expect(captured?.from, 'Rabbit');
    expect(captured?.to, 'Hare');
  });

  testWidgets('both sheets name the page the edit will land on', (
    tester,
  ) async {
    // The page an edit targets is worked out by matching text, so it can be
    // wrong. Showing it before the message is sent is what makes that
    // recoverable rather than a surprise in the proposal that comes back.
    await openSheet<String>(
      tester,
      const ReaderInstructionSheet(
        excerpt: 'The rabbit ran.',
        placement: 'Page 14',
      ),
    );
    expect(find.text('Page 14'), findsOneWidget);

    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    await openSheet<({String from, String to})>(
      tester,
      const ReaderReplacementSheet(
        excerpt: 'Rabbit',
        placement: 'Page not identified',
      ),
    );
    expect(find.text('Page not identified'), findsOneWidget);
  });

  testWidgets('a sheet with nothing to say about the page stays quiet', (
    tester,
  ) async {
    await openSheet<String>(
      tester,
      const ReaderInstructionSheet(excerpt: 'The rabbit ran.'),
    );

    expect(find.text('Rewrite this passage'), findsOneWidget);
    expect(find.textContaining('Page'), findsNothing);
  });

  testWidgets('dismissing the rewrite sheet returns nothing', (tester) async {
    final result = await openSheet<String>(
      tester,
      const ReaderInstructionSheet(excerpt: 'The rabbit ran.'),
    );
    expect(result, isNull);

    // Tapping the scrim dismisses without sending.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(find.text('Rewrite this passage'), findsNothing);
  });
}
