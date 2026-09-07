import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../domain/voice_models.dart';

/// HTTP side of character voice calls.
///
/// The audio itself never comes through here — the app opens its own socket to
/// Gemini with the token this hands back. What stays server-side is who may
/// call, and what the call costs.
///
/// Two casts, one call. A `projectId` names a finished book's cast; null names
/// the reader's own character library, which the server serves in the same
/// shape and meters through the same heartbeat and end. Everything after the
/// start is identical, which is why it is one repository and not two.
abstract interface class VoiceRepository {
  Future<VoiceCast> getCast(String? projectId);

  /// Starts a metered call.
  ///
  /// Throws [VoiceCharacterPreparingException] when the character's persona is
  /// still being built — the caller shows that as ringing and retries, because
  /// it resolves on its own within seconds. A library character is never
  /// preparing: its persona is the reader's own notes.
  Future<VoiceCallSession> startCall({
    required String? projectId,
    required String characterId,
    int? pageIndex,
  });

  /// Reports elapsed time, and carries whatever transcript has piled up since
  /// the last report — the server never hears the call, so this is the only way
  /// the character gets a memory of it.
  Future<VoiceCallMeter> heartbeat({
    required String callId,
    required int elapsedSeconds,
    List<VoiceCallCaption> messages,
  });

  Future<VoiceCallMeter> endCall({
    required String callId,
    required int elapsedSeconds,
    String reason,
    List<VoiceCallCaption> messages,
  });
}

class VoiceCharacterPreparingException implements Exception {
  const VoiceCharacterPreparingException(this.message);

  final String message;

  @override
  String toString() => message;
}

class HttpVoiceRepository implements VoiceRepository {
  HttpVoiceRepository(this._client);

  final ApiClient _client;

  @override
  Future<VoiceCast> getCast(String? projectId) async {
    final data = await _client.getMap(
      projectId == null
          ? '/api/mobile/voice/characters'
          : '/api/mobile/projects/$projectId/voice/cast',
    );
    return VoiceCast.fromJson(data['cast'] as Map<String, dynamic>);
  }

  @override
  Future<VoiceCallSession> startCall({
    required String? projectId,
    required String characterId,
    int? pageIndex,
  }) async {
    try {
      // A library call carries no page: there is no book for one to be in,
      // and the server's body schema for it is empty.
      final data = await _client.postMap(
        projectId == null
            ? '/api/mobile/voice/characters/$characterId/calls'
            : '/api/mobile/projects/$projectId/voice/characters/$characterId/calls',
        data: {if (projectId != null) 'pageIndex': ?pageIndex},
      );
      return VoiceCallSession.fromJson(data['session'] as Map<String, dynamic>);
    } on ApiException catch (error) {
      if (error.code == 'CHARACTER_PREPARING') {
        throw VoiceCharacterPreparingException(error.message);
      }
      rethrow;
    }
  }

  @override
  Future<VoiceCallMeter> heartbeat({
    required String callId,
    required int elapsedSeconds,
    List<VoiceCallCaption> messages = const [],
  }) async {
    final data = await _client.postMap(
      '/api/mobile/voice/calls/$callId/heartbeat',
      data: {'elapsedSeconds': elapsedSeconds, ..._transcript(messages)},
    );
    return VoiceCallMeter.fromJson(data['meter'] as Map<String, dynamic>);
  }

  @override
  Future<VoiceCallMeter> endCall({
    required String callId,
    required int elapsedSeconds,
    String reason = 'ended',
    List<VoiceCallCaption> messages = const [],
  }) async {
    final data = await _client.postMap(
      '/api/mobile/voice/calls/$callId/end',
      data: {
        'elapsedSeconds': elapsedSeconds,
        'reason': reason,
        ..._transcript(messages),
      },
    );
    return VoiceCallMeter.fromJson(data['meter'] as Map<String, dynamic>);
  }

  /// Omitted rather than sent empty: the body is validated strictly, and a
  /// silent call has nothing to say.
  Map<String, dynamic> _transcript(List<VoiceCallCaption> messages) {
    if (messages.isEmpty) return const {};
    return {
      'messages': messages.map((line) => line.toJson()).toList(growable: false),
    };
  }
}

final voiceRepositoryProvider = Provider<VoiceRepository>((ref) {
  return HttpVoiceRepository(ref.watch(apiClientProvider));
});

/// The cast of one book, or — keyed by null — the reader's character library.
final voiceCastProvider = FutureProvider.family<VoiceCast, String?>((ref, projectId) {
  return ref.watch(voiceRepositoryProvider).getCast(projectId);
});
