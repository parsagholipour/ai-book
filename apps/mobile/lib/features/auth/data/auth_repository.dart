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

      final response = await apiClient.getJson('/api/mobile/auth/me');
      final data = response.data as Map<String, dynamic>;
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
    final response = await apiClient.postJson(
      path,
      data: data,
      requiresAuth: false,
    );
    final session = AuthSession.fromJson(response.data as Map<String, dynamic>);
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
