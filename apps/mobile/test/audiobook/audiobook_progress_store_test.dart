import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/data/audiobook_progress_store.dart';

void main() {
  late Directory root;
  late AudiobookProgressStore store;

  AudiobookListeningPosition positionAt(
    int positionMs, {
    String audiobookId = 'audiobook-1',
  }) {
    return AudiobookListeningPosition(
      audiobookId: audiobookId,
      positionMs: positionMs,
      updatedAt: DateTime.utc(2026, 8, 4, 12),
    );
  }

  File progressFile(String projectId) => File(
    '${root.path}/${AudiobookCache.directoryName}/$projectId/progress.json',
  );

  setUp(() {
    root = Directory.systemTemp.createTempSync('tomeza-progress-store');
    store = AudiobookProgressStore(root: root);
  });

  tearDown(() => root.deleteSync(recursive: true));

  test('a book that has never been listened to has no position', () async {
    expect(await store.load('project-1'), isNull);
  });

  test('reads back what it saved', () async {
    await store.save('project-1', positionAt(90000));

    final saved = await store.load('project-1');
    expect(saved?.positionMs, 90000);
    expect(saved?.audiobookId, 'audiobook-1');
    expect(saved?.updatedAt, DateTime.utc(2026, 8, 4, 12));
  });

  test('keeps one position per project', () async {
    await store.save('project-1', positionAt(1000));
    await store.save('project-2', positionAt(2000));

    expect((await store.load('project-1'))?.positionMs, 1000);
    expect((await store.load('project-2'))?.positionMs, 2000);
  });

  test('clearing forgets it', () async {
    await store.save('project-1', positionAt(1000));
    await store.clear('project-1');

    expect(await store.load('project-1'), isNull);
    // Clearing a book that was never listened to is not an error: it runs on
    // every re-narration, including the first one.
    await store.clear('project-2');
  });

  test('sits beside the audio, under the project', () async {
    await store.save('project-1', positionAt(1000));

    expect(progressFile('project-1').existsSync(), isTrue);
  });

  test('a project id that is not path-safe still lands in one place', () async {
    await store.save('../escape/../project', positionAt(1000));

    expect((await store.load('../escape/../project'))?.positionMs, 1000);
    expect(
      progressFile('..-escape-..-project').existsSync(),
      isTrue,
      reason: 'the id is flattened the same way the audio cache flattens it',
    );
  });

  test('a corrupt file starts the book over rather than throwing', () async {
    final file = progressFile('project-1');
    file.parent.createSync(recursive: true);
    file.writeAsStringSync('{"audiobookId": "audiobook-1", "posi');

    expect(await store.load('project-1'), isNull);
  });

  test('a position with no narration behind it is not trusted', () async {
    final file = progressFile('project-1');
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(jsonEncode({'positionMs': 4000}));

    // Without a narration id there is no way to know the audio still matches,
    // and a wrong resume is worse than none.
    expect(await store.load('project-1'), isNull);
  });

  test('overlapping saves leave a whole file behind, not a torn one', () async {
    // The position is written on a timer while the app may be killed at any
    // moment, so two writes in flight together is ordinary.
    await Future.wait([
      store.save('project-1', positionAt(1000)),
      store.save('project-1', positionAt(2000)),
      store.save('project-1', positionAt(3000)),
    ]);

    expect((await store.load('project-1'))?.positionMs, 3000);
    expect(File('${progressFile('project-1').path}.part').existsSync(), isFalse);
  });
}
