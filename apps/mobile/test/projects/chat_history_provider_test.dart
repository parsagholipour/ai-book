import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';

void main() {
  test(
    'only one next-page request runs and overlapping chats are deduplicated',
    () async {
      final tail = Completer<MobileChatSessionPage>();
      final repository = _Repository(
        (cursor, _) async => cursor == null
            ? _page(['one', 'two'], cursor: 'next')
            : tail.future,
      );
      final container = ProviderContainer.test(
        overrides: [creationRepositoryProvider.overrideWithValue(repository)],
      );
      await container.read(chatSessionsProvider.future);
      final controller = container.read(chatSessionsProvider.notifier);
      final first = controller.loadMore();
      await controller.loadMore();
      expect(repository.cursors, [null, 'next']);
      expect(
        container.read(chatSessionsProvider).requireValue.loadingMore,
        isTrue,
      );
      tail.complete(_page(['two', 'three']));
      await first;
      expect(_ids(container), ['one', 'two', 'three']);
      await controller.loadMore();
      expect(repository.cursors, [null, 'next']);
    },
  );

  test(
    'a failed page preserves the list and cursor until an explicit retry',
    () async {
      var offline = true;
      final repository = _Repository((cursor, _) async {
        if (cursor == null) return _page(['one'], cursor: 'next');
        if (offline) throw Exception('offline');
        return _page(['two']);
      });
      final container = ProviderContainer.test(
        overrides: [creationRepositoryProvider.overrideWithValue(repository)],
      );
      await container.read(chatSessionsProvider.future);
      final controller = container.read(chatSessionsProvider.notifier);
      await controller.loadMore();
      expect(_ids(container), ['one']);
      expect(
        container.read(chatSessionsProvider).requireValue.loadMoreFailed,
        isTrue,
      );
      await controller.loadMore();
      expect(repository.cursors, [null, 'next']);
      offline = false;
      await controller.loadMore(retry: true);
      expect(_ids(container), ['one', 'two']);
      expect(
        container.read(chatSessionsProvider).requireValue.loadMoreFailed,
        isFalse,
      );
    },
  );

  test('a stale page cannot append after a refresh', () async {
    final tail = Completer<MobileChatSessionPage>();
    var refreshed = false;
    final repository = _Repository(
      (cursor, _) async => cursor != null
          ? tail.future
          : _page([refreshed ? 'fresh' : 'old'], cursor: 'next'),
    );
    final container = ProviderContainer.test(
      overrides: [creationRepositoryProvider.overrideWithValue(repository)],
    );
    await container.read(chatSessionsProvider.future);
    final staleRequest = container
        .read(chatSessionsProvider.notifier)
        .loadMore();
    refreshed = true;
    container.invalidate(chatSessionsProvider);
    await container.read(chatSessionsProvider.future);
    tail.complete(_page(['stale']));
    await staleRequest;
    expect(_ids(container), ['fresh']);
  });

  test(
    'search is debounced and isolated from history and an abandoned query',
    () async {
      final queries = <String>[];
      final repository = _Repository((_, query) async {
        queries.add(query);
        return _page([query.isEmpty ? 'history' : query]);
      });
      final container = ProviderContainer.test(
        overrides: [creationRepositoryProvider.overrideWithValue(repository)],
      );
      await container.read(chatSessionsProvider.future);
      final abandoned = container.listen(chatSearchProvider('moo'), (_, _) {});
      abandoned.close();
      final active = container.listen(chatSearchProvider('moon'), (_, _) {});
      addTearDown(active.close);
      final result = await container.read(chatSearchProvider('moon').future);
      expect(result.sessions.single.draftId, 'moon');
      expect(queries, ['', 'moon']);
      expect(_ids(container), ['history']);
    },
  );
}

List<String> _ids(ProviderContainer container) => container
    .read(chatSessionsProvider)
    .requireValue
    .sessions
    .map((session) => session.draftId)
    .toList();

MobileChatSessionPage _page(List<String> ids, {String? cursor}) =>
    MobileChatSessionPage(
      sessions: [
        for (final id in ids)
          MobileChatSession(
            draftId: id,
            title: id,
            preview: '',
            messageCount: 1,
            status: 'ACTIVE',
            createdAt: DateTime.utc(2026),
            updatedAt: DateTime.utc(2026),
          ),
      ],
      nextCursor: cursor,
    );

class _Repository implements CreationRepository {
  _Repository(this.load);
  final Future<MobileChatSessionPage> Function(String?, String) load;
  final cursors = <String?>[];

  @override
  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  }) {
    cursors.add(cursor);
    return load(cursor, query);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}
