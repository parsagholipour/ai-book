import 'message_allowance.dart';

export 'credit_log_models.dart';

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
    this.messageAllowance,
    this.freeTier = const MobileFreeTier(),
    this.maxBookPages,
    this.paidMaxBookPages = maxPlanBookPages,
    this.ultraTierEnabled = true,
    this.purchaseAccountId,
    this.welcomeCreditsPending = false,
    this.welcomeCreditsPendingReason,
    this.welcomeCreditsPendingCredits,
  });

  final CreditBalance credits;
  final List<MobileEntitlement> entitlements;
  final List<MobileBillingProduct> products;
  final Map<String, dynamic> creditCosts;

  /// Server-issued, stable Play checkout identity. Older servers omit it.
  final String? purchaseAccountId;

  /// Optional so an older server — and every test fixture that predates plans —
  /// still parses. A null plan reads as free.
  final MobileSubscriptionPlan? plan;
  final MobileAllowance? allowance;

  /// What the free tier offers: a monthly credit allowance, an optional
  /// one-time welcome grant, and the illustrated-book quota. This describes
  /// the offer itself — the same for every reader — rather than a remainder
  /// or whether this account has already received the welcome.
  final MobileFreeTier freeTier;

  /// Null means this plan has no image limit at all. Only meaningful on free.
  final MobileImageQuota? imageQuota;
  final MessageAllowance? messageAllowance;

  /// The longest book this reader may have written. Null means no free-tier
  /// cap — any paid plan, held only to the 600-page ceiling — and is also what
  /// a server that predates the cap sends, so nothing is locked against it.
  final int? maxBookPages;

  /// The longest book *any* account may have generated right now — the
  /// operator's `paidMaxBookPages`. Lengths past it are not offered at all:
  /// no plan unlocks them, so they get neither a lock nor the long-book offer.
  /// A server that predates the key sends nothing, which reads as the
  /// 600-page request ceiling it always enforced.
  final int paidMaxBookPages;

  /// Whether the Ultra effort may start a new book. A server that predates
  /// the operator switch sends nothing and always offered it, so absent reads
  /// as on. Books already written at Ultra keep their tier either way.
  final bool ultraTierEnabled;

  /// True while this account's one-time welcome grant is owed but not yet
  /// paid: the server holds a free account's grant while Tomeza is very busy
  /// and pays it on a later balance read. An older server never sends it.
  final bool welcomeCreditsPending;

  /// Why the grant waits: `email_unverified` (the reader confirms the emailed
  /// code) or `spend_hold` (nothing to do). Null when nothing is pending, and
  /// from a server that predates email verification.
  final String? welcomeCreditsPendingReason;

  /// What the pending grant would pay, read from the server's price list —
  /// the number "Verify your email to get your … free credits" names.
  final int? welcomeCreditsPendingCredits;

  /// The welcome credits are waiting for this reader to verify their email.
  bool get welcomeCreditsAwaitEmailVerification =>
      welcomeCreditsPending &&
      welcomeCreditsPendingReason == 'email_unverified';

  factory MobileBilling.fromJson(Map<String, dynamic> json) {
    final entitlements = json['entitlements'] as List<dynamic>;
    final products = json['products'] as List<dynamic>;
    final plan = json['plan'];
    final allowance = json['allowance'];
    final imageQuota = json['imageQuota'];
    final messageAllowance = json['messageAllowance'];
    final freeTier = json['freeTier'];
    return MobileBilling(
      purchaseAccountId: json['purchaseAccountId'] as String?,
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
      messageAllowance: messageAllowance is Map<String, dynamic>
          ? MessageAllowance.fromJson(messageAllowance)
          : null,
      imageQuota: imageQuota is Map<String, dynamic>
          ? MobileImageQuota.fromJson(imageQuota)
          : null,
      freeTier: freeTier is Map<String, dynamic>
          ? MobileFreeTier.fromJson(freeTier)
          : const MobileFreeTier(),
      maxBookPages: (json['maxBookPages'] as num?)?.toInt(),
      paidMaxBookPages: _paidMaxBookPagesFrom(json),
      ultraTierEnabled: _ultraTierEnabledFrom(json),
      welcomeCreditsPending: json['welcomeCreditsPending'] == true,
      welcomeCreditsPendingReason:
          json['welcomeCreditsPendingReason'] as String?,
      welcomeCreditsPendingCredits:
          (json['welcomeCreditsPendingCredits'] as num?)?.toInt(),
    );
  }

  /// The top-level field, then the price-table copy, then the old ceiling.
  static int _paidMaxBookPagesFrom(Map<String, dynamic> json) {
    final costs = json['creditCosts'];
    final raw =
        json['paidMaxBookPages'] ??
        (costs is Map ? costs['paidMaxBookPages'] : null);
    if (raw is! num || raw < 1) return maxPlanBookPages;
    return raw.toInt().clamp(1, maxPlanBookPages);
  }

  /// The top-level flag, then the price table's 0/1, then on.
  static bool _ultraTierEnabledFrom(Map<String, dynamic> json) {
    final flag = json['ultraTierEnabled'];
    if (flag is bool) return flag;
    final costs = json['creditCosts'];
    final raw = costs is Map ? costs['ultraTierEnabled'] : null;
    return raw is num ? raw != 0 : true;
  }

  /// Whether a book of [pages] is past the longest book any plan writes —
  /// the length every page picker stops at rather than locks.
  bool exceedsBookPagesCeiling(int pages) => pages > paidMaxBookPages;

  /// Whether a book of [pages] is past this reader's length cap — the one
  /// question every page picker asks before it draws a lock.
  bool locksBookPages(int pages) {
    final limit = maxBookPages;
    return limit != null && pages > limit;
  }

  String get planTier => plan?.tier ?? 'free';

  bool get isPaidPlan => planTier != 'free';

  /// Balanced planning charge from the live table, when the server sent one.
  int? get planGenerationCredits {
    final raw = creditCosts['planGeneration'];
    return raw is num ? raw.toInt() : null;
  }

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

