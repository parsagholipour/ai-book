import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/export_cache.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

// A 200 is not a PDF: a captive portal, a proxy's error page or a body cut
// short before its header all arrive as a successful download. Renamed into
// place they reached pdfrx, whose own error screen is a developer's.
void main() {
  late Directory root;
  late _FakeApiClient api;
  late ExportCache cache;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('export-cache-unreadable');
    api = _FakeApiClient();
    cache = ExportCache(apiClient: api, storage: ReaderStorage(root: root));
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('bytes that are not a PDF are a failed download, not a book', () async {
    api.payload = '<html><body>Sign in to the Wi-Fi</body></html>';

    await expectLater(
      cache.ensure(projectId: 'project-1', export: _export(byteSize: null)),
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'EXPORT_UNREADABLE',
        ),
      ),
    );

    final directory = await ReaderStorage(
      root: root,
    ).projectDirectory('project-1');
    final left = await directory.list().map((entry) => entry.path).toList();
    expect(left, isEmpty, reason: 'nothing is filed as the book');
    expect(
      await cache.lookup(projectId: 'project-1', export: _export()),
      isNull,
    );
  });

  test('a PDF header after leading bytes is still a PDF', () async {
    api.payload = '\n\n%PDF-1.7 body';

    final entry = await cache.ensure(
      projectId: 'project-1',
      export: _export(byteSize: null),
    );

    expect(await File(entry.path).readAsString(), '\n\n%PDF-1.7 body');
  });

  test('a download that was not a book never replaces the one on the phone', () async {
    final first = await cache.ensure(projectId: 'project-1', export: _export());

    api
      ..payload = '502 Bad Gateway'
      ..headers = _provenance(revision: 2);
    await expectLater(
      cache.ensure(
        projectId: 'project-1',
        export: _export(revision: 2, byteSize: 15),
      ),
      throwsA(isA<ApiException>()),
    );

    expect(await File(first.path).readAsString(), '%PDF-fake');
    final kept = await cache.lookup(projectId: 'project-1', export: _export());
    expect(kept?.revision, 1, reason: 'still filed, still readable');
  });

  test('discarding a cached book makes the next open download it', () async {
    await cache.ensure(projectId: 'project-1', export: _export());
    expect(api.downloads, 1);

    await cache.discard(projectId: 'project-1', export: _export());
    expect(
      await cache.lookup(projectId: 'project-1', export: _export()),
      isNull,
    );

    await cache.ensure(projectId: 'project-1', export: _export());
    expect(api.downloads, 2);
  });

  test('the header check reads the bytes, not the name', () {
    expect(isPdfHeader('%PDF-1.4'.codeUnits), isTrue);
    expect(isPdfHeader('  %PDF-'.codeUnits), isTrue);
    expect(isPdfHeader('%PDF'.codeUnits), isFalse);
    expect(isPdfHeader('<!doctype html>'.codeUnits), isFalse);
    expect(isPdfHeader(const []), isFalse);
  });
}

class _FakeApiClient implements ApiClient {
  String payload = '%PDF-fake';
  Map<String, String> headers = _provenance(revision: 1);
  int downloads = 0;

  @override
  Future<DownloadedFile> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    downloads++;
    await File(savePath).writeAsString(payload);
    return DownloadedFile(headers: headers);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Map<String, String> _provenance({required int revision}) => {
  'x-export-provenance': 'exact',
  'x-export-content-digest': 'pdf-digest-$revision',
  'x-export-content-revision': '$revision',
};

MobileExportAvailability _export({int revision = 1, int? byteSize = 9}) {
  return MobileExportAvailability(
    format: 'pdf',
    available: true,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'the-book.pdf',
    contentType: 'application/pdf',
    revision: revision,
    byteSize: byteSize,
    updatedAt: DateTime.utc(2026, 7, 25),
  );
}
