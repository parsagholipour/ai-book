import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

import 'billing_export_offer_harness.dart';
import 'billing_paywall_harness.dart';

/// Play can answer the product query without a product the server sells — the
/// query failed, or the product is not active in Play Console yet. Every plan
/// used to read "Unavailable" over a disabled "Temporarily unavailable", with
/// no reason and nothing to press, and each row printed the server's dollar
/// price as though Play had quoted it.
class _FlakyPricesStore extends FakeStoreBillingClient {
  _FlakyPricesStore({
    this.priced = false,
    this.error,
    this.throws = false,
    this.missing = const {},
  });

  /// False answers with no products at all.
  bool priced;
  String? error;
  bool throws;
  Set<String> missing;
  var queries = 0;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    queries += 1;
    if (throws) {
      throw PlatformException(code: 'service_unavailable');
    }
    if (!priced) {
      return StoreProductQueryResult(
        products: const [],
        notFoundIds: productIds.toList(),
        error: error,
      );
    }
    final result = await super.queryProducts(productIds);
    return StoreProductQueryResult(
      products: [
        for (final product in result.products)
          if (!missing.contains(product.id)) product,
      ],
      notFoundIds: missing.toList(),
    );
  }
}

/// The export store, counting the queries a retry makes.
class _CountingExportStore extends ExportOfferStore {
  _CountingExportStore({super.missing});

  var queries = 0;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) {
    queries += 1;
    return super.queryProducts(productIds);
  }
}

final _checkoutBuy = find.descendant(
  of: find.byKey(const ValueKey('paywall-checkout-buy')),
  matching: find.byType(FilledButton),
);

const _allMissing = {
  'tomeza.creator_monthly',
  'tomeza.pro_monthly',
  'tomeza.max_monthly',
};

