import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_state.dart';
import 'package:tomeza/features/projects/presentation/plan_build_progress.dart';

// The Build button's working state paces its own progress, because neither of
// the two calls behind it reports any. These pin the promises that pacing
// makes: it climbs, it never rewinds, it never arrives, and the second phase
// starts above where the first one can reach.

Widget _host(Widget child, {bool reducedMotion = false}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reducedMotion),
      child: Scaffold(
        body: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    ),
  );
}

String _percentOnScreen(WidgetTester tester) {
  final texts = tester
      .widgetList<Text>(find.byType(Text))
      .map((text) => text.data ?? '')
      .where((data) => data.endsWith('%'));
  return texts.single;
}

int _percentValue(WidgetTester tester) =>
    int.parse(_percentOnScreen(tester).replaceAll('%', ''));

void main() {
  group('pacedBuildProgress', () {
    test('climbs and never reaches its ceiling', () {
      final start = pacedBuildProgress(
        Duration.zero,
        CreationBuildPhase.preparing,
      );
      final later = pacedBuildProgress(
        const Duration(seconds: 8),
        CreationBuildPhase.preparing,
      );
      final muchLater = pacedBuildProgress(
        const Duration(minutes: 2),
        CreationBuildPhase.preparing,
      );
      expect(start, lessThan(later));
      expect(later, lessThan(muchLater));
      expect(muchLater, lessThan(0.46));
    });

    test('the build phase starts above anything the preflight can show', () {
      final preflightForever = pacedBuildProgress(
        const Duration(hours: 1),
        CreationBuildPhase.preparing,
      );
      final buildStart = pacedBuildProgress(
        Duration.zero,
        CreationBuildPhase.building,
      );
      expect(buildStart, greaterThan(preflightForever));
      expect(
        pacedBuildProgress(
          const Duration(hours: 1),
          CreationBuildPhase.building,
        ),
        lessThan(1),
      );
    });
  });

  group('buildStageLabel', () {
    test('advances one stage per interval and settles on the last', () {
      const phase = CreationBuildPhase.preparing;
      final stages = buildStagesFor(phase);
      expect(buildStageLabel(Duration.zero, phase), stages.first);
      expect(buildStageLabel(buildStageInterval, phase), stages[1]);
      expect(buildStageLabel(const Duration(minutes: 5), phase), stages.last);
    });
  });

  group('PlanBuildProcessingButton', () {
    testWidgets('shows the first stage and a percent that only climbs', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProcessingButton(phase: CreationBuildPhase.preparing),
        ),
      );
      await tester.pump();
      expect(find.text('Reading your idea'), findsOneWidget);
      final first = _percentValue(tester);

      await tester.pump(const Duration(seconds: 2));
      final second = _percentValue(tester);
      expect(second, greaterThan(first));

      // The next stage rises in after the interval; the old one is on its
      // way out for a few frames, so wait for the switch to finish.
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Checking the details'), findsOneWidget);
      expect(find.text('Reading your idea'), findsNothing);
      expect(_percentValue(tester), greaterThanOrEqualTo(second));
      expect(_percentValue(tester), lessThan(46));

      // Semantics keep the button's name and the stage, not a per-frame number.
      final semantics = tester.getSemantics(
        find.byType(PlanBuildProcessingButton),
      );
      expect(semantics.label, contains('Building the plan'));
      expect(semantics.label, contains('Checking the details'));
    });

    testWidgets('moving to the build phase continues from above, never back', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProcessingButton(phase: CreationBuildPhase.preparing),
        ),
      );
      await tester.pump(const Duration(seconds: 3));
      final beforeBuild = _percentValue(tester);

      await tester.pumpWidget(
        _host(
          const PlanBuildProcessingButton(phase: CreationBuildPhase.building),
        ),
      );
      await tester.pump();
      expect(_percentValue(tester), greaterThan(beforeBuild));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Setting up your book'), findsOneWidget);

      await tester.pump(const Duration(seconds: 30));
      expect(_percentValue(tester), lessThan(100));
    });

    testWidgets('reduced motion still reports progress', (tester) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProcessingButton(phase: CreationBuildPhase.building),
          reducedMotion: true,
        ),
      );
      await tester.pump();
      final first = _percentValue(tester);
      await tester.pump(const Duration(seconds: 2));
      expect(_percentValue(tester), greaterThan(first));
      expect(find.text('Setting up your book'), findsOneWidget);
    });
  });

  group('PlanBuildProgressBar', () {
    testWidgets('announces working until a reading arrives, then the percent', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProgressBar(
            value: null,
            semanticLabel: 'Book plan progress',
          ),
        ),
      );
      await tester.pump();
      expect(find.bySemanticsLabel('Book plan progress'), findsOneWidget);
      expect(
        tester.getSemantics(find.bySemanticsLabel('Book plan progress')).value,
        'Working',
      );

      await tester.pumpWidget(
        _host(
          const PlanBuildProgressBar(
            value: 0.64,
            semanticLabel: 'Book plan progress',
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 500));
      expect(
        tester.getSemantics(find.bySemanticsLabel('Book plan progress')).value,
        '64 percent complete',
      );
    });

    testWidgets('a stopped bar settles too, at whatever it reached', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProgressBar(
            value: 0.4,
            active: false,
            semanticLabel: 'Book generation progress',
          ),
        ),
      );
      // A failed book's bar must not keep promising more.
      await tester.pumpAndSettle();
      expect(
        tester
            .getSemantics(find.bySemanticsLabel('Book generation progress'))
            .value,
        '40 percent complete',
      );
    });

    testWidgets('a finished bar settles instead of shimmering forever', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const PlanBuildProgressBar(
            value: 1,
            semanticLabel: 'Book plan progress',
          ),
        ),
      );
      // Would time out if the sheen were still repeating.
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(find.bySemanticsLabel('Book plan progress')).value,
        '100 percent complete',
      );
    });
  });

  group('RisingStatusText', () {
    testWidgets('a new line replaces the old one after the switch', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const RisingStatusText(text: 'Writing page 3 of 40', style: null),
        ),
      );
      await tester.pump();
      expect(find.text('Writing page 3 of 40'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const RisingStatusText(text: 'Writing page 4 of 40', style: null),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Writing page 4 of 40'), findsOneWidget);
      expect(find.text('Writing page 3 of 40'), findsNothing);
    });
  });
}
