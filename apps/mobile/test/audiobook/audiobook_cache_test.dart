import 'dart:io';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/shared/api/api_client.dart';

class _FakeApiClient implements ApiClient {
  int downloads = 0;
  Object? failWith;

  @override
  Future<void> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    downloads += 1;
    final failure = failWith;
    if (failure != null) {
      await File(savePath).writeAsString('partial');
      throw failure;
    }
    if (path.contains('/timeline')) {
      await File(savePath).writeAsString(
        jsonEncode({
          'chapterIndex': 1,
          'title': 'One',
          'direction': 'ltr',
          'durationMs': 1000,
          'segments': <Object>[],
        }),
      );
    } else {
      await File(savePath).writeAsString('mp3-$path');
    }
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

NarratorVoice voice({String version = '1'}) => NarratorVoice(
  voice: 'Zephyr',
  name: 'Zephyr',
  blurb: 'Bright and warm.',
  sampleUrl: '/api/mobile/audiobook/voices/Zephyr/sample?v=$version',
);

MobileAudiobookChapter chapter({String? version = '1'}) {
  final query = version == null ? '' : '?v=$version';
  return MobileAudiobookChapter(
    index: 1,
    title: 'One',
    status: AudiobookChapterStatus.ready,
    durationMs: 1000,
    estimatedDurationMs: 1000,
    byteSize: null,
    segmentCount: 1,
    audioUrl: '/api/mobile/projects/p/audiobook/chapters/1/audio$query',
    timelineUrl: '/api/mobile/projects/p/audiobook/chapters/1/timeline$query',
  );
}

void main() {
  late Directory root;
  late _FakeApiClient api;
  late AudiobookCache cache;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('audiobook-cache-test');
    api = _FakeApiClient();
    cache = AudiobookCache(apiClient: api, root: root);
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('downloads a narrator sample once and reuses the local file', () async {
    final first = await cache.ensureNarratorSample(voice());
    final second = await cache.ensureNarratorSample(voice());

    expect(api.downloads, 1);
    expect(second.path, first.path);
    expect(await second.readAsString(), contains('/Zephyr/sample?v=1'));
  });

  test('a new sample version downloads to a new cache file', () async {
    final first = await cache.ensureNarratorSample(voice());
    final updated = await cache.ensureNarratorSample(voice(version: '2'));

    expect(api.downloads, 2);
    expect(updated.path, isNot(first.path));
    expect(updated.path, endsWith('Zephyr-v2.mp3'));
  });

  test('an interrupted sample download leaves no partial file', () async {
    api.failWith = Exception('connection lost');

    await expectLater(cache.ensureNarratorSample(voice()), throwsException);

    final sampleDir = Directory(
      '${root.path}/${AudiobookCache.directoryName}/samples',
    );
    expect(sampleDir.listSync(), isEmpty);
  });

  test(
    'chapter audio and timeline cache keys include the render version',
    () async {
      final audio = await cache.ensureChapterAudio(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: '2'),
      );
      await cache.ensureChapterTimeline(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: '2'),
      );

      expect(audio.path, endsWith('chapter-1-v2.mp3'));
      final names = audio.parent.listSync().map((entry) => entry.path).toList();
      expect(names, contains(endsWith('chapter-1-v2.timeline.json')));
    },
  );

  test(
    'unversioned chapter URLs are version 1 and version 2 prunes both old caches',
    () async {
      final legacy = await cache.ensureChapterAudio(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: null),
      );
      await cache.ensureChapterTimeline(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: null),
      );
      expect(legacy.path, endsWith('chapter-1-v1.mp3'));

      final current = await cache.ensureChapterAudio(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: '2'),
      );
      await cache.ensureChapterTimeline(
        projectId: 'p',
        audiobookId: 'a',
        chapter: chapter(version: '2'),
      );

      final names = current.parent
          .listSync()
          .map((entry) => entry.path)
          .toList();
      expect(names, isNot(contains(endsWith('chapter-1-v1.mp3'))));
      expect(names, isNot(contains(endsWith('chapter-1-v1.timeline.json'))));
      expect(names, contains(endsWith('chapter-1-v2.mp3')));
      expect(names, contains(endsWith('chapter-1-v2.timeline.json')));
    },
  );

  test(
    'older audiobook payloads default backup narration disclosure to false',
    () {
      expect(MobileAudiobook.fromJson(const {}).backupNarrationUsed, isFalse);
      expect(
        MobileAudiobook.fromJson(const {
          'backupNarrationUsed': true,
        }).backupNarrationUsed,
        isTrue,
      );
    },
  );
}
