import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/export_cache.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/shared/api/api_client.dart';

class _DownloadApi implements ApiClient {
  String payload = '%PDF-fake';
  String digest = 'pdf-a';
  Object? error;
  int downloads = 0;

  @override
  Future<DownloadedFile> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    downloads++;
    final failure = error;
    if (failure != null) throw failure;
    await File(savePath).writeAsString(payload);
    return DownloadedFile(
      headers: {
        'x-export-provenance': 'exact',
        'x-export-content-revision': '7',
        'x-export-content-digest': digest,
      },
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

const export = MobileExportAvailability(
  format: 'pdf',
  available: true,
  unlocked: true,
  creditsRequired: 0,
  downloadUrl: '/api/mobile/projects/project-1/export/pdf',
  filename: 'book.pdf',
  contentType: 'application/pdf',
  revision: 7,
  byteSize: 9,
);

MobilePdfPageNumbering numbering(String digest, {bool cover = true}) {
  return MobilePdfPageNumbering(
    hasCoverPage: cover,
    contentRevision: 7,
    pdfDigest: digest,
  );
}

void main() {
  late Directory root;
  late _DownloadApi api;
  late ExportCache cache;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('cover-identity-cache');
    api = _DownloadApi();
    cache = ExportCache(
      apiClient: api,
      storage: ReaderStorage(root: root),
    );
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test(
    'same-revision same-size repair downloads and stamps the repaired bytes',
    () async {
      final first = await cache.ensure(
        projectId: 'project-1',
        export: export,
        pageNumbering: numbering('pdf-a'),
      );
      expect(first.hasCoverPage, isTrue);

      api
        ..payload = '%PDF-next'
        ..digest = 'pdf-b';
      final repaired = await cache.ensure(
        projectId: 'project-1',
        export: export,
        pageNumbering: numbering('pdf-b', cover: false),
      );

      expect(api.downloads, 2);
      expect(repaired.digest, 'pdf-b');
      expect(repaired.hasCoverPage, isFalse);
      expect(await File(repaired.path).readAsString(), '%PDF-next');
    },
  );

  test('download race never stamps a stale same-revision map', () async {
    api
      ..payload = '%PDF-next'
      ..digest = 'pdf-b';
    final received = await cache.ensure(
      projectId: 'project-1',
      export: export,
      pageNumbering: numbering('pdf-a'),
    );

    expect(received.digest, 'pdf-b');
    expect(received.hasCoverPage, isNull);
    final caughtUp = await cache.ensure(
      projectId: 'project-1',
      export: export,
      pageNumbering: numbering('pdf-b'),
    );
    expect(
      api.downloads,
      1,
      reason: 'the matching status stamps the cache hit',
    );
    expect(caughtUp.hasCoverPage, isTrue);
  });

  test(
    'failed digest promotion keeps a pre-digest cache readable and unstamped',
    () async {
      final directory = await ReaderStorage(
        root: root,
      ).projectDirectory('project-1');
      await File('${directory.path}/book.pdf').writeAsString('%PDF-old');
      await File('${directory.path}/manifest.json').writeAsString(
        jsonEncode({
          'revision': 7,
          'revisionIsExact': true,
          'byteSize': 8,
          'downloadedAt': '2026-08-18T00:00:00.000Z',
          'hasCoverPage': true,
        }),
      );
      api.error = Exception('offline');

      final cached = await cache.ensure(
        projectId: 'project-1',
        export: const MobileExportAvailability(
          format: 'pdf',
          available: true,
          unlocked: true,
          creditsRequired: 0,
          downloadUrl: '/export/pdf',
          filename: 'book.pdf',
          contentType: 'application/pdf',
          revision: 7,
          byteSize: 8,
        ),
        pageNumbering: numbering('pdf-a'),
      );

      expect(api.downloads, 1);
      expect(await File(cached.path).readAsString(), '%PDF-old');
      expect(cached.digest, isNull);
      expect(cached.hasCoverPage, isNull);
    },
  );
}
