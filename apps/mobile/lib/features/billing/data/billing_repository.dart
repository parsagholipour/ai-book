import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/billing_models.dart';

abstract interface class BillingRepository {
  Future<MobileBilling> getBilling();

  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  });
}

class MobileBillingRepository implements BillingRepository {
  const MobileBillingRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<MobileBilling> getBilling() async {
    final response = await apiClient.getJson('/api/mobile/billing');
    final data = response.data as Map<String, dynamic>;
    return MobileBilling.fromJson(data['billing'] as Map<String, dynamic>);
  }

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  }) async {
    final payload = <String, dynamic>{
      'productId': productId,
      'purchaseToken': purchaseToken,
    };
    if (transactionId != null) {
      payload['transactionId'] = transactionId;
    }
    if (purchaseStatus != null) {
      payload['purchaseStatus'] = purchaseStatus;
    }
    if (projectId != null) {
      payload['projectId'] = projectId;
    }
    final response = await apiClient.postJson(
      '/api/mobile/billing/google-play/verify',
      data: payload,
    );
    return GooglePlayVerificationResult.fromJson(
      response.data as Map<String, dynamic>,
    );
  }
}

final billingRepositoryProvider = Provider<BillingRepository>((ref) {
  return MobileBillingRepository(apiClient: ref.watch(apiClientProvider));
});

final billingProvider = FutureProvider.autoDispose<MobileBilling>((ref) {
  return ref.watch(billingRepositoryProvider).getBilling();
});
