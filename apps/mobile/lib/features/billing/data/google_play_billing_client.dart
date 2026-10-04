import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';

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

  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  });
}

class InAppPurchaseStoreBillingClient implements StoreBillingClient {
  InAppPurchaseStoreBillingClient({InAppPurchase? inAppPurchase})
    : _inAppPurchase = inAppPurchase ?? InAppPurchase.instance;

  final InAppPurchase _inAppPurchase;

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
    return StoreProductQueryResult(
      products: response.productDetails
          .map(
            (product) => StoreProduct(
              id: product.id,
              title: product.title,
              description: product.description,
              price: product.price,
              rawPrice: product.rawPrice,
              currencyCode: product.currencyCode,
              source: product,
            ),
          )
          .toList(),
      notFoundIds: response.notFoundIDs,
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
    final opened = await _inAppPurchase.buyNonConsumable(
      purchaseParam: purchaseParam,
    );
    if (!opened) {
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
    if (!subscription.hasActivePlan ||
        previous.productID != subscription.currentProductId) {
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
    return GooglePlayPurchaseParam(
      productDetails: product,
      applicationUserName: purchaseAccountId,
      changeSubscriptionParam: ChangeSubscriptionParam(
        oldPurchaseDetails: previous,
        // A plan grants a full allowance immediately. Charge for the new
        // period; Google carries remaining paid time into its expiry date.
        replacementMode: ReplacementMode.chargeFullPrice,
      ),
    );
  }

  ApiException _checkoutError(String message) =>
      ApiException(code: 'GOOGLE_PLAY_CHECKOUT_UNAVAILABLE', message: message);

  @override
  Future<void> restorePurchases() => _inAppPurchase.restorePurchases();

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
      await androidAddition.consumePurchase(details);
    }
    if (purchase.pendingCompletePurchase) {
      await _inAppPurchase.completePurchase(details);
    }
  }

  StorePurchaseUpdate _mapPurchase(PurchaseDetails details) {
    return StorePurchaseUpdate(
      productId: details.productID,
      purchaseId: details.purchaseID,
      purchaseAccountId: details is GooglePlayPurchaseDetails
          ? details.billingClientPurchase.obfuscatedAccountId
          : null,
      purchaseToken: details.verificationData.serverVerificationData,
      status: _mapStatus(details.status),
      errorMessage: details.error?.message,
      pendingCompletePurchase: details.pendingCompletePurchase,
      source: details,
    );
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
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  }) async {}

  void dispose() {
    unawaited(_purchaseUpdates.close());
  }
}

final storeBillingClientProvider = Provider<StoreBillingClient>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.environment == AppEnvironment.local) {
    final client = DebugStoreBillingClient();
    ref.onDispose(client.dispose);
    return client;
  }
  return InAppPurchaseStoreBillingClient();
});
