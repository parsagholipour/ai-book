import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/haptics.dart';
import '../data/billing_repository.dart';
import '../data/google_play_billing_client.dart';
import '../domain/billing_models.dart';

sealed class BillingPurchaseEvent {
  const BillingPurchaseEvent({required this.productId});

  final String productId;
}

class BillingPurchaseSuccess extends BillingPurchaseEvent {
  const BillingPurchaseSuccess({
    required super.productId,
    required this.purchaseId,
    required this.message,
  });

  final String purchaseId;
  final String message;
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
  final Set<String> pendingProductIds;
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
      loading: loading ?? this.loading,
      storeAvailable: storeAvailable ?? this.storeAvailable,
      restoring: restoring ?? this.restoring,
      subscriptionBusy: subscriptionBusy ?? this.subscriptionBusy,
      message: clearMessage ? null : message ?? this.message,
      error: clearError ? null : error ?? this.error,
    );
  }
}

class BillingController extends ChangeNotifier {
  BillingController({
    required this._billingRepository,
    required this._storeClient,
    required this._onBillingChanged,
    required this._keepAlive,
    this.projectId,
  }) {
    _subscription = _storeClient.purchaseUpdates.listen(_handlePurchases);
    unawaited(load());
  }

  final BillingRepository _billingRepository;
  final StoreBillingClient _storeClient;
  final VoidCallback _onBillingChanged;
  final VoidCallback Function() _keepAlive;
  final String? projectId;
  late final StreamSubscription<List<StorePurchaseUpdate>> _subscription;
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
          'tomeza.one_book_export' => 0,
          'tomeza.creator_monthly' => 1,
          'tomeza.pro_monthly' => 2,
          'tomeza.max_monthly' => 3,
          'tomeza.credit_pack_1' => 4,
          'tomeza.credit_pack_2' => 5,
          _ => 6,
        };
      }

      return rank(left).compareTo(rank(right));
    });
    return copy;
  }

  /// Plans, cheapest first — the headline of the paywall.
  List<MobileBillingProduct> get plans =>
      products.where((product) => product.isSubscription).toList();

  /// One-off purchases: an export unlock or a credit pack. These stay for the
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
      StoreProductQueryResult query = const StoreProductQueryResult(
        products: [],
        notFoundIds: [],
      );
      if (storeAvailable && billing.products.isNotEmpty) {
        query = await _storeClient.queryProducts(
          billing.products.map((product) => product.sku).toSet(),
        );
      }
      _setState(
        _state.copyWith(
          billing: billing,
          loading: false,
          storeAvailable: storeAvailable,
          storeProducts: {
            for (final product in query.products) product.id: product,
          },
          missingProductIds: query.notFoundIds,
        ),
      );
    } catch (error) {
      _setState(_state.copyWith(loading: false, error: userFacingError(error)));
    }
  }

  Future<void> buy(MobileBillingProduct product) async {
    final storeProduct = _state.storeProducts[product.sku];
    if (!_state.storeAvailable || storeProduct == null) {
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
    try {
      await _storeClient.buyProduct(
        storeProduct,
        consumable: product.isConsumable,
      );
    } catch (error) {
      final nextPending = {..._state.pendingProductIds}..remove(product.sku);
      _setState(
        _state.copyWith(
          pendingProductIds: nextPending,
          error: userFacingError(error),
        ),
      );
      _emitPurchaseEvent(BillingPurchaseStopped(productId: product.sku));
      _releasePurchase(product.sku);
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
    unawaited(_subscription.cancel());
    unawaited(_purchaseEvents.close());
    super.dispose();
  }

  Future<void> _handlePurchases(List<StorePurchaseUpdate> purchases) async {
    for (final purchase in purchases) {
      await _handlePurchase(purchase);
    }
  }

  Future<void> _handlePurchase(StorePurchaseUpdate purchase) async {
    final product = _state.billing?.products
        .where((item) => item.sku == purchase.productId)
        .firstOrNull;
    switch (purchase.status) {
      case StorePurchaseStatus.pending:
        _holdPurchase(purchase.productId);
        _setState(
          _state.copyWith(
            pendingProductIds: {
              ..._state.pendingProductIds,
              purchase.productId,
            },
            message:
                'Payment is pending. Credits unlock after Google Play confirms payment.',
            clearError: true,
          ),
        );
        return;
      case StorePurchaseStatus.canceled:
        final nextPending = {..._state.pendingProductIds}
          ..remove(purchase.productId);
        _setState(
          _state.copyWith(
            pendingProductIds: nextPending,
            message: 'Purchase canceled.',
          ),
        );
        _emitPurchaseEvent(
          BillingPurchaseStopped(productId: purchase.productId),
        );
        _releasePurchase(purchase.productId);
        return;
      case StorePurchaseStatus.error:
        AppHaptics.error();
        final nextPending = {..._state.pendingProductIds}
          ..remove(purchase.productId);
        _setState(
          _state.copyWith(
            pendingProductIds: nextPending,
            error:
                purchase.errorMessage ??
                'Google Play could not complete this purchase.',
          ),
        );
        _emitPurchaseEvent(
          BillingPurchaseStopped(productId: purchase.productId),
        );
        _releasePurchase(purchase.productId);
        return;
      case StorePurchaseStatus.purchased:
      case StorePurchaseStatus.restored:
        if (product == null) {
          _setState(
            _state.copyWith(
              error: 'This Google Play product is not configured.',
            ),
          );
          _emitPurchaseEvent(
            BillingPurchaseStopped(productId: purchase.productId),
          );
          _releasePurchase(purchase.productId);
          return;
        }
        if (purchase.purchaseToken.trim().isEmpty) {
          _setState(
            _state.copyWith(
              error: 'Google Play did not return a purchase token.',
            ),
          );
          _emitPurchaseEvent(
            BillingPurchaseStopped(productId: purchase.productId),
          );
          _releasePurchase(purchase.productId);
          return;
        }
        final verificationKeepAlive = _keepAlive();
        _setState(
          _state.copyWith(
            pendingProductIds: {
              ..._state.pendingProductIds,
              purchase.productId,
            },
            message: purchase.status == StorePurchaseStatus.restored
                ? 'Restoring purchase with the backend.'
                : 'Verifying purchase with the backend.',
            clearError: true,
          ),
        );
        try {
          final result = await _billingRepository.verifyGooglePlayPurchase(
            productId: purchase.productId,
            purchaseToken: purchase.purchaseToken,
            transactionId: purchase.purchaseId,
            purchaseStatus: purchase.status == StorePurchaseStatus.restored
                ? 'restored'
                : 'purchased',
            projectId: projectId,
          );
          await _storeClient.finishPurchase(
            purchase,
            consumable: product.isConsumable,
          );
          if (_disposed) {
            return;
          }
          final nextPending = {..._state.pendingProductIds}
            ..remove(purchase.productId);
          final granted = result.purchase.status == 'granted';
          if (granted) {
            AppHaptics.success();
          }
          final successMessage = _successMessage(result);
          _setState(
            _state.copyWith(
              billing: result.billing,
              pendingProductIds: nextPending,
              message: successMessage,
              clearError: true,
            ),
          );
          _onBillingChanged();
          if (granted) {
            final success = BillingPurchaseSuccess(
              productId: purchase.productId,
              purchaseId: result.purchase.id,
              message: successMessage,
            );
            _unacknowledgedPurchaseSuccess = success;
            _emitPurchaseEvent(success);
          } else if (result.purchase.status != 'pending') {
            _emitPurchaseEvent(
              BillingPurchaseStopped(productId: purchase.productId),
            );
          }
        } catch (error) {
          if (!_disposed) {
            AppHaptics.error();
            final nextPending = {..._state.pendingProductIds}
              ..remove(purchase.productId);
            _setState(
              _state.copyWith(
                pendingProductIds: nextPending,
                error: userFacingError(error),
              ),
            );
            _emitPurchaseEvent(
              BillingPurchaseStopped(productId: purchase.productId),
            );
          }
        } finally {
          verificationKeepAlive();
          _releasePurchase(purchase.productId);
        }
    }
  }

  String _successMessage(GooglePlayVerificationResult result) {
    if (result.purchase.status == 'pending') {
      return 'Payment is pending. Credits unlock after Google Play confirms payment.';
    }
    if (result.purchase.subscriptionStatus != null) {
      return 'Subscription verified. Your monthly credits are available.';
    }
    if (result.purchase.creditsGranted > 0) {
      return '${result.purchase.creditsGranted} credits added.';
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
        projectId: projectId,
        onBillingChanged: () => ref.invalidate(billingProvider),
        keepAlive: () {
          final link = ref.keepAlive();
          return link.close;
        },
      );
      ref.onDispose(controller.dispose);
      return controller;
    });
