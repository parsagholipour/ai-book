import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/billing_models.dart';

abstract interface class BillingRepository {
  Future<MobileBilling> getBilling();

  /// [localPriceMicros] and [localCurrency] are what Play priced the purchase
  /// at for the buyer — analytics only, sent only together.
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
    int? localPriceMicros,
    String? localCurrency,
  });

  /// Ask the server to re-check the subscription with Google.
  ///
  /// Cancelling happens in the Play subscription centre, outside the app, and
  /// the server's renewal sweep would not notice until the period ended — so a
  /// reader coming back from Play needs this to see the new state.
  Future<MobileBilling> refreshSubscription();

  /// End the subscription now. Only backends running the mock Play verifier
  /// accept this; against real Play the app deep-links to Play instead.
  Future<MobileBilling> cancelSubscription();
}

class MobileBillingRepository implements BillingRepository {
  const MobileBillingRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<MobileBilling> getBilling() async {
    final data = await apiClient.getMap('/api/mobile/billing');
    return MobileBilling.fromJson(data['billing'] as Map<String, dynamic>);
  }

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
    int? localPriceMicros,
    String? localCurrency,
  }) async {
    final payload = <String, dynamic>{
      'productId': productId,
      'purchaseToken': purchaseToken,
    };
    // Play has no order id yet for a pending payment or a promo code, and the
    // plugin hands that over as ''. Servers before 2026-10 refused a blank one
    // outright, which left the payment unrecorded, unacknowledged and refunded.
    final orderId = transactionId?.trim();
    if (orderId != null && orderId.isNotEmpty) {
      payload['transactionId'] = orderId;
    }
    if (localPriceMicros != null &&
        localPriceMicros >= 0 &&
        localCurrency != null &&
        RegExp(r'^[A-Z]{3}$').hasMatch(localCurrency)) {
      payload['localPriceMicros'] = localPriceMicros;
      payload['localCurrency'] = localCurrency;
    }
    if (purchaseStatus != null) {
      payload['purchaseStatus'] = purchaseStatus;
    }
    if (projectId != null) {
      payload['projectId'] = projectId;
    }
    final data = await apiClient.postMap(
      '/api/mobile/billing/google-play/verify',
      data: payload,
    );
    return GooglePlayVerificationResult.fromJson(data);
  }

  @override
  Future<MobileBilling> refreshSubscription() {
    return _postBilling('/api/mobile/billing/subscription/refresh');
  }

  @override
  Future<MobileBilling> cancelSubscription() {
    return _postBilling('/api/mobile/billing/subscription/cancel');
  }

  Future<MobileBilling> _postBilling(String path) async {
    final data = await apiClient.postMap(path);
    return MobileBilling.fromJson(data['billing'] as Map<String, dynamic>);
  }
}

final billingRepositoryProvider = Provider<BillingRepository>((ref) {
  return MobileBillingRepository(apiClient: ref.watch(apiClientProvider));
});

final billingProvider = FutureProvider.autoDispose<MobileBilling>((ref) {
  return ref.watch(billingRepositoryProvider).getBilling();
});
