import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../domain/billing_models.dart';

abstract interface class StoreBillingClient {
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates;

  Future<bool> isAvailable();

  Future<StoreProductQueryResult> queryProducts(Set<String> productIds);

  Future<void> buyProduct(StoreProduct product, {required bool consumable});

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
  }) async {
    final details = product.source;
    if (details is! ProductDetails) {
      throw StateError('Store product details are unavailable.');
    }
    final purchaseParam = PurchaseParam(productDetails: details);
    if (consumable) {
      await _inAppPurchase.buyConsumable(
        purchaseParam: purchaseParam,
        autoConsume: false,
      );
      return;
    }
    await _inAppPurchase.buyNonConsumable(purchaseParam: purchaseParam);
  }

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

final storeBillingClientProvider = Provider<StoreBillingClient>((ref) {
  return InAppPurchaseStoreBillingClient();
});
