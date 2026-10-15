import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/project_chat_composer.dart';

// The finished-book chat's composer follows the language being typed, the way
// the creation composer and the bubbles already did.
void main() {
  testWidgets('the book chat composer turns to the right for Persian', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectChatComposer(
            controller: controller,
            sending: false,
            onSend: () {},
          ),
        ),
      ),
    );

    TextDirection? direction() =>
        tester.widget<TextField>(find.byType(TextField)).textDirection;

    expect(direction(), isNull, reason: 'empty follows the app');

    await tester.enterText(find.byType(TextField), 'صفحه ۳ را کوتاه‌تر کن');
    await tester.pump();
    expect(direction(), TextDirection.rtl);

    await tester.enterText(find.byType(TextField), 'Make page 3 shorter');
    await tester.pump();
    expect(direction(), TextDirection.ltr);
  });
}
