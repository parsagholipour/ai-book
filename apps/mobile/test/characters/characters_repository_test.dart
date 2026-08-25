import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

Map<String, dynamic> characterJson({
  String id = 'char-1',
  String name = 'Mina',
  String portraitStatus = 'none',
}) {
  return {
    'id': id,
    'name': name,
    'description': 'Brave',
    'mentions': const <dynamic>[],
    'fields': [
      {'key': 'Age', 'value': '9'},
    ],
    'portraitStatus': portraitStatus,
    'portraitError': null,
    'hasPhoto': false,
    'photoUrl': null,
    'portraitUrl': null,
    'createdAt': '2026-08-01T10:00:00.000Z',
    'updatedAt': '2026-08-01T10:00:00.000Z',
  };
}

class _Call {
  const _Call(this.method, this.path, this.data);

  final String method;
  final String path;
  final Object? data;
}

class _FakeApiClient implements ApiClient {
  // The public name belongs to the overridden `dio` getter, so an
  // initializing formal cannot be used here.
  // ignore: prefer_initializing_formals
  _FakeApiClient({Dio? dio}) : _dio = dio;

  final Dio? _dio;
  final calls = <_Call>[];
  Object? nextData;
  ApiException? failWith;
  int tokenRefreshes = 0;
  Map<String, String>? putQueryParameters;
  List<int>? putBytesSent;

  @override
  Dio get dio => _dio!;

  Future<Response<dynamic>> _respond(
    String method,
    String path,
    Object? data,
  ) async {
    calls.add(_Call(method, path, data));
    final failure = failWith;
    if (failure != null) throw failure;
    return Response<dynamic>(
      requestOptions: RequestOptions(path: path),
      data: nextData ?? const <String, dynamic>{},
      statusCode: 200,
    );
  }

  Future<Map<String, dynamic>> _respondMap(
    String method,
    String path,
    Object? data,
  ) async {
    final response = await _respond(method, path, data);
    return response.data as Map<String, dynamic>;
  }

  @override
  Future<Response<dynamic>> getJson(String path, {bool requiresAuth = true}) {
    return _respond('GET', path, null);
  }

  @override
  Future<Map<String, dynamic>> getMap(String path, {bool requiresAuth = true}) {
    return _respondMap('GET', path, null);
  }

