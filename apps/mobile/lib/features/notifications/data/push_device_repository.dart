import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import 'push_messaging.dart';

/// Where this install's book notifications go (`PUT` / `DELETE
/// /api/mobile/push-device`). The server binds the token to the session
/// that filed it, so signing out needs no call here (but see
/// [PushRegistrar.signOut] for the session the server never heard end).
abstract interface class PushDeviceRepository {
  Future<void> register({required String token, required String platform});
  Future<void> unregister(String token);
}

class MobilePushDeviceRepository implements PushDeviceRepository {
  const MobilePushDeviceRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<void> register({required String token, required String platform}) {
    return apiClient.putJson(
      '/api/mobile/push-device',
      data: {'token': token, 'platform': platform},
    );
  }

  @override
  Future<void> unregister(String token) {
    return apiClient.deleteJson(
      '/api/mobile/push-device',
      data: {'token': token},
    );
  }
}

final pushDeviceRepositoryProvider = Provider<PushDeviceRepository>((ref) {
  return MobilePushDeviceRepository(apiClient: ref.watch(apiClientProvider));
});

/// Keeps the server's copy of this install's token in step with who is signed
/// in and whether notifications are allowed. Asked after sign-in, on resume
/// (the reader may have changed the setting) and when Firebase rotates the
/// token; it calls the server only when the answer changed.
class PushRegistrar {
  PushRegistrar({required this._messaging, required this._repository});

  final PushMessaging _messaging;
  final PushDeviceRepository _repository;

  /// `userId|token` as last filed in this run, or null.
  String? _filed;

  /// The token last withdrawn in this run, so a reader who said no is not
  /// withdrawn again on every resume.
  String? _withdrawn;

  Future<void>? _inFlight;

  Future<void> sync({required String? userId}) {
    return _queue(() => _sync(userId));
  }

  /// The account on this install is gone — logged out, or its session ended.
  /// Its notifications come down and the token it filed is deleted, because
  /// the server's copy dies with the session only if the server heard about
  /// the logout: offline, or with a session the server still thinks live, it
  /// kept sending the old account's books. The next sign-in's [sync] files the
  /// fresh token Firebase issues.
  Future<void> signOut() {
    return _queue(() async {
      _filed = null;
      _withdrawn = null;
      await _messaging.clearBookNotifications();
      await _messaging.deleteToken();
    });
  }

  Future<void> _queue(Future<void> Function() step) {
    // One at a time: resume, a token refresh and a sign-out can land together.
    final previous = _inFlight ?? Future<void>.value();
    final next = previous.then((_) => step()).catchError((_) {});
    _inFlight = next;
    return next;
  }

  Future<void> _sync(String? userId) async {
    if (userId == null) {
      // Signed out: the logout revoked the session the server filed the token
      // under. The next account to sign in files it afresh.
      _filed = null;
      return;
    }
    final token = await _messaging.token();
    if (token == null) return;
    final permission = await _messaging.permission();
    if (permission == PushPermission.granted) {
      final key = '$userId|$token';
      if (_filed == key) return;
      await _repository.register(token: token, platform: _messaging.platform);
      _filed = key;
      _withdrawn = null;
      return;
    }
    // Never asked means never filed; only a reader who refused, or turned
    // notifications off in the phone's settings, has a token to withdraw.
    if (permission == PushPermission.notAsked || _withdrawn == token) return;
    await _repository.unregister(token);
    _withdrawn = token;
    _filed = null;
  }
}

final pushRegistrarProvider = Provider<PushRegistrar?>((ref) {
  final messaging = ref.watch(pushMessagingProvider);
  if (messaging == null) return null;
  return PushRegistrar(
    messaging: messaging,
    repository: ref.watch(pushDeviceRepositoryProvider),
  );
});
