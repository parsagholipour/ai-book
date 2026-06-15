import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/billing_models.dart';

abstract interface class BillingRepository {
  Future<MobileBilling> getBilling();
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
}

final billingRepositoryProvider = Provider<BillingRepository>((ref) {
  return MobileBillingRepository(apiClient: ref.watch(apiClientProvider));
});

final billingProvider = FutureProvider.autoDispose<MobileBilling>((ref) {
  return ref.watch(billingRepositoryProvider).getBilling();
});