/// The free tier's one-time welcome grant and usage ceilings.
/// [monthlyCredits] remains in the wire format for older servers; free accounts
/// have no recurring credit grant.
class MobileFreeTier {
  const MobileFreeTier({
    this.monthlyCredits = 0,
    this.welcomeCredits = 0,
    this.illustratedBooksPerMonth = 3,
    this.maxBookPages = 30,
  });

  final int monthlyCredits;
  final int welcomeCredits;
  final int illustratedBooksPerMonth;

  /// The longest book the free tier writes. Plans go to [maxPlanBookPages].
  final int maxBookPages;

  factory MobileFreeTier.fromJson(Map<String, dynamic> json) {
    return MobileFreeTier(
      monthlyCredits: json['monthlyCredits'] as int? ?? 0,
      welcomeCredits: json['welcomeCredits'] as int? ?? 0,
      illustratedBooksPerMonth: json['illustratedBooksPerMonth'] as int? ?? 3,
      maxBookPages: json['maxBookPages'] as int? ?? 30,
    );
  }
}

/// The longest book any plan writes — the server's 600-page request ceiling.
const maxPlanBookPages = 600;

/// A book the free tier will not write: how long it is allowed to be, and how
/// long the reader asked for. Read from a `PAGE_LIMIT_EXCEEDED` body or from a
/// chat reply's `pageLimit` metadata, which carry the same three numbers.
class BookPageLimit {
  const BookPageLimit({
    required this.limit,
    required this.requestedPages,
    this.maxPages = maxPlanBookPages,
  });

  final int limit;
  final int requestedPages;
  final int maxPages;

  /// Null unless [json] is a well-formed `pageLimit` object.
  static BookPageLimit? fromJson(Object? json) {
    if (json is! Map) return null;
    final limit = json['limit'];
    final requested = json['requestedPages'];
    final max = json['maxPages'];
    if (limit is! num || requested is! num) return null;
    return BookPageLimit(
      limit: limit.toInt(),
      requestedPages: requested.toInt(),
      maxPages: max is num ? max.toInt() : maxPlanBookPages,
    );
  }
}

