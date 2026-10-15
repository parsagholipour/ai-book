import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../domain/billing_models.dart';
import 'billing_repository.dart';
import 'google_play_billing_client.dart';
import 'purchase_funnel_reporter.dart';

/// What became of one Google Play update, told to every open purchase surface.
///
/// [background] marks a purchase reconciliation found on its own, rather than
/// one Play delivered for a checkout or a restore. A surface still shows what
/// such a purchase added, but not why it failed: the next pass retries it.
sealed class PlayPurchaseEvent {
  const PlayPurchaseEvent({required this.productId, this.background = false});

  final String productId;
  final bool background;
}

/// Play's sheet closed without a purchase: Back, or an error with no purchase
/// list. [productId] is the open checkout's even when Play's answer named none.
final class PlayCheckoutClosed extends PlayPurchaseEvent {
  const PlayCheckoutClosed({
    required super.productId,
    required this.canceled,
    this.alreadyOwned = false,
    this.errorMessage,
  });

  final bool canceled;

  /// Play refused because this Google account already holds the product — for
  /// a pack, one bought earlier and never consumed.
  final bool alreadyOwned;
  final String? errorMessage;
}

/// Play holds the purchase as pending: a payment method that has not cleared.
final class PlayPurchasePending extends PlayPurchaseEvent {
  const PlayPurchasePending({required super.productId, super.background});
}

/// A settled purchase is on its way to the server.
final class PlayPurchaseVerifying extends PlayPurchaseEvent {
  const PlayPurchaseVerifying({
    required super.productId,
    required this.restored,
    super.background,
  });

  final bool restored;
}

/// The server has recorded the purchase.
final class PlayPurchaseVerified extends PlayPurchaseEvent {
  const PlayPurchaseVerified({
    required super.productId,
    required this.result,
    super.background,
  });

  final GooglePlayVerificationResult result;
}

/// The purchase was refused, or never reached the server. Play still holds it
/// unfinished, so a later reconciliation or restore tries again.
final class PlayPurchaseNotVerified extends PlayPurchaseEvent {
  const PlayPurchaseNotVerified({
    required super.productId,
    required this.message,
    this.paid = false,
    super.background,
  });

  final String message;

  /// Play took the payment — or accepted a deferred plan change — and only
  /// the server's record of it is missing; the next pass or a restore adds it.
  /// [message] says so, and is no error.
  final bool paid;
}

/// What a buyer is told when Play charged them and the server could not record
/// it yet — a dropped connection, a busy server. "Check your connection" read
/// as a failed payment to someone whose card had just been charged.
const playPaymentNotRecordedMessage =
    'Your payment went through, but it hasn’t reached your account yet. '
    'It will appear shortly, or tap Restore purchases to add it now.';

/// What a reader is told when Play accepted a downgrade for the renewal date
/// but neither the owned-purchases pass nor a billing read could confirm it
/// here. Nothing failed and nothing was charged, so it is a message, never an
/// error.
const playPlanChangeNotConfirmedMessage =
    'Google Play accepted your plan change. Restore purchases in a moment to see it.';

/// What one reconciliation pass found.
class PlayReconcileOutcome {
  const PlayReconcileOutcome({
    this.checked = false,
    this.granted = const {},
    this.planResult,
  });

  /// Whether Play answered the query at all.
  final bool checked;

  /// Products the pass verified into a grant.
  final Set<String> granted;

  /// What the server said about a subscription the pass verified, if any.
  final GooglePlayVerificationResult? planResult;
}

/// The one owner of Google Play's purchase stream, for the life of the app.
///
/// Play delivers a purchase once, to whoever is listening, and refunds it after
/// three days unless it is acknowledged — which the server does only once it
/// has recorded the purchase. The listener used to live exactly as long as a
/// paywall, so a slow card clearing after it closed, a checkout the process
/// died under, and a verify call a flaky network dropped all ended the same
/// way: charged, no credits, refunded. RTDN cannot rescue those either; it
/// ignores a token no account has claimed.
///
/// So this listens while anyone is signed in (or a purchase surface is open),
/// verifies each settled purchase before telling Play it is finished, records
/// pending ones so Google's notification finds an owner when they clear, and
/// asks Play for anything unfinished on sign-in, on a return to the foreground,
/// and when a checkout says the product is already owned. Purchase surfaces
/// subscribe to [events] rather than to Play, so a purchase is verified once
/// however many of them are open.
class PlayPurchaseProcessor extends ChangeNotifier {
  PlayPurchaseProcessor({
    required this._billingRepository,
    required this._storeClient,
    required this._onBillingChanged,
    DateTime Function()? clock,
    PurchaseFunnelReporter? funnel,
  }) : _now = clock ?? DateTime.now,
       _funnel = funnel ?? const SilentPurchaseFunnelReporter();

