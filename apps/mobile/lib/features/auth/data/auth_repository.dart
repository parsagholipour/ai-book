import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/api/auth_token_store.dart';
import '../domain/auth_models.dart';

abstract interface class AuthRepository {
  Future<AuthSession?> restoreSession();
  Future<AuthSession> signIn({required String email, required String password});
  Future<AuthSession> signInWithGoogle({
    required String idToken,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
    String? password,
  });
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
    final generation = tokenStore.generation;
    var tokens = await tokenStore.read();
    if (tokens == null || tokenStore.generation != generation) {
      return null;
    }
    if (tokens.isRefreshExpired) {
      await tokenStore.clearIfCurrent(generation);
      return null;
    }

    try {
      if (tokens.shouldRefreshAccessToken) {
        tokens = await apiClient.refreshTokens();
      }
      if (tokenStore.generation != generation) return null;

      final data = await apiClient.getMap('/api/mobile/auth/me');
      final latestTokens = await tokenStore.read() ?? tokens;
      if (tokenStore.generation != generation) return null;
      final user = AuthUser.fromJson(data['user'] as Map<String, dynamic>);
      await tokenStore.writeUserIfCurrent(generation, user);
      return AuthSession(user: user, tokens: latestTokens);
    } on ApiException catch (error) {
      if (tokenStore.generation != generation) return null;
      if (error.isAuthFailure) {
        await tokenStore.clearIfCurrent(generation);
        return null;
      }
      if (cannotReachServer(error)) {
        final offline = await _offlineSession(generation);
        if (offline != null) return offline;
      }
      rethrow;
    }
  }

  /// The session this phone already holds, opened without the server.
  ///
  /// A cold start on a plane used to stop at the splash's "Connection
  /// problem": the stored session was never in doubt, only `/auth/me` was out
  /// of reach, and every downloaded book and narration sat behind it. Nothing
  /// here vouches for the session — `AuthController` keeps asking the server
  /// and signs the reader out if it says the session is dead. Null when this
  /// install has no copy of the account (one that last ran a build which did
  /// not keep it), which leaves the retryable splash as before.
  Future<AuthSession?> _offlineSession(int generation) async {
    final user = await tokenStore.readUser();
    final tokens = await tokenStore.read();
    if (user == null || tokens == null) return null;
    if (tokenStore.generation != generation) return null;
    return AuthSession(
      // Offline nothing can be written, so the terms gate (which only refuses
      // writes) would be a wall with no door; the next online restore says
      // whether it still applies.
      user: user.copyWith(legalAcceptanceRequired: false),
      tokens: tokens,
      offline: true,
    );
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
  Future<AuthSession> signInWithGoogle({
    required String idToken,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
    String? password,
  }) {
    return _createSession(
      '/api/mobile/auth/google',
      data: {
        'idToken': idToken,
        'termsAccepted': termsAccepted,
        'ageGuardianAttested': ageGuardianAttested,
        'password': ?password,
      },
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
    final generation = tokenStore.generation;
    final tokens = await tokenStore.read();
    // Revoke local ownership before the network is involved. The captured
    // token still revokes the server session; its delayed response may never
    // clear a sign-in that happened in the meantime.
    await tokenStore.clearIfCurrent(generation);
    if (tokens != null) unawaited(_revoke(tokens.refreshToken));
  }

  /// Best effort, and not waited for: the device is signed out once its
  /// tokens are gone, and waiting held the logout spinner for up to the 32
  /// seconds of a bad network's connect and receive timeouts. A session the
  /// server never hears about lapses with its refresh token, and stops
  /// receiving book pushes once the push registrar deletes this install's
  /// notification token.
  Future<void> _revoke(String refreshToken) async {
    try {
      await apiClient.postJson(
        '/api/mobile/auth/logout',
        data: {'refreshToken': refreshToken},
        requiresAuth: false,
      );
    } catch (error) {
      debugPrint('Sign-out could not reach the server: $error');
    }
  }

  Future<AuthSession> _createSession(
    String path, {
    required Map<String, dynamic> data,
  }) async {
    final requestedAt = DateTime.now();
    final responseData = await apiClient.postMap(
      path,
      data: data,
      requiresAuth: false,
    );
    final session = AuthSession.fromJson(
      responseData,
      requestedAt: requestedAt,
    );
    await tokenStore.write(session.tokens);
    await tokenStore.writeUserIfCurrent(tokenStore.generation, session.user);
    return session;
  }
}

/// Whether a failure says only that the server was out of reach: no network,
/// a timeout, or a gateway or overloaded server answering for it. Not a
/// refusal of the session, which is [ApiException.isAuthFailure].
bool cannotReachServer(ApiException error) {
  if (error.code == 'NETWORK_ERROR') return true;
  final status = error.statusCode;
  return status != null && status >= 500;
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return MobileAuthRepository(
    apiClient: ref.watch(apiClientProvider),
    tokenStore: ref.watch(authTokenStoreProvider),
  );
});