class MobileSubscriptionPlan {
  const MobileSubscriptionPlan({
    required this.tier,
    required this.source,
    this.status,
    this.renewsAt,
    this.cancelAtPeriodEnd = false,
    this.endsAt,
    this.canCancelInApp = false,
    this.productSku,
    this.purchaseTokenHash,
    this.pendingChangeSku,
    this.pendingChangeAt,
  });

  final String tier;
  final String source;
  final String? status;

  /// Null once the plan has been cancelled — read [endsAt] instead.
  final DateTime? renewsAt;

  /// The plan is running out its last paid period and then drops to free.
  final bool cancelAtPeriodEnd;

  /// When that drop happens. Null while the plan is still renewing.
  final DateTime? endsAt;

  /// Whether this backend can end the subscription itself. It cannot against
  /// real Google Play, where cancelling happens in the Play subscription centre.
  final bool canCancelInApp;
  final String? productSku;
  final String? purchaseTokenHash;

  /// A downgrade Play deferred to the end of the paid period: the plan the
  /// reader moves to, and when. Until then [productSku] is the plan being run
  /// out. Null when nothing is scheduled, and from a server that predates it.
  final String? pendingChangeSku;
  final DateTime? pendingChangeAt;

  factory MobileSubscriptionPlan.fromJson(Map<String, dynamic> json) {
    final renewsAt = json['renewsAt'];
    final endsAt = json['endsAt'];
    final pendingChange = json['pendingChange'];
    final pendingChangeAt = pendingChange is Map<String, dynamic>
        ? pendingChange['startsAt']
        : null;
    return MobileSubscriptionPlan(
      tier: json['tier'] as String? ?? 'free',
      source: json['source'] as String? ?? 'free',
      status: json['status'] as String?,
      renewsAt: renewsAt is String ? DateTime.tryParse(renewsAt) : null,
      cancelAtPeriodEnd: json['cancelAtPeriodEnd'] as bool? ?? false,
      endsAt: endsAt is String ? DateTime.tryParse(endsAt) : null,
      canCancelInApp: json['canCancelInApp'] as bool? ?? false,
      productSku: json['productSku'] as String?,
      purchaseTokenHash: json['purchaseTokenHash'] as String?,
      pendingChangeSku: pendingChange is Map<String, dynamic>
          ? pendingChange['productSku'] as String?
          : null,
      pendingChangeAt: pendingChangeAt is String
          ? DateTime.tryParse(pendingChangeAt)
          : null,
    );
  }

  /// The day the plan next changes hands, whichever direction it is going.
  DateTime? get periodEndsAt => endsAt ?? renewsAt;

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

