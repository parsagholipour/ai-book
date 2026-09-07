import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_buy_credits_sheet.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/billing_product_option.dart';

import 'billing_export_offer_harness.dart'
    show exportPlans, loadExportOfferFonts;
import 'billing_paywall_harness.dart';

class SalesOfferRepository extends FakeBillingRepository {
  SalesOfferRepository({super.planTier}) {
    billing = MobileBilling(
      credits: billing.credits,
      entitlements: billing.entitlements,
      products: [
        ...exportPlans,
        ...billing.products.where((p) => !p.isSubscription),
      ],
      creditCosts: billing.creditCosts,
      plan: billing.plan,
    );
  }
}

class SalesOfferStore extends FakeStoreBillingClient {
  SalesOfferStore({this.missing = const {}});
  final Set<String> missing;
  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    final result = await super.queryProducts(productIds);
    return StoreProductQueryResult(
      products: [
        for (final product in result.products)
          if (!missing.contains(product.id))
            product.id == 'tomeza.max_monthly'
                ? StoreProduct(
                    id: product.id,
                    title: product.title,
                    description: '',
                    price: r'$199.99',
                    rawPrice: 199.99,
                    currencyCode: 'USD',
                  )
                : product,
      ],
      notFoundIds: missing.toList(),
    );
  }
}

Widget salesOfferLauncher({
  required SalesOfferStore store,
  required SalesOfferRepository repository,
  PaywallCreditsNeeded? creditsNeeded,
  bool dark = false,
  double textScale = 1,
}) => ProviderScope(
  overrides: [
    storeBillingClientProvider.overrideWithValue(store),
    billingRepositoryProvider.overrideWithValue(repository),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: dark ? buildTomezaDarkTheme() : buildTomezaLightTheme(),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(textScale)),
      child: child!,
    ),
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: FilledButton(
            onPressed: () => showBillingPaywall(
              context,
              projectId: 'project-1',
              creditsNeeded: creditsNeeded,
            ),
            child: const Text('Buy credits / plan'),
          ),
        ),
      ),
    ),
  ),
);

final salesCheckout = find.byKey(const ValueKey('paywall-checkout'));
final salesBuy = find.byKey(const ValueKey('paywall-checkout-buy'));

