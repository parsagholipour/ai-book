import 'dart:convert';
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

  /// What the export route says about the bytes it just sent. Empty is an
  /// older server, which says nothing at all.
  Map<String, String> headers = const {};

  @override
  Future<DownloadedFile> downloadFile(
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
    return DownloadedFile(headers: headers);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// The headers the export route sends alongside the bytes.
Map<String, String> provenance({required String state, int? revision}) {
  return {
    'x-export-provenance': state,
    'x-export-content-digest': 'sha256-of-whatever-was-sent',
    if (revision != null) 'x-export-content-revision': '$revision',
  };
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
    api.headers = provenance(state: 'exact', revision: 1);
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
    api.headers = provenance(state: 'exact', revision: 2);
    final updated = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 2, byteSize: 18),
    );

    expect(api.downloads, 2);
    expect(updated.revision, 2);
    expect(await File(updated.path).readAsString(), '%PDF-edited-longer');
  });

  test(
    're-downloads when the file changed size at the same revision',
    () async {
      await cache.ensure(projectId: 'project-1', export: exportOf());

      await cache.ensure(
        projectId: 'project-1',
        export: exportOf(byteSize: 999),
      );

      expect(api.downloads, 2);
    },
  );

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

  test('files no revision for bytes it cannot identify', () async {
    // Every compile is published over the same URL, so a descriptor only
    // describes what was behind it when the status was read. A retry after an
    // EXPORT_NOT_READY is answered by whatever landed since — and filing those
    // bytes under the revision that failed makes the cache, the update banner
    // and every markup stamp agree on the wrong book.
    api.payload = '%PDF-recompiled';
    api.headers = provenance(state: 'unknown');

    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 1, byteSize: 9),
    );

    expect(entry.revision, isNull, reason: 'these are not revision 1 bytes');
    expect(entry.matches(exportOf(revision: 1, byteSize: 9)), isFalse);
    expect(await File(entry.path).readAsString(), '%PDF-recompiled');
    // Still nothing cached: the next open fetches again rather than serving
    // this file as the revision it was asked for.
    expect(
      await cache.lookup(
        projectId: 'project-1',
        export: exportOf(revision: 1, byteSize: 9),
      ),
      isNull,
    );
  });

  test('drops the entry the replaced file left behind', () async {
    await cache.ensure(projectId: 'project-1', export: exportOf());

    // A recompile lands, so the size the descriptor reports no longer matches
    // the file, and what comes back matches neither.
    api.payload = '%PDF-recompiled';
    api.headers = provenance(state: 'unknown');
    await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 1, byteSize: 999),
    );

    expect(
      await cache.lookup(projectId: 'project-1', export: exportOf()),
      isNull,
      reason: 'the old manifest outlived the bytes it described',
    );
  });

  test('files the download when there is no size to check', () async {
    // The size check may only ever establish a mismatch. A server that reports
    // nothing leaves the descriptor standing, or every open would re-download.
    api.headers = const {};
    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 3, byteSize: null),
    );

    expect(entry.revision, 3);
    expect(
      await cache.lookup(
        projectId: 'project-1',
        export: exportOf(revision: 3, byteSize: null),
      ),
      isNotNull,
    );
  });

  test('files a same-length recompile under the revision that made it', () async {
    // The race the whole contract exists for. The reader asked with revision 1,
    // a compile landed while it was asking, and the book that came back is the
    // same length as the one the descriptor described — a presentation reprint,
    // a re-applied edit or an undo all produce one. Nothing about the request
    // can tell these apart, so the response says which compile answered.
    api.payload = '%PDF-two';
    api.headers = provenance(state: 'exact', revision: 2);

    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 1, byteSize: '%PDF-two'.length),
    );

    expect(entry.revision, 2, reason: 'these are revision 2 bytes');
    expect(entry.revisionIsExact, isTrue);
    // Filed under 2, so the descriptor that catches up finds it cached...
    expect(
      await cache.lookup(
        projectId: 'project-1',
        export: exportOf(revision: 2, byteSize: '%PDF-two'.length),
      ),
      isNotNull,
    );
    // ...and the stale descriptor it was fetched with does not call it stale,
    // which would re-download the file the reader already has and announce an
    // edit they already have.
    expect(entry.matches(exportOf(revision: 1, byteSize: 8)), isTrue);
  });

  test('files nothing for bytes the server says are being replaced', () async {
    // A record exists for this file and describes other bytes: something is
    // publishing over it right now, so no revision may be guessed — least of
    // all the descriptor's, which is the one the reader is most likely to have.
    api.headers = provenance(state: 'mismatch');

    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 1, byteSize: 9),
    );

    expect(entry.revision, isNull);
    expect(entry.revisionIsExact, isFalse);
    expect(await File(entry.path).readAsString(), '%PDF-fake');
    expect(
      await cache.lookup(projectId: 'project-1', export: exportOf()),
      isNull,
      reason: 'the next open fetches again rather than trusting these bytes',
    );
  });

  test(
    'keeps the descriptor when a current server reports unknown — a legacy '
    'file no publication recorded still caches',
    () async {
      api.headers = provenance(state: 'unknown');

      final entry = await cache.ensure(
        projectId: 'project-1',
        export: exportOf(revision: 4),
      );

      expect(entry.revision, 4);
      expect(entry.revisionIsExact, isFalse);
      expect(entry.exactRevision, isNull);
      // Cached like any pre-provenance download, so the next open is a hit
      // rather than another full fetch of a book the server can never stamp.
      expect(
        await cache.lookup(projectId: 'project-1', export: exportOf(revision: 4)),
        isNotNull,
      );
    },
  );

  test(
    'keeps the descriptor only when an older server sends no header',
    () async {
      api.headers = const {};

      final entry = await cache.ensure(
        projectId: 'project-1',
        export: exportOf(revision: 4),
      );

      expect(entry.revision, 4);
      expect(entry.revisionIsExact, isFalse);
      expect(entry.exactRevision, isNull);
    },
  );

  test('files nothing when fewer bytes arrived than were declared', () async {
    api.headers = {
      ...provenance(state: 'exact', revision: 2),
      'content-length': '4096',
    };

    final entry = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(),
    );

    expect(
      entry.revision,
      isNull,
      reason: 'a truncated file is not the compile those headers describe',
    );
    expect(entry.revisionIsExact, isFalse);
  });

  test(
    'serves a book cached before provenance existed without re-downloading, '
    'and promotes it on the next real miss',
    () async {
      // A manifest from an older build names a revision and nothing else. It was
      // filed under the descriptor that asked for it, which is what a stand-in
      // is, so it is read back as one — and still a cache hit, because making
      // every reader re-download their library on upgrade is not a fix. Nor is
      // re-fetching on every open to chase an exact promotion: a book whose
      // provenance can never be established would re-download forever.
      final directory = await ReaderStorage(
        root: root,
      ).projectDirectory('project-1');
      await File('${directory.path}/book.pdf').writeAsString('%PDF-old');
      await File('${directory.path}/manifest.json').writeAsString(
        jsonEncode({
          'revision': 3,
          'byteSize': 8,
          'downloadedAt': '2026-07-25T00:00:00.000Z',
        }),
      );

      final cached = await cache.ensure(
        projectId: 'project-1',
        export: exportOf(revision: 3, byteSize: 8),
      );

      expect(api.downloads, 0, reason: 'a matching approximate entry is a hit');
      expect(cached.revision, 3);
      expect(cached.revisionIsExact, isFalse);
      expect(cached.exactRevision, isNull);

      // The book is recompiled: the descriptor moves, the entry stops
      // matching, and the download that follows files an exact revision.
      api
        ..payload = '%PDF-new'
        ..headers = provenance(state: 'exact', revision: 4);
      final promoted = await cache.ensure(
        projectId: 'project-1',
        export: exportOf(revision: 4, byteSize: 8),
      );

      expect(api.downloads, 1);
      expect(promoted.revision, 4);
      expect(promoted.revisionIsExact, isTrue);
      expect(await File(promoted.path).readAsString(), '%PDF-new');
    },
  );

  test('serves an approximate legacy cache while offline', () async {
    final directory = await ReaderStorage(
      root: root,
    ).projectDirectory('project-1');
    await File('${directory.path}/book.pdf').writeAsString('%PDF-old');
    await File('${directory.path}/manifest.json').writeAsString(
      jsonEncode({
        'revision': 3,
        'byteSize': 8,
        'downloadedAt': '2026-07-25T00:00:00.000Z',
      }),
    );
    api.failWith = Exception('offline');

    final cached = await cache.ensure(
      projectId: 'project-1',
      export: exportOf(revision: 3, byteSize: 8),
    );

    expect(cached.revisionIsExact, isFalse);
    expect(await File(cached.path).readAsString(), '%PDF-old');
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
