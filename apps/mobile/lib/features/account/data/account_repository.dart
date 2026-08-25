import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';

abstract interface class AccountRepository {
  Future<AccountDeletionRequestReceipt> requestAccountDeletion({
    String? reason,
  });
}

class MobileAccountRepository implements AccountRepository {
  const MobileAccountRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<AccountDeletionRequestReceipt> requestAccountDeletion({
    String? reason,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/account/deletion-request',
      data: {
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
    return AccountDeletionRequestReceipt.fromJson(
      data['request'] as Map<String, dynamic>,
    );
  }
}

class AccountDeletionRequestReceipt {
  const AccountDeletionRequestReceipt({
    required this.id,
    required this.status,
    required this.email,
    required this.requestedAt,
    this.reason,
    this.completedAt,
  });

  final String id;
  final String status;
  final String email;
  final String? reason;
  final DateTime requestedAt;
  final DateTime? completedAt;

  factory AccountDeletionRequestReceipt.fromJson(Map<String, dynamic> json) {
    return AccountDeletionRequestReceipt(
      id: json['id'] as String,
      status: json['status'] as String,
      email: json['email'] as String,
      reason: json['reason'] as String?,
      requestedAt: DateTime.parse(json['requestedAt'] as String),
      completedAt: json['completedAt'] == null
          ? null
          : DateTime.parse(json['completedAt'] as String),
    );
  }
}

final accountRepositoryProvider = Provider<AccountRepository>((ref) {
  return MobileAccountRepository(apiClient: ref.watch(apiClientProvider));
});
