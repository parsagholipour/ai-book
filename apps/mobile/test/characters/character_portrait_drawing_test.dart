import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/presentation/character_portrait_drawing.dart';

/// What a portrait being drawn reads as: a bar that only climbs and never
/// claims to have arrived, and stage words that only move forward.
void main() {
  test('the pace climbs, and never reaches the end', () {
    var last = 0.0;
    for (final seconds in [0, 5, 15, 30, 60, 120, 600]) {
      final value = pacedDrawingProgress(Duration(seconds: seconds));
      expect(value, greaterThanOrEqualTo(last));
      expect(value, lessThan(0.93));
      last = value;
    }
    expect(pacedDrawingProgress(Duration.zero), greaterThan(0));
  });

  test('the stage words advance and settle on an honest last one', () {
    expect(drawingStageLabel(Duration.zero), 'Getting started');
    expect(
      drawingStageLabel(const Duration(seconds: 10)),
      'Sketching the outline',
    );
    expect(drawingStageLabel(const Duration(seconds: 20)), 'Adding colour');
    expect(drawingStageLabel(const Duration(seconds: 40)), 'Finishing touches');
    expect(drawingStageLabel(const Duration(minutes: 5)), 'Still drawing');
  });

  testWidgets('the veil names who is being drawn and moves with the clock', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: CharacterDrawingOverlay(name: 'Mina Park')),
      ),
    );
    expect(find.text('Drawing Mina Park'), findsOneWidget);
    expect(find.text('Getting started'), findsOneWidget);
    await tester.pump(const Duration(seconds: 9));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Sketching the outline'), findsOneWidget);
  });

  testWidgets('reduced motion keeps the reading but drops the sweep', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: const Scaffold(body: CharacterDrawingOverlay(name: 'Mina')),
      ),
    );
    await tester.pump(const Duration(seconds: 2));
    expect(find.byType(CustomPaint), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
