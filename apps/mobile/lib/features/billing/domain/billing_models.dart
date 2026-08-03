/// Plan tiers, cheapest first. The names match the server's `PlanTier`.
const planTierOrder = <String>['free', 'creator', 'pro', 'max'];

class MobileBilling {
  const MobileBilling({
    required this.credits,
    required this.entitlements,
    required this.products,
    required this.creditCosts,
    this.plan,
    this.allowance,
    this.imageQuota,
  });

  final CreditBalance credits;
  final List<MobileEntitlement> entitlements;
  final List<MobileBillingProduct> products;
  final Map<String, dynamic> creditCosts;

  /// Optional so an older server — and every test fixture that predates plans —
  /// still parses. A null plan reads as free.
  final MobileSubscriptionPlan? plan;
  final MobileAllowance? allowance;

  /// Null means this plan has no image limit at all. Only meaningful on free.
  final MobileImageQuota? imageQuota;

  factory MobileBilling.fromJson(Map<String, dynamic> json) {
    final entitlements = json['entitlements'] as List<dynamic>;
    final products = json['products'] as List<dynamic>;
    final plan = json['plan'];
    final allowance = json['allowance'];
    final imageQuota = json['imageQuota'];
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
      plan: plan is Map<String, dynamic>
          ? MobileSubscriptionPlan.fromJson(plan)
          : null,
      allowance: allowance is Map<String, dynamic>
          ? MobileAllowance.fromJson(allowance)
          : null,
      imageQuota: imageQuota is Map<String, dynamic>
          ? MobileImageQuota.fromJson(imageQuota)
          : null,
    );
  }

  int get activeExportUnlockCount {
    return entitlements
        .where((entitlement) => entitlement.type == 'EXPORT_UNLOCK')
        .length;
  }

  String get planTier => plan?.tier ?? 'free';

  bool get isPaidPlan => planTier != 'free';

  /// Any paid plan — gates "bring your own book" import.
  bool get hasCreatorSubscription {
    if (isPaidPlan) {
      return true;
    }
    return entitlements.any(
      (entitlement) =>
          entitlement.type == 'CREATOR_PLAN' ||
          entitlement.type == 'PRO_PLAN' ||
          entitlement.type == 'MAX_PLAN',
    );
  }

  /// True once the month's illustrated books are used up. Paid plans, and a
  /// server that did not send a quota, are never out.
  bool get isImageQuotaExhausted => imageQuota?.isExhausted ?? false;
}

class MobileSubscriptionPlan {
  const MobileSubscriptionPlan({
    required this.tier,
    required this.source,
    this.status,
    this.renewsAt,
    this.productSku,
  });

  final String tier;
  final String source;
  final String? status;
  final DateTime? renewsAt;
  final String? productSku;

  factory MobileSubscriptionPlan.fromJson(Map<String, dynamic> json) {
    final renewsAt = json['renewsAt'];
    return MobileSubscriptionPlan(
      tier: json['tier'] as String? ?? 'free',
      source: json['source'] as String? ?? 'free',
      status: json['status'] as String?,
      renewsAt: renewsAt is String ? DateTime.tryParse(renewsAt) : null,
      productSku: json['productSku'] as String?,
    );
  }

  String get label => switch (tier) {
    'creator' => 'Creator',
    'pro' => 'Pro',
    'max' => 'Max',
    _ => 'Free',
  };
}

class MobileAllowance {
  const MobileAllowance({
    required this.monthlyCredits,
    required this.planCredits,
    this.resetsAt,
  });

  /// What the plan grants each period.
  final int monthlyCredits;

  /// What is left of it — this does not carry over.
  final int planCredits;
  final DateTime? resetsAt;

  factory MobileAllowance.fromJson(Map<String, dynamic> json) {
    final resetsAt = json['resetsAt'];
    return MobileAllowance(
      monthlyCredits: json['monthlyCredits'] as int? ?? 0,
      planCredits: json['planCredits'] as int? ?? 0,
      resetsAt: resetsAt is String ? DateTime.tryParse(resetsAt) : null,
    );
  }
}

class MobileImageQuota {
  const MobileImageQuota({
    required this.used,
    required this.limit,
    required this.resetsAt,
  });

