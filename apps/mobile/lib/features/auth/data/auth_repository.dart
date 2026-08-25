import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/api/auth_token_store.dart';
import '../domain/auth_models.dart';

abstract interface class AuthRepository {
  Future<AuthSession?> restoreSession();
  Future<AuthSession> signIn({required String email, required String password});
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
  });
  Future<void> acceptCurrentLegalDocuments();
  Future<void> requestPasswordReset({required String email});
  Future<AuthSession> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  });
  Future<void> logout();
}

class MobileAuthRepository implements AuthRepository {
  const MobileAuthRepository({
    required this.apiClient,
    required this.tokenStore,
  });

  final ApiClient apiClient;
  final AuthTokenStore tokenStore;

  @override
  Future<AuthSession?> restoreSession() async {
    var tokens = await tokenStore.read();
    if (tokens == null) {
      return null;
    }
    if (tokens.isRefreshExpired) {
      await tokenStore.clear();
      return null;
    }

    try {
      if (tokens.shouldRefreshAccessToken) {
        tokens = await apiClient.refreshTokens();
      }

      final data = await apiClient.getMap('/api/mobile/auth/me');
      final latestTokens = await tokenStore.read() ?? tokens;
      return AuthSession(
        user: AuthUser.fromJson(data['user'] as Map<String, dynamic>),
        tokens: latestTokens,
      );
    } on ApiException catch (error) {
      if (error.isAuthFailure) {
        await tokenStore.clear();
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) {
    return _createSession(
      '/api/mobile/auth/signin',
      data: {'email': email.trim(), 'password': password},
    );
  }

  @override
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
  }) {
    return _createSession(
      '/api/mobile/auth/signup',
      data: {
        'email': email.trim(),
        'password': password,
        if (displayName != null && displayName.trim().isNotEmpty)
          'displayName': displayName.trim(),
        'termsAccepted': termsAccepted,
        'ageGuardianAttested': ageGuardianAttested,
      },
    );
  }

  @override
  Future<void> acceptCurrentLegalDocuments() async {
    // One tap, terms only: the server stamps the versions in force, and the
    // age/guardian attestation from signup does not expire with a terms bump.
    await apiClient.postJson(
      '/api/mobile/legal/acceptance',
      data: {'termsAccepted': true},
    );
  }

  @override
  Future<void> requestPasswordReset({required String email}) async {
    // Always answers ok for a well-formed email — the server never says
    // whether an account exists. Failures that do surface (rate limit, mail
    // not configured) are real and worth showing.
    await apiClient.postJson(
      '/api/mobile/auth/password/forgot',
      data: {'email': email.trim()},
      requiresAuth: false,
    );
  }

  @override
  Future<AuthSession> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  }) {
    // A successful reset answers with a fresh session — the reader lands in
    // the app signed in, not back at the sign-in form.
    return _createSession(
      '/api/mobile/auth/password/reset',
      data: {
        'email': email.trim(),
        'code': code.trim(),
        'newPassword': newPassword,
      },
    );
  }

  @override
  Future<void> logout() async {
    final tokens = await tokenStore.read();
    try {
      if (tokens != null) {
        await apiClient.postJson(
          '/api/mobile/auth/logout',
          data: {'refreshToken': tokens.refreshToken},
          requiresAuth: false,
        );
      }
    } finally {
      await tokenStore.clear();
    }
  }

  Future<AuthSession> _createSession(
    String path, {
    required Map<String, dynamic> data,
  }) async {
    final responseData = await apiClient.postMap(
      path,
      data: data,
      requiresAuth: false,
    );
    final session = AuthSession.fromJson(responseData);
    await tokenStore.write(session.tokens);
    return session;
  }
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return MobileAuthRepository(
    apiClient: ref.watch(apiClientProvider),
    tokenStore: ref.watch(authTokenStoreProvider),
  );
});
