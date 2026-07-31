import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/export_cache.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/shared/api/api_client.dart';

/// Stands in for the network: writes [payload] where the real client would.
class _FakeApiClient implements ApiClient {
  String payload = '%PDF-fake';
  Object? failWith;
  int downloads = 0;

  @override
  Future<void> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    downloads++;
    final failure = failWith;
    if (failure != null) {
      // A real interrupted download leaves bytes behind before it throws.
      await File(savePath).writeAsString('half');
      throw failure;
    }
    onReceiveProgress?.call(payload.length ~/ 2, payload.length);
    await File(savePath).writeAsString(payload);
    onReceiveProgress?.call(payload.length, payload.length);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

MobileExportAvailability exportOf({
  bool available = true,
  int revision = 1,
  int? byteSize = 9,
}) {
  return MobileExportAvailability(
    format: 'pdf',
    available: available,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'the-book.pdf',
    contentType: 'application/pdf',
    revision: revision,
    byteSize: byteSize,
    updatedAt: DateTime.utc(2026, 7, 25),
  );
}

void main() {
  late Directory root;
  late _FakeApiClient api;
  late ExportCache cache;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('export-cache-test');
    api = _FakeApiClient();
    cache = ExportCache(
      apiClient: api,
      storage: ReaderStorage(root: root),
    );
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('downloads a book that is not cached yet', () async {
    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(),
    );

    expect(api.downloads, 1);
    expect(entry.revision, 1);
    expect(await File(entry.path).readAsString(), '%PDF-fake');
  });

  test('reuses the cached file on a second open', () async {
    await cache.ensure(projectId: 'project-1', export: exportOf());
    final second = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(),
    );

    expect(api.downloads, 1, reason: 'reading again must not re-download');
    expect(await File(second.path).readAsString(), '%PDF-fake');
  });

  test('re-downloads after the book is recompiled', () async {
    await cache.ensure(projectId: 'project-1', export: exportOf());

    api.payload = '%PDF-edited-longer';
    final updated = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 2, byteSize: 18),
    );

    expect(api.downloads, 2);
    expect(updated.revision, 2);
    expect(await File(updated.path).readAsString(), '%PDF-edited-longer');
  });

  test('re-downloads when the file changed size at the same revision', () async {
    await cache.ensure(projectId: 'project-1', export: exportOf());

    await cache.ensure(
      projectId: 'project-1',
      export: exportOf(byteSize: 999),
    );

    expect(api.downloads, 2);
  });

  test('reports progress while downloading', () async {
    final seen = <int>[];
    await cache.ensure(
      projectId: 'project-1',
      export: exportOf(),
      onProgress: (received, _) => seen.add(received),
    );

    expect(seen, [4, 9]);
  });

  test('leaves no usable file behind when a download fails', () async {
    api.failWith = Exception('connection lost');

    await expectLater(
      cache.ensure(projectId: 'project-1', export: exportOf()),
      throwsException,
    );

    final cached = await cache.lookup(
      projectId: 'project-1',
      export: exportOf(),
    );
    expect(cached, isNull);
    final directory = await ReaderStorage(
      root: root,
    ).projectDirectory('project-1');
    expect(
      directory.listSync().map((entity) => entity.path.split('/').last),
      isEmpty,
      reason: 'a partial download must not survive as book.pdf or a .part file',
    );
  });

  test('treats an unavailable export as a cache miss', () async {
    await cache.ensure(projectId: 'project-1', export: exportOf());

    final cached = await cache.lookup(
      projectId: 'project-1',
      export: exportOf(available: false),
    );

    expect(cached, isNull);
  });
}
