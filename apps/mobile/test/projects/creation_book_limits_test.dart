import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/creation_labels.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

/// The two operator switches that bound what a new book may be: the longest
/// book any plan writes (`paidMaxBookPages`) and whether Ultra may start one
/// (`ultraTierEnabled`). Past the first nothing is offered — no lock, no plan
/// offer, because no plan unlocks it — and while the second is off the Effort
/// picker has no Ultra and a carried-over Ultra choice is built at Extra polish.
class _LimitsBilling implements BillingRepository {
  _LimitsBilling({this.ceiling = maxPlanBookPages, this.ultra = true});

  final int ceiling;
  final bool ultra;

  @override
  Future<MobileBilling> getBilling() async => MobileBilling(
    credits: const CreditBalance(
      available: 100000,
      reserved: 0,
      lifetimeGranted: 100000,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: const {
      'fullBookBase': 250,
      'fullBookPerPage': 8,
      'imageGeneration': 70,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
    paidMaxBookPages: ceiling,
    ultraTierEnabled: ultra,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

Finder _inDetails(Finder matching) => find.descendant(
  of: find.byKey(const ValueKey('creationBriefDetails')),
  matching: matching,
);

Future<void> _openAdvanced(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('creationBriefHeader')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.tap(_inDetails(find.text('Type: Auto')));
  await tester.pumpAndSettle();
}

CreationChatController _controller(WidgetTester tester) =>
    ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);

Future<void> _tapBuild(WidgetTester tester) async {
  await tester.tap(find.text('A kids book'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
  await tester.pumpAndSettle();
}

void main() {
  test('the Effort list drops Ultra only while it is off', () {
    expect(
      qualityPresetOptionsFor(ultraEnabled: true).map((option) => option.value),
      ['fast', 'balanced', 'premium', 'ultra'],
    );
    expect(
      qualityPresetOptionsFor(
        ultraEnabled: false,
      ).map((option) => option.value),
      ['fast', 'balanced', 'premium'],
    );
    expect(startableQualityPreset('ultra', ultraEnabled: false), 'premium');
    expect(startableQualityPreset('ultra', ultraEnabled: true), 'ultra');
    expect(startableQualityPreset('fast', ultraEnabled: false), 'fast');
  });

  testWidgets('the Effort picker offers Ultra while it is on', (tester) async {
    await tester.pumpWidget(
      app(
        creation: ScriptedCreationRepository(),
        billingRepository: _LimitsBilling(),
      ),
    );
    await tester.pumpAndSettle();
    await _openAdvanced(tester);

    expect(find.text('Ultra effort'), findsOneWidget);
    await tester.teardownScreen();
  });

  testWidgets('the Effort picker has no Ultra while the operator has it off', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(
        creation: ScriptedCreationRepository(),
        billingRepository: _LimitsBilling(ultra: false),
      ),
    );
    await tester.pumpAndSettle();
    await _openAdvanced(tester);

    expect(find.text('Ultra effort'), findsNothing);
    expect(find.text('Extra polish'), findsOneWidget);
    await tester.teardownScreen();
  });

  testWidgets('an Ultra choice is built at Extra polish while Ultra is off', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        billingRepository: _LimitsBilling(ultra: false),
      ),
    );
    await tester.pumpAndSettle();
    // A remix of an Ultra book, or a choice made while Ultra was on.
    _controller(tester).setQualityPreset('ultra');
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey('creationBriefHeader')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(_inDetails(find.text('Effort: Extra polish')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('creationBriefHeader')));
    await tester.pumpAndSettle();

    await _tapBuild(tester);
    await tester.continuePastVisualsPrompt();
    await tester.pump(const Duration(milliseconds: 100));
    expect(creation.buildPresets?.qualityPreset, 'premium');
    await tester.teardownScreen();
  });

  testWidgets('the page sheet offers nothing past the longest book', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    );
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        billingRepository: _LimitsBilling(ceiling: 12),
      ),
    );
    await tester.pumpAndSettle();
    await _tapBuild(tester);
    expect(find.text('How many pages?'), findsOneWidget);

    expect(find.text('8 pages'), findsOneWidget);
    expect(find.text('12 pages'), findsOneWidget);
    // The 24-page option is past the ceiling: not locked, simply not there.
    expect(find.text('Expanded'), findsNothing);
    expect(find.byKey(const ValueKey('page-option-locked-24')), findsNothing);

    await tester.enterText(find.byType(TextField).last, '30');
    await tester.pump();
    expect(find.text('Enter a number from 1 to 12.'), findsOneWidget);
    final useCustom = find.widgetWithText(FilledButton, 'Use custom');
    expect(tester.widget<FilledButton>(useCustom).onPressed, isNull);
    expect(creation.buildCount, 0);
    await tester.teardownScreen();
  });

  testWidgets('a length past the longest book is offered at the longest', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()..preflightDetectedPages = 60;
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        billingRepository: _LimitsBilling(ceiling: 40),
      ),
    );
    await tester.pumpAndSettle();
    await _tapBuild(tester);

    expect(find.text('Books go up to 40 pages'), findsOneWidget);
    expect(creation.buildCount, 0);
    await tester.tap(find.text('Use 40 pages'));
    await tester.pumpAndSettle();
    await tester.continuePastVisualsPrompt();
    await tester.pump(const Duration(milliseconds: 100));
    expect(creation.buildPresets?.targetPages, 40);
    await tester.teardownScreen();
  });

  testWidgets('declining the longest book builds nothing', (tester) async {
    final creation = ScriptedCreationRepository()..preflightDetectedPages = 60;
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        billingRepository: _LimitsBilling(ceiling: 40),
      ),
    );
    await tester.pumpAndSettle();
    await _tapBuild(tester);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(creation.buildCount, 0);
    await tester.teardownScreen();
  });
}
