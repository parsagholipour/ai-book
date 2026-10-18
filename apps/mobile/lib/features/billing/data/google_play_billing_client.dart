import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../domain/billing_models.dart';

/// Server plan identity and the catalog of mutually exclusive plans. Play's
/// owned purchases supply the actual token, including after an app restart.
class StoreSubscriptionCheckout {
  const StoreSubscriptionCheckout({
    required this.productIds,
    required this.hasActivePlan,
    this.currentProductId,
    this.currentPurchaseTokenHash,
  });

  final Set<String> productIds;
  final bool hasActivePlan;
  final String? currentProductId;
  final String? currentPurchaseTokenHash;
}

abstract interface class StoreBillingClient {
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates;

  Future<bool> isAvailable();

  Future<StoreProductQueryResult> queryProducts(Set<String> productIds);

  Future<void> buyProduct(
    StoreProduct product, {
    required bool consumable,
    required String purchaseAccountId,
    StoreSubscriptionCheckout? subscription,
  });

  Future<void> restorePurchases();

  /// Every purchase Play still holds for this device's Google account: each
  /// subscription it has, and each one-time product not yet consumed, pending
  /// payments included. Unlike [restorePurchases] the answer comes back here
  /// rather than through [purchaseUpdates]. A settled purchase is reported as
  /// [StorePurchaseStatus.restored], a pending one as pending.
  Future<List<StorePurchaseUpdate>> queryOwnedPurchases();

  /// Acknowledges [purchase], and consumes it when [consumable]. Throws when
  /// Play refused, so the purchase is left for the next reconciliation.
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  });
}

/// A price as Play quotes it: integer micros of an ISO 4217 currency.
typedef StorePrice = ({int micros, String currency});

/// A downgrade this client launched with `ReplacementMode.deferred`, until
/// Play's answer to it has been seen.
typedef _DeferredSwitch = ({String from, String to, String oldToken});

class InAppPurchaseStoreBillingClient implements StoreBillingClient {
  InAppPurchaseStoreBillingClient({InAppPurchase? inAppPurchase})
    : _inAppPurchase = inAppPurchase ?? InAppPurchase.instance;

  final InAppPurchase _inAppPurchase;

  /// What the checkout this process launched for each product charges: the
  /// pricing phase bought, an intro offer's when it went through one.
  final _checkoutPrices = <String, StorePrice>{};

  /// One-time products' prices from every catalog query, for a pack found
  /// unfinished after the process that bought it is gone.
  final _oneTimePrices = <String, StorePrice>{};

  /// Products Play has said are subscriptions, so they are not looked up again.
  final _subscriptionIds = <String>{};

  _DeferredSwitch? _deferredSwitch;

  @override
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates {
    return _inAppPurchase.purchaseStream.map(
      (items) => items.map(_mapPurchase).toList(),
    );
  }

