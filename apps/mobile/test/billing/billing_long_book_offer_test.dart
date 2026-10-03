import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'billing_export_offer_harness.dart';

const _limit = BookPageLimit(limit: 30, requestedPages: 45);

final _upgrade = find.descendant(
  of: find.byKey(const ValueKey('long-book-upgrade')),
  matching: find.byType(FilledButton),
);

/// Opens the long-book offer from a button and records what it closed with.
Future<List<LongBookChoice?>> _openOffer(
  WidgetTester tester, {
  ExportOfferStore? store,
  ExportOfferRepository? repository,
  bool canShorten = true,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final results = <LongBookChoice?>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        storeBillingClientProvider.overrideWithValue(
          store ?? ExportOfferStore(),
        ),
        billingRepositoryProvider.overrideWithValue(
          repository ?? ExportOfferRepository(),
        ),
      ],
      child: MaterialApp(
        theme: buildTomezaLightTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: FilledButton(
                onPressed: () async => results.add(
                  await showLongBookOffer(
                    context,
                    projectId: 'project-1',
                    limit: _limit,
                    canShorten: canShorten,
                  ),
                ),
                child: const Text('Make it 45 pages'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Make it 45 pages'));
  await tester.pumpAndSettle();
  return results;
}

void main() {
  setUpAll(loadExportOfferFonts);

  testWidgets(
    'says the length back, shows where free stops, and sells the plan',
    (tester) async {
      await _openOffer(tester);

      expect(find.text('Your book wants\n45 pages.'), findsOneWidget);
      // The meter's three marks.
      expect(find.text('Free'), findsOneWidget);
      expect(find.text('Your book'), findsOneWidget);
      expect(find.text('With a plan'), findsOneWidget);
      expect(
        find.text('Every plan below writes books up to 600 pages.'),
        findsOneWidget,
      );
      expect(find.text('Unlock 600 pages with Creator'), findsOneWidget);
      expect(find.text('Start here'), findsOneWidget);
    },
  );

  testWidgets('keeping it free is one tap, and says so', (tester) async {
    final results = await _openOffer(tester);

    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('long-book-shorten')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Write it as a 30-page book instead'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('long-book-shorten')));
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsNothing);
    expect(results, [LongBookChoice.shorten]);
  });

  testWidgets('a surface that cannot shorten offers only "Not now"', (
    tester,
  ) async {
    final results = await _openOffer(tester, canShorten: false);

    expect(find.byKey(const ValueKey('long-book-shorten')), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Not now'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();

    expect(results, [null]);
  });

  testWidgets('a verified plan purchase answers "unlocked"', (tester) async {
    final store = ExportOfferStore();
    final results = await _openOffer(tester, store: store);

    await tester.tap(_upgrade);
    await tester.pump();
    expect(store.buyCalls.single.product.id, 'tomeza.creator_monthly');
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.creator_monthly',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'long-book-token',
        purchaseId: 'long-book-order',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();

    expect(results, [LongBookChoice.unlocked]);
  });

  testWidgets('a reader already on a plan just carries on', (tester) async {
    final results = await _openOffer(
      tester,
      repository: ExportOfferRepository(planTier: 'creator'),
    );

    expect(find.text('Your plan is ready'), findsOneWidget);
    await tester.tap(find.text('Continue with 45 pages'));
    await tester.pumpAndSettle();

    expect(results, [LongBookChoice.unlocked]);
  });

  group('the length wall in the model', () {
    test('reads the reader cap and the free tier offer from billing', () {
      final billing = MobileBilling.fromJson({
        'credits': {
          'available': 500,
          'reserved': 0,
          'lifetimeGranted': 500,
          'lifetimeSpent': 0,
        },
        'entitlements': const [],
        'products': const [],
        'creditCosts': const <String, dynamic>{},
        'freeTier': {'maxBookPages': 25},
        'maxBookPages': 25,
      });
      expect(billing.freeTier.maxBookPages, 25);
      expect(billing.locksBookPages(25), isFalse);
      expect(billing.locksBookPages(26), isTrue);
    });

    test('a server that sends no cap locks nothing', () {
      final billing = MobileBilling.fromJson({
        'credits': {
          'available': 500,
          'reserved': 0,
          'lifetimeGranted': 500,
          'lifetimeSpent': 0,
        },
        'entitlements': const [],
        'products': const [],
        'creditCosts': const <String, dynamic>{},
      });
      expect(billing.maxBookPages, isNull);
      expect(billing.locksBookPages(600), isFalse);
    });

    test('a refusal carries its numbers to the offer', () {
      const error = ApiException(
        code: 'PAGE_LIMIT_EXCEEDED',
        message: 'Free books go up to 30 pages.',
        statusCode: 403,
        details: {
          'pageLimit': {'limit': 30, 'requestedPages': 80, 'maxPages': 600},
        },
      );
      final limit = pageLimitFromError(error)!;
      expect(limit.limit, 30);
      expect(limit.requestedPages, 80);
      expect(limit.maxPages, 600);
      expect(
        pageLimitFromError(
          const ApiException(code: 'INSUFFICIENT_CREDITS', message: ''),
        ),
        isNull,
      );
    });
  });

  test('every plan sells the longer book, and free says where it stops', () {
    const creator = MobileBillingProduct(
      sku: 'tomeza.creator_monthly',
      title: 'Creator',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 6000,
      priceMicros: 19990000,
      currency: 'USD',
    );
    expect(planBenefits(creator).first, 'Books up to 600 pages');
  });
}
