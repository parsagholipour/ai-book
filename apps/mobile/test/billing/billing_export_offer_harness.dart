import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

import 'billing_paywall_harness.dart';

// Viewport assertions need the app's font metrics, rather than Flutter's wide
// Ahem test glyphs. These are the same bundled fonts used on the device.
Future<void> loadExportOfferFonts() async {
  final loader = FontLoader('Manrope');
  for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold']) {
    loader.addFont(rootBundle.load('assets/fonts/Manrope-$weight.ttf'));
  }
  await loader.load();
}

const exportPlans = [
  MobileBillingProduct(
    sku: 'tomeza.creator_monthly',
    title: 'Creator',
    description: '',
    productType: 'SUBSCRIPTION',
    creditAmount: 6000,
    priceMicros: 19990000,
    currency: 'USD',
  ),
  MobileBillingProduct(
    sku: 'tomeza.pro_monthly',
    title: 'Pro',
    description: '',
    productType: 'SUBSCRIPTION',
    creditAmount: 15000,
    priceMicros: 39990000,
    currency: 'USD',
  ),
  MobileBillingProduct(
    sku: 'tomeza.max_monthly',
    title: 'Max',
    description: '',
    productType: 'SUBSCRIPTION',
    creditAmount: 80000,
    priceMicros: 199990000,
    currency: 'USD',
  ),
];

class ExportOfferRepository extends FakeBillingRepository {
  ExportOfferRepository({super.planTier, bool empty = false}) {
    billing = MobileBilling(
      credits: billing.credits,
      entitlements: billing.entitlements,
      products: empty ? const [] : exportPlans,
      creditCosts: billing.creditCosts,
      plan: billing.plan,
    );
  }
}

class ExportOfferStore extends FakeStoreBillingClient {
  ExportOfferStore({
    this.missing = const {},
    this.available = true,
    this.localizedProducts = const {},
  });

  final Set<String> missing;
  final bool available;
  final Map<String, StoreProduct> localizedProducts;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    return StoreProductQueryResult(
      products: [
        for (final product in exportPlans)
          if (!missing.contains(product.sku))
            localizedProducts[product.sku] ??
                StoreProduct(
                  id: product.sku,
                  title: product.title,
                  description: '',
                  price:
                      '\$${(product.priceMicros / 1000000).toStringAsFixed(2)}',
                  rawPrice: product.priceMicros / 1000000,
                  currencyCode: 'USD',
                ),
      ],
      notFoundIds: missing.toList(),
    );
  }
}

Widget exportOfferLauncher({
  required ExportOfferStore store,
  required ExportOfferRepository repository,
  double textScale = 1,
  bool dark = false,
}) {
  return ProviderScope(
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
                exportFormatLabel: 'Word',
              ),
              child: const Text('Upgrade for Word'),
            ),
          ),
        ),
      ),
    ),
  );
}
