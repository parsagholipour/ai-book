import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../features/auth/domain/auth_models.dart';

abstract class AuthTokenStore {
  int _generation = 0;
  Future<void>? _pending;

  /// Changes on sign-in/sign-out, but not on a refresh within that session.
  /// Advanced before storage I/O so old requests lose ownership immediately.
  int get generation => _generation;

  Future<MobileSessionTokens?> read() => _serialize(_read);

  Future<void> write(MobileSessionTokens tokens) {
    _generation++;
    return _serialize(() => _write(tokens));
  }

  Future<void> clear() {
    _generation++;
    return _serialize(_clear);
  }

  /// Rotation must not replace a sign-in that happened during the request.
  /// Serializing the actual secure-storage writes also closes the window where
  /// a refresh has checked ownership but its storage write has not finished.
  Future<bool> writeIfCurrent(int generation, MobileSessionTokens tokens) {
    return _serialize(() async {
      if (_generation != generation) return false;
      await _write(tokens);
      return _generation == generation;
    });
  }

  Future<bool> clearIfCurrent(int generation) {
    if (_generation != generation) return Future.value(false);
    return clear().then((_) => true);
  }

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final previous = _pending;
    final result = previous == null
        ? operation()
        : previous.then((_) => operation());
    late final Future<void> pending;
    void release() {
      if (identical(_pending, pending)) _pending = null;
    }

    // A failed platform write must not prevent a subsequent logout/sign-in.
    pending = result.then<void>(
      (_) => release(),
      onError: (Object _, StackTrace _) => release(),
    );
    _pending = pending;
    return result;
  }

  Future<MobileSessionTokens?> _read();
  Future<void> _write(MobileSessionTokens tokens);
  Future<void> _clear();
}

class SecureAuthTokenStore extends AuthTokenStore {
  SecureAuthTokenStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _sessionKey = 'tomeza.mobile.session.v1';

  final FlutterSecureStorage _storage;

  @override
  Future<MobileSessionTokens?> _read() async {
    final rawValue = await _storage.read(key: _sessionKey);
    if (rawValue == null || rawValue.trim().isEmpty) {
      return null;
    }

    try {
      final json = jsonDecode(rawValue) as Map<String, dynamic>;
      return MobileSessionTokens.fromJson(json);
    } catch (_) {
      // Already inside the serialized read; do not queue another operation.
      await _clear();
      return null;
    }
  }

  @override
  Future<void> _write(MobileSessionTokens tokens) {
    return _storage.write(key: _sessionKey, value: jsonEncode(tokens.toJson()));
  }

  @override
  Future<void> _clear() {
    return _storage.delete(key: _sessionKey);
  }
}

class MemoryAuthTokenStore extends AuthTokenStore {
  MemoryAuthTokenStore([this._tokens]);

  MobileSessionTokens? _tokens;

  @override
  Future<MobileSessionTokens?> _read() async => _tokens;

  @override
  Future<void> _write(MobileSessionTokens tokens) async {
    _tokens = tokens;
  }

  @override
  Future<void> _clear() async {
    _tokens = null;
  }
}

final authTokenStoreProvider = Provider<AuthTokenStore>((ref) {
  return SecureAuthTokenStore();
});
