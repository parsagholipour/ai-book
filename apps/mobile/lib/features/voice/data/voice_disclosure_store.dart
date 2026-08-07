import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class VoiceDisclosureStore {
  Future<bool> hasAcknowledged();
  Future<void> acknowledge();
}

class SecureVoiceDisclosureStore implements VoiceDisclosureStore {
  SecureVoiceDisclosureStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'tomeza.voice.microphone-disclosure.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<bool> hasAcknowledged() async {
    return await _storage.read(key: _key) == 'accepted';
  }

  @override
  Future<void> acknowledge() {
    return _storage.write(key: _key, value: 'accepted');
  }
}

final voiceDisclosureStoreProvider = Provider<VoiceDisclosureStore>((ref) {
  return SecureVoiceDisclosureStore();
});
