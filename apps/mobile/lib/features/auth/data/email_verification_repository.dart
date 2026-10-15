import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/auth_models.dart';

/// What the server said when it mailed a code.
class EmailVerificationSent {
  const EmailVerificationSent({
    required this.email,
    this.resendAfter = const Duration(seconds: 60),
  });

  /// Where the code went: the account's address.
  final String email;

  /// How long before another code may be asked for. The server refuses an
  /// earlier one with a 429, so the screen counts down the same.
  final Duration resendAfter;

  factory EmailVerificationSent.fromJson(Map<String, dynamic> json) {
    final seconds = json['resendAfterSeconds'];
    return EmailVerificationSent(
      email: json['email'] as String? ?? '',
      resendAfter: Duration(seconds: seconds is num ? seconds.round() : 60),
    );
  }
}

/// Proving the account's email address, which the welcome credits wait for.
///
/// Its own repository rather than more of `AuthRepository`: that interface is
/// hand-implemented by several test fakes, and none of them has any business
/// growing two methods only the verify screen calls.
abstract interface class EmailVerificationRepository {
  /// Mails a fresh 6-digit code. `EMAIL_ALREADY_VERIFIED` (409) means there is
  /// nothing left to do.
  Future<EmailVerificationSent> sendCode();

  /// Confirms [code]; answers the account as it now stands, verified.
  Future<AuthUser> confirm(String code);
}

class MobileEmailVerificationRepository implements EmailVerificationRepository {
  const MobileEmailVerificationRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<EmailVerificationSent> sendCode() async {
    final data = await apiClient.postMap('/api/mobile/auth/email/verification');
    return EmailVerificationSent.fromJson(data);
  }

  @override
  Future<AuthUser> confirm(String code) async {
    final data = await apiClient.postMap(
      '/api/mobile/auth/email/verification/confirm',
      data: {'code': code.trim()},
    );
    return AuthUser.fromJson(data['user'] as Map<String, dynamic>);
  }
}

final emailVerificationRepositoryProvider =
    Provider<EmailVerificationRepository>((ref) {
      return MobileEmailVerificationRepository(
        apiClient: ref.watch(apiClientProvider),
      );
    });