  /// When the next month's credits arrive. The only date any surface may
  /// give for a refill: Creator yearly refills every month, while its plan
  /// (`MobileSubscriptionPlan.renewsAt`) renews once a year.
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
    this.scheduledChangeSku,
    this.scheduledChangeAt,
  });

  final String id;
  final String status;
  final int creditsGranted;
  final String? subscriptionStatus;
  final String? entitlementType;

  /// A downgrade Play deferred to the renewal date: the plan the reader moves
  /// to, and when. Nothing was granted for it. Null for every other purchase,
  /// and from a server that predates it.
  final String? scheduledChangeSku;
  final DateTime? scheduledChangeAt;

  factory VerifiedPurchase.fromJson(Map<String, dynamic> json) {
    final scheduled = json['scheduledChange'];
    final startsAt = scheduled is Map<String, dynamic>
        ? scheduled['startsAt']
        : null;
    return VerifiedPurchase(
      id: json['id'] as String,
      status: json['status'] as String,
      creditsGranted: json['creditsGranted'] as int,
      subscriptionStatus: json['subscriptionStatus'] as String?,
      entitlementType: json['entitlementType'] as String?,
      scheduledChangeSku: scheduled is Map<String, dynamic>
          ? scheduled['productSku'] as String?
          : null,
      scheduledChangeAt: startsAt is String
          ? DateTime.tryParse(startsAt)
          : null,
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
    this.billingPeriod,
    this.offered = true,
    this.introOfferId,
    this.introOfferCredits,
    this.monthlyCreditAmount,
  });

  final String sku;
  final String title;
  final String description;
  final String productType;
  final int creditAmount;
  final int priceMicros;
  final String currency;

  /// Whether the paywall lists this product for this reader. Every product is
  /// still queried from Play and verified, so a restore finds an unlisted one.
  /// A server that predates the field offered everything.
  final bool offered;

  /// ISO 8601 renewal period of a subscription ("P1M", "P1Y"); null for a
  /// one-time product, and for a server that predates the field (monthly).
  final String? billingPeriod;

  /// The Play offer this plan is bought through when Play lists it for the
  /// device's account (Play decides eligibility); null for none.
  final String? introOfferId;

  /// Credits the intro offer's discounted period grants — fewer than
  /// [creditAmount], which the renewals after it grant. Null when there is no
  /// intro offer, and from a server that predates the field.
  final int? introOfferCredits;

  /// What the plan grants at the start of each month of its paid time: 6,000
  /// for Creator yearly, a monthly plan's own [creditAmount], null for a pack.
  /// The one source of the monthly figure; see [creditsPerGrant].
  final int? monthlyCreditAmount;

  bool get isYearly => billingPeriod == 'P1Y';

  /// Credits one grant carries: a pack's whole amount, a plan's monthly
  /// allowance.
  ///
  /// Every plan is granted monthly, the yearly one too — Creator yearly is
  /// billed once a year and grants 6,000 credits each month of the paid year,
  /// each month's lapsing at its end like Creator monthly's. The server says
  /// so in [monthlyCreditAmount]; [creditAmount] stays what one payment buys
  /// in all (72,000 for the year), which is what value per price compares. A
  /// server from before the field is read as twelve grants for a yearly plan.
  int get creditsPerGrant {
    if (!isSubscription) return creditAmount;
    return monthlyCreditAmount ??
        (isYearly ? creditAmount ~/ 12 : creditAmount);
  }

  /// "month" or "year", for "/ month" and "Renews monthly" alike.
  String get periodNoun => isYearly ? 'year' : 'month';

  /// "Renews monthly" or "Renews yearly".
  String get renewsLabel => isYearly ? 'Renews yearly' : 'Renews monthly';

  factory MobileBillingProduct.fromJson(Map<String, dynamic> json) {
    return MobileBillingProduct(
      sku: json['sku'] as String,
      title: json['title'] as String,
      description: json['description'] as String,
      productType: json['productType'] as String,
      creditAmount: json['creditAmount'] as int,
      priceMicros: json['priceMicros'] as int,
      currency: json['currency'] as String,
      offered: json['offered'] as bool? ?? true,
      billingPeriod: json['billingPeriod'] as String?,
      introOfferId: json['introOfferId'] as String?,
      introOfferCredits: json['introOfferCredits'] as int?,
      monthlyCreditAmount: switch (json['monthlyCreditAmount']) {
        final int value when value > 0 => value,
        _ => null,
      },
    );
  }

  bool get isSubscription => productType == 'SUBSCRIPTION';

  bool get isConsumable => !isSubscription;

  String get benefitLabel {
    if (isSubscription) {
      return isYearly
          ? '${formatCredits(creditsPerGrant)} credits every month, billed yearly'
          : '${formatCredits(creditsPerGrant)} credits each month';
    }
    return '${formatCredits(creditAmount)} credits';
  }
}

