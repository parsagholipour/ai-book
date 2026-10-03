import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/message_actions_menu.dart';

/// Google Play's generative-AI policy asks for every surface that shows AI
/// output to be reportable in the app. An AI reply's long-press menu carries
/// Report; the reader's own message does not.
void main() {
  Future<void> openMenu(WidgetTester tester, {VoidCallback? onReport}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showMessageActionsMenu(
                context: context,
                position: const Offset(100, 100),
                message: 'A reply',
                onReport: onReport,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('offers Report on an AI reply and runs it', (tester) async {
    var reported = 0;
    await openMenu(tester, onReport: () => reported += 1);
    expect(find.text('Report'), findsOneWidget);
    await tester.tap(find.text('Report'));
    await tester.pumpAndSettle();
    expect(reported, 1);
  });

  testWidgets('leaves Report off a message with nothing to report', (
    tester,
  ) async {
    await openMenu(tester);
    expect(find.text('Copy'), findsOneWidget);
    expect(find.text('Report'), findsNothing);
  });
}