  @override
  Future<Response<dynamic>> postJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) {
    return _respond('POST', path, data);
  }

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) {
    return _respondMap('POST', path, data);
  }

  @override
  Future<Response<dynamic>> patchJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _respond('PATCH', path, data);
  }

  @override
  Future<Response<dynamic>> deleteJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _respond('DELETE', path, data);
  }

  /// Records the shared byte transport instead of performing it: what the
  /// transport itself does is `ApiClient`'s own test's problem now.
  @override
  Future<Response<dynamic>> putBytes(
    String path, {
    required List<int> bytes,
    Map<String, String>? queryParameters,
    void Function(int sent, int total)? onSendProgress,
  }) {
    putQueryParameters = queryParameters;
    putBytesSent = bytes;
    onSendProgress?.call(bytes.length, bytes.length);
    return _respond('PUT', path, null);
  }

  @override
  Future<Map<String, String>> authHeaders() async {
    return {'Authorization': 'Bearer first-token'};
  }

  @override
  Future<MobileSessionTokens> refreshTokens() async {
    tokenRefreshes++;
    return MobileSessionTokens(
      accessToken: 'refreshed-token',
      accessTokenExpiresAt: DateTime.now().add(const Duration(hours: 1)),
      refreshToken: 'refresh',
      refreshTokenExpiresAt: DateTime.now().add(const Duration(days: 30)),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _FakeApiClient api;
  late MobileCharactersRepository repository;

  setUp(() {
    api = _FakeApiClient();
    repository = MobileCharactersRepository(apiClient: api);
  });

  test('list parses the characters and the portrait price', () async {
    api.nextData = {
      'characters': [characterJson(), characterJson(id: 'char-2')],
      'portraitCredits': 40,
    };

    final library = await repository.list();

    expect(api.calls.single.method, 'GET');
    expect(api.calls.single.path, '/api/mobile/characters');
    expect(library.characters, hasLength(2));
    expect(library.portraitCredits, 40);
  });

  test('create posts the full payload and returns the character', () async {
    api.nextData = {'character': characterJson()};

    final created = await repository.create(
      name: 'Mina',
      description: 'Brave',
      fields: const [CharacterField(key: 'Age', value: '9')],
    );

    expect(api.calls.single.method, 'POST');
    expect(api.calls.single.path, '/api/mobile/characters');
    expect(api.calls.single.data, {
      'name': 'Mina',
      'description': 'Brave',
      'fields': [
        {'key': 'Age', 'value': '9'},
      ],
      'mentionedCharacterIds': [],
    });
    expect(created.name, 'Mina');
  });

  test('create lets a CHARACTER_NAME_TAKEN refusal through unchanged', () {
    api.failWith = const ApiException(
      code: 'CHARACTER_NAME_TAKEN',
      message: 'You already have a character with that name.',
      statusCode: 409,
    );

    expect(
      () => repository.create(name: 'Mina'),
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'CHARACTER_NAME_TAKEN',
        ),
      ),
    );
  });

  test('update sends only what changed', () async {
    api.nextData = {'character': characterJson(name: 'Nova')};

    await repository.update(id: 'char-1', name: 'Nova');

    expect(api.calls.single.method, 'PATCH');
    expect(api.calls.single.path, '/api/mobile/characters/char-1');
    expect(api.calls.single.data, {'name': 'Nova'});
  });

  test('create and update send durable character mention ids', () async {
    api.nextData = {'character': characterJson()};

    await repository.create(
      name: 'Mina',
      description: 'Friends with @Bram.',
      mentionedCharacterIds: const ['char-2'],
    );
    expect(
      (api.calls.single.data as Map<String, dynamic>)['mentionedCharacterIds'],
      ['char-2'],
    );

    api.calls.clear();
    await repository.update(
      id: 'char-1',
      description: 'Friends with @Bram.',
      mentionedCharacterIds: const ['char-2'],
    );
    expect(api.calls.single.data, {
      'description': 'Friends with @Bram.',
      'mentionedCharacterIds': ['char-2'],
    });
  });

  test('delete hits the character route', () async {
    api.nextData = {'deleted': true};

    await repository.delete('char-1');

    expect(api.calls.single.method, 'DELETE');
    expect(api.calls.single.path, '/api/mobile/characters/char-1');
  });

  test('deletePhoto returns the character without its photo', () async {
    api.nextData = {'character': characterJson()};

    final updated = await repository.deletePhoto('char-1');

    expect(api.calls.single.method, 'DELETE');
    expect(api.calls.single.path, '/api/mobile/characters/char-1/photo');
    expect(updated.hasPhoto, isFalse);
  });

  test('generatePortrait returns the character and the charge', () async {
    api.nextData = {
      'character': characterJson(portraitStatus: 'queued'),
      'creditsCharged': 40,
    };

    final started = await repository.generatePortrait(id: 'char-1');

    expect(api.calls.single.method, 'POST');
    expect(api.calls.single.path, '/api/mobile/characters/char-1/portrait');
    expect(api.calls.single.data, const <String, dynamic>{});
    expect(started.character.portraitStatus, CharacterPortraitStatus.queued);
    expect(started.creditsCharged, 40);
  });

  test(
    'generatePortrait forwards a requestId for idempotent retries',
    () async {
      api.nextData = {
        'character': characterJson(portraitStatus: 'queued'),
        'creditsCharged': 40,
      };

      await repository.generatePortrait(
        id: 'char-1',
        requestId: 'req-12345678',
      );

      expect(api.calls.single.data, {'requestId': 'req-12345678'});
    },
  );

  test('uploadPhoto goes through the shared byte transport', () async {
    // The repository used to carry its own PUT, a copy of `ApiClient.postBytes`
    // plus a copy of its error mapping. The transport's own assertions live in
    // `test/shared/api/api_client_test.dart` now; what is this feature's to get
    // right is the path, the metadata, and passing the progress callback
    // through — a 20 MB photo with no bar reads as a broken upload.
    api.nextData = {'character': characterJson()};
    final progress = <int>[];

    final updated = await repository.uploadPhoto(
      id: 'char-1',
      filename: 'face.jpg',
      bytes: const [1, 2, 3],
      mimeType: 'image/jpeg',
      onProgress: (sent, total) => progress.add(sent),
    );

    expect(api.calls.single.method, 'PUT');
    expect(api.calls.single.path, '/api/mobile/characters/char-1/photo');
    expect(api.putQueryParameters, {
      'filename': 'face.jpg',
      'mimeType': 'image/jpeg',
    });
    expect(api.putBytesSent, const [1, 2, 3]);
    expect(progress, [3]);
    expect(updated.name, 'Mina');
  });
}