/// A credit amount the way every billing surface prints it: "1,000".
String formatCredits(int value) {
  final digits = value.abs().toString();
  final buffer = StringBuffer(value < 0 ? '-' : '');
  for (var index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 == 0) {
      buffer.write(',');
    }
    buffer.write(digits[index]);
  }
  return buffer.toString();
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
    this.offers = const [],
    this.source,
  });

  final String id;
  final String title;
  final String description;

  /// What it costs: a one-time product's price, a subscription's base-plan
  /// price for every period — never an offer's first phase.
  final String price;
  final double rawPrice;
  final String currencyCode;

  /// Every discounted offer Play lists for this account — Play leaves out the
  /// ones it is not eligible for. [introOfferFor] picks the one we sell.
  final List<StoreIntroOffer> offers;
  final Object? source;

  /// This product bought through [offer]: same id and listing, the offer's
  /// store details, which carry the token Play charges the offer by.
  StoreProduct throughOffer(StoreIntroOffer offer) => StoreProduct(
    id: id,
    title: title,
    description: description,
    price: price,
    rawPrice: rawPrice,
    currencyCode: currencyCode,
    offers: offers,
    source: offer.source ?? source,
  );
}

/// The intro offer [product] is sold through, when the server names one and
/// Play lists it for this account; otherwise null, and the base plan is sold.
StoreIntroOffer? introOfferFor(
  MobileBillingProduct? product,
  StoreProduct? store,
) {
  final offerId = product?.introOfferId;
  if (offerId == null || store == null) return null;
  for (final offer in store.offers) {
    if (offer.offerId == offerId) return offer;
  }
  return null;
}

/// A subscription's discounted opening periods, as Play prices them for this
/// account. Bought through [source], and always shown with the price after it.
class StoreIntroOffer {
  const StoreIntroOffer({
    required this.offerId,
    required this.price,
    required this.billingPeriod,
    required this.cycles,
    this.source,
  });

  final String offerId;

  /// Play's formatted price for one discounted period.
  final String price;

  /// ISO 8601 length of one discounted period ("P1M").
  final String billingPeriod;

  /// How many discounted periods the offer lasts.
  final int cycles;
  final Object? source;

  /// "first month", "first 3 months", "first year".
  String get termLabel {
    final unit = switch (billingPeriod) {
      'P1Y' => 'year',
      'P1W' => 'week',
      _ => 'month',
    };
    return cycles <= 1 ? 'first $unit' : 'first $cycles ${unit}s';
  }
}

class StoreProductQueryResult {
  const StoreProductQueryResult({
    required this.products,
    required this.notFoundIds,
    this.error,
  });

  final List<StoreProduct> products;
  final List<String> notFoundIds;

  /// Play's own account of a query it could not answer in full. Whatever it
  /// did return is still for sale; everything else has no price.
  final String? error;
}

class StorePurchaseUpdate {
  const StorePurchaseUpdate({
    required this.productId,
    required this.status,
    required this.purchaseToken,
    this.purchaseId,
    this.purchaseAccountId,
    this.errorMessage,
    this.alreadyOwned = false,
    this.pendingCompletePurchase = false,
    this.planChangeDeferred = false,
    this.localPriceMicros,
    this.localCurrency,
    this.source,
  });

  /// Empty on a checkout Play could not complete: Back, or an error such as
  /// ITEM_ALREADY_OWNED, arrives as one update with no purchase behind it.
  final String productId;
  final StorePurchaseStatus status;
  final String purchaseToken;
  final String? purchaseId;

  /// Account identity retained by Google, including delayed/restored purchases.
  final String? purchaseAccountId;
  final String? errorMessage;

  /// Play refused the checkout because the account already holds the product.
  final bool alreadyOwned;

  /// Play has not been told the purchase is acknowledged.
  final bool pendingCompletePurchase;

  /// Play's answer to a downgrade it scheduled for the renewal date
  /// (`ReplacementMode.deferred`): it says the change went through and hands
  /// back no purchase, so [productId] is the plan switched to and the token
  /// it issued is found by asking Play for owned purchases.
  final bool planChangeDeferred;

  /// What Play priced this purchase at for the buyer, in micros of
  /// [localCurrency] before tax: the phase bought for a subscription, the
  /// price times quantity for a pack. Null when this process does not know —
  /// a subscription bought before it started. Analytics only.
  final int? localPriceMicros;
  final String? localCurrency;
  final Object? source;
}
