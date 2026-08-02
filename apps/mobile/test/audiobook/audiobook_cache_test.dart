import 'dart:io';

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
    await File(savePath).writeAsString('mp3-$path');
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
}