Future<void> openSalesOffer(
  WidgetTester tester, {
  SalesOfferStore? store,
  SalesOfferRepository? repository,
  PaywallCreditsNeeded? needed,
  Size size = const Size(390, 844),
  bool dark = false,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    salesOfferLauncher(
      store: store ?? SalesOfferStore(),
      repository: repository ?? SalesOfferRepository(),
      creditsNeeded: needed,
      dark: dark,
      textScale: textScale,
    ),
  );
  await tester.tap(find.text('Buy credits / plan'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(loadExportOfferFonts);

  testWidgets('custom amount checkout stays above the keyboard', (
    tester,
  ) async {
    await openSalesOffer(
      tester,
      needed: const PaywallCreditsNeeded(credits: 1500),
    );
    await openCustomCreditAmount(tester);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.tap(find.byKey(const ValueKey('buy-credits-amount')));
    await tester.pumpAndSettle();
    final checkout = find.byKey(const ValueKey('buy-credits-checkout'));
    expect(tester.getRect(checkout).bottom, lessThanOrEqualTo(544));
    expect(
      find.byKey(const ValueKey('buy-credits-buy')).hitTestable(),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'See plans returns from the amount picker to visible plan options',
    (tester) async {
      await openSalesOffer(
        tester,
        needed: const PaywallCreditsNeeded(credits: 4000),
      );
      await openCustomCreditAmount(tester);
      final seePlans = find.byKey(const ValueKey('buy-credits-see-plans'));
      await tester.scrollUntilVisible(
        seePlans,
        160,
        scrollable: find
            .descendant(
              of: find.byType(BuyCreditsSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.ensureVisible(seePlans);
      await tester.pumpAndSettle();
      await tester.tap(seePlans);
      await tester.pumpAndSettle();
      expect(find.byType(BuyCreditsSheet), findsNothing);
      expectInViewport(
        tester,
        find.byKey(const ValueKey('paywall-plan-tomeza.creator_monthly')),
      );
      expect(find.text('Choose Creator'), findsOneWidget);
    },
  );

  testWidgets(
    'browsing shows every plan and a fixed checkout without scrolling',
    (tester) async {
      final store = SalesOfferStore();
      await openSalesOffer(tester, store: store);
      for (final plan in exportPlans) {
        final finder = find.byKey(ValueKey('paywall-plan-${plan.sku}'));
        expectInViewport(tester, finder);
        expect(finder.hitTestable(), findsOneWidget);
      }
      expect(find.text('Monthly plans').hitTestable(), findsOneWidget);
      expect(find.text('One-time credits').hitTestable(), findsOneWidget);
      expect(salesBuy.hitTestable(), findsOneWidget);
      expect(find.text('Choose Creator'), findsOneWidget);
      expect(store.buyCalls, isEmpty);
    },
  );

  testWidgets(
    'a shortfall selects the cheapest available pack that covers it',
    (tester) async {
      final store = SalesOfferStore();
      await openSalesOffer(
        tester,
        store: store,
        needed: const PaywallCreditsNeeded(
          credits: 1600,
          reason: 'Finish writing your book.',
        ),
      );
      expect(find.textContaining('1,500 short'), findsOneWidget);
      expect(find.text('Covers your gap'), findsOneWidget);
      expect(
        find.descendant(
          of: salesCheckout,
          matching: find.text(r'2,000 credits · $14.99 once'),
        ),
        findsOneWidget,
      );
      expect(
        find.text('Balance after this pack: 2,100 · Enough to continue'),
        findsOneWidget,
      );
      expect(store.buyCalls, isEmpty);
      await tester.tap(salesBuy);
      await tester.pump();
      expect(store.buyCalls.single.product.id, 'tomeza.credit_pack_2');
      expect(store.buyCalls.single.consumable, isTrue);
    },
  );

  testWidgets('switching modes keeps selections and never buys a product', (
    tester,
  ) async {
    final store = SalesOfferStore();
    await openSalesOffer(tester, store: store);
    await tester.tap(
      find.byKey(const ValueKey('paywall-plan-tomeza.pro_monthly')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Choose Pro'), findsOneWidget);
    await selectPaywallPack(tester, sku: 'tomeza.credit_pack_2');
    expect(find.text('Add 2,000 credits'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Monthly plans'),
      -160,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Monthly plans'));
    await tester.pumpAndSettle();
    expect(find.text('Choose Pro'), findsOneWidget);
    expect(
      find.text('Renews monthly · Cancel anytime in Google Play'),
      findsOneWidget,
    );
    expect(store.buyCalls, isEmpty);
  });

  testWidgets('a pack that is too small states the remaining gap', (
    tester,
  ) async {
    await openSalesOffer(
      tester,
      needed: const PaywallCreditsNeeded(credits: 6000),
    );
    expect(
      find.text('Balance after this pack: 2,100 · 3,900 more needed'),
      findsOneWidget,
    );
    expect(find.text('Covers your gap'), findsNothing);
    expect(find.text('Add 2,000 credits'), findsOneWidget);
  });

  testWidgets('unavailable packs never become the recommendation', (
    tester,
  ) async {
    await openSalesOffer(
      tester,
      store: SalesOfferStore(missing: {'tomeza.credit_pack_1'}),
      needed: const PaywallCreditsNeeded(credits: 500),
    );
    expect(find.text('Unavailable'), findsOneWidget);
    expect(find.text('Add 2,000 credits'), findsOneWidget);
    expect(find.text(r'2,000 credits · $14.99 once'), findsOneWidget);
  });

  testWidgets('pending checkout locks switching and duplicate purchases', (
    tester,
  ) async {
    final store = SalesOfferStore();
    await openSalesOffer(
      tester,
      store: store,
      needed: const PaywallCreditsNeeded(credits: 500),
    );
    await tester.tap(salesBuy);
    await tester.tap(salesBuy);
    await tester.pump();
    expect(store.buyCalls, hasLength(1));
    await tester.scrollUntilVisible(
      find.text('Monthly plans'),
      -160,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Monthly plans'));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('paywall-plan-tomeza.creator_monthly')),
      findsNothing,
    );
    expect(
      tester
          .widget<SegmentedButton<bool>>(find.byType(SegmentedButton<bool>))
          .onSelectionChanged,
      isNull,
    );
  });

  testWidgets('a paid account is not offered a downgrade as a credit fix', (
    tester,
  ) async {
    await openSalesOffer(
      tester,
      repository: SalesOfferRepository(planTier: 'max'),
      needed: const PaywallCreditsNeeded(credits: 5000),
    );
    await tester.scrollUntilVisible(
      find.text('Compare monthly plans'),
      180,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    expect(find.text('More credits for less upfront'), findsNothing);
    expect(find.text('Add 2,000 credits'), findsOneWidget);
  });

  testWidgets(
    'small screens with large text keep checkout reachable in both modes',
    (tester) async {
      await openSalesOffer(
        tester,
        size: const Size(320, 640),
        textScale: 2,
        dark: true,
      );
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('One-time credits'),
        120,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('One-time credits'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(salesBuy.hitTestable(), findsOneWidget);
      final before = tester.getRect(salesCheckout);
      await tester.drag(find.byType(ListView), const Offset(0, -260));
      await tester.pumpAndSettle();
      expect(tester.getRect(salesCheckout), before);
    },
  );

  testWidgets(
    'custom credit goals disclose one purchase and reject an empty amount',
    (tester) async {
      await openSalesOffer(
        tester,
        needed: const PaywallCreditsNeeded(credits: 2600),
      );
      await openCustomCreditAmount(tester);
      final sheet = find.byType(BuyCreditsSheet);
      expect(
        find.descendant(
          of: sheet,
          matching: find.textContaining('2 purchases'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: sheet,
          matching: find.textContaining(r'one pack for $14.99'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: sheet,
          matching: find.text(r'2,000 credits · $14.99 once'),
        ),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('buy-credits-amount')),
        '',
      );
      await tester.pumpAndSettle();
      expect(find.text('Enter at least 1 credit.'), findsOneWidget);
      final buy = find.descendant(
        of: find.byKey(const ValueKey('buy-credits-buy')),
        matching: find.byType(FilledButton),
      );
      expect(tester.widget<FilledButton>(buy).onPressed, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the current plan remains clearly marked and cannot be selected again',
    (tester) async {
      await openSalesOffer(
        tester,
        repository: SalesOfferRepository(planTier: 'creator'),
      );
      final current = find.byKey(
        const ValueKey('paywall-plan-tomeza.creator_monthly'),
      );
      expect(tester.widget<BillingProductOption>(current).isCurrent, isTrue);
      await tester.tap(current);
      await tester.pumpAndSettle();
      expect(find.text('Choose Pro'), findsOneWidget);
    },
  );
}