  @override
  Future<bool> isAvailable() => _inAppPurchase.isAvailable();

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    final response = await _inAppPurchase.queryProductDetails(productIds);
    // Android lists a subscription once per base plan and offer, each priced
    // at its own first phase. Keyed by id, the last one won: a plan with an
    // intro offer could be shown at the intro price as if it renewed there.
    final byId = <String, List<ProductDetails>>{};
    for (final details in response.productDetails) {
      byId.putIfAbsent(details.id, () => []).add(details);
    }
    _rememberPrices(response.productDetails);
    return StoreProductQueryResult(
      products: byId.values.map(storeProductFromDetails).toList(),
      notFoundIds: response.notFoundIDs,
      error: response.error?.message,
    );
  }

  @override
  Future<void> buyProduct(
    StoreProduct product, {
    required bool consumable,
    required String purchaseAccountId,
    StoreSubscriptionCheckout? subscription,
  }) async {
    final details = product.source;
    if (details is! ProductDetails) {
      throw StateError('Store product details are unavailable.');
    }
    // Only the checkout being opened can be the one Play answers next.
    _deferredSwitch = null;
    final price = storePriceOf(details);
    if (price != null) _checkoutPrices[product.id] = price;
    final purchaseParam =
        !consumable &&
            subscription != null &&
            defaultTargetPlatform == TargetPlatform.android
        ? await _subscriptionPurchaseParam(
            details,
            subscription,
            purchaseAccountId,
          )
        : PurchaseParam(
            productDetails: details,
            applicationUserName: purchaseAccountId,
          );
    if (consumable) {
      final opened = await _inAppPurchase.buyConsumable(
        purchaseParam: purchaseParam,
        autoConsume: false,
      );
      if (!opened) {
        throw _checkoutError('Google Play checkout could not open. Try again.');
      }
      return;
    }
    final bool opened;
    try {
      opened = await _inAppPurchase.buyNonConsumable(
        purchaseParam: purchaseParam,
      );
    } on Object {
      _deferredSwitch = null;
      rethrow;
    }
    if (!opened) {
      _deferredSwitch = null;
      throw _checkoutError('Google Play checkout could not open. Try again.');
    }
  }

  Future<PurchaseParam> _subscriptionPurchaseParam(
    ProductDetails product,
    StoreSubscriptionCheckout subscription,
    String purchaseAccountId,
  ) async {
    final response = await _inAppPurchase
        .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>()
        .queryPastPurchases();
    if (response.error != null) {
      throw _checkoutError(
        'Your current Google Play plan could not be checked. Try again.',
      );
    }
    final plans = response.pastPurchases
        .where(
          (purchase) =>
              subscription.productIds.contains(purchase.productID) ||
              purchase.productID == subscription.currentProductId,
        )
        .toList();
    if (plans.any(
      (purchase) =>
          purchase.status == PurchaseStatus.pending ||
          purchase.billingClientPurchase.pendingPurchaseUpdate != null,
    )) {
      throw _checkoutError(
        'A Google Play plan purchase is still pending. Complete it before switching plans.',
      );
    }
    final owned = {
      for (final purchase in plans)
        if (purchase.status == PurchaseStatus.purchased ||
            purchase.status == PurchaseStatus.restored)
          purchase.verificationData.serverVerificationData: purchase,
    };
    if (owned.length > 1) {
      throw _checkoutError(
        'More than one plan is active in Google Play. Manage those subscriptions before switching.',
      );
    }
    if (owned.isEmpty) {
      if (subscription.hasActivePlan) {
        throw _checkoutError(
          'Your current plan was not found in this Google Play account. Use the account that bought it, then restore purchases.',
        );
      }
      return GooglePlayPurchaseParam(
        productDetails: product,
        applicationUserName: purchaseAccountId,
      );
    }
    final previous = owned.values.single;
    // Play holds a plan this account has no record of: most often one just
    // bought whose verification did not get through. Nothing is being
    // switched, so the reader is only told where to find it.
    if (!subscription.hasActivePlan) {
      throw _checkoutError(
        'This Google account already has a Tomeza plan that isn’t on your account yet. Tap Restore purchases to add it.',
      );
    }
    if (previous.productID != subscription.currentProductId) {
      throw _checkoutError(
        'Restore purchases to sync your current Google Play plan before switching.',
      );
    }
    if (subscription.currentPurchaseTokenHash == null ||
        sha256
                .convert(
                  utf8.encode(previous.verificationData.serverVerificationData),
                )
                .toString() !=
            subscription.currentPurchaseTokenHash) {
      throw _checkoutError(
        'This Google Play purchase does not match your current plan. Use the Google account that bought it, then restore purchases.',
      );
    }
    if (previous.productID == product.id) {
      throw _checkoutError(
        'You already own this plan. Manage it in Google Play.',
      );
    }
    // An upgrade is charged in full now and granted in full now; Google adds
    // the old plan's remaining time to its expiry. A downgrade waits for the
    // renewal date instead: charged in full, it forfeited what was left of the
    // bigger allowance the reader had already paid for, so Max to Creator on
    // day 3 threw away most of a month of Max. Deferred, the old plan runs out
    // and the new one starts — and is charged — when it would have renewed.
    final downgrade = isPlanDowngrade(previous.productID, product.id);
    if (downgrade) {
      _deferredSwitch = (
        from: previous.productID,
        to: product.id,
        oldToken: previous.verificationData.serverVerificationData,
      );
    }
    return GooglePlayPurchaseParam(
      productDetails: product,
      applicationUserName: purchaseAccountId,
      changeSubscriptionParam: ChangeSubscriptionParam(
        oldPurchaseDetails: previous,
        replacementMode: downgrade
            ? ReplacementMode.deferred
            : ReplacementMode.chargeFullPrice,
      ),
    );
  }

  ApiException _checkoutError(String message) =>
      ApiException(code: 'GOOGLE_PLAY_CHECKOUT_UNAVAILABLE', message: message);

  @override
  Future<void> restorePurchases() => _inAppPurchase.restorePurchases();

  @override
  Future<List<StorePurchaseUpdate>> queryOwnedPurchases() async {
    if (defaultTargetPlatform != TargetPlatform.android) {
      return const [];
    }
    final response = await _inAppPurchase
        .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>()
        .queryPastPurchases();
    // Half an answer would read as a pending payment that went away.
    if (response.error != null) {
      throw _checkoutError(
        'Your Google Play purchases could not be checked. Try again.',
      );
    }
    await _learnPrices({
      for (final purchase in response.pastPurchases)
        if (!_oneTimePrices.containsKey(purchase.productID) &&
            !_subscriptionIds.contains(purchase.productID))
          purchase.productID,
    });
    return [
      for (final purchase in response.pastPurchases)
        _mapPurchase(purchase, owned: true),
    ];
  }

  @override
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  }) async {
    final details = purchase.source;
    if (details is! PurchaseDetails) {
      return;
    }
    if (consumable && defaultTargetPlatform == TargetPlatform.android) {
      final androidAddition = _inAppPurchase
          .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>();
      final consumed = await androidAddition.consumePurchase(details);
      // An unconsumed pack makes Play refuse the next purchase of it as
      // already owned; the caller leaves it for reconciliation to retry.
      if (consumed.responseCode != BillingResponse.ok) {
        throw _checkoutError('Google Play could not finish this purchase.');
      }
    }
    if (purchase.pendingCompletePurchase) {
      await _inAppPurchase.completePurchase(details);
    }
  }

  StorePurchaseUpdate _mapPurchase(
    PurchaseDetails details, {
    bool owned = false,
  }) {
    final play = details is GooglePlayPurchaseDetails
        ? details.billingClientPurchase
        : null;
    final response = _billingResponse(details.error);
    final token = details.verificationData.serverVerificationData;
    final deferred = _deferredSwitch;
    var productId = details.productID;
    // Play answers a downgrade it deferred by saying it went through and
    // returning no purchase (the plugin's productless placeholder). The token
    // it issued carries the old plan until the switch, and may be delivered
    // under that plan's id; either way it is the checkout's answer.
    final planChangeDeferred =
        deferred != null &&
        productId.isEmpty &&
        token.isEmpty &&
        details.status == PurchaseStatus.purchased;
    if (deferred != null &&
        (planChangeDeferred ||
            (productId == deferred.from &&
                token.isNotEmpty &&
                token != deferred.oldToken))) {
      productId = deferred.to;
      _deferredSwitch = null;
    }
    final price = _paidPrice(productId, play);
    return StorePurchaseUpdate(
      productId: productId,
      planChangeDeferred: planChangeDeferred,
      localPriceMicros: price?.micros,
      localCurrency: price?.currency,
      purchaseId: details.purchaseID,
      purchaseAccountId: play?.obfuscatedAccountId,
      purchaseToken: token,
      // `restorePurchases` marks every purchase restored, a payment still
      // pending included; Play's own purchase state says which it is.
      status: play?.purchaseState == PurchaseStateWrapper.pending
          ? StorePurchaseStatus.pending
          : owned && details.status == PurchaseStatus.purchased
          ? StorePurchaseStatus.restored
          : _mapStatus(details.status),
      errorMessage: details.error == null ? null : _failureMessage(response),
      alreadyOwned: response == BillingResponse.itemAlreadyOwned,
      pendingCompletePurchase: details.pendingCompletePurchase,
      source: details,
    );
  }

  /// Play's answer to a checkout it could not complete. The plugin spells the
  /// response code into the error's message (`BillingResponse.itemAlreadyOwned`),
  /// which is no sentence to show anyone.
  static BillingResponse? _billingResponse(IAPError? error) {
    final message = error?.message;
    return BillingResponse.values
        .where((code) => code.toString() == message)
        .firstOrNull;
  }

  /// Null leaves the surface its generic "could not complete" line.
  static String? _failureMessage(BillingResponse? response) {
    return switch (response) {
      BillingResponse.itemAlreadyOwned => 'You already own this.',
      BillingResponse.billingUnavailable =>
        'Google Play Billing is not available for this Google account or device.',
      BillingResponse.itemUnavailable =>
        'This item is not available from Google Play right now.',
      BillingResponse.serviceUnavailable ||
      BillingResponse.serviceDisconnected ||
      BillingResponse.serviceTimeout ||
      BillingResponse.networkError =>
        'Google Play could not be reached. Check your connection and try again.',
      _ => null,
    };
  }

  /// What [productId] charged the buyer, when this process knows: the phase
  /// its own checkout bought, or a pack's price times the quantity Play
  /// reports. A subscription bought before this process started is unknown —
  /// which phase it is in is Play's to say, not the catalog's.
  StorePrice? _paidPrice(String productId, PurchaseWrapper? play) {
    final bought = _checkoutPrices[productId];
    if (bought != null) {
      if (_subscriptionIds.contains(productId)) return bought;
      return (
        micros: bought.micros * _quantity(play),
        currency: bought.currency,
      );
    }
    final pack = _oneTimePrices[productId];
    if (pack == null) return null;
    return (micros: pack.micros * _quantity(play), currency: pack.currency);
  }

  /// Play's own quantity for a multi-quantity pack; the plugin does not expose
  /// it, but the purchase's original JSON carries it.
  static int _quantity(PurchaseWrapper? play) {
    final json = play?.originalJson;
    if (json == null || json.isEmpty) return 1;
    try {
      final quantity = (jsonDecode(json) as Map<String, dynamic>)['quantity'];
      return quantity is int && quantity > 0 ? quantity : 1;
    } on Object {
      return 1;
    }
  }

  void _rememberPrices(Iterable<ProductDetails> entries) {
    for (final entry in entries) {
      if (entry is! GooglePlayProductDetails) continue;
      if (entry.productDetails.productType == ProductType.subs) {
        _subscriptionIds.add(entry.id);
        continue;
      }
      final price = storePriceOf(entry);
      if (price != null) _oneTimePrices[entry.id] = price;
    }
  }

  /// Looks up prices for products this process has not seen in a catalog yet.
  /// Best effort: an unanswered lookup only leaves the price unknown.
  Future<void> _learnPrices(Set<String> productIds) async {
    productIds.removeWhere((id) => id.isEmpty);
    if (productIds.isEmpty) return;
    try {
      final response = await _inAppPurchase
          .queryProductDetails(productIds)
          .timeout(const Duration(seconds: 10));
      _rememberPrices(response.productDetails);
    } on Object catch (error) {
      debugPrint('Google Play prices could not be read: $error');
    }
  }

  StorePurchaseStatus _mapStatus(PurchaseStatus status) {
    return switch (status) {
      PurchaseStatus.pending => StorePurchaseStatus.pending,
      PurchaseStatus.purchased => StorePurchaseStatus.purchased,
      PurchaseStatus.restored => StorePurchaseStatus.restored,
      PurchaseStatus.error => StorePurchaseStatus.error,
      PurchaseStatus.canceled => StorePurchaseStatus.canceled,
    };
  }
}