  final int used;
  final int limit;
  final DateTime resetsAt;

  factory MobileImageQuota.fromJson(Map<String, dynamic> json) {
    return MobileImageQuota(
      used: json['used'] as int? ?? 0,
      limit: json['limit'] as int? ?? 0,
      resetsAt:
          DateTime.tryParse(json['resetsAt'] as String? ?? '') ??
          DateTime.now(),
    );
  }

  int get remaining => limit - used < 0 ? 0 : limit - used;

  bool get isExhausted => remaining <= 0;
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
    this.purchased = 0,
  });

  /// Everything spendable: the month's allowance plus anything bought.
  final int available;

  /// The part of [available] that was bought and never expires.
  final int purchased;
  final int reserved;
  final int lifetimeGranted;
  final int lifetimeSpent;

  factory CreditBalance.fromJson(Map<String, dynamic> json) {
    return CreditBalance(
      available: json['available'] as int,
      purchased: json['purchased'] as int? ?? 0,
      reserved: json['reserved'] as int,
      lifetimeGranted: json['lifetimeGranted'] as int,
      lifetimeSpent: json['lifetimeSpent'] as int,
    );
  }
}

/// What a credit log entry was, in the reader's terms. The server sends the
/// name; anything it adds later that this list has not caught up with reads as
/// [CreditLogKind.spend] or [CreditLogKind.bonus] depending on its direction.
enum CreditLogKind { purchase, subscription, monthly, bonus, spend, refund, expired }

/// One movement of credits: bought, granted, charged, or given back.
///
/// [credits] is always positive — [addsCredits] carries the sign. A [refunded]
/// entry is history rather than a movement: the credits came straight back, so
/// the balance never kept the change.
class CreditLogEntry {
  const CreditLogEntry({
    required this.id,
    required this.createdAt,
    required this.addsCredits,
    required this.credits,
    required this.kind,
    required this.title,
    this.pending = false,
    this.refunded = false,
    this.projectId,
    this.projectTitle,
  });

  final String id;
  final DateTime createdAt;
  final bool addsCredits;
  final int credits;
  final CreditLogKind kind;
  final String title;

  /// Held against work still running. The credits are gone from the balance,
  /// but the charge is not settled and may still come back.
  final bool pending;
  final bool refunded;
  final String? projectId;
  final String? projectTitle;

  factory CreditLogEntry.fromJson(Map<String, dynamic> json) {
    final addsCredits = (json['direction'] as String?) != 'out';
    return CreditLogEntry(
      id: json['id'] as String,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
      addsCredits: addsCredits,
      credits: json['credits'] as int? ?? 0,
      kind: _creditLogKind(json['kind'] as String?, addsCredits: addsCredits),
      title: json['title'] as String? ?? 'Credits',
      pending: json['pending'] as bool? ?? false,
      refunded: json['refunded'] as bool? ?? false,
      projectId: json['projectId'] as String?,
      projectTitle: json['projectTitle'] as String?,
    );
  }
}

CreditLogKind _creditLogKind(String? value, {required bool addsCredits}) {
  return switch (value) {
    'purchase' => CreditLogKind.purchase,
    'subscription' => CreditLogKind.subscription,
    'monthly' => CreditLogKind.monthly,
    'bonus' => CreditLogKind.bonus,
    'spend' => CreditLogKind.spend,
    'refund' => CreditLogKind.refund,
    'expired' => CreditLogKind.expired,
    _ => addsCredits ? CreditLogKind.bonus : CreditLogKind.spend,
  };
}

/// A page of credit history. [nextCursor] is null once the history has run out,
/// which is what stops the list asking for more.
class CreditLogPage {
  const CreditLogPage({required this.entries, this.nextCursor});

  final List<CreditLogEntry> entries;
  final String? nextCursor;

  factory CreditLogPage.fromJson(Map<String, dynamic> json) {
    final entries = json['entries'] as List<dynamic>? ?? const [];
    return CreditLogPage(
      entries: entries
          .map((item) => CreditLogEntry.fromJson(item as Map<String, dynamic>))
          .toList(),
      nextCursor: json['nextCursor'] as String?,
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
