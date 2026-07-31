import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/data/reader_state_store.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';

void main() {
  late Directory root;
  late ReaderStateStore store;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('reader-state-test');
    store = ReaderStateStore(storage: ReaderStorage(root: root));
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('starts a book that has never been opened at page one', () async {
    final state = await store.load('project-1');

    expect(state.lastPage, 1);
    expect(state.bookmarks, isEmpty);
    expect(state.isEmpty, isTrue);
  });

  test('round trips the reading position and bookmarks', () async {
    await store.save(
      'project-1',
      ReaderState(
        revision: 7,
        lastPage: 42,
        bookmarks: [
          ReaderBookmark(
            page: 12,
            label: 'Page 12',
            createdAt: DateTime.utc(2026, 7, 25),
            revision: 7,
          ),
        ],
      ),
    );

    final state = await store.load('project-1');

    expect(state.revision, 7);
    expect(state.lastPage, 42);
    expect(state.bookmarks.single.page, 12);
    expect(state.bookmarks.single.revision, 7);
  });

  test('keeps each book separate', () async {
    await store.save('project-1', const ReaderState(lastPage: 10));
    await store.save('project-2', const ReaderState(lastPage: 99));

    expect((await store.load('project-1')).lastPage, 10);
    expect((await store.load('project-2')).lastPage, 99);
  });

  test('starts over rather than failing on a corrupt file', () async {
    final directory = await ReaderStorage(
      root: root,
    ).projectDirectory('project-1');
    await File('${directory.path}/state.json').writeAsString('{not json');

    expect((await store.load('project-1')).lastPage, 1);
  });

  test('sanitises a project id before it reaches the filesystem', () async {
    await store.save('../escape', const ReaderState(lastPage: 5));

    expect((await store.load('../escape')).lastPage, 5);
    expect(
      Directory('${root.path}/${ReaderStorage.directoryName}').listSync(),
      hasLength(1),
    );
  });

  group('ReaderState.clampedTo', () {
    test('pulls a position past the end of a shorter book into range', () {
      const state = ReaderState(lastPage: 80);

      expect(state.clampedTo(40).lastPage, 40);
    });

    test('drops bookmarks that no longer exist', () {
      final state = ReaderState(
        lastPage: 3,
        bookmarks: [
          ReaderBookmark(page: 2, label: 'a', createdAt: DateTime.utc(2026)),
          ReaderBookmark(page: 90, label: 'b', createdAt: DateTime.utc(2026)),
        ],
      );

      final clamped = state.clampedTo(40);

      expect(clamped.bookmarks.map((bookmark) => bookmark.page), [2]);
    });

    test('leaves a state alone when the page count is unknown', () {
      const state = ReaderState(lastPage: 80);

      expect(state.clampedTo(0).lastPage, 80);
    });
  });

  group('ReaderBookmark', () {
    test('is approximate once the book has been recompiled', () {
      final bookmark = ReaderBookmark(
        page: 12,
        label: 'Page 12',
        createdAt: DateTime.utc(2026),
        revision: 3,
      );

      expect(bookmark.isApproximateFor(3), isFalse);
      expect(bookmark.isApproximateFor(4), isTrue);
    });
  });
}
