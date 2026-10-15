import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/haptics.dart';
import '../data/billing_repository.dart';
import '../data/google_play_billing_client.dart';
import '../data/paywall_view_reporter.dart';
import '../data/play_purchase_processor.dart';
import '../data/purchase_funnel_reporter.dart';
import '../domain/billing_models.dart';
import 'billing_product_option.dart';
import 'billing_shared_parts.dart';
import 'billing_tier_style.dart';

/// What a surface says about a product whose payment Play holds as pending.
const billingAwaitingPaymentMessage =
    "Payment is pending. We'll add it when Google Play confirms the payment.";

sealed class BillingPurchaseEvent {
  const BillingPurchaseEvent({required this.productId});

  final String productId;
}

class BillingPurchaseSuccess extends BillingPurchaseEvent {
  const BillingPurchaseSuccess({
    required super.productId,
    required this.purchaseId,
    required this.message,
    this.scheduled = false,
  });

  final String purchaseId;
  final String message;

  /// A downgrade Play deferred to the renewal date: nothing was bought today,
  /// and [message] says when the plan changes.
  final bool scheduled;
}

class BillingPurchaseStopped extends BillingPurchaseEvent {
  const BillingPurchaseStopped({required super.productId});
}

class BillingPurchaseState {
  const BillingPurchaseState({
    this.billing,
    this.storeProducts = const {},
    this.missingProductIds = const [],
    this.pendingProductIds = const {},
    this.awaitingPaymentProductIds = const {},
    this.loading = true,
    this.storeAvailable = false,
    this.restoring = false,
    this.subscriptionBusy = false,
    this.message,
    this.error,
  });

  final MobileBilling? billing;
  final Map<String, StoreProduct> storeProducts;
  final List<String> missingProductIds;

  /// A Play sheet is open or a purchase is being verified. Every purchase
  /// surface holds all its products while this is non-empty: one at a time.
  final Set<String> pendingProductIds;

  /// Products whose payment Play holds as pending (a slow card). Only these
  /// are held; the rest stay for sale.
  final Set<String> awaitingPaymentProductIds;
  final bool loading;
  final bool storeAvailable;
  final bool restoring;

  /// A cancel or a subscription re-check is in flight.
  final bool subscriptionBusy;
  final String? message;
  final String? error;

  BillingPurchaseState copyWith({
    MobileBilling? billing,
    Map<String, StoreProduct>? storeProducts,
    List<String>? missingProductIds,
    Set<String>? pendingProductIds,
    Set<String>? awaitingPaymentProductIds,
    bool? loading,
    bool? storeAvailable,
    bool? restoring,
    bool? subscriptionBusy,
    String? message,
    String? error,
    bool clearMessage = false,
    bool clearError = false,
  }) {
    return BillingPurchaseState(
      billing: billing ?? this.billing,
      storeProducts: storeProducts ?? this.storeProducts,
      missingProductIds: missingProductIds ?? this.missingProductIds,
      pendingProductIds: pendingProductIds ?? this.pendingProductIds,
      awaitingPaymentProductIds:
          awaitingPaymentProductIds ?? this.awaitingPaymentProductIds,
      loading: loading ?? this.loading,
      storeAvailable: storeAvailable ?? this.storeAvailable,
      restoring: restoring ?? this.restoring,
      subscriptionBusy: subscriptionBusy ?? this.subscriptionBusy,
      message: clearMessage ? null : message ?? this.message,
      error: clearError ? null : error ?? this.error,
    );
  }

  /// Those of [products] Play gave no price for although it answered: its
  /// product query failed, or it left them out (a product not yet active in
  /// Play Console). A surface says so and offers a retry rather than greying
  /// them out in silence. Empty while loading, and while Play itself is
  /// unreachable — [storeAvailable] has its own notice.
  List<MobileBillingProduct> unpricedAmong(
    Iterable<MobileBillingProduct> products,
  ) {
    if (loading || !storeAvailable || billing == null) return const [];
    return [
      for (final product in products)
        if (!storeProducts.containsKey(product.sku)) product,
    ];
  }
}

class BillingController extends ChangeNotifier {
  /// Play's purchases reach this through [_purchases], which owns the store's
  /// stream for the life of the app; this only draws what it reports.
  BillingController({
    required this._billingRepository,
    required this._storeClient,
    required this._purchases,
    required this._onBillingChanged,
    required this._keepAlive,
    this.projectId,
    PurchaseFunnelReporter? funnel,
  }) : _funnel = funnel ?? const SilentPurchaseFunnelReporter() {
    _detach = _purchases.attach();
    _subscription = _purchases.events.listen(_onPurchaseEvent);
    _purchases.addListener(_syncAwaitingPayment);
    _state = _state.copyWith(
      awaitingPaymentProductIds: _purchases.awaitingPaymentProductIds,
    );
    unawaited(load());
  }

