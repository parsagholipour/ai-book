import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import 'billing_repository.dart';
import 'paywall_view_reporter.dart';

/// Why a checkout ended without a purchase, as a class — never Play's or the
/// server's own words. Mirrors `PURCHASE_FAILURE_REASONS` in
/// `apps/api/src/productEventNames.ts`; the server refuses any other word, so
/// a new one lands on both sides at once.
enum PurchaseFailureReason {
  /// Play is not reachable here, or gave no price for the product.
  storeUnavailable('store_unavailable'),

  /// The billing account could not be read before the sheet opened.
  accountUnavailable('account_unavailable'),

  /// The store client threw, or Play refused to open the sheet.
  launchFailed('launch_failed'),

  /// Play's sheet closed with an error.
  playError('play_error'),

  /// Play said this Google account already holds the product.
  alreadyOwned('already_owned'),

  /// Play closed the sheet with no purchase token.
  noToken('no_token'),

  /// The server refused the purchase for good.
  refused('refused'),
  other('other');

  const PurchaseFailureReason(this.wire);

  final String wire;
}

/// Tells the operator's growth funnel what became of a checkout: started,
/// cancelled in Play, or failed. A completed purchase needs no event — the
/// server's payment row is the record. Send and forget: a failure costs the
/// funnel one row and the reader nothing, and nothing here may change what a
/// purchase does.
abstract interface class PurchaseFunnelReporter {
  /// The reader asked to buy [sku]; [intro] when through the intro offer.
  /// [surface] is the paywall it was started from, when the caller knows;
  /// otherwise the last paywall shown.
  void purchaseStarted({
    required String sku,
    required bool intro,
    PaywallTrigger? surface,
  });

  /// The reader backed out of Play's sheet.
  void purchaseCancelled(String sku);

  void purchaseFailed(String sku, PurchaseFailureReason reason);
}

class HttpPurchaseFunnelReporter implements PurchaseFunnelReporter {
  const HttpPurchaseFunnelReporter(this.apiClient, this.lastPaywall);

  final ApiClient apiClient;
  final PaywallTriggerMemory lastPaywall;

  @override
  void purchaseStarted({
    required String sku,
    required bool intro,
    PaywallTrigger? surface,
  }) {
    _send({
      'name': 'purchase_started',
      'sku': sku,
      'intro': intro,
      'surface': (surface ?? lastPaywall.recent ?? PaywallTrigger.other).wire,
    });
  }

  @override
  void purchaseCancelled(String sku) {
    _send({'name': 'purchase_cancelled', 'sku': sku});
  }

  @override
  void purchaseFailed(String sku, PurchaseFailureReason reason) {
    _send({'name': 'purchase_failed', 'sku': sku, 'reason': reason.wire});
  }

  void _send(Map<String, Object> event) {
    try {
      apiClient
          .postMap('/api/mobile/events', data: event)
          .then<void>((_) {}, onError: (Object _) {});
    } on Object {
      // The funnel loses one row; the purchase goes on.
    }
  }
}

class SilentPurchaseFunnelReporter implements PurchaseFunnelReporter {
  const SilentPurchaseFunnelReporter();

  @override
  void purchaseStarted({
    required String sku,
    required bool intro,
    PaywallTrigger? surface,
  }) {}

  @override
  void purchaseCancelled(String sku) {}

  @override
  void purchaseFailed(String sku, PurchaseFailureReason reason) {}
}

/// Reports only through the real billing repository, so a test that fakes
/// billing never reaches the network from here.
final purchaseFunnelReporterProvider = Provider<PurchaseFunnelReporter>((ref) {
  final repository = ref.watch(billingRepositoryProvider);
  return repository is MobileBillingRepository
      ? HttpPurchaseFunnelReporter(
          repository.apiClient,
          ref.watch(paywallTriggerMemoryProvider),
        )
      : const SilentPurchaseFunnelReporter();
});