  /// The least time between two passes a return to the foreground may start.
  /// A pass is a local Play query; it only reaches the API for a purchase that
  /// is unfinished, but the verify route allows twenty calls an hour.
  static const resumeInterval = Duration(minutes: 1);

  /// Play's purchase query has no deadline of its own, and a hung pass would
  /// hold every later one — and an already-owned checkout's spinner — with it.
  static const ownedQueryTimeout = Duration(seconds: 20);

  final BillingRepository _billingRepository;
  final StoreBillingClient _storeClient;
  final VoidCallback _onBillingChanged;
  final DateTime Function() _now;

  /// Analytics only: how a checkout Play answered ended. Told here, where each
  /// answer arrives once, rather than by every surface listening to [events].
  final PurchaseFunnelReporter _funnel;
  final _events = StreamController<PlayPurchaseEvent>.broadcast();
  StreamSubscription<List<StorePurchaseUpdate>>? _subscription;
  String? _userId;
  var _attached = 0;
  var _disposed = false;

  /// Bumped on every sign-in and sign-out, so work queued for one account is
  /// never carried out under the next.
  var _session = 0;
  Future<void> _tail = Future.value();
  final _queued = <String, Future<GooglePlayVerificationResult?>>{};
  Future<PlayReconcileOutcome>? _reconciling;
  DateTime? _lastReconciled;

  /// The product whose Play sheet is open. Play answers a checkout it could not
  /// complete with an update naming no product, and this is whose answer it is.
  String? _checkout;

  /// A checkout whose launch failed. Play can still send the productless
  /// answer for it — ITEM_ALREADY_OWNED comes both ways — after the failure.
  String? _unanswered;
  final _checkoutBegan = <String, DateTime>{};
  final _grantedAt = <String, DateTime>{};

  // Covers in-process pending callbacks from older store implementations that
  // omit the receipt's account id. Google retains the durable identity itself.
  final _checkoutAccounts = <String, String>{};
  final _checkoutProjects = <String, String?>{};

  /// Product → token of a payment Play holds as pending.
  final _awaiting = <String, String>{};
  final _recordedPending = <String>{};

  /// Tokens Play was told are finished this session, and tokens the server
  /// refused for good. A background pass skips both.
  final _finished = <String>{};
  final _refused = <String>{};

  /// Product → whether it is consumed once granted, learned from the catalog.
  final _consumable = <String, bool>{};

  Stream<PlayPurchaseEvent> get events => _events.stream;

  /// Products whose payment Play holds as pending. Buying one again would only
  /// have Play refuse it as already owned, so purchase surfaces hold just that
  /// product; every other one stays for sale.
  Set<String> get awaitingPaymentProductIds => Set.unmodifiable(_awaiting.keys);

  bool get _active => _userId != null || _attached > 0;

  /// Starts the app-lifetime listener for [userId] and looks for anything Play
  /// still holds unfinished. Called on sign-in and on a restored session.
  Future<void> signedIn(String userId) async {
    if (_disposed || _userId == userId) return;
    if (_userId != null) _forgetSession();
    _userId = userId;
    _listen();
    await reconcile(force: true);
  }

  void signedOut() {
    if (_disposed || _userId == null) return;
    _userId = null;
    _forgetSession();
    _listen();
  }

  /// The app came back to the foreground. Play may have cleared a slow payment,
  /// or finished a checkout while this process was gone.
  Future<void> resumed() async {
    if (_userId == null) return;
    await reconcile();
  }

  /// Keeps the stream open while a purchase surface is, signed in or not.
  /// Returns the call that lets go of it.
  VoidCallback attach() {
    _attached += 1;
    _listen();
    var detached = false;
    return () {
      if (detached) return;
      detached = true;
      _attached -= 1;
      _listen();
    };
  }

  /// Records the checkout a surface is about to open, so Play's answer reaches
  /// it even when that answer names no product.
  void beginCheckout(
    String productId, {
    required String accountId,
    String? projectId,
  }) {
    final superseded = _checkout;
    _checkout = productId;
    _unanswered = null;
    _checkoutBegan[productId] = _now();
    _checkoutAccounts[productId] = accountId;
    _checkoutProjects[productId] = projectId;
    // Play shows one sheet at a time, so an earlier checkout still open here
    // never got its answer; settle it rather than leave its surface spinning.
    if (superseded != null && superseded != productId) {
      _publish(PlayCheckoutClosed(productId: superseded, canceled: true));
    }
  }

