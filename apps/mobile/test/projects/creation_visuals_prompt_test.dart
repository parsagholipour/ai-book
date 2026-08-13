import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/domain/creation_prefs.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The generated-image confirmation that sits between "Build the plan" and the
// build request. It prices the cover and interior art independently.

/// The quote the fakes produce: 8 pages, auto (charged as custom), `balanced`,
/// and the empty `creditCosts` the fake billing repository returns.
int _estimate({
  required bool coverEnabled,
  required bool illustrationsEnabled,
}) => estimateProjectCredits(
  bookType: 'lead_magnet',
  bookTypeChoice: 'auto',
  qualityPreset: 'balanced',
  coverEnabled: coverEnabled,
  illustrationsEnabled: illustrationsEnabled,
  targetPages: 8,
  creditCosts: const {},
);

Future<void> _openPrompt(
  WidgetTester tester,
  ScriptedCreationRepository creation,
) async {
  await tester.pumpWidget(
    app(creation: creation, projects: PlanProjectsRepository()),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('A kids book'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('the build separates cover and illustration choices and price', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    expect(find.text('Choose book images'), findsOneWidget);
    expect(find.widgetWithText(AppToggleTile, 'AI cover art'), findsOneWidget);
    expect(
      find.widgetWithText(AppToggleTile, 'In-book illustrations'),
      findsOneWidget,
    );
    expect(find.text('One cover image drawn for your book.'), findsOneWidget);
    // Nothing was requested yet — the dialog stands in front of the build.
    expect(creation.buildCount, 0);

    final base = _estimate(coverEnabled: false, illustrationsEnabled: false);
    final coverOnly = _estimate(
      coverEnabled: true,
      illustrationsEnabled: false,
    );
    final withImages = _estimate(
      coverEnabled: true,
      illustrationsEnabled: true,
    );
    expect(coverOnly - base, 45);
    expect(withImages, greaterThan(coverOnly));

    // Both generated-image lines are called out rather than folded into a total
    // nobody can take apart. Auto 8-page books charge one interior, same as
    // the cover, so the two rows share a string.
    expect(find.text('+${coverOnly - base} credits'), findsNWidgets(2));
    expect(find.text('$base credits'), findsOneWidget);
    expect(find.text('≈ $withImages credits'), findsOneWidget);
    expect(
      find.text(
        'Estimated full package cost, charged when you approve the plan.',
      ),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('turning illustrations off restates the quote and the build', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    await tester.tap(
      find.widgetWithText(AppToggleTile, 'In-book illustrations'),
    );
    await tester.pump();

    final coverOnly = _estimate(
      coverEnabled: true,
      illustrationsEnabled: false,
    );
    expect(find.text('≈ $coverOnly credits'), findsOneWidget);
    // The cover row never says "Not included": turning AI art off still leaves
    // the book with a cover, picked from the bundled catalog for free.
    expect(find.text('Not included'), findsOneWidget);
    expect(find.text('Designed cover, free'), findsNothing);
    expect(find.text('No generated images inside the book.'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.coverEnabled, isTrue);
    expect(creation.buildPresets?.illustrationsEnabled, isFalse);
    expect(creation.buildPresets?.imagesEnabled, isTrue);

    await tester.teardownScreen();
  });

  testWidgets('cancelling the prompt abandons the build', (tester) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Choose book images'), findsNothing);
    expect(creation.buildCount, 0);
    // Back in the pre-build stage, free to try again.
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('illustrations already turned off are not questioned', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();
    final illustrations = find.widgetWithText(
      AppToggleTile,
      'In-book illustrations',
    );
    await tester.ensureVisible(illustrations);
    await tester.tap(illustrations);
    await tester.pumpAndSettle();
    final doneButton = find.widgetWithText(FilledButton, 'Done');
    await tester.ensureVisible(doneButton);
    await tester.tap(doneButton);
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // Off is a deliberate answer — asking again would argue with it.
    expect(find.text('Choose book images'), findsNothing);
    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.coverEnabled, isTrue);
    expect(creation.buildPresets?.illustrationsEnabled, isFalse);

    await tester.teardownScreen();
  });

  testWidgets("don't ask again is remembered for the next build", (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final prefs = MemoryCreationPrefsStore();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository(), prefs: prefs),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final suppression = find.widgetWithText(
      CheckboxListTile,
      "Don't ask again",
    );
    await tester.ensureVisible(suppression);
    await tester.tap(suppression);
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect((await prefs.load()).visualsPromptSuppressed, isTrue);

    await tester.teardownScreen();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository(), prefs: prefs),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Choose book images'), findsNothing);
    expect(creation.buildCount, 2);
    // Only the asking was suppressed, never the answer: saying yes to the
    // default records no override at all, so the build still carries the
    // server's presets rather than a pinned "your choice".
    expect(creation.buildPresets, isNull);

    await tester.teardownScreen();
  });

  testWidgets('a suppressed prompt never opens at all', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        prefs: MemoryCreationPrefsStore(
          const CreationPrefs(visualsPromptSuppressed: true),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Choose book images'), findsNothing);
    expect(creation.buildCount, 1);

    await tester.teardownScreen();
  });

  testWidgets('a page count taken from the chat is still asked about', (
    tester,
  ) async {
    // The page-count sheet is skipped when the chat already named a number.
    // That build is exactly as expensive, so the prompt still runs.
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    expect(find.text('How many pages?'), findsNothing);
    expect(find.text('Choose book images'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('all four image combinations show the matching total', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    final illustratedTotal = _estimate(
      coverEnabled: true,
      illustrationsEnabled: true,
    );
    final illustrationsOnly = _estimate(
      coverEnabled: false,
      illustrationsEnabled: true,
    );
    final noImages = _estimate(
      coverEnabled: false,
      illustrationsEnabled: false,
    );
    final coverOnly = _estimate(
      coverEnabled: true,
      illustrationsEnabled: false,
    );
    expect(find.text('≈ $illustratedTotal credits'), findsOneWidget);

    final coverSwitch = find.widgetWithText(AppToggleTile, 'AI cover art');
    final illustrationSwitch = find.widgetWithText(
      AppToggleTile,
      'In-book illustrations',
    );

    await tester.tap(coverSwitch);
    await tester.pump();

    expect(illustratedTotal - illustrationsOnly, 45);
    expect(find.text('≈ $illustrationsOnly credits'), findsOneWidget);
    // Off is a free designed cover, not the absence of one.
    expect(
      find.text('Free: a designed cover is chosen to match your book.'),
      findsOneWidget,
    );

    await tester.tap(illustrationSwitch);
    await tester.pump();
    expect(find.text('≈ $noImages credits'), findsOneWidget);

    await tester.tap(coverSwitch);
    await tester.pump();
    expect(find.text('≈ $coverOnly credits'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(creation.buildPresets?.coverEnabled, isTrue);
    expect(creation.buildPresets?.illustrationsEnabled, isFalse);
    expect(creation.buildPresets?.imagesEnabled, isTrue);

    await tester.teardownScreen();
  });
}
