import 'dart:io' show Directory;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/shared/storage/app_files.dart';
import 'package:tomeza/shared/storage/file_transfer.dart';

class _BytesAdapter implements HttpClientAdapter {
  int status = 200;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => ResponseBody.fromString(
    '%PDF-browser',
    status,
    headers: {
      'content-length': ['12'],
      'x-export-content-revision': ['7'],
    },
  );
  @override
  void close({bool force = false}) {}
}

void main() {
  test(
    'downloads preserve bytes and provenance for the reader and sharing',
    () async {
      final directory = kIsWeb
          ? await getTemporaryDirectory()
          : await Directory.systemTemp.createTemp('tomeza-web-test-');
      final path = '${directory.path}/browser-download.pdf';
      final adapter = _BytesAdapter();
      final dio = Dio()..httpClientAdapter = adapter;
      final response = await downloadToFile(
        dio,
        'https://example.test/book',
        path,
      );
      expect(await appFile(path).readAsString(), '%PDF-browser');
      expect(response.headers.value('x-export-content-revision'), '7');
      expect(await shareableFile(path).readAsString(), '%PDF-browser');
      adapter.status = 401;
      final refused = '$path.refused';
      await expectLater(
        downloadToFile(dio, 'https://example.test/book', refused),
        throwsA(isA<DioException>()),
      );
      expect(await appFile(refused).exists(), isFalse);
      await appFile(path).delete();
      if (!kIsWeb) await directory.delete(recursive: true);
    },
  );

  test(
    'JSON stores can publish atomically and delete files in a browser',
    () async {
      final root = await getApplicationDocumentsDirectory();
      final directory = appDirectory('${root.path}/web-test');
      await directory.create(recursive: true);
      final draft = appFile('${directory.path}/draft.json.part');
      await draft.writeAsString('{"text":"kept"}');
      final finalFile = await draft.rename('${directory.path}/draft.json');
      expect(await finalFile.readAsString(), '{"text":"kept"}');
      expect(await draft.exists(), isFalse);
      await directory.delete(recursive: true);
      expect(await finalFile.exists(), isFalse);
    },
    skip: !kIsWeb,
  );

  test(
    'browser billing has no native plugin or fake purchase stream',
    () async {
      const store = BrowserStoreBillingClient();
      expect(await store.isAvailable(), isFalse);
      expect(await store.queryOwnedPurchases(), isEmpty);
      expect((await store.queryProducts({'credits'})).products, isEmpty);
      expect(await store.purchaseUpdates.toList(), isEmpty);
    },
  );
}