class DebugStoreProduct {
  const DebugStoreProduct();
}

class DebugStoreBillingClient implements StoreBillingClient {
  final _purchaseUpdates =
      StreamController<List<StorePurchaseUpdate>>.broadcast();
  var _purchaseCounter = 0;

  @override
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates =>
      _purchaseUpdates.stream;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    return StoreProductQueryResult(
      products: [
        for (final id in productIds)
          StoreProduct(
            id: id,
            title: id,
            description: id,
            price: 'Debug',
            rawPrice: 0,
            currencyCode: 'DBG',
            source: const DebugStoreProduct(),
          ),
      ],
      notFoundIds: const [],
    );
  }

  @override
  Future<void> buyProduct(
    StoreProduct product, {
    required bool consumable,
    required String purchaseAccountId,
    StoreSubscriptionCheckout? subscription,
  }) async {
    _purchaseCounter += 1;
    final timestamp = DateTime.now().microsecondsSinceEpoch;
    final purchaseId = 'debug-${product.id}-$timestamp-$_purchaseCounter';
    _purchaseUpdates.add([
      StorePurchaseUpdate(
        productId: product.id,
        status: StorePurchaseStatus.purchased,
        purchaseId: purchaseId,
        purchaseAccountId: purchaseAccountId,
        purchaseToken: purchaseId,
        pendingCompletePurchase: true,
        source: const DebugStoreProduct(),
      ),
    ]);
  }

  @override
  Future<void> restorePurchases() async {}

  @override
  Future<List<StorePurchaseUpdate>> queryOwnedPurchases() async => const [];

  @override
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  }) async {}

  void dispose() {
    unawaited(_purchaseUpdates.close());
  }
}

