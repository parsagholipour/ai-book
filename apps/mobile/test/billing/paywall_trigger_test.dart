import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/data/paywall_view_reporter.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

import 'billing_paywall_harness.dart';

class RecordingReporter implements PaywallViewReporter {
  final views = <PaywallTrigger>[];

  @override
  void paywallViewed(PaywallTrigger trigger) => views.add(trigger);
}

Widget launcher(
  RecordingReporter reporter,
  Future<void> Function(BuildContext context) open,
) {
  return ProviderScope(
    overrides: [
      storeBillingClientProvider.overrideWithValue(FakeStoreBillingClient()),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      creditLogRepositoryProvider.overrideWithValue(EmptyCreditLogRepository()),
      paywallViewReporterProvider.overrideWithValue(reporter),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => FilledButton(
            onPressed: () => open(context),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('a shortfall reports itself as credits needed', (tester) async {
    final reporter = RecordingReporter();
    await tester.pumpWidget(
      launcher(
        reporter,
        (context) => showBillingPaywall(
          context,
          creditsNeeded: const PaywallCreditsNeeded(credits: 900),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(reporter.views, [PaywallTrigger.creditsNeeded]);
  });

  testWidgets('a named trigger wins over what is read off the call', (
    tester,
  ) async {
    final reporter = RecordingReporter();
    await tester.pumpWidget(
      launcher(
        reporter,
        (context) => showBillingPaywall(
          context,
          trigger: PaywallTrigger.messageLimit,
          creditsNeeded: const PaywallCreditsNeeded(credits: 1),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(reporter.views, [PaywallTrigger.messageLimit]);
  });

  test('every trigger is one the server accepts', () {
    expect(PaywallTrigger.values.map((trigger) => trigger.wire), [
      'credits_needed',
      'image_limit',
      'page_limit',
      'export',
      'message_limit',
      'add_credits',
      'plans',
      'made_with_credit',
      'first_book',
      'other',
    ]);
  });
}