  final BillingRepository _billingRepository;
  final StoreBillingClient _storeClient;
  final PlayPurchaseProcessor _purchases;
  final VoidCallback _onBillingChanged;
  final VoidCallback Function() _keepAlive;
  final String? projectId;

  /// Analytics only: a checkout asked for, and why one never opened. How Play
  /// answered is [_purchases]'s to report, since every controller hears it.
  final PurchaseFunnelReporter _funnel;
  late final VoidCallback _detach;
  late final StreamSubscription<PlayPurchaseEvent> _subscription;
  final _purchaseEvents = StreamController<BillingPurchaseEvent>.broadcast();
  final _purchaseKeepAliveReleases = <String, VoidCallback>{};

  BillingPurchaseState _state = const BillingPurchaseState();
  BillingPurchaseSuccess? _unacknowledgedPurchaseSuccess;
  bool _disposed = false;

  BillingPurchaseState get state => _state;

  /// One-shot lifecycle events for purchases initiated by a visible surface.
  /// Success is emitted only after a backend grant; stopped events let the
  /// surface forget ownership after cancellation or failure.
  Stream<BillingPurchaseEvent> get purchaseEvents => _purchaseEvents.stream;

  /// Removes the inline copy once a purchase surface has taken responsibility
  /// for showing the verified result in a dialog. Restore results and other
  /// status messages stay in place until a surface explicitly handles them.
  void acknowledgePurchaseSuccess(BillingPurchaseSuccess purchase) {
    if (_unacknowledgedPurchaseSuccess?.purchaseId != purchase.purchaseId ||
        _state.message != purchase.message) {
      return;
    }
    _unacknowledgedPurchaseSuccess = null;
    _setState(_state.copyWith(clearMessage: true));
  }

  List<MobileBillingProduct> get products {
    final billing = _state.billing;
    if (billing == null) {
      return const [];
    }
    final copy = [...billing.products];
    copy.sort((left, right) {
      int rank(MobileBillingProduct product) {
        return switch (product.sku) {
          'tomeza.creator_monthly' => 1,
          'tomeza.creator_yearly' => 2,
          'tomeza.pro_monthly' => 3,
          'tomeza.max_monthly' => 4,
          'tomeza.credit_pack_1' => 5,
          'tomeza.credit_pack_2' => 6,
          _ => 7,
        };
      }

      return rank(left).compareTo(rank(right));
    });
    return copy;
  }

  /// Plans, cheapest first — the headline of the paywall. A plan the server
  /// does not offer this reader is left off unless it is the one they hold.
  List<MobileBillingProduct> get plans => products
      .where(
        (product) =>
            product.isSubscription &&
            (product.offered || isHeldPlan(product, _state.billing)),
      )
      .toList();

  /// One-off purchases: the credit packs. These stay for the
  /// subscriber who runs dry mid-month and for anyone who will not subscribe.
  List<MobileBillingProduct> get topUps =>
      products.where((product) => !product.isSubscription).toList();

  Future<void> load() async {
    _setState(
      _state.copyWith(loading: true, clearError: true, clearMessage: true),
    );
    try {
      final billing = await _billingRepository.getBilling();
      final storeAvailable = await _storeClient.isAvailable();
      final skus = billing.products.map((product) => product.sku).toSet();
      var products = const <StoreProduct>[];
      if (storeAvailable && skus.isNotEmpty) {
        // Play failing to price the catalog is not the catalog failing to
        // load: the plans stay on screen, unpriced, beside a retry.
        try {
          final query = await _storeClient.queryProducts(skus);
          if (query.error != null) {
            debugPrint('Google Play product query failed: ${query.error}');
          }
          products = query.products;
        } catch (error) {
          debugPrint('Google Play products could not be read: $error');
        }
      }
      final storeProducts = {
        for (final product in products) product.id: product,
      };
      _setState(
        _state.copyWith(
          billing: billing,
          loading: false,
          storeAvailable: storeAvailable,
          storeProducts: storeProducts,
          missingProductIds: storeAvailable
              ? [
                  for (final sku in skus)
                    if (!storeProducts.containsKey(sku)) sku,
                ]
              : const [],
        ),
      );
    } catch (error) {
      _setState(_state.copyWith(loading: false, error: userFacingError(error)));
    }
  }