final storeBillingClientProvider = Provider<StoreBillingClient>((ref) {
  if (kIsWeb) return const BrowserStoreBillingClient();
  final config = ref.watch(appConfigProvider);
  if (config.environment == AppEnvironment.local) {
    final client = DebugStoreBillingClient();
    ref.onDispose(client.dispose);
    return client;
  }
  return InAppPurchaseStoreBillingClient();
});

/// What buying [details] charges first: a pack's price, or the first pricing
/// phase of the subscription base plan or offer it names. Null for anything
/// that is not a Play listing.
@visibleForTesting
StorePrice? storePriceOf(ProductDetails details) {
  if (details is! GooglePlayProductDetails) return null;
  final offer = _offerDetails(details);
  if (offer != null) {
    final phase = offer.pricingPhases.isEmpty
        ? null
        : offer.pricingPhases.first;
    return phase == null
        ? null
        : (micros: phase.priceAmountMicros, currency: phase.priceCurrencyCode);
  }
  final oneTime = details.productDetails.oneTimePurchaseOfferDetails;
  return oneTime == null
      ? null
      : (
          micros: oneTime.priceAmountMicros,
          currency: oneTime.priceCurrencyCode,
        );
}

/// Each plan's tier and length, for telling a downgrade from an upgrade.
/// Mirrors `PLAN_TIER_BY_SKU` and the catalog's billing periods on the server.
const _planSwitchRank = <String, ({int tier, int months})>{
  'tomeza.creator_monthly': (tier: 1, months: 1),
  'tomeza.creator_yearly': (tier: 1, months: 12),
  'tomeza.pro_monthly': (tier: 2, months: 1),
  'tomeza.max_monthly': (tier: 3, months: 1),
};

