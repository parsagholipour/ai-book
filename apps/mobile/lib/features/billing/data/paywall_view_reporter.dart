import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import 'billing_repository.dart';

/// What opened a paywall. Mirrors `PAYWALL_TRIGGERS` in
/// `apps/api/src/productEventNames.ts`; the server refuses any other word, so
/// a new one lands on both sides at once.
enum PaywallTrigger {
  creditsNeeded('credits_needed'),
  imageLimit('image_limit'),
  pageLimit('page_limit'),
  export('export'),
  messageLimit('message_limit'),
  addCredits('add_credits'),
  plans('plans'),
  madeWithCredit('made_with_credit'),
  firstBook('first_book'),
  other('other');

  const PaywallTrigger(this.wire);

  final String wire;
}

/// Tells the operator's growth funnel a paywall was shown, and why. Send and
/// forget: a failure costs the funnel one row and the reader nothing.
abstract interface class PaywallViewReporter {
  void paywallViewed(PaywallTrigger trigger);
}

class HttpPaywallViewReporter implements PaywallViewReporter {
  const HttpPaywallViewReporter(this.apiClient);

  final ApiClient apiClient;

  @override
  void paywallViewed(PaywallTrigger trigger) {
    apiClient
        .postMap(
          '/api/mobile/events',
          data: {'name': 'paywall_viewed', 'trigger': trigger.wire},
        )
        .then<void>((_) {}, onError: (Object _) {});
  }
}

class _SilentPaywallViewReporter implements PaywallViewReporter {
  const _SilentPaywallViewReporter();

  @override
  void paywallViewed(PaywallTrigger trigger) {}
}

/// The paywall the reader saw last, so a checkout started from it can say
/// where it was started (`purchase_started`'s `surface`) without every purchase
/// surface threading the trigger through to the controller. Every checkout
/// opens from a paywall (`showBillingPaywall` reports each one), and the
/// buy-credits sheet it opens inherits its trigger.
class PaywallTriggerMemory {
  PaywallTriggerMemory({DateTime Function()? clock})
    : _now = clock ?? DateTime.now;

  /// Longer than any reader spends between a paywall and its checkout; a
  /// purchase after that was not started from it.
  static const maxAge = Duration(minutes: 30);

  final DateTime Function() _now;
  PaywallTrigger? _trigger;
  DateTime? _seenAt;

  void remember(PaywallTrigger trigger) {
    _trigger = trigger;
    _seenAt = _now();
  }

  /// The last paywall's trigger, unless it was seen longer ago than [maxAge].
  PaywallTrigger? get recent {
    final seenAt = _seenAt;
    if (seenAt == null || _now().difference(seenAt) > maxAge) return null;
    return _trigger;
  }
}

final paywallTriggerMemoryProvider = Provider<PaywallTriggerMemory>((ref) {
  return PaywallTriggerMemory();
});

class _RememberingPaywallViewReporter implements PaywallViewReporter {
  const _RememberingPaywallViewReporter(this._inner, this._memory);

  final PaywallViewReporter _inner;
  final PaywallTriggerMemory _memory;

  @override
  void paywallViewed(PaywallTrigger trigger) {
    _memory.remember(trigger);
    _inner.paywallViewed(trigger);
  }
}

/// Reports only through the real billing repository, so a test that fakes
/// billing never reaches the network from here. Remembers the trigger either
/// way, for the checkout that may follow.
final paywallViewReporterProvider = Provider<PaywallViewReporter>((ref) {
  final repository = ref.watch(billingRepositoryProvider);
  return _RememberingPaywallViewReporter(
    repository is MobileBillingRepository
        ? HttpPaywallViewReporter(repository.apiClient)
        : const _SilentPaywallViewReporter(),
    ref.watch(paywallTriggerMemoryProvider),
  );
});
