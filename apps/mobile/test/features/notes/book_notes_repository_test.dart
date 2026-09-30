import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notes/data/book_notes_repository.dart';
import 'package:tomeza/features/notes/domain/book_note.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

Map<String, dynamic> _noteJson({String id = 'n1', int revision = 1}) => {
  'id': id,
  'title': 'Plot',
  'body': 'The storm.',
  'pinned': false,
  'revision': revision,
  'createdAt': '2026-09-01T10:00:00.000Z',
  'editedAt': '2026-09-01T10:00:00.000Z',
};

/// Answers every request with [nextData], or throws [failWith].
class _FakeApiClient implements ApiClient {
  final calls = <({String method, String path, Object? data})>[];
  Object? nextData;
  ApiException? failWith;

  Future<Response<dynamic>> _respond(
    String method,
    String path,
    Object? data,
  ) async {
    calls.add((method: method, path: path, data: data));
    final failure = failWith;
    if (failure != null) throw failure;
    return Response<dynamic>(
      requestOptions: RequestOptions(path: path),
      data: nextData ?? const <String, dynamic>{},
      statusCode: 200,
    );
  }

  @override
  Future<Map<String, dynamic>> getMap(
    String path, {
    bool requiresAuth = true,
  }) async => (await _respond('GET', path, null)).data as Map<String, dynamic>;

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async => (await _respond('POST', path, data)).data as Map<String, dynamic>;

  @override
  Future<Response<dynamic>> patchJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) => _respond('PATCH', path, data);

  @override
  Future<Response<dynamic>> deleteJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) => _respond('DELETE', path, data);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _FakeApiClient api;
  late MobileBookNotesRepository repository;

  setUp(() {
    api = _FakeApiClient();
    repository = MobileBookNotesRepository(apiClient: api);
  });

  test('lists a book\'s notes', () async {
    api.nextData = {
      'notes': [_noteJson(), _noteJson(id: 'n2')],
      'limit': 200,
    };
    final notes = await repository.listNotes('p1');
    expect(api.calls.single.path, '/api/mobile/projects/p1/notes');
    expect(notes.map((note) => note.id), ['n1', 'n2']);
  });

  test('creates with the request id, title, body and pin', () async {
    api.nextData = {'note': _noteJson()};
    final note = await repository.createNote(
      'p1',
      requestId: 'note-123456',
      title: 'Plot',
      body: 'The storm.',
      pinned: true,
    );
    expect(note.id, 'n1');
    expect(api.calls.single.method, 'POST');
    expect(api.calls.single.data, {
      'requestId': 'note-123456',
      'title': 'Plot',
      'body': 'The storm.',
      'pinned': true,
    });
  });

  test(
    'a text save sends its base revision; a pin sends only the pin',
    () async {
      api.nextData = {'note': _noteJson(revision: 3)};
      await repository.updateNote(
        'p1',
        'n1',
        title: 'A',
        body: 'B',
        baseRevision: 2,
      );
      await repository.updateNote('p1', 'n1', pinned: true);
      expect(api.calls[0].path, '/api/mobile/projects/p1/notes/n1');
      expect(api.calls[0].data, {'title': 'A', 'body': 'B', 'baseRevision': 2});
      expect(api.calls[1].data, {'pinned': true});
    },
  );

  test('NOTE_CONFLICT carries the server copy out of the error', () async {
    api.failWith = ApiException(
      code: 'NOTE_CONFLICT',
      message: 'Choose which version to keep.',
      statusCode: 409,
      details: {'code': 'NOTE_CONFLICT', 'note': _noteJson(revision: 7)},
    );
    await expectLater(
      repository.updateNote('p1', 'n1', body: 'mine', baseRevision: 6),
      throwsA(
        isA<BookNoteConflictException>().having(
          (conflict) => conflict.note.revision,
          'server revision',
          7,
        ),
      ),
    );
  });

  test('deleting a note that is already gone is done', () async {
    api.failWith = const ApiException(
      code: 'NOTE_NOT_FOUND',
      message: 'That note no longer exists.',
      statusCode: 404,
    );
    await repository.deleteNote('p1', 'n1');
    api.failWith = const ApiException(
      code: 'PROJECT_NOT_FOUND',
      message: 'Not found.',
      statusCode: 404,
    );
    await repository.deleteNote('p1', 'n1');
    expect(api.calls, hasLength(2));
  });

  test('any other delete failure is the caller\'s to show', () async {
    api.failWith = const ApiException(
      code: 'NETWORK_ERROR',
      message: 'Check your connection and try again.',
    );
    await expectLater(
      repository.deleteNote('p1', 'n1'),
      throwsA(isA<ApiException>()),
    );
  });
}
