import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/chat_media_preview.dart';

void main() {
  testWidgets('image preview opens fullscreen and closes', (tester) async {
    final navigatorKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigatorKey,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showChatImagePreview(
                context: context,
                semanticLabel: 'cover',
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );

    expect(navigatorKey.currentState!.canPop(), isFalse);

    await tester.tap(find.text('Open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(navigatorKey.currentState!.canPop(), isTrue);
    expect(find.byTooltip('Close'), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);

    navigatorKey.currentState!.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(navigatorKey.currentState!.canPop(), isFalse);
    expect(find.byTooltip('Close'), findsNothing);
  });
}
