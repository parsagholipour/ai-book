import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/message_allowance.dart';

class MessageAllowanceRepository {
  const MessageAllowanceRepository(this.apiClient);
  final ApiClient apiClient;

  Future<void> reset(MessageAllowance allowance) async {
    await apiClient.postMap(
      '/api/mobile/billing/messages/reset',
      data: {
        'resetToken': allowance.resetToken,
        'expectedCredits': allowance.resetCredits,
      },
    );
  }
}

final messageAllowanceRepositoryProvider = Provider<MessageAllowanceRepository>(
  (ref) => MessageAllowanceRepository(ref.watch(apiClientProvider)),
);
