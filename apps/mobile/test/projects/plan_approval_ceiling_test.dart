import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/presentation/plan_approval.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

/// Past the longest book any plan writes there is nothing to buy, so approval
/// says the server's sentence before anything; below it, the long-book offer
/// a lapsed plan meets names the operator's ceiling, not the 600-page request
/// limit.
void main() {
  Future<void> approve(
    WidgetTester tester, {
    required int targetPages,
    int? maxBookPages,
  }) async {
    final project = plannedProject(targetPages: targetPages);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          billingRepositoryProvider.overrideWithValue(
            _CeilingBillingRepository(maxBookPages: maxBookPages),
          ),
          projectsRepositoryProvider.overrideWithValue(
            PlanProjectsRepository(project: project),
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) => FilledButton(
                onPressed: () => confirmAndApprovePlan(context, ref, project),
                child: const Text('Start approval'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Start approval'));
    await tester.pumpAndSettle();
  }

  testWidgets('a book past the paid ceiling is refused with its sentence', (
    tester,
  ) async {
    await approve(tester, targetPages: 250);

    expect(
      find.text("Books longer than 200 pages aren't available yet."),
      findsOneWidget,
    );
    expect(find.text('Approve this plan?'), findsNothing);
  });

  testWidgets('the long-book offer names the paid ceiling', (tester) async {
    await approve(tester, targetPages: 60, maxBookPages: 30);

    expect(
      find.text('Every plan below writes books up to 200 pages.'),
      findsOneWidget,
    );
  });

  test('a plan\'s benefits read the server\'s page ceiling', () {
    const creator = MobileBillingProduct(
      sku: 'tomeza.creator_monthly',
      title: 'Creator',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 6000,
      priceMicros: 19990000,
      currency: 'USD',
    );
    expect(
      planBenefits(creator, creditCosts: const {'paidMaxBookPages': 200}).first,
      'Books up to 200 pages',
    );
    // A server that sends no ceiling keeps the request limit.
    expect(planBenefits(creator).first, 'Books up to 600 pages');
  });
}

class _CeilingBillingRepository implements BillingRepository {
  _CeilingBillingRepository({this.maxBookPages});

  final int? maxBookPages;

  @override
  Future<MobileBilling> getBilling() async {
    return MobileBilling(
      credits: const CreditBalance(
        available: 50000,
        reserved: 0,
        lifetimeGranted: 50000,
        lifetimeSpent: 0,
      ),
      entitlements: const [],
      products: const [],
      creditCosts: const {'paidMaxBookPages': 200},
      maxBookPages: maxBookPages,
      paidMaxBookPages: 200,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
