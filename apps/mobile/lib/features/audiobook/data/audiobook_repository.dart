import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../domain/audiobook_models.dart';

/// Talks to `/api/mobile/…/audiobook`.
abstract interface class AudiobookRepository {
  Future<List<NarratorVoice>> listVoices();

  /// The narration manifest, or null when the book has never been narrated.
  Future<MobileAudiobook?> fetch(String projectId);

  Future<MobileAudiobook?> start({
    required String projectId,
    required String voice,
    bool replace,
    String? requestId,
  });
}

class HttpAudiobookRepository implements AudiobookRepository {
  HttpAudiobookRepository(this.apiClient);

  final ApiClient apiClient;

  @override
  Future<List<NarratorVoice>> listVoices() async {
    final response = await apiClient.getJson('/api/mobile/audiobook/voices');
    final data = response.data as Map<String, dynamic>;
    return (data['voices'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(NarratorVoice.fromJson)
        .toList(growable: false);
  }

  @override
  Future<MobileAudiobook?> fetch(String projectId) async {
    try {
      final response = await apiClient.getJson(
        '/api/mobile/projects/$projectId/audiobook',
      );
      final audiobook = (response.data as Map<String, dynamic>)['audiobook'];
      return audiobook is Map<String, dynamic>
          ? MobileAudiobook.fromJson(audiobook)
          : null;
    } on ApiException catch (error) {
      // "Never narrated" is an ordinary state, not a failure to report.
      if (error.code == 'AUDIOBOOK_NOT_FOUND') {
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<MobileAudiobook?> start({
    required String projectId,
    required String voice,
    bool replace = false,
    String? requestId,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/audiobook',
      data: {
        'voice': voice,
        if (replace) 'replace': true,
        'requestId': ?requestId,
      },
    );
    final audiobook = (response.data as Map<String, dynamic>)['audiobook'];
    return audiobook is Map<String, dynamic>
        ? MobileAudiobook.fromJson(audiobook)
        : null;
  }
}

final audiobookRepositoryProvider = Provider<AudiobookRepository>((ref) {
  return HttpAudiobookRepository(ref.watch(apiClientProvider));
});

final narratorVoicesProvider = FutureProvider<List<NarratorVoice>>((ref) {
  return ref.watch(audiobookRepositoryProvider).listVoices();
});
