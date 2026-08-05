import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/ui/feedback/app_snack_bar.dart';

Widget _app(GlobalKey<ScaffoldMessengerState> messengerKey) {
  return MaterialApp(
    scaffoldMessengerKey: messengerKey,
    home: const Scaffold(body: SizedBox.expand()),
  );
}

void main() {
  testWidgets('a tap anywhere on a snack bar dismisses it', (tester) async {
    final messengerKey = GlobalKey<ScaffoldMessengerState>();
    await tester.pumpWidget(_app(messengerKey));

    messengerKey.currentState!.showAppSnackBar(
      const SnackBar(
        content: Text('Passage copied.'),
        duration: Duration(minutes: 1),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Passage copied.'), findsOneWidget);

    // The edge of the bar, not the run of text: that strip is the snack bar's
    // own padding, which the wrapper has to take over to be tappable at all.
    final bar = tester.getRect(find.byType(SnackBar));
    final text = tester.getRect(find.text('Passage copied.'));
    expect(text.left - bar.left, greaterThan(16));
    await tester.tapAt(Offset(bar.left + 4, bar.center.dy));
    await tester.pumpAndSettle();

    expect(find.text('Passage copied.'), findsNothing);
  });

  testWidgets('an action survives, and still runs on its own tap', (
    tester,
  ) async {
    final messengerKey = GlobalKey<ScaffoldMessengerState>();
    await tester.pumpWidget(_app(messengerKey));
    var undone = false;

    messengerKey.currentState!.showAppSnackBar(
      SnackBar(
        content: const Text('Highlight removed.'),
        action: SnackBarAction(label: 'Undo', onPressed: () => undone = true),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(undone, isTrue);
    expect(find.text('Highlight removed.'), findsNothing);
  });

  testWidgets('tapping the message of a snack bar with an action dismisses it', (
    tester,
  ) async {
    final messengerKey = GlobalKey<ScaffoldMessengerState>();
    await tester.pumpWidget(_app(messengerKey));
    var undone = false;

    messengerKey.currentState!.showAppSnackBar(
      SnackBar(
        content: const Text('Note removed.'),
        action: SnackBarAction(label: 'Undo', onPressed: () => undone = true),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Note removed.'));
    await tester.pumpAndSettle();

    expect(find.text('Note removed.'), findsNothing);
    expect(undone, isFalse);
  });
}
