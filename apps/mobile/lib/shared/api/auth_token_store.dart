import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../features/auth/domain/auth_models.dart';

abstract interface class AuthTokenStore {
  Future<MobileSessionTokens?> read();
  Future<void> write(MobileSessionTokens tokens);
  Future<void> clear();
}

class SecureAuthTokenStore implements AuthTokenStore {
  SecureAuthTokenStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _sessionKey = 'tomeza.mobile.session.v1';

  final FlutterSecureStorage _storage;

  @override
  Future<MobileSessionTokens?> read() async {
    final rawValue = await _storage.read(key: _sessionKey);
    if (rawValue == null || rawValue.trim().isEmpty) {
      return null;
    }

    try {
      final json = jsonDecode(rawValue) as Map<String, dynamic>;
      return MobileSessionTokens.fromJson(json);
    } catch (_) {
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(MobileSessionTokens tokens) {
    return _storage.write(key: _sessionKey, value: jsonEncode(tokens.toJson()));
  }

  @override
  Future<void> clear() {
    return _storage.delete(key: _sessionKey);
  }
}

class MemoryAuthTokenStore implements AuthTokenStore {
  MemoryAuthTokenStore([this._tokens]);

  MobileSessionTokens? _tokens;

  @override
  Future<MobileSessionTokens?> read() async => _tokens;

  @override
  Future<void> write(MobileSessionTokens tokens) async {
    _tokens = tokens;
  }

  @override
  Future<void> clear() async {
    _tokens = null;
  }
}

final authTokenStoreProvider = Provider<AuthTokenStore>((ref) {
  return SecureAuthTokenStore();
});
