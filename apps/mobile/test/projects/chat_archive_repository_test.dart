import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/shared/api/api_client.dart';

void main() {
  test('sidebar and archived lists request separate server views', () async {
    final api = _ArchiveApiClient();
    final repository = MobileCreationRepository(apiClient: api);
    expect((await repository.listSessions()).single.draftId, 'draft-1');
    expect((await repository.listArchivedSessions()).single.draftId, 'draft-1');
    expect(api.paths, [
      '/api/mobile/creation-sessions',
      '/api/mobile/creation-sessions?archived=true',
    ]);
  });

  test(
    'archive and unarchive send explicit booleans to the same chat',
    () async {
      final api = _ArchiveApiClient();
      final repository = MobileCreationRepository(apiClient: api);
      await repository.setSessionArchived(draftId: 'draft-1', archived: true);
      await repository.setSessionArchived(draftId: 'draft-1', archived: false);
      expect(api.paths, [
        '/api/mobile/creation-sessions/draft-1/archive',
        '/api/mobile/creation-sessions/draft-1/archive',
      ]);
      expect(api.bodies, [
        {'archived': true},
        {'archived': false},
      ]);
    },
  );

  test(
    'cached archived chats can be opened by ID without becoming the auto-resume chat',
    () {
      final cache = CreationConversationCache();
      final original = _conversation();
      cache.write(original);
      expect(cache.readActive(), same(original));
      final archived = _conversation(archived: true);
      cache.write(archived);
      expect(cache.readActive(), isNull);
      expect(cache.readById('draft-1'), same(archived));
      cache.updateTitle(draftId: 'draft-1', title: 'Renamed');
      expect(cache.readById('draft-1')!.session!.archived, isTrue);
      cache.write(_conversation(archived: false));
      expect(cache.readActive()!.session!.draftId, 'draft-1');
    },
  );

  test('sessions from older servers default to unarchived', () {
    expect(_conversation().session!.archived, isFalse);
  });

  test('a stale unarchived conversation write cannot undo a local archive', () {
    final cache = CreationConversationCache();
    cache.write(_conversation());
    cache.setArchived('draft-1', true);
    expect(cache.readActive(), isNull);
    expect(cache.readById('draft-1')!.session!.archived, isTrue);

    cache.write(_conversation(archived: false));

    expect(cache.readActive(), isNull);
    expect(cache.readById('draft-1')!.session!.archived, isTrue);
  });

  test('archiveGeneration increments on setArchived', () {
    final cache = CreationConversationCache();
    expect(cache.archiveGeneration, 0);
    cache.setArchived('draft-1', true);
    expect(cache.archiveGeneration, 1);
    cache.setArchived('draft-1', false);
    expect(cache.archiveGeneration, 2);
  });

  test('a stale archived conversation write cannot undo a local restore', () {
    final cache = CreationConversationCache();
    cache.write(_conversation(archived: true));
    cache.setArchived('draft-1', false);
    expect(cache.readActive()!.session!.draftId, 'draft-1');
    expect(cache.readById('draft-1')!.session!.archived, isFalse);

    cache.write(_conversation(archived: true));

    expect(cache.readActive()!.session!.archived, isFalse);
    expect(cache.readById('draft-1')!.session!.archived, isFalse);
  });
}

MobileCreationConversationResponse _conversation({bool? archived}) =>
    MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': 'My story',
        'status': 'ACTIVE',
        'archived': ?archived,
        'updatedAt': '2026-09-10T00:00:00.000Z',
      },
      'turn': {
        'brief': <String, dynamic>{},
        'presets': {
          'bookType': 'short_story',
          'lengthPreset': 'short',
          'qualityPreset': 'balanced',
        },
        'readiness': <String, dynamic>{},
      },
    });

class _ArchiveApiClient implements ApiClient {
  final paths = <String>[];
  final bodies = <Object?>[];

  @override
  Future<Map<String, dynamic>> getMap(
    String path, {
    bool requiresAuth = true,
  }) async {
    expect(requiresAuth, isTrue);
    paths.add(path);
    return {
      'sessions': [
        {
          'draftId': 'draft-1',
          'title': 'My story',
          'preview': 'A story about the sea',
          'messageCount': 2,
          'status': 'ACTIVE',
          'createdAt': '2026-09-10T00:00:00.000Z',
          'updatedAt': '2026-09-10T00:00:00.000Z',
        },
      ],
    };
  }

  @override
  Future<Response<dynamic>> patchJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) async {
    expect(requiresAuth, isTrue);
    paths.add(path);
    bodies.add(data);
    return Response(
      requestOptions: RequestOptions(path: path),
      data: {'ok': true},
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}