  /// [surface] names the paywall the checkout was started from, for the growth
  /// funnel; left out, the last paywall shown stands in.
  Future<void> buy(
    MobileBillingProduct product, {
    PaywallTrigger? surface,
  }) async {
    if (_state.pendingProductIds.isNotEmpty) return;
    // Play would refuse it as already owned; the pending payment is the answer.
    if (_state.awaitingPaymentProductIds.contains(product.sku)) {
      _setState(
        _state.copyWith(
          message: billingAwaitingPaymentMessage,
          clearError: true,
        ),
      );
      _emitPurchaseEvent(BillingPurchaseStopped(productId: product.sku));
      return;
    }
    final storeProduct = _state.storeProducts[product.sku];
    // The intro offer when Play lists one for this account: the paywall
    // showed its price, and its token is what makes Play charge it.
    final intro = introOfferFor(product, storeProduct);
    _funnel.purchaseStarted(
      sku: product.sku,
      intro: intro != null,
      surface: surface,
    );
    if (!_state.storeAvailable || storeProduct == null) {
      _funnel.purchaseFailed(
        product.sku,
        PurchaseFailureReason.storeUnavailable,
      );
      _setState(
        _state.copyWith(
          error: 'This item is not available from Google Play yet.',
        ),
      );
      _emitPurchaseEvent(BillingPurchaseStopped(productId: product.sku));
      return;
    }
    _holdPurchase(product.sku);
    _setState(
      _state.copyWith(
        pendingProductIds: {..._state.pendingProductIds, product.sku},
        message: storeProduct.source is DebugStoreProduct
            ? 'Adding debug credits.'
            : 'Opening Google Play checkout.',
        clearError: true,
      ),
    );
    var launched = false;
    try {
      // A pending checkout can keep this controller alive across account changes.
      // Its cached billing payload must never select the next purchase's owner.
      final billing = await _billingRepository.getBilling();
      final accountId = billing.purchaseAccountId;
      if (accountId == null || accountId.isEmpty) {
        throw const ApiException(
          code: 'BILLING_ACCOUNT_UNAVAILABLE',
          message:
              'Purchases are temporarily unavailable. Please try again later.',
        );
      }
      _setState(_state.copyWith(billing: billing));
      _purchases.beginCheckout(
        product.sku,
        accountId: accountId,
        projectId: projectId,
      );
      launched = true;
      await _storeClient.buyProduct(
        intro == null ? storeProduct : storeProduct.throughOffer(intro),
        consumable: product.isConsumable,
        purchaseAccountId: accountId,
        subscription: product.isSubscription
            ? StoreSubscriptionCheckout(
                productIds: plans.map((plan) => plan.sku).toSet(),
                hasActivePlan:
                    _state.billing?.plan != null &&
                    _state.billing!.plan!.tier != 'free',
                currentProductId: _state.billing?.plan?.productSku,
                currentPurchaseTokenHash:
                    _state.billing?.plan?.purchaseTokenHash,
              )
            : null,
      );
    } catch (error) {
      // The sheet never opened (or the plugin returned false for it), so no
      // answer from Play will settle this checkout; it is settled here.
      _funnel.purchaseFailed(
        product.sku,
        launched
            ? PurchaseFailureReason.launchFailed
            : PurchaseFailureReason.accountUnavailable,
      );
      if (launched) _purchases.checkoutFailed(product.sku);
      _settleCheckout(product.sku);
      _setState(
        _state.copyWith(error: userFacingError(error), clearMessage: true),
      );
      _emitPurchaseEvent(BillingPurchaseStopped(productId: product.sku));
    }
  }

  Future<void> restore() async {
    _setState(
      _state.copyWith(
        restoring: true,
        message: 'Checking Google Play purchases.',
        clearError: true,
      ),
    );
    try {
      await _storeClient.restorePurchases();
      _setState(
        _state.copyWith(
          restoring: false,
          message:
              'Restore started. Purchases will appear as Google Play returns them.',
        ),
      );
    } catch (error) {
      _setState(
        _state.copyWith(restoring: false, error: userFacingError(error)),
      );
    }
  }

  /// End the subscription now, on backends that can. Returns false and leaves an
  /// error on the state when the server says cancelling belongs in Play.
  Future<bool> cancelSubscription() {
    return _runSubscriptionAction(
      () => _billingRepository.cancelSubscription(),
      'Your plan has been cancelled. You are on the free plan now.',
    );
  }

  /// Re-check the subscription with Google, for the reader who has just come
  /// back from cancelling in the Play subscription centre.
  Future<bool> refreshSubscription() {
    return _runSubscriptionAction(
      () => _billingRepository.refreshSubscription(),
      'Your plan is up to date.',
    );
  }

