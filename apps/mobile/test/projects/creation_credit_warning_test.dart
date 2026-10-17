import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/domain/creation_prefs.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

class _BillingRepository extends FakeBillingRepository {
  _BillingRepository(this.available, {this.awaitingVerification = false});
  int available;

  /// The welcome grant waits on this reader's email.
  final bool awaitingVerification;

  @override
  Future<MobileBilling> getBilling() async => MobileBilling(
    credits: CreditBalance(
      available: available,
      reserved: 300,
      lifetimeGranted: available + 300,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: billing().creditCosts,
    welcomeCreditsPending: awaitingVerification,
    welcomeCreditsPendingReason: awaitingVerification
        ? 'email_unverified'
        : null,
    welcomeCreditsPendingCredits: awaitingVerification ? 1250 : null,
  );
}

/// The harness reader is on the free tier: 478 buys a 6-page book and its
/// plan, 494 the whole 8 pages the chat settled on.
Future<void> _start(
  WidgetTester tester,
  ScriptedCreationRepository creation, {
  int credits = 478,
  MemoryCreationPrefsStore? prefs,
  _BillingRepository? repository,
}) async {
  await tester.pumpWidget(
    app(
      creation: creation,
      projects: PlanProjectsRepository(),
      billingRepository: repository ?? _BillingRepository(credits),
      prefs:
          prefs ??
          MemoryCreationPrefsStore(
            const CreationPrefs(visualsPromptSuppressed: true),
          ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('A kids book'));
  await tester.pumpAndSettle();
}

Future<void> _build(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
  await _pump(tester);
}

Future<void> _pump(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('Yes reduces a chat-detected count before building', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _start(tester, creation);
    await _build(tester);

    expect(find.textContaining('you can make up to 6 pages'), findsOneWidget);
    expect(creation.buildCount, 0);
    await tester.tap(find.widgetWithText(FilledButton, 'Yes'));
    await _pump(tester);
    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.targetPages, 6);
    expect(creation.buildPresets?.pageCountSource, 'settings');
    await tester.teardownScreen();
  });

  testWidgets('No keeps the count selected in the page sheet', (tester) async {
    final creation = ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    );
    await _start(tester, creation);
    await _build(tester);
    await tester.tap(find.text('12 pages'));
    await _pump(tester);
    expect(find.text('Reduce the page count?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'No'));
    await _pump(tester);
    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.targetPages, 12);
    await tester.teardownScreen();
  });

  testWidgets('an email sign-up short of credits is offered the free ones '
      'first', (tester) async {
    final creation = ScriptedCreationRepository();
    await _start(
      tester,
      creation,
      repository: _BillingRepository(478, awaitingVerification: true),
    );
    await _build(tester);

    expect(find.textContaining('you can make up to 6 pages'), findsOneWidget);
    // In the warning itself; the home's own banner says it behind the dialog.
    Finder inWarning(Finder finder) =>
        find.descendant(of: find.byType(AlertDialog), matching: finder);
    expect(
      inWarning(find.text('Verify your email to get your 1,250 free credits.')),
      findsOneWidget,
    );
    expect(
      inWarning(find.widgetWithText(FilledButton, 'Verify email')),
      findsOneWidget,
    );
    // The warning's own answers stay below it.
    expect(inWarning(find.widgetWithText(FilledButton, 'Yes')), findsOneWidget);
    await tester.teardownScreen();
  });

  testWidgets('a verified reader\'s warning names no verification', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _start(tester, creation);
    await _build(tester);

    expect(find.textContaining('you can make up to 6 pages'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.textContaining('Verify your email'),
      ),
      findsNothing,
    );
    await tester.teardownScreen();
  });

  testWidgets('an exact sufficient balance builds without a warning', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _start(tester, creation, credits: 494);
    await _build(tester);
    expect(find.text('Reduce the page count?'), findsNothing);
    expect(creation.buildCount, 1);
    await tester.teardownScreen();
  });

  testWidgets('refreshes the balance before deciding whether to warn', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final repository = _BillingRepository(1200);
    await _start(tester, creation, repository: repository);
    repository.available = 478;
    await _build(tester);
    expect(find.textContaining('you can make up to 6 pages'), findsOneWidget);
    expect(creation.buildCount, 0);
    await tester.teardownScreen();
  });

  testWidgets('checks the updated image choices before warning', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await _start(tester, creation, prefs: MemoryCreationPrefsStore());
    await _build(tester);
    expect(find.text('Choose book images'), findsOneWidget);
    expect(find.text('Reduce the page count?'), findsNothing);
    await tester.tap(
      find.widgetWithText(AppToggleTile, 'In-book illustrations'),
    );
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await _pump(tester);
    expect(find.text('Reduce the page count?'), findsNothing);
    expect(creation.buildCount, 1);
    expect(creation.buildPresets?.illustrationsEnabled, isFalse);
    await tester.teardownScreen();
  });

  for (final answer in ['Yes', 'No']) {
    testWidgets(
      "Don't show again persists after $answer without remembering the answer",
      (tester) async {
        final prefs = MemoryCreationPrefsStore(
          const CreationPrefs(visualsPromptSuppressed: true),
        );
        final creation = ScriptedCreationRepository();
        await _start(tester, creation, prefs: prefs);
        await _build(tester);
        await tester.tap(
          find.widgetWithText(CheckboxListTile, "Don't show again"),
        );
        await tester.pump();
        await tester.tap(find.text(answer));
        await _pump(tester);
        expect((await prefs.load()).creditWarningSuppressed, isTrue);
        expect((await prefs.load()).visualsPromptSuppressed, isTrue);
        await tester.teardownScreen();

        final nextCreation = ScriptedCreationRepository();
        await _start(tester, nextCreation, prefs: prefs);
        await _build(tester);
        expect(find.text('Reduce the page count?'), findsNothing);
        expect(nextCreation.buildCount, 1);
        expect(nextCreation.buildPresets, isNull);
        await tester.teardownScreen();
      },
    );
  }

  testWidgets(
    'dismissal does not build, save suppression, or commit a page choice',
    (tester) async {
      final creation = ScriptedCreationRepository(
        preflightRequiresPageCount: true,
      );
      final prefs = MemoryCreationPrefsStore(
        const CreationPrefs(visualsPromptSuppressed: true),
      );
      await _start(tester, creation, prefs: prefs);
      await _build(tester);
      await tester.tap(find.text('12 pages'));
      await _pump(tester);
      await tester.tap(
        find.widgetWithText(CheckboxListTile, "Don't show again"),
      );
      await tester.pump();
      await tester.tapAt(const Offset(5, 5));
      await _pump(tester);
      expect(creation.buildCount, 0);
      expect((await prefs.load()).creditWarningSuppressed, isFalse);
      await _build(tester);
      expect(find.text('How many pages?'), findsOneWidget);
      await tester.teardownScreen();
    },
  );

  for (final answer in ['Yes', 'No']) {
    testWidgets('zero affordable pages offers a plan-only choice: $answer', (
      tester,
    ) async {
      final creation = ScriptedCreationRepository();
      await _start(tester, creation, credits: 100);
      await _build(tester);
      expect(find.text('Not enough credits'), findsOneWidget);
      expect(
        find.textContaining('cannot cover even a 1-page book'),
        findsOneWidget,
      );
      await tester.tap(find.text(answer));
      await _pump(tester);
      expect(creation.buildCount, answer == 'Yes' ? 1 : 0);
      expect(creation.buildPresets, isNull);
      await tester.teardownScreen();
    });
  }
}
