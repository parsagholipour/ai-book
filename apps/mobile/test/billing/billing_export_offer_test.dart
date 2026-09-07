import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

import 'billing_export_offer_harness.dart';

Finder planOption(String tier) =>
    find.byKey(ValueKey('export-plan-tomeza.${tier}_monthly'));
final checkout = find.byKey(const ValueKey('export-checkout'));
final upgrade = find.descendant(
  of: find.byKey(const ValueKey('export-upgrade')),
  matching: find.byType(FilledButton),
);

Future<void> openOffer(
  WidgetTester tester, {
  ExportOfferStore? store,
  ExportOfferRepository? repository,
  Size size = const Size(390, 844),
  double textScale = 1,
  bool dark = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    exportOfferLauncher(
      store: store ?? ExportOfferStore(),
      repository: repository ?? ExportOfferRepository(),
      textScale: textScale,
      dark: dark,
    ),
  );
  await tester.tap(find.text('Upgrade for Word'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(loadExportOfferFonts);

  testWidgets(
    'accessible plan options expose price, selection, and a tap action',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await openOffer(tester);
      final creator = tester
          .getSemantics(planOption('creator'))
          .getSemanticsData();
      final pro = tester.getSemantics(planOption('pro')).getSemanticsData();
      expect(creator.label, contains(r'$19.99 per month'));
      expect(creator.flagsCollection.isSelected, Tristate.isTrue);
      expect(pro.hasAction(SemanticsAction.tap), isTrue);
      expect(pro.label, contains('Word export included'));
      semantics.dispose();
    },
  );

  testWidgets('checkout and value badges use localized store prices', (
    tester,
  ) async {
    final store = ExportOfferStore(
      localizedProducts: {
        for (final (index, plan) in exportPlans.indexed)
          plan.sku: StoreProduct(
            id: plan.sku,
            title: plan.title,
            description: '',
            price: ['€7.50', '€12.00', '€500.00'][index],
            rawPrice: [7.5, 12.0, 500.0][index],
            currencyCode: 'EUR',
          ),
      },
    );
    await openOffer(tester, store: store);
    expect(
      find.descendant(
        of: checkout,
        matching: find.text('Creator · €7.50 / month'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: planOption('pro'),
        matching: find.text('Best per credit'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: planOption('max'),
        matching: find.text('Best per credit'),
      ),
      findsNothing,
    );
    await tester.tap(planOption('pro'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: checkout,
        matching: find.text('Pro · €12.00 / month'),
      ),
      findsOneWidget,
    );
  });
  testWidgets('all three plans and checkout are visible without scrolling', (
    tester,
  ) async {
    final store = ExportOfferStore();
    await openOffer(tester, store: store, size: const Size(390, 740));

    expect(find.text('Every plan below includes Word export.'), findsOneWidget);
    final viewport = tester.getRect(find.byType(ListView));
    for (final tier in ['creator', 'pro', 'max']) {
      final rect = tester.getRect(planOption(tier));
      expect(rect.top, greaterThanOrEqualTo(viewport.top));
      expect(rect.bottom, lessThanOrEqualTo(viewport.bottom));
      expect(planOption(tier).hitTestable(), findsOneWidget);
    }
    expect(find.text('Unlock Word with Creator'), findsOneWidget);
    expect(
      find.text('Renews monthly · Cancel anytime in Google Play'),
      findsOneWidget,
    );
    expect(upgrade.hitTestable(), findsOneWidget);
    expect(store.buyCalls, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'selecting a plan updates the price and only checkout purchases it',
    (tester) async {
      final store = ExportOfferStore();
      await openOffer(tester, store: store);
      await tester.tap(planOption('pro'));
      await tester.pumpAndSettle();

      expect(find.text('Unlock Word with Pro'), findsOneWidget);
      expect(
        find.descendant(
          of: checkout,
          matching: find.text(r'Pro · $39.99 / month'),
        ),
        findsOneWidget,
      );
      expect(store.buyCalls, isEmpty);
      await tester.tap(upgrade);
      await tester.pump();
      expect(store.buyCalls.single.product.id, 'tomeza.pro_monthly');
      expect(store.buyCalls.single.consumable, isFalse);
      expect(tester.widget<FilledButton>(upgrade).onPressed, isNull);

      await tester.tap(planOption('max'));
      await tester.pump();
      expect(
        find.descendant(
          of: checkout,
          matching: find.text(r'Pro · $39.99 / month'),
        ),
        findsOneWidget,
      );
      expect(store.buyCalls, hasLength(1));

      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.pro_monthly',
          status: StorePurchaseStatus.canceled,
          purchaseToken: '',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Unlock Word with Pro'), findsOneWidget);
      expect(tester.widget<FilledButton>(upgrade).onPressed, isNotNull);
    },
  );

  testWidgets(
    'verified purchase closes the offer and shows the existing success dialog',
    (tester) async {
      final store = ExportOfferStore();
      final repository = ExportOfferRepository();
      await openOffer(tester, store: store, repository: repository);
      await tester.tap(upgrade);
      await tester.pump();
      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.creator_monthly',
          status: StorePurchaseStatus.purchased,
          purchaseToken: 'word-upgrade-token',
          purchaseId: 'word-upgrade-order',
          pendingCompletePurchase: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(BillingPaywall), findsNothing);
      expect(
        find.byKey(const ValueKey('billing-purchase-success-dialog')),
        findsOneWidget,
      );
      expect(repository.verifications.single.projectId, 'project-1');
      expect(store.finished.single.consumable, isFalse);
    },
  );

  testWidgets(
    'unavailable products cannot be bought and the next available tier is selected',
    (tester) async {
      final store = ExportOfferStore(missing: {'tomeza.creator_monthly'});
      await openOffer(tester, store: store);
      expect(find.text('Unlock Word with Pro'), findsOneWidget);
      await tester.tap(planOption('creator'));
      await tester.pumpAndSettle();
      expect(find.text('Unlock Word with Pro'), findsOneWidget);
      expect(store.buyCalls, isEmpty);
    },
  );

  testWidgets('store unavailable leaves prices visible and checkout disabled', (
    tester,
  ) async {
    await openOffer(tester, store: ExportOfferStore(available: false));
    expect(find.text('Creator'), findsOneWidget);
    expect(tester.widget<FilledButton>(upgrade).onPressed, isNull);
    expect(find.text('Plan unavailable'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'existing subscribers return to their book without another purchase',
    (tester) async {
      final store = ExportOfferStore();
      await openOffer(
        tester,
        store: store,
        repository: ExportOfferRepository(planTier: 'creator'),
      );
      expect(find.text('Your plan'), findsOneWidget);
      expect(
        find.text('Word export is included in your plan.'),
        findsOneWidget,
      );
      await tester.tap(planOption('creator'));
      await tester.pumpAndSettle();
      expect(find.text('Back to your book'), findsOneWidget);
      await tester.tap(upgrade);
      await tester.pumpAndSettle();
      expect(find.byType(BillingPaywall), findsNothing);
      expect(store.buyCalls, isEmpty);
    },
  );

  testWidgets(
    'small screens and large text keep checkout usable while details scroll',
    (tester) async {
      await openOffer(
        tester,
        size: const Size(320, 640),
        textScale: 2,
        dark: true,
      );
      expect(tester.takeException(), isNull);
      final initialCheckout = tester.getRect(checkout);
      await tester.scrollUntilVisible(
        find.text('Restore purchases'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(checkout), initialCheckout);
      expect(upgrade.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('restore and keeping Free remain available', (tester) async {
    final store = ExportOfferStore();
    await openOffer(tester, store: store);
    await tester.scrollUntilVisible(
      find.text('Restore purchases'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Restore purchases'));
    await tester.pump();
    expect(store.restoreCalls, 1);
    await tester.tap(find.text('Keep Free'));
    await tester.pumpAndSettle();
    expect(find.byType(BillingPaywall), findsNothing);
    expect(store.buyCalls, isEmpty);
  });

  testWidgets('an empty catalogue offers retry without an active checkout', (
    tester,
  ) async {
    await openOffer(tester, repository: ExportOfferRepository(empty: true));
    expect(find.text('Try again'), findsOneWidget);
    expect(tester.widget<FilledButton>(upgrade).onPressed, isNull);
    expect(tester.takeException(), isNull);
  });
}