  Future<bool> _runSubscriptionAction(
    Future<MobileBilling> Function() action,
    String successMessage,
  ) async {
    if (_state.subscriptionBusy) {
      return false;
    }
    _setState(
      _state.copyWith(
        subscriptionBusy: true,
        clearError: true,
        clearMessage: true,
      ),
    );
    try {
      final billing = await action();
      _setState(
        _state.copyWith(
          billing: billing,
          subscriptionBusy: false,
          message: successMessage,
          clearError: true,
        ),
      );
      _onBillingChanged();
      return true;
    } catch (error) {
      AppHaptics.error();
      _setState(
        _state.copyWith(subscriptionBusy: false, error: userFacingError(error)),
      );
      return false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    for (final release in _purchaseKeepAliveReleases.values) {
      release();
    }
    _purchaseKeepAliveReleases.clear();
    _purchases.removeListener(_syncAwaitingPayment);
    unawaited(_subscription.cancel());
    _detach();
    unawaited(_purchaseEvents.close());
    super.dispose();
  }

  void _syncAwaitingPayment() {
    _setState(
      _state.copyWith(
        awaitingPaymentProductIds: _purchases.awaitingPaymentProductIds,
      ),
    );
  }

  void _onPurchaseEvent(PlayPurchaseEvent event) {
    final productId = event.productId;
    switch (event) {
      case PlayCheckoutClosed(alreadyOwned: true):
        unawaited(_recoverOwned(productId));
      case PlayCheckoutClosed(canceled: true):
        _settleCheckout(productId);
        _setState(_state.copyWith(message: 'Purchase canceled.'));
        _emitPurchaseEvent(BillingPurchaseStopped(productId: productId));
      case PlayCheckoutClosed(:final errorMessage):
        AppHaptics.error();
        _settleCheckout(productId);
        _setState(
          _state.copyWith(
            error:
                errorMessage ?? 'Google Play could not complete this purchase.',
          ),
        );
        _emitPurchaseEvent(BillingPurchaseStopped(productId: productId));
      case PlayPurchasePending(:final background):
        // The sheet has closed and the payment is Google's to clear. No stopped
        // event: a surface still open when it clears shows its success.
        _settleCheckout(productId);
        if (!background) {
          _setState(
            _state.copyWith(
              message: billingAwaitingPaymentMessage,
              clearError: true,
            ),
          );
        }
      case PlayPurchaseVerifying(:final restored, :final background):
        // A pass on resume re-checks what Play holds on its own. It holds
        // nothing on this surface: every button spun for it, and a failure
        // left "Restoring" on screen for a purchase nobody had asked about.
        if (background) return;
        _holdPurchase(productId);
        _setState(
          _state.copyWith(
            pendingProductIds: {..._state.pendingProductIds, productId},
            message: restored
                ? 'Adding your purchase to your account.'
                : 'Confirming your purchase.',
            clearError: true,
          ),
        );
      case PlayPurchaseVerified(:final result):
        _settleCheckout(productId);
        final scheduled = _scheduledChangeMessage(productId, result);
        final granted =
            result.purchase.status == 'granted' || scheduled != null;
        if (granted) {
          AppHaptics.success();
        }
        final successMessage = scheduled ?? _successMessage(result);
        _setState(
          _state.copyWith(
            billing: result.billing,
            message: successMessage,
            clearError: true,
          ),
        );
        if (granted) {
          final success = BillingPurchaseSuccess(
            productId: productId,
            purchaseId: result.purchase.id,
            message: successMessage,
            scheduled: scheduled != null,
          );
          _unacknowledgedPurchaseSuccess = success;
          _emitPurchaseEvent(success);
        } else if (result.purchase.status != 'pending') {
          _emitPurchaseEvent(BillingPurchaseStopped(productId: productId));
        }
      case PlayPurchaseNotVerified(
        :final message,
        :final background,
        :final paid,
      ):
        // A purchase found in the background is retried by the next pass; its
        // failure is not news to whoever happens to have a paywall open —
        // unless a checkout here is waiting on that very product.
        if (background && !_state.pendingProductIds.contains(productId)) {
          return;
        }
        _settleCheckout(productId);
        if (paid) {
          // The money moved; only the record is late. Said plainly, not as an
          // error, with the way to fetch it now.
          _setState(_state.copyWith(message: message, clearError: true));
        } else {
          AppHaptics.error();
          _setState(_state.copyWith(error: message, clearMessage: true));
        }
        _emitPurchaseEvent(BillingPurchaseStopped(productId: productId));
    }
  }

  /// Play refused the checkout as already owned: a pack bought earlier that
  /// was never consumed, usually because its verification never finished. The
  /// way out is to settle that purchase, so the next one can go through.
  Future<void> _recoverOwned(String productId) async {
    _settleCheckout(productId);
    // Play also answered the launch, and that failure's own pass has already
    // found and granted it.
    if (_purchases.grantedSinceCheckout(productId)) return;
    _setState(
      _state.copyWith(
        restoring: true,
        message: 'You already own this. Checking Google Play for it.',
        clearError: true,
      ),
    );
    final outcome = await _purchases.reconcile(force: true, announce: true);
    if (_disposed) return;
    // Whichever pass found it: a launch Play refused starts a quiet one that
    // can get there first.
    if (outcome.granted.contains(productId) ||
        _purchases.grantedSinceCheckout(productId)) {
      // The verification has already said what it added, and its success
      // event answers the surface that started this checkout.
      _setState(_state.copyWith(restoring: false));
      return;
    }
    _emitPurchaseEvent(BillingPurchaseStopped(productId: productId));
    _setState(
      _state.copyWith(
        restoring: false,
        message: _state.awaitingPaymentProductIds.contains(productId)
            ? billingAwaitingPaymentMessage
            : outcome.checked
            ? 'Google Play says this is already yours, but nothing is waiting to be added to this account. If another Tomeza account bought it, sign in there and restore purchases.'
            : null,
        error: outcome.checked
            ? null
            : 'Google Play could not be checked. Try Restore purchases in a moment.',
      ),
    );
  }

  /// Play has answered this product's checkout, or never will.
  void _settleCheckout(String productId) {
    if (_state.pendingProductIds.contains(productId)) {
      _setState(
        _state.copyWith(
          pendingProductIds: {..._state.pendingProductIds}..remove(productId),
        ),
      );
    }
    _releasePurchase(productId);
  }

  /// "Your plan switches to Creator on Wed, Nov 4." for a downgrade Play
  /// deferred to the renewal date; null for anything bought today. Nothing was
  /// granted for it, so "Subscription verified. Your monthly credits are
  /// available." described a purchase that had not happened.
  String? _scheduledChangeMessage(
    String productId,
    GooglePlayVerificationResult result,
  ) {
    final purchase = result.purchase;
    final plan = result.billing.plan;
    final sku =
        purchase.scheduledChangeSku ??
        (purchase.status == 'scheduled'
            ? productId
            : plan?.pendingChangeSku == productId
            ? productId
            : null);
    if (sku == null) return null;
    final at =
        purchase.scheduledChangeAt ??
        (plan?.pendingChangeSku == sku ? plan?.pendingChangeAt : null);
    final name = billingPlanNameForSku(sku, result.billing.products);
    return at == null
        ? 'Your plan switches to $name when your current plan renews.'
        : 'Your plan switches to $name on ${billingMessageDate(at)}.';
  }

  String _successMessage(GooglePlayVerificationResult result) {
    if (result.purchase.status == 'pending') {
      return billingAwaitingPaymentMessage;
    }
    if (result.purchase.subscriptionStatus != null) {
      return 'Subscription verified. Your monthly credits are available.';
    }
    if (result.purchase.creditsGranted > 0) {
      return '${formatCredits(result.purchase.creditsGranted)} credits added.';
    }
    return 'Purchase verified.';
  }

  void _setState(BillingPurchaseState value) {
    if (_disposed) {
      return;
    }
    _state = value;
    notifyListeners();
  }

  void _holdPurchase(String productId) {
    if (_disposed) {
      return;
    }
    _purchaseKeepAliveReleases.putIfAbsent(productId, _keepAlive);
  }

  void _releasePurchase(String productId) {
    _purchaseKeepAliveReleases.remove(productId)?.call();
  }

  void _emitPurchaseEvent(BillingPurchaseEvent event) {
    if (!_disposed) {
      _purchaseEvents.add(event);
    }
  }
}

final billingControllerProvider = Provider.autoDispose
    .family<BillingController, String?>((ref, projectId) {
      final controller = BillingController(
        billingRepository: ref.watch(billingRepositoryProvider),
        storeClient: ref.watch(storeBillingClientProvider),
        purchases: ref.watch(playPurchaseProcessorProvider),
        projectId: projectId,
        funnel: ref.watch(purchaseFunnelReporterProvider),
        onBillingChanged: () => ref.invalidate(billingProvider),
        keepAlive: () {
          final link = ref.keepAlive();
          return link.close;
        },
      );
      ref.onDispose(controller.dispose);
      return controller;
    });
