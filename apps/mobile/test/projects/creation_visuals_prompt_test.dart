import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/domain/creation_prefs.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The illustrations confirmation that sits between "Build the plan" and the
// build request. Illustrations are the most expensive line item in a book and
// they default to on, so this is the one place the price of that default is put
// in front of someone before the plan exists.

/// The quote the fakes produce: 8 pages, `lead_magnet`, `balanced`, and the
/// empty `creditCosts` the fake billing repository returns.
int _estimate({required bool imagesEnabled}) => estimateProjectCredits(
  bookType: 'lead_magnet',
  qualityPreset: 'balanced',
  imagesEnabled: imagesEnabled,
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
  testWidgets('the build asks about illustrations and prices them separately', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    expect(find.text('Add illustrations?'), findsOneWidget);
    // Nothing was requested yet — the dialog stands in front of the build.
    expect(creation.buildCount, 0);

    final withImages = _estimate(imagesEnabled: true);
    final withoutImages = _estimate(imagesEnabled: false);
    expect(withImages, greaterThan(withoutImages));

    // The illustrations are called out as their own number rather than being
    // folded into a total nobody can take apart.
    expect(find.text('+${withImages - withoutImages} credits'), findsOneWidget);
    expect(find.text('$withoutImages credits'), findsOneWidget);
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

    await tester.tap(find.widgetWithText(SwitchListTile, 'Illustrations'));
    await tester.pump();

    final withoutImages = _estimate(imagesEnabled: false);
    expect(find.text('≈ $withoutImages credits'), findsOneWidget);
    expect(find.text('Not included'), findsOneWidget);
    expect(
      find.text('Text-first project with no planned visuals.'),
      findsOneWidget,
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.imagesEnabled, isFalse);

    await tester.teardownScreen();
  });

  testWidgets('cancelling the prompt abandons the build', (tester) async {
    final creation = ScriptedCreationRepository();
    await _openPrompt(tester, creation);

    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Add illustrations?'), findsNothing);
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
    final visuals = find.widgetWithText(SwitchListTile, 'Visuals');
    await tester.ensureVisible(visuals);
    await tester.tap(visuals);
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
    expect(find.text('Add illustrations?'), findsNothing);
    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.imagesEnabled, isFalse);

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

    await tester.tap(find.widgetWithText(CheckboxListTile, "Don't ask again"));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect((await prefs.load()).visualsPromptSuppressed, isTrue);

    await tester.tap(find.byTooltip('New output in this chat'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Add illustrations?'), findsNothing);
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

    expect(find.text('Add illustrations?'), findsNothing);
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
    expect(find.text('Add illustrations?'), findsOneWidget);

    await tester.teardownScreen();
  });
}
