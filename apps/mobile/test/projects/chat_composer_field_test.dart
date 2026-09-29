import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/projects/presentation/chat_composer_field.dart';

Widget _host(
  TextEditingController controller, {
  required ValueChanged<String> onSend,
  bool enabled = true,
  bool busy = false,
  bool canSendWithoutText = false,
  bool holdSend = false,
  int? maxLength,
  VoidCallback? onAttach,
}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: ChatComposerField(
          controller: controller,
          hintText: 'Say something',
          onSend: onSend,
          enabled: enabled,
          busy: busy,
          canSendWithoutText: canSendWithoutText,
          holdSend: holdSend,
          maxLength: maxLength,
          onAttach: onAttach,
        ),
      ),
    ),
  );
}

VoidCallback? _sendPressed(WidgetTester tester) => tester
    .widget<IconButton>(find.widgetWithIcon(IconButton, Icons.send_rounded))
    .onPressed;

void main() {
  testWidgets(
    'send follows the text, an attachment, and a file still reading',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      final sent = <String>[];
      await tester.pumpWidget(_host(controller, onSend: sent.add));
      expect(_sendPressed(tester), isNull);

      await tester.enterText(find.byType(TextField), 'Hello');
      await tester.pump();
      expect(_sendPressed(tester), isNotNull);
      await tester.tap(find.byTooltip('Send'));
      expect(sent, ['Hello']);

      controller.clear();
      await tester.pumpWidget(
        _host(controller, onSend: sent.add, canSendWithoutText: true),
      );
      expect(_sendPressed(tester), isNotNull);

      await tester.pumpWidget(
        _host(
          controller,
          onSend: sent.add,
          canSendWithoutText: true,
          holdSend: true,
        ),
      );
      expect(_sendPressed(tester), isNull);
    },
  );

  testWidgets('a reply on its way shows progress and holds the send', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'Next thought');
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, onSend: (_) {}, busy: true));

    expect(_sendPressed(tester), isNull);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // Typing ahead is still allowed; only the send waits.
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
  });

  testWidgets(
    'the counter appears only near the limit and closes the send past it',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _host(controller, onSend: (_) {}, maxLength: 100),
      );

      await tester.enterText(find.byType(TextField), 'a' * 50);
      await tester.pump();
      expect(find.textContaining('/ 100'), findsNothing);

      await tester.enterText(find.byType(TextField), 'a' * 90);
      await tester.pump();
      expect(find.text('90 / 100'), findsOneWidget);
      expect(_sendPressed(tester), isNotNull);

      await tester.enterText(find.byType(TextField), 'a' * 101);
      await tester.pump();
      expect(find.text('101 / 100 · too long to send'), findsOneWidget);
      expect(_sendPressed(tester), isNull);
    },
  );

  testWidgets('the field follows the language being typed', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, onSend: (_) {}));

    TextDirection? direction() =>
        tester.widget<TextField>(find.byType(TextField)).textDirection;
    expect(direction(), isNull);

    await tester.enterText(find.byType(TextField), 'سلام');
    await tester.pump();
    expect(direction(), TextDirection.rtl);

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    expect(direction(), TextDirection.ltr);
  });

  testWidgets('the paperclip is optional and can be shut on its own', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(controller, onSend: (_) {}));
    expect(find.byTooltip('Attach a photo, document, or notes'), findsNothing);

    var attached = 0;
    await tester.pumpWidget(
      _host(controller, onSend: (_) {}, onAttach: () => attached++),
    );
    await tester.tap(find.byTooltip('Attach a photo, document, or notes'));
    expect(attached, 1);
  });
}
