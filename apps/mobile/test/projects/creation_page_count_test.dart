import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

Future<void> openPages(
  WidgetTester tester,
  ScriptedCreationRepository creation,
) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: const ValueKey('page-count-preview'),
      child: app(creation: creation, projects: PlanProjectsRepository()),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('A kids book'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
  await tester.pumpAndSettle();
  expect(find.text('How many pages?'), findsOneWidget);
}

Future<void> captureSheet(WidgetTester tester, String name) async {
  const directory = String.fromEnvironment('PAGE_COUNT_SCREENSHOTS');
  if (directory.isEmpty) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey('page-count-preview')),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    final loader = FontLoader('Manrope');
    for (final weight in [
      'Regular',
      'Medium',
      'SemiBold',
      'Bold',
      'ExtraBold',
    ]) {
      loader.addFont(rootBundle.load('assets/fonts/Manrope-$weight.ttf'));
    }
    await loader.load();
  });
  testWidgets(
    'orders counts and highlights one recommendation without selecting',
    (tester) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      creation.preflightRecommendations = creation
          .preflightRecommendations
          .reversed
          .toList();
      await openPages(tester, creation);

      expect(find.text('Recommended'), findsOneWidget);
      expect(find.text('Recommended for a compact book.'), findsOneWidget);
      expect(find.text('More room for detail.'), findsOneWidget);
      expect(
        find.text('Room for additional examples and practice.'),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(find.text('8 pages')).dy,
        lessThan(tester.getTopLeft(find.text('12 pages')).dy),
      );
      expect(
        tester.getTopLeft(find.text('12 pages')).dy,
        lessThan(tester.getTopLeft(find.text('24 pages')).dy),
      );
      final recommended = tester.widget<Card>(
        find.ancestor(
          of: find.text('Recommended'),
          matching: find.byType(Card),
        ),
      );
      expect((recommended.shape! as RoundedRectangleBorder).side.width, 2);
      expect(creation.buildCount, 0);
      expect(creation.buildPresets, isNull);
      final continueButton = find.widgetWithText(FilledButton, 'Continue');
      expect(continueButton, findsOneWidget);
      expect(tester.widget<FilledButton>(continueButton).onPressed, isNotNull);
      expect(find.widgetWithText(FilledButton, 'Use custom'), findsNothing);
      expect(find.text('Choose book images'), findsNothing);
      await tester.teardownScreen();
    },
  );

  for (final pages in [8, 12, 24]) {
    testWidgets('can continue with the $pages-page option', (tester) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      await openPages(tester, creation);
      await tester.ensureVisible(find.text('$pages pages'));
      await tester.tap(find.text('$pages pages'));
      await tester.continuePastVisualsPrompt();
      await tester.pump(const Duration(milliseconds: 100));
      expect(creation.buildPresets?.targetPages, pages);
      expect(creation.buildPresets?.pageCountSource, 'recommended');
      await tester.teardownScreen();
    });
  }

  testWidgets('continue uses the recommended count', (tester) async {
    final creation = ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    );
    await openPages(tester, creation);
    final continueButton = find.widgetWithText(FilledButton, 'Continue');
    await tester.ensureVisible(continueButton);
    await tester.tap(continueButton);
    await tester.continuePastVisualsPrompt();
    await tester.pump(const Duration(milliseconds: 100));
    expect(creation.buildPresets?.targetPages, 8);
    expect(creation.buildPresets?.pageCountSource, 'recommended');
    await tester.teardownScreen();
  });

  testWidgets(
    'custom entry validates the range and continues with that count',
    (tester) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      await openPages(tester, creation);
      final custom = find.widgetWithText(TextField, 'Custom pages');
      final continueButton = find.widgetWithText(FilledButton, 'Continue');
      expect(tester.widget<FilledButton>(continueButton).onPressed, isNotNull);
      for (final value in ['0', '601']) {
        await tester.enterText(custom, value);
        await tester.pump();
        final useCustom = find.widgetWithText(FilledButton, 'Use custom');
        expect(tester.widget<FilledButton>(useCustom).onPressed, isNull);
      }
      await tester.enterText(custom, '37');
      await tester.pump();
      expect(find.textContaining('credits for 37 pages'), findsOneWidget);
      final useCustom = find.widgetWithText(FilledButton, 'Use custom');
      await tester.ensureVisible(useCustom);
      await tester.tap(useCustom);
      await tester.continuePastVisualsPrompt();
      await tester.pump(const Duration(milliseconds: 100));
      expect(creation.buildPresets?.targetPages, 37);
      expect(creation.buildPresets?.pageCountSource, 'settings');
      await tester.teardownScreen();
    },
  );

  for (final dismissWithBack in [false, true]) {
    testWidgets('cancelling saves no page selection (back: $dismissWithBack)', (
      tester,
    ) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      await openPages(tester, creation);
      await tester.enterText(
        find.widgetWithText(TextField, 'Custom pages'),
        '37',
      );
      await tester.pump();
      if (dismissWithBack) {
        await tester.binding.handlePopRoute();
      } else {
        final cancel = find.widgetWithText(OutlinedButton, 'Cancel');
        await tester.ensureVisible(cancel);
        await tester.tap(cancel);
      }
      await tester.pumpAndSettle();
      expect(creation.buildCount, 0);
      expect(creation.buildPresets, isNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.pumpAndSettle();
      expect(find.text('How many pages?'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, 'Custom pages'))
            .controller!
            .text,
        isEmpty,
      );
      await tester.teardownScreen();
    });
  }

  testWidgets('older responses without isRecommended render without a badge', (
    tester,
  ) async {
    final legacy = MobileCreationBuildPreflight.fromJson({
      'requiresPageCount': true,
      'recommendations': [
        {
          'targetPages': 8,
          'label': '8 pages',
          'description': 'A compact read.',
        },
        {'targetPages': 12, 'label': '12 pages', 'description': 'More detail.'},
      ],
    });
    expect(legacy.recommendations.every((item) => !item.isRecommended), isTrue);
    final creation = ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    )..preflightRecommendations = legacy.recommendations;
    await openPages(tester, creation);
    expect(find.text('Recommended'), findsNothing);
    expect(find.text('A compact read.'), findsOneWidget);
    await tester.tap(find.text('12 pages'));
    await tester.continuePastVisualsPrompt();
    await tester.pump(const Duration(milliseconds: 100));
    expect(creation.buildPresets?.targetPages, 12);
    await tester.teardownScreen();
  });

  for (final scale in [1.0, 2.0]) {
    testWidgets('sheet remains usable at 320px and text scale $scale', (
      tester,
    ) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      await openPages(tester, creation);
      // Resize after opening to isolate the sheet from the chat's own layout.
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 740);
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await captureSheet(tester, 'pages-320-scale-$scale');
      for (final pages in [8, 12, 24]) {
        final count = find.text('$pages pages');
        await tester.ensureVisible(count);
        await tester.pumpAndSettle();
        expect(count.hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
      final cancel = find.widgetWithText(OutlinedButton, 'Cancel');
      await tester.ensureVisible(cancel);
      await tester.pumpAndSettle();
      await captureSheet(tester, 'pages-320-scale-$scale-custom');
      expect(cancel.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.teardownScreen();
    });
  }
}