  /// The checkout never opened: the store client threw, or Play refused to
  /// launch it — which is also how Play can say a pack is already owned.
  void checkoutFailed(String productId) {
    if (_checkout == productId) {
      _checkout = null;
      _unanswered = productId;
    }
    unawaited(reconcile(force: true));
  }

  /// Whether [productId] was granted after its latest checkout began, by any
  /// pass: the answer to a checkout Play refused as already owned.
  bool grantedSinceCheckout(String productId) {
    final began = _checkoutBegan[productId];
    final granted = _grantedAt[productId];
    return began != null && granted != null && !granted.isBefore(began);
  }

  /// Asks Play for every purchase it still holds and settles the unfinished
  /// ones: a plan nobody acknowledged, a pack nobody consumed, a pending
  /// payment the server has not recorded. [announce] is for a pass someone is
  /// waiting on, whose failures they should see and whose refusals are retried.
  Future<PlayReconcileOutcome> reconcile({
    bool force = false,
    bool announce = false,
  }) {
    const nothing = PlayReconcileOutcome();
    if (_disposed || !_active) return Future.value(nothing);
    final running = _reconciling;
    if (running != null && !announce) return running;
    final now = _now();
    if (!force) {
      // The resume a closing checkout causes is answered by Play's own update.
      if (_checkout != null) return Future.value(nothing);
      final last = _lastReconciled;
      if (last != null && now.difference(last) < resumeInterval) {
        return Future.value(nothing);
      }
    }
    _lastReconciled = now;
    final session = _session;
    final Future<Object?> previous = running ?? Future<Object?>.value();
    late final Future<PlayReconcileOutcome> pass;
    pass = previous
        .then((_) => _reconcile(session, announce: announce))
        .whenComplete(() {
          if (identical(_reconciling, pass)) _reconciling = null;
        });
    _reconciling = pass;
    return pass;
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_subscription?.cancel());
    _subscription = null;
    unawaited(_events.close());
    super.dispose();
  }

  void _listen() {
    if (_disposed) return;
    if (_active) {
      _subscription ??= _storeClient.purchaseUpdates.listen(_receive);
    } else {
      unawaited(_subscription?.cancel());
      _subscription = null;
    }
  }

  void _forgetSession() {
    _session += 1;
    _checkout = null;
    _unanswered = null;
    _checkoutBegan.clear();
    _grantedAt.clear();
    _checkoutAccounts.clear();
    _checkoutProjects.clear();
    _recordedPending.clear();
    _finished.clear();
    _refused.clear();
    _lastReconciled = null;
    _reconciling = null;
    if (_awaiting.isNotEmpty) {
      _awaiting.clear();
      notifyListeners();
    }
  }

  void _receive(List<StorePurchaseUpdate> updates) {
    final session = _session;
    for (final update in updates) {
      final purchase =
          update.status != StorePurchaseStatus.canceled &&
          update.status != StorePurchaseStatus.error;
      if (!purchase || update.purchaseToken.trim().isEmpty) {
        _closeCheckout(update);
        continue;
      }
      if (_checkout == update.productId) _checkout = null;
      unawaited(_enqueue(update, session: session, background: false));
    }
  }

  void _closeCheckout(StorePurchaseUpdate update) {
    // in_app_purchase_android answers a flow Play could not complete — Back,
    // ITEM_ALREADY_OWNED, BILLING_UNAVAILABLE — with one update and no
    // purchase: `productID: ''` (`_getPurchaseDetailsFromResult`). Only the
    // open checkout can own it. A failed flow never names another product.
    final productId = update.productId.isNotEmpty
        ? update.productId
        : _checkout ?? _unanswered ?? '';
    if (_checkout == productId) _checkout = null;
    if (_unanswered == productId) _unanswered = null;
    if (update.planChangeDeferred) {
      unawaited(_settleDeferredChange(productId, _session));
      return;
    }
    final failed =
        update.status == StorePurchaseStatus.canceled ||
        update.status == StorePurchaseStatus.error;
    _reportClosed(productId, update);
    _publish(
      PlayCheckoutClosed(
        productId: productId,
        canceled: update.status == StorePurchaseStatus.canceled,
        alreadyOwned: update.alreadyOwned,
        errorMessage: failed
            ? update.errorMessage
            : 'Google Play did not return a purchase token.',
      ),
    );
  }

  /// Play scheduled a downgrade for the renewal date and returned no purchase.
  /// It did issue a token, which carries the old plan until then and must be
  /// recorded and acknowledged now or Play refunds it: a pass over owned
  /// purchases finds it. The checkout is then settled with what the server
  /// said about it, or — when Play has not surfaced the token yet — with the
  /// billing as it stands; never as a failure, because nothing failed.
  Future<void> _settleDeferredChange(String productId, int session) async {
    final outcome = await reconcile(force: true, announce: true);
    if (_disposed || session != _session) return;
    var result = outcome.planResult;
    if (result == null) {
      try {
        final billing = await _billingRepository.getBilling();
        result = GooglePlayVerificationResult(
          purchase: const VerifiedPurchase(
            id: '',
            status: 'scheduled',
            creditsGranted: 0,
          ),
          billing: billing,
        );
      } on Object catch (error) {
        debugPrint('The scheduled plan change could not be confirmed: $error');
      }
    }
    if (_disposed || session != _session) return;
    if (result == null) {
      // Play said yes; only this phone's confirmation is missing. Published as
      // a payment whose record is late, which every surface shows as a
      // message: it used to close the checkout as an error, in error colours.
      _publish(
        PlayPurchaseNotVerified(
          productId: productId,
          message: playPlanChangeNotConfirmedMessage,
          paid: true,
        ),
      );
      return;
    }
    _onBillingChanged();
    _publish(PlayPurchaseVerified(productId: productId, result: result));
  }

  /// Purchases are settled one at a time, in the order they arrived, and each
  /// purchase once per state: Play repeats itself, and a restore can land
  /// while a reconciliation holds the same token.
  Future<GooglePlayVerificationResult?> _enqueue(
    StorePurchaseUpdate update, {
    required int session,
    required bool background,
  }) {
    final pending = update.status == StorePurchaseStatus.pending;
    final key = '${pending ? 'pending' : 'settled'}:${update.purchaseToken}';
    final queued = _queued[key];
    if (queued != null) return queued;
    final task = _tail.then<GooglePlayVerificationResult?>((_) {
      if (_disposed || session != _session) return null;
      return pending
          ? _recordPending(update, background: background)
          : _verify(update, background: background);
    });
    _queued[key] = task;
    void dequeue() => _queued.remove(key);
    _tail = task.then<void>((_) => dequeue(), onError: (Object _) => dequeue());
    return task;
  }

  Future<GooglePlayVerificationResult?> _verify(
    StorePurchaseUpdate update, {
    required bool background,
  }) async {
    final productId = update.productId;
    _publish(
      PlayPurchaseVerifying(
        productId: productId,
        restored: update.status == StorePurchaseStatus.restored,
        background: background,
      ),
    );
    // Each purchase is caught on its own: a throw here must never skip the
    // purchases queued behind it.
    try {
      final billing = await _billingRepository.getBilling();
      final product = _productFor(update, billing);
      final result = await _send(update);
      // Only after the server has recorded it: Play forgets a finished
      // purchase, and the grant is the one thing a refund cannot undo here.
      await _finish(update, consumable: product.isConsumable);
      _checkoutAccounts.remove(productId);
      _checkoutProjects.remove(productId);
      _clearAwaiting(productId, update.purchaseToken);
      _settled(productId, result, background: background);
      return result;
    } on Object catch (error) {
      final refused = _refuses(error);
      if (refused) _refused.add(update.purchaseToken);
      if (refused) _reportRefused(update, background: background);
      _publish(
        PlayPurchaseNotVerified(
          productId: productId,
          // Play settled it, so the money has moved; only a refusal is news
          // about the purchase itself. Anything else is retried.
          message: refused
              ? userFacingError(error)
              : playPaymentNotRecordedMessage,
          paid: !refused,
          background: background,
        ),
      );
      return null;
    }
  }

  Future<GooglePlayVerificationResult?> _recordPending(
    StorePurchaseUpdate update, {
    required bool background,
  }) async {
    final productId = update.productId;
    final token = update.purchaseToken;
    MobileBilling? billing;
    try {
      billing = await _billingRepository.getBilling();
    } on Object catch (error) {
      // Unreadable is not refused: the payment is pending whoever records it.
      debugPrint(
        'A pending Google Play purchase could not be recorded: $error',
      );
    }
    if (billing != null) {
      try {
        _productFor(update, billing);
      } on ApiException catch (error) {
        _refused.add(token);
        _clearAwaiting(productId, token);
        _reportRefused(update, background: background);
        _publish(
          PlayPurchaseNotVerified(
            productId: productId,
            message: error.message,
            background: background,
          ),
        );
        return null;
      }
    }
    _markAwaiting(productId, token);
    _publish(PlayPurchasePending(productId: productId, background: background));
    if (billing == null || _recordedPending.contains(token)) return null;
    try {
      // Recorded now so Google's notification finds an owner when the payment
      // clears, even if this app never runs again. Nothing is granted for it,
      // and nothing is finished: Play cannot finish a pending purchase.
      final result = await _send(update);
      _recordedPending.add(token);
      if (result.purchase.status == 'pending') return result;
      // Google settled it between Play's callback and the server's read. Play
      // reports the purchase again once its own copy catches up, and that is
      // the delivery that finishes it.
      _clearAwaiting(productId, token);
      _settled(productId, result, background: background);
      return result;
    } on Object catch (error) {
      if (!_refuses(error)) {
        debugPrint('A pending Google Play purchase was not recorded: $error');
        return null;
      }
      _refused.add(token);
      _clearAwaiting(productId, token);
      _reportRefused(update, background: background);
      _publish(
        PlayPurchaseNotVerified(
          productId: productId,
          message: userFacingError(error),
          background: background,
        ),
      );
      return null;
    }
  }

  /// A checkout Play closed without a purchase: Back, or an error.
  void _reportClosed(String productId, StorePurchaseUpdate update) {
    if (productId.isEmpty) return;
    if (update.status == StorePurchaseStatus.canceled && !update.alreadyOwned) {
      _funnel.purchaseCancelled(productId);
      return;
    }
    _funnel.purchaseFailed(
      productId,
      update.alreadyOwned
          ? PurchaseFailureReason.alreadyOwned
          : update.status == StorePurchaseStatus.error
          ? PurchaseFailureReason.playError
          : PurchaseFailureReason.noToken,
    );
  }

  /// A purchase from a checkout the server refused for good. A restore or a
  /// background pass is not a checkout, and says nothing to the funnel.
  void _reportRefused(StorePurchaseUpdate update, {required bool background}) {
    if (background || update.status == StorePurchaseStatus.restored) return;
    _funnel.purchaseFailed(update.productId, PurchaseFailureReason.refused);
  }

  MobileBillingProduct _productFor(
    StorePurchaseUpdate update,
    MobileBilling billing,
  ) {
    for (final item in billing.products) {
      _consumable[item.sku] = item.isConsumable;
    }
    final product = billing.products
        .where((item) => item.sku == update.productId)
        .firstOrNull;
    if (product == null) {
      throw const ApiException(
        code: 'GOOGLE_PLAY_PRODUCT_UNKNOWN',
        message: 'This Google Play product is not configured.',
      );
    }
    final accountId =
        update.purchaseAccountId ?? _checkoutAccounts[update.productId];
    if (accountId != null && billing.purchaseAccountId != accountId) {
      throw const ApiException(
        code: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
        message:
            'Sign in to the Tomeza account that started this purchase, then restore purchases.',
      );
    }
    return product;
  }

  Future<GooglePlayVerificationResult> _send(StorePurchaseUpdate update) {
    // The server repeats the account check against Google's receipt, closing an
    // account switch between the read above and this authenticated request.
    return _billingRepository.verifyGooglePlayPurchase(
      productId: update.productId,
      purchaseToken: update.purchaseToken,
      transactionId: update.purchaseId,
      // The route takes a settled status only. A pending purchase is sent
      // without one; Google's own state is what the server records either way.
      purchaseStatus: switch (update.status) {
        StorePurchaseStatus.purchased => 'purchased',
        StorePurchaseStatus.restored => 'restored',
        _ => null,
      },
      projectId: _checkoutProjects[update.productId],
      // Analytics only: what Play priced it at in the buyer's own currency.
      localPriceMicros: update.localPriceMicros,
      localCurrency: update.localCurrency,
    );
  }

  Future<void> _finish(
    StorePurchaseUpdate update, {
    required bool consumable,
  }) async {
    try {
      await _storeClient.finishPurchase(update, consumable: consumable);
      _finished.add(update.purchaseToken);
    } on Object catch (error) {
      // The grant stands: the server has recorded the purchase and
      // acknowledged it itself. A pack left unconsumed is found again by the
      // next reconciliation, which consumes it then.
      debugPrint('Google Play purchase could not be finished: $error');
    }
  }

  void _settled(
    String productId,
    GooglePlayVerificationResult result, {
    required bool background,
  }) {
    if (result.purchase.status == 'granted') _grantedAt[productId] = _now();
    _onBillingChanged();
    _publish(
      PlayPurchaseVerified(
        productId: productId,
        result: result,
        background: background,
      ),
    );
  }

  Future<PlayReconcileOutcome> _reconcile(
    int session, {
    required bool announce,
  }) async {
    final List<StorePurchaseUpdate> owned;
    try {
      owned = await _storeClient.queryOwnedPurchases().timeout(
        ownedQueryTimeout,
      );
    } on Object catch (error) {
      debugPrint('Google Play purchases could not be read: $error');
      return const PlayReconcileOutcome();
    }
    if (_disposed || session != _session) return const PlayReconcileOutcome();
    // A pending payment Play no longer holds was declined or abandoned.
    final held = {for (final purchase in owned) purchase.purchaseToken};
    final awaiting = _awaiting.length;
    _awaiting.removeWhere((_, token) => !held.contains(token));
    if (_awaiting.length != awaiting) notifyListeners();

    var catalogRead = false;
    final unfinished = <StorePurchaseUpdate>[];
    for (final purchase in owned) {
      final token = purchase.purchaseToken;
      if (token.trim().isEmpty || _finished.contains(token)) continue;
      if (!announce && _refused.contains(token)) continue;
      if (purchase.status == StorePurchaseStatus.pending) {
        if (!_recordedPending.contains(token)) unfinished.add(purchase);
        continue;
      }
      if (purchase.pendingCompletePurchase) {
        unfinished.add(purchase);
        continue;
      }
      // Play returns a plan for as long as it runs, so an acknowledged one is
      // finished; it returns a pack only until it is consumed, so any pack it
      // returns is not — even one the server acknowledged and granted.
      if (!_consumable.containsKey(purchase.productId) && !catalogRead) {
        catalogRead = true;
        try {
          final billing = await _billingRepository.getBilling();
          for (final item in billing.products) {
            _consumable[item.sku] = item.isConsumable;
          }
        } on Object catch (error) {
          debugPrint('The purchase catalog could not be read: $error');
        }
        if (_disposed || session != _session) {
          return const PlayReconcileOutcome();
        }
      }
      if (_consumable[purchase.productId] ?? false) unfinished.add(purchase);
    }
    final results = await Future.wait([
      for (final purchase in unfinished)
        _enqueue(purchase, session: session, background: !announce),
    ]);
    return PlayReconcileOutcome(
      checked: true,
      granted: {
        for (final (index, result) in results.indexed)
          if (result?.purchase.status == 'granted') unfinished[index].productId,
      },
      planResult: results
          .where((result) => result?.purchase.subscriptionStatus != null)
          .firstOrNull,
    );
  }

  void _markAwaiting(String productId, String token) {
    if (_awaiting[productId] == token) return;
    _awaiting[productId] = token;
    if (!_disposed) notifyListeners();
  }

  void _clearAwaiting(String productId, String token) {
    if (_awaiting[productId] != token) return;
    _awaiting.remove(productId);
    if (!_disposed) notifyListeners();
  }

  void _publish(PlayPurchaseEvent event) {
    if (!_disposed) _events.add(event);
  }

  /// A refusal the same request would only get again: the purchase belongs to
  /// another account, or names a product this catalog does not sell. An
  /// expired session, a rate limit, an unaccepted policy and a dropped
  /// connection are not, and the next pass retries them.
  static bool _refuses(Object error) =>
      error is ApiException && _refusalCodes.contains(error.code);

  static const _refusalCodes = {
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    'GOOGLE_PLAY_PRODUCT_UNKNOWN',
    'GOOGLE_PLAY_PRODUCT_MISMATCH',
    'UNKNOWN_BILLING_PRODUCT',
  };
}

final playPurchaseProcessorProvider = Provider<PlayPurchaseProcessor>((ref) {
  final processor = PlayPurchaseProcessor(
    billingRepository: ref.watch(billingRepositoryProvider),
    storeClient: ref.watch(storeBillingClientProvider),
    onBillingChanged: () => ref.invalidate(billingProvider),
    funnel: ref.watch(purchaseFunnelReporterProvider),
  );
  ref.onDispose(processor.dispose);
  return processor;
});
