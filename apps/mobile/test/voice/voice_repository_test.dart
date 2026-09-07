import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/shared/api/api_client.dart';

/// Which route a call goes to is decided by one thing: whether there is a
/// book. A `projectId` is the book's cast; null is the reader's own library,
/// which the server meters through the very same heartbeat and end.
void main() {
  Map<String, dynamic> castJson() => {
    'cast': {
      'characters': const <dynamic>[],
      'creditsPerMinute': 60,
      'creditsToStart': 180,
      'availableCredits': 600,
      'maxCallSeconds': 1800,
    },
  };

  Map<String, dynamic> sessionJson() => {
    'session': {
      'callId': 'call-1',
      'characterId': 'lib-1',
      'characterName': 'Mina',
      'token': 'auth_tokens/abc',
      'model': 'gemini-live',
      'inputSampleRate': 16000,
      'outputSampleRate': 24000,
      'secondsRemaining': 180,
      'creditsPerMinute': 60,
      'heartbeatSeconds': 20,
      'maxCallSeconds': 1800,
    },
  };

  test('reads a book cast from the book, and the library from the library', () async {
    final client = _FakeApiClient()..nextData = castJson();
    final repository = HttpVoiceRepository(client);

    await repository.getCast('project-1');
    await repository.getCast(null);

    expect(client.paths, [
      '/api/mobile/projects/project-1/voice/cast',
      '/api/mobile/voice/characters',
    ]);
  });

  test('places a book call with the page, and a library call with nothing', () async {
    final client = _FakeApiClient()..nextData = sessionJson();
    final repository = HttpVoiceRepository(client);

    await repository.startCall(
      projectId: 'project-1',
      characterId: 'character-1',
      pageIndex: 4,
    );
    await repository.startCall(projectId: null, characterId: 'lib-1', pageIndex: 4);

    expect(client.paths, [
      '/api/mobile/projects/project-1/voice/characters/character-1/calls',
      '/api/mobile/voice/characters/lib-1/calls',
    ]);
    expect(client.bodies.first, {'pageIndex': 4});
    // No book, no page: a library call is never scoped, whatever it is handed.
    expect(client.bodies.last, isEmpty);
  });
}

class _FakeApiClient implements ApiClient {
  final paths = <String>[];
  final bodies = <Object?>[];
  Object? nextData;

  @override
  Future<Map<String, dynamic>> getMap(String path, {bool requiresAuth = true}) async {
    paths.add(path);
    return nextData as Map<String, dynamic>;
  }

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async {
    paths.add(path);
    bodies.add(data);
    return nextData as Map<String, dynamic>;
  }

  @override
  Dio get dio => throw UnimplementedError();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