/// Whether moving from [fromSku] to [toSku] is a downgrade: a lower tier, or
/// the same tier for a shorter term (a year of Creator to a month of it).
/// Downgrades are deferred to the renewal date, which the checkout says.
/// Unknown plans are not downgrades.
bool isPlanDowngrade(String fromSku, String toSku) {
  final from = _planSwitchRank[fromSku];
  final to = _planSwitchRank[toSku];
  if (from == null || to == null) return false;
  if (to.tier != from.tier) return to.tier < from.tier;
  return to.months < from.months;
}

/// One product from every entry Play listed for its id: the base plan's price,
/// and each discounted offer apart. Exposed for tests.
@visibleForTesting
StoreProduct storeProductFromDetails(List<ProductDetails> entries) {
  ProductDetails base = entries.first;
  final offers = <StoreIntroOffer>[];
  for (final entry in entries) {
    final offer = entry is GooglePlayProductDetails
        ? _offerDetails(entry)
        : null;
    if (offer == null || offer.offerId == null) {
      base = entry;
      continue;
    }
    final phase = offer.pricingPhases.isEmpty
        ? null
        : offer.pricingPhases.first;
    // A free first phase is a trial, which this app does not sell.
    if (phase == null || phase.priceAmountMicros <= 0) continue;
    offers.add(
      StoreIntroOffer(
        offerId: offer.offerId!,
        price: phase.formattedPrice,
        billingPeriod: phase.billingPeriod,
        cycles: phase.billingCycleCount,
        source: entry,
      ),
    );
  }
  return StoreProduct(
    id: base.id,
    title: base.title,
    description: base.description,
    price: base.price,
    rawPrice: base.rawPrice,
    currencyCode: base.currencyCode,
    offers: offers,
    source: base,
  );
}

SubscriptionOfferDetailsWrapper? _offerDetails(GooglePlayProductDetails entry) {
  final index = entry.subscriptionIndex;
  final offers = entry.productDetails.subscriptionOfferDetails;
  if (index == null || offers == null || index >= offers.length) return null;
  return offers[index];
}

/// Google Play has no browser checkout. Existing account credits still work.
class BrowserStoreBillingClient implements StoreBillingClient {
  const BrowserStoreBillingClient();
  @override
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates => const Stream.empty();
  @override
  Future<bool> isAvailable() async => false;
  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async =>
      StoreProductQueryResult(products: const [], notFoundIds: productIds.toList(),
          error: 'Purchases are available in the Tomeza Android app.');
  @override
  Future<void> buyProduct(StoreProduct product, {required bool consumable,
      required String purchaseAccountId, StoreSubscriptionCheckout? subscription}) async {
    throw UnsupportedError('Purchases are available in the Tomeza Android app.');
  }
  @override
  Future<void> restorePurchases() async {}
  @override
  Future<List<StorePurchaseUpdate>> queryOwnedPurchases() async => const [];
  @override
  Future<void> finishPurchase(StorePurchaseUpdate purchase, {required bool consumable}) async {}
}
