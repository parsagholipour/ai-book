import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

class _DownloadApi implements ApiClient {
  String payload = 'epub-five';
  Map<String, String> headers = const {};
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

Map<String, String> _provenance(String state, {int? revision}) => {
  'x-export-provenance': state,
  'x-export-content-digest': 'digest-of-response',
  if (revision != null) 'x-export-content-revision': '$revision',
};

MobileExportAvailability _epub({int revision = 5, int? byteSize}) {
  return MobileExportAvailability(
    format: 'epub',
    available: true,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'the-book.epub',
    contentType: 'application/epub+zip',
    revision: revision,
    byteSize: byteSize,
  );
}

void main() {
  late Directory root;
  late _DownloadApi api;
  late MobileProjectsRepository repository;

  setUp(() async {
    root = await Directory.systemTemp.createTemp(
      'direct-export-provenance-test',
    );
    api = _DownloadApi();
    repository = MobileProjectsRepository(
      apiClient: api,
      documentsDirectory: () async => root,
    );
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('downloads bytes whose exact revision matches the descriptor', () async {
    api.headers = _provenance('exact', revision: 5);

    final file = await repository.downloadExport(
      projectId: 'project-1',
      export: _epub(byteSize: api.payload.length),
    );

    expect(await File(file.path).readAsString(), api.payload);
    expect(File('${file.path}.part').existsSync(), isFalse);
  });

  test('refuses exact revision 4 for revision 5 without '
      'replacing a good local export', () async {
    api.headers = _provenance('exact', revision: 4);
    final exportDirectory = Directory('${root.path}/tomeza_exports/project-1');
    await exportDirectory.create(recursive: true);
    final existing = File('${exportDirectory.path}/the-book.epub');
    await existing.writeAsString('existing-current-file');

    await expectLater(
      repository.downloadExport(
        projectId: 'project-1',
        export: _epub(byteSize: api.payload.length),
      ),
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'EXPORT_REVISION_MISMATCH',
        ),
      ),
    );

    expect(await existing.readAsString(), 'existing-current-file');
    expect(File('${existing.path}.part').existsSync(), isFalse);
  });

  test('accepts exact revision 6 for a descriptor still naming revision 5 — '
      'the compile that just published answered the retry', () async {
    api.headers = _provenance('exact', revision: 6);

    final file = await repository.downloadExport(
      projectId: 'project-1',
      export: _epub(byteSize: api.payload.length),
    );

    expect(await File(file.path).readAsString(), api.payload);
    expect(File('${file.path}.part').existsSync(), isFalse);
  });

  test(
    'open refuses an exact older EPUB before invoking the platform opener',
    () async {
      api.headers = _provenance('exact', revision: 4);

      await expectLater(
        repository.openExport(projectId: 'project-1', export: _epub()),
        throwsA(
          isA<ApiException>()
              .having((error) => error.code, 'code', 'EXPORT_REVISION_MISMATCH')
              .having(
                (error) => error.message,
                'message',
                contains('older version'),
              ),
        ),
      );
    },
  );

  test('refuses bytes reported as changing under the download', () async {
    api.headers = _provenance('mismatch');

    await expectLater(
      repository.downloadExport(projectId: 'project-1', export: _epub()),
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'EXPORT_PROVENANCE_MISMATCH',
        ),
      ),
    );
  });

  test(
    'accepts unknown provenance with the descriptor standing in — a legacy '
    'file the server can never stamp still downloads',
    () async {
      api.headers = _provenance('unknown');

      final file = await repository.downloadExport(
        projectId: 'project-1',
        export: _epub(byteSize: api.payload.length),
      );

      expect(await File(file.path).readAsString(), api.payload);
      expect(File('${file.path}.part').existsSync(), isFalse);
    },
  );

  test(
    'refuses unknown provenance when the descriptor size guard fails',
    () async {
      api.headers = _provenance('unknown');

      await expectLater(
        repository.downloadExport(
          projectId: 'project-1',
          export: _epub(byteSize: api.payload.length + 1),
        ),
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'EXPORT_REVISION_MISMATCH',
          ),
        ),
      );
    },
  );

  test(
    'preserves descriptor compatibility when an older server sends no header',
    () async {
      api.headers = const {};

      final file = await repository.downloadExport(
        projectId: 'project-1',
        export: _epub(byteSize: api.payload.length),
      );

      expect(await File(file.path).readAsString(), api.payload);
    },
  );
}
