import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/billing_models.dart';

/// Credit history reads on its own repository rather than on
/// [BillingRepository]: nothing in the purchase flow needs it, and the paywall's
/// controller should not grow a second thing to keep in sync.
abstract interface class CreditLogRepository {
  Future<CreditLogPage> getCreditLog({String? cursor, int limit});
}

class MobileCreditLogRepository implements CreditLogRepository {
  const MobileCreditLogRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<CreditLogPage> getCreditLog({String? cursor, int limit = 30}) async {
    final path = Uri(
      path: '/api/mobile/billing/credit-log',
      queryParameters: <String, String>{'limit': '$limit', 'cursor': ?cursor},
    ).toString();
    final data = await apiClient.getMap(path);
    return CreditLogPage.fromJson(data['log'] as Map<String, dynamic>);
  }
}

final creditLogRepositoryProvider = Provider<CreditLogRepository>((ref) {
  return MobileCreditLogRepository(apiClient: ref.watch(apiClientProvider));
});
