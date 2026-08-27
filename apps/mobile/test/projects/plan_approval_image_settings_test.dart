import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/plan_approval.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

void main() {
  testWidgets('cover-only approval ignores exhausted illustration quota', (
    tester,
  ) async {
    final project = plannedProject(
      coverEnabled: true,
      illustrationsEnabled: false,
    );
    final projects = PlanProjectsRepository(project: project);
    MobilePlanOperation? result;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          billingRepositoryProvider.overrideWithValue(
            _ExhaustedIllustrationBillingRepository(),
          ),
          projectsRepositoryProvider.overrideWithValue(projects),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) => FilledButton(
                onPressed: () async {
                  result = await confirmAndApprovePlan(context, ref, project);
                },
                child: const Text('Start approval'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Start approval'));
    await tester.pumpAndSettle();

    final expected = estimateApprovalCredits(project, _creditCosts);
    expect(find.text('Out of illustrated books'), findsNothing);
    expect(find.text('Approve this plan?'), findsOneWidget);
    expect(
      find.text(
        'Book after approval: $expected credits. You have 5000 available. Planning is not charged again.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Approve and start writing'));
    await tester.pumpAndSettle();

    expect(result, isNotNull);
  });
}

const _creditCosts = <String, dynamic>{
  'fullBookBase': 350,
  'fullBookPerPage': 8,
  'imageGeneration': 45,
  'premiumReview': 200,
  'exportUnlock': 150,
};

class _ExhaustedIllustrationBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async {
    return MobileBilling(
      credits: const CreditBalance(
        available: 5000,
        reserved: 0,
        lifetimeGranted: 5000,
        lifetimeSpent: 0,
      ),
      entitlements: const [],
      products: const [],
      creditCosts: _creditCosts,
      imageQuota: MobileImageQuota(
        used: 3,
        limit: 3,
        resetsAt: DateTime.utc(2026, 9, 1),
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
