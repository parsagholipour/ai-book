import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';

import 'character_test_support.dart';

void main() {
  testWidgets('closing an untouched character does not ask to discard', (
    tester,
  ) async {
    await pumpCharacterEditorSheet(tester, testCharacter());
    await tester.tap(find.byTooltip('Close editor'));
    await tester.pumpAndSettle();
    expect(find.text('Edit character'), findsNothing);
    expect(find.text('Discard changes?'), findsNothing);
  });

  testWidgets('closing keeps unsaved text until discard is confirmed', (
    tester,
  ) async {
    final repository = await pumpCharacterEditorSheet(tester, testCharacter());
    await tester.enterText(
      find.widgetWithText(TextField, 'Mina Park'),
      'Mina Parker',
    );
    await tester.tap(find.byTooltip('Close editor'));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'Mina Parker'), findsOneWidget);
    await tester.tap(find.byTooltip('Close editor'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard changes'));
    await tester.pumpAndSettle();
    expect(find.text('Edit character'), findsNothing);
    expect(repository.updates, isEmpty);
  });

  testWidgets('system back also protects an unsaved description', (
    tester,
  ) async {
    await pumpCharacterEditorSheet(tester, testCharacter());
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'A new story.',
    );
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
  });

  testWidgets('a downward swipe cannot discard editor changes', (tester) async {
    await pumpCharacterEditorSheet(
      tester,
      testCharacter(),
      theme: buildTomezaLightTheme(),
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Mina Park'),
      'Mina Parker',
    );
    final sheet = tester.getRect(find.byType(BottomSheet));
    await tester.dragFrom(
      Offset(sheet.center.dx, sheet.top + 16),
      const Offset(0, 500),
    );
    await tester.pumpAndSettle();
    expect(
      find.widgetWithText(TextField, 'Mina Parker').hitTestable(),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('character-editor-save')).hitTestable(),
      findsOneWidget,
    );
    expect(find.text('Discard changes?'), findsNothing);
  });

  testWidgets('tapping outside the editor asks before discarding', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pumpCharacterEditorSheet(
      tester,
      testCharacter(),
      theme: buildTomezaLightTheme(),
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Mina Park'),
      'Mina Parker',
    );
    await tester.tapAt(const Offset(12, 12));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(
      find.widgetWithText(TextField, 'Mina Parker').hitTestable(),
      findsOneWidget,
    );
  });

  testWidgets('save stays reachable with a phone keyboard and added details', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repository = await pumpCharacterEditorSheet(tester, testCharacter());
    await tester.ensureVisible(find.text('Personality'));
    await tester.tap(find.text('Personality'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.widgetWithText(TextField, 'Value'));
    await tester.enterText(
      find.widgetWithText(TextField, 'Value'),
      'Quietly courageous',
    );
    tester.view.viewInsets = const FakeViewPadding(bottom: 320);
    await tester.pumpAndSettle();
    final save = find.byKey(const ValueKey('character-editor-save'));
    expect(save.hitTestable(), findsOneWidget);
    expect(tester.getBottomRight(save).dy, lessThanOrEqualTo(844 - 320));
    expect(tester.takeException(), isNull);
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(repository.updates.single['fields'], 1);
    expect(find.text('Discard changes?'), findsNothing);
  });
}
