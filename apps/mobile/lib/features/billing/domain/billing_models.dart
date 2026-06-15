class MobileBilling {
  const MobileBilling({
    required this.credits,
    required this.entitlements,
    required this.products,
    required this.creditCosts,
  });

  final CreditBalance credits;
  final List<MobileEntitlement> entitlements;
  final List<MobileBillingProduct> products;
  final Map<String, dynamic> creditCosts;

  factory MobileBilling.fromJson(Map<String, dynamic> json) {
    final entitlements = json['entitlements'] as List<dynamic>;
    final products = json['products'] as List<dynamic>;
    return MobileBilling(
      credits: CreditBalance.fromJson(json['credits'] as Map<String, dynamic>),
      entitlements: entitlements
          .map(
            (item) => MobileEntitlement.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      products: products
          .map(
            (item) =>
                MobileBillingProduct.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      creditCosts: Map<String, dynamic>.from(
        json['creditCosts'] as Map<String, dynamic>,
      ),
    );
  }

  int get activeExportUnlockCount {
    return entitlements
        .where((entitlement) => entitlement.type == 'EXPORT_UNLOCK')
        .length;
  }
}

class GooglePlayVerificationResult {
  const GooglePlayVerificationResult({
    required this.purchase,
    required this.billing,
  });

  final VerifiedPurchase purchase;
  final MobileBilling billing;

  factory GooglePlayVerificationResult.fromJson(Map<String, dynamic> json) {
    return GooglePlayVerificationResult(
      purchase: VerifiedPurchase.fromJson(
        json['purchase'] as Map<String, dynamic>,
      ),
      billing: MobileBilling.fromJson(json['billing'] as Map<String, dynamic>),
    );
  }
}

class VerifiedPurchase {
  const VerifiedPurchase({
    required this.id,
    required this.status,
    required this.creditsGranted,
    this.subscriptionStatus,
    this.entitlementType,
  });

  final String id;
  final String status;
  final int creditsGranted;
  final String? subscriptionStatus;
  final String? entitlementType;

  factory VerifiedPurchase.fromJson(Map<String, dynamic> json) {
    return VerifiedPurchase(
      id: json['id'] as String,
      status: json['status'] as String,
      creditsGranted: json['creditsGranted'] as int,
      subscriptionStatus: json['subscriptionStatus'] as String?,
      entitlementType: json['entitlementType'] as String?,
    );
  }
}

class CreditBalance {
  const CreditBalance({
    required this.available,
    required this.reserved,
    required this.lifetimeGranted,
    required this.lifetimeSpent,
  });

  final int available;
  final int reserved;
  final int lifetimeGranted;
  final int lifetimeSpent;

  factory CreditBalance.fromJson(Map<String, dynamic> json) {
    return CreditBalance(
      available: json['available'] as int,
      reserved: json['reserved'] as int,
      lifetimeGranted: json['lifetimeGranted'] as int,
      lifetimeSpent: json['lifetimeSpent'] as int,
    );
  }
}

class MobileEntitlement {
  const MobileEntitlement({
    required this.id,
    required this.type,
    required this.status,
    required this.source,
    required this.creditsCost,
    required this.startsAt,
    this.projectId,
    this.expiresAt,
  });

  final String id;
  final String type;
  final String? projectId;
  final String status;
  final String source;
  final int creditsCost;
  final DateTime startsAt;
  final DateTime? expiresAt;

  factory MobileEntitlement.fromJson(Map<String, dynamic> json) {
    return MobileEntitlement(
      id: json['id'] as String,
      type: json['type'] as String,
      projectId: json['projectId'] as String?,
      status: json['status'] as String,
      source: json['source'] as String,
      creditsCost: json['creditsCost'] as int,
      startsAt: DateTime.parse(json['startsAt'] as String),
      expiresAt: json['expiresAt'] == null
          ? null
          : DateTime.parse(json['expiresAt'] as String),
    );
  }
}

class MobileBillingProduct {
  const MobileBillingProduct({
    required this.sku,
    required this.title,
    required this.description,
    required this.productType,
    required this.creditAmount,
    required this.priceMicros,
    required this.currency,
  });

  final String sku;
  final String title;
  final String description;
  final String productType;
  final int creditAmount;
  final int priceMicros;
  final String currency;

  factory MobileBillingProduct.fromJson(Map<String, dynamic> json) {
    return MobileBillingProduct(
      sku: json['sku'] as String,
      title: json['title'] as String,
      description: json['description'] as String,
      productType: json['productType'] as String,
      creditAmount: json['creditAmount'] as int,
      priceMicros: json['priceMicros'] as int,
      currency: json['currency'] as String,
    );
  }

  bool get isSubscription => productType == 'SUBSCRIPTION';

  bool get isConsumable => !isSubscription;

  String get benefitLabel {
    if (isSubscription) {
      return '$creditAmount credits each month';
    }
    return '$creditAmount credits';
  }
}

enum StorePurchaseStatus { pending, purchased, restored, error, canceled }

class StoreProduct {
  const StoreProduct({
    required this.id,
    required this.title,
    required this.description,
    required this.price,
    required this.rawPrice,
    required this.currencyCode,
    this.source,
  });

  final String id;
  final String title;
  final String description;
  final String price;
  final double rawPrice;
  final String currencyCode;
  final Object? source;
}

class StoreProductQueryResult {
  const StoreProductQueryResult({
    required this.products,
    required this.notFoundIds,
  });

  final List<StoreProduct> products;
  final List<String> notFoundIds;
}

class StorePurchaseUpdate {
  const StorePurchaseUpdate({
    required this.productId,
    required this.status,
    required this.purchaseToken,
    this.purchaseId,
    this.errorMessage,
    this.pendingCompletePurchase = false,
    this.source,
  });

  final String productId;
  final StorePurchaseStatus status;
  final String purchaseToken;
  final String? purchaseId;
  final String? errorMessage;
  final bool pendingCompletePurchase;
  final Object? source;
}
