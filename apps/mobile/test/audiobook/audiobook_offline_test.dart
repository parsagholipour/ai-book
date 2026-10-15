import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'audiobook_fakes.dart';

// Chapters downloaded to the phone could not be played with no connection: the
// player needed the server's manifest to know what they were, and the manifest
// lived only in memory. It is now kept beside the audio, and offline the
// player queues the chapters already on the phone and downloads nothing.

const _offline = ApiException(
  code: 'NETWORK_ERROR',
  message: 'Check your connection and try again.',
);

MobileAudiobookChapter _chapter(int index) => MobileAudiobookChapter(
  index: index,
  title: 'Chapter $index',
  status: AudiobookChapterStatus.ready,
  durationMs: 9000,
  estimatedDurationMs: 9000,
  byteSize: 10,
  segmentCount: 3,
  audioUrl: '/a/$index',
  timelineUrl: '/t/$index',
);

/// Three chapters narrated; kept while the narration was still being made.
MobileAudiobook _kept({AudiobookStatus status = AudiobookStatus.generating}) =>
    audiobookWith(
      status: status,
      chapters: [_chapter(1), _chapter(2), _chapter(3)],
    );

void main() {
  late Directory tempDir;
  late FakeAudiobookPlayer player;
  late FakeAudiobookRepository repository;
  late FakeAudiobookCache cache;
  ProviderContainer? container;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-audiobook-offline');
    player = FakeAudiobookPlayer();
    repository = FakeAudiobookRepository()..fetchError = _offline;
    cache = FakeAudiobookCache(tempDir);
    for (final index in [1, 2, 3]) {
      cache.timelinesByChapter[index] = timelineFixture();
    }
  });

  tearDown(() {
    container?.dispose();
    container = null;
    tempDir.deleteSync(recursive: true);
  });

  Future<void> pumpScreen(WidgetTester tester) async {
    final active = audiobookContainer(
      repository: repository,
      cache: cache,
      player: player,
      progress: FakeAudiobookProgressStore(),
    );
    container = active;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: active,
        child: const MaterialApp(home: AudiobookScreen(projectId: 'project-1')),
      ),
    );
    await settle(tester);
  }

  testWidgets('offline, the chapters on this phone play and nothing is '
      'downloaded', (tester) async {
    cache.manifests['project-1'] = _kept();
    cache.storedChapters.addAll([1, 2]);

    await pumpScreen(tester);

    expect(find.byKey(const ValueKey('audiobook-offline-banner')), findsOne);
    expect(
      find.text('Offline — 2 of 3 chapters on this phone'),
      findsOneWidget,
    );
    expect(player.tracks.map((track) => track.id), [
      'audiobook-1:1',
      'audiobook-1:2',
    ]);
    expect(cache.downloadedAudio, isEmpty);
    // A narration kept mid-way is not shown as being made now.
    expect(find.text('Still narrating'), findsNothing);
    // Nor is anything offered that needs the server.
    expect(find.byTooltip('Change narrator'), findsNothing);

    // The server answers again: the rest of the book downloads behind what
    // is already queued.
    repository
      ..fetchError = null
      ..audiobook = _kept(status: AudiobookStatus.complete);
    await tester.pump(const Duration(seconds: 30));
    await settle(tester);

    expect(
      find.byKey(const ValueKey('audiobook-offline-banner')),
      findsNothing,
    );
    expect(cache.downloadedAudio, ['audiobook-1:3']);
    expect(player.tracks, hasLength(3));
    container?.dispose();
    container = null;
  });

  testWidgets('offline with nothing downloaded says so, not "preparing"', (
    tester,
  ) async {
    cache.manifests['project-1'] = _kept();

    await pumpScreen(tester);

    expect(find.byKey(const ValueKey('audiobook-not-on-phone')), findsOne);
    expect(find.text('Not on this phone yet'), findsOneWidget);
    expect(cache.downloadedAudio, isEmpty);
    container?.dispose();
    container = null;
  });

  testWidgets('offline with no manifest kept is an error with a retry, never '
      'an offer to narrate', (tester) async {
    await pumpScreen(tester);

    expect(find.text('Narration unavailable'), findsOneWidget);
    expect(find.text('Hear your book read aloud'), findsNothing);
  });

  testWidgets('every manifest the server sends is kept for being offline', (
    tester,
  ) async {
    repository
      ..fetchError = null
      ..audiobook = _kept(status: AudiobookStatus.complete);

    await pumpScreen(tester);

    expect(cache.manifests['project-1']?.id, 'audiobook-1');
    container?.dispose();
    container = null;
  });

  group('AudiobookCache on disk', () {
    late Directory root;

    setUp(() async {
      root = await Directory.systemTemp.createTemp('audiobook_cache_offline');
    });

    tearDown(() async {
      await root.delete(recursive: true);
    });

    test('keeps the manifest beside the audio and reads it back', () async {
      final cache = AudiobookCache(apiClient: _NoNetwork(), root: root);
      final manifest = MobileAudiobook.fromJson({
        'id': 'audiobook-1',
        'projectId': 'p1',
        'status': 'complete',
        'voice': 'Zephyr',
        'narratorName': 'Zephyr',
        'chapters': [
          {
            'index': 1,
            'title': 'Low Tide',
            'status': 'ready',
            'durationMs': 9000,
            'byteSize': 4,
            'audioUrl': '/a/1?v=2',
            'timelineUrl': '/t/1?v=2',
          },
        ],
      });

      await cache.saveManifest(manifest);
      // Re-narrating prunes the other narrations' directories, never this.
      await cache.pruneOtherAudiobooks('p1', 'audiobook-2');
      final kept = await cache.loadManifest('p1');

      expect(kept?.id, 'audiobook-1');
      expect(kept?.chapters.single.audioUrl, '/a/1?v=2');

      // Nothing on disk yet: nothing to play, and no download attempted.
      expect(
        await cache.storedChapter(
          projectId: 'p1',
          audiobookId: 'audiobook-1',
          chapter: kept!.chapters.single,
        ),
        isNull,
      );

      final directory = await cache.audiobookDirectory('p1', 'audiobook-1');
      await File('${directory.path}/chapter-1-v2.mp3').writeAsString('abcd');
      await File(
        '${directory.path}/chapter-1-v2.timeline.json',
      ).writeAsString('{"chapterIndex":1,"title":"Low Tide","segments":[]}');

      final stored = await cache.storedChapter(
        projectId: 'p1',
        audiobookId: 'audiobook-1',
        chapter: kept.chapters.single,
      );
      expect(stored, isNotNull);
      expect(stored!.$2.title, 'Low Tide');

      await cache.clearProject('p1');
      expect(await cache.loadManifest('p1'), isNull);
    });
  });
}

class _NoNetwork implements ApiClient {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('no network in this test');
}