Future<void> _openSheet(
  WidgetTester tester, {
  required StoreBillingClient store,
  required BillingRepository repository,
  required Future<void> Function(BuildContext context) open,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        storeBillingClientProvider.overrideWithValue(store),
        billingRepositoryProvider.overrideWithValue(repository),
      ],
      child: MaterialApp(
        theme: buildTomezaLightTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: FilledButton(
                onPressed: () => open(context),
                child: const Text('Open offer'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open offer'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(loadExportOfferFonts);

  group('the paywall', () {
    for (final (name, store) in [
      ('answers with none of the products', _FlakyPricesStore()),
      (
        'reports a query error',
        _FlakyPricesStore(error: 'BillingResponse.serviceUnavailable'),
      ),
      ('throws on the product query', _FlakyPricesStore(throws: true)),
    ]) {
      testWidgets('says it could not load prices and retries when Play $name', (
        tester,
      ) async {
        final repository = FakeBillingRepository();
        await tester.pumpWidget(
          testPaywall(store: store, repository: repository),
        );
        await tester.pumpAndSettle();

        // The plans are still there — the catalog loaded — but unpriced.
        expect(find.text('Could not load purchase options'), findsNothing);
        expect(
          find.text('Couldn’t load prices from Google Play'),
          findsOneWidget,
        );
        expect(find.text('Unavailable'), findsWidgets);
        // Never the server's catalog price in Play's place.
        expect(find.textContaining('USD'), findsNothing);
        expect(find.textContaining(r'$19.99'), findsNothing);
        expect(find.text('Temporarily unavailable'), findsNothing);

        // The checkout bar retries instead of sitting disabled.
        final button = tester.widget<FilledButton>(_checkoutBuy);
        expect(button.onPressed, isNotNull);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('paywall-checkout')),
            matching: find.text('Try again'),
          ),
          findsOneWidget,
        );

        store
          ..priced = true
          ..throws = false
          ..error = null;
        final before = store.queries;
        await tester.tap(_checkoutBuy);
        await tester.pumpAndSettle();

        expect(store.queries, before + 1);
        expect(
          find.text('Couldn’t load prices from Google Play'),
          findsNothing,
        );
        expect(find.text('Choose Creator'), findsOneWidget);
        expect(store.buyCalls, isEmpty);
      });
    }

    testWidgets('the notice\'s own Retry asks Play again', (tester) async {
      final store = _FlakyPricesStore();
      await tester.pumpWidget(
        testPaywall(store: store, repository: FakeBillingRepository()),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(store.queries, 2);
    });

    testWidgets('a product Play left out is named as such, the rest sell', (
      tester,
    ) async {
      final store = _FlakyPricesStore(
        priced: true,
        missing: {'tomeza.pro_monthly'},
      );
      await tester.pumpWidget(
        testPaywall(store: store, repository: FakeBillingRepository()),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Some prices didn’t load from Google Play'),
        findsOneWidget,
      );
      expect(find.text('Unavailable', skipOffstage: false), findsOneWidget);
      // Creator is priced and selected, so it is what the checkout sells.
      expect(find.text('Choose Creator'), findsOneWidget);
      expect(find.textContaining('USD'), findsNothing);
    });
  });

  testWidgets(
    'the long-book offer says why its plans are unpriced and retries',
    (tester) async {
      final store = _CountingExportStore(missing: _allMissing);
      await _openSheet(
        tester,
        store: store,
        repository: ExportOfferRepository(),
        open: (context) => showLongBookOffer(
          context,
          projectId: 'project-1',
          limit: const BookPageLimit(limit: 30, requestedPages: 45),
        ),
      );

      expect(
        find.text('Couldn’t load prices from Google Play'),
        findsOneWidget,
      );
      expect(find.textContaining('USD'), findsNothing);
      expect(find.text('Plan unavailable'), findsNothing);
      final upgrade = find.descendant(
        of: find.byKey(const ValueKey('long-book-upgrade')),
        matching: find.byType(FilledButton),
      );
      expect(tester.widget<FilledButton>(upgrade).onPressed, isNotNull);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('long-book-upgrade')),
          matching: find.text('Try again'),
        ),
        findsOneWidget,
      );

      await tester.tap(upgrade);
      await tester.pumpAndSettle();
      expect(store.queries, 2);
      expect(store.buyCalls, isEmpty);
    },
  );

  testWidgets('the export offer says why its plans are unpriced and retries', (
    tester,
  ) async {
    final store = _CountingExportStore(missing: _allMissing);
    await _openSheet(
      tester,
      store: store,
      repository: ExportOfferRepository(),
      open: (context) => showBillingPaywall(
        context,
        projectId: 'project-1',
        exportFormatLabel: 'Word',
      ),
    );

    expect(find.text('Couldn’t load prices from Google Play'), findsOneWidget);
    expect(find.textContaining('USD'), findsNothing);
    final upgrade = find.descendant(
      of: find.byKey(const ValueKey('export-upgrade')),
      matching: find.byType(FilledButton),
    );
    await tester.tap(upgrade);
    await tester.pumpAndSettle();
    expect(store.queries, 2);
    expect(store.buyCalls, isEmpty);
  });

  testWidgets('the long-book offer states the chosen plan\'s own renewal', (
    tester,
  ) async {
    final repository = FakeBillingRepository();
    final billing = repository.billing;
    repository.billing = MobileBilling(
      purchaseAccountId: billing.purchaseAccountId,
      credits: billing.credits,
      entitlements: billing.entitlements,
      creditCosts: billing.creditCosts,
      products: const [
        MobileBillingProduct(
          sku: 'tomeza.creator_monthly',
          title: 'Creator',
          description: '',
          productType: 'SUBSCRIPTION',
          creditAmount: 6000,
          priceMicros: 19990000,
          currency: 'USD',
          billingPeriod: 'P1M',
        ),
        MobileBillingProduct(
          sku: 'tomeza.creator_yearly',
          title: 'Creator yearly',
          description: '',
          productType: 'SUBSCRIPTION',
          creditAmount: 72000,
          priceMicros: 199990000,
          currency: 'USD',
          billingPeriod: 'P1Y',
        ),
      ],
    );
    await _openSheet(
      tester,
      store: FakeStoreBillingClient(),
      repository: repository,
      open: (context) => showLongBookOffer(
        context,
        projectId: 'project-1',
        limit: const BookPageLimit(limit: 30, requestedPages: 45),
      ),
    );

    final renewal = find.byKey(const ValueKey('long-book-renewal'));
    final list = find.byType(Scrollable).first;
    await tester.scrollUntilVisible(renewal, 200, scrollable: list);
    expect(
      find.textContaining('Plans renew monthly', skipOffstage: false),
      findsNothing,
    );
    expect(
      tester.widget<Text>(renewal).data,
      startsWith('Renews monthly; cancel anytime in Google Play.'),
    );

    final yearly = find.byKey(
      const ValueKey('long-book-plan-tomeza.creator_yearly'),
    );
    await tester.scrollUntilVisible(yearly, -200, scrollable: list);
    await tester.tap(yearly);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(renewal, 200, scrollable: list);

    expect(
      tester.widget<Text>(renewal).data,
      startsWith('Renews yearly; cancel anytime in Google Play.'),
    );
  });
}
