import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/presentation/sample_book_screen.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';

// The sample had no error state of its own: a file pdfrx could not open
// showed pdfrx's developer screen (a stack trace and a note to set
// `errorBannerBuilder`) to someone who had not even signed up yet.
void main() {
  testWidgets('a sample that will not open says so and downloads again', (
    tester,
  ) async {
    var downloads = 0;
    var opens = false;
    final identities = <Object>[];
    Widget viewer(
      BuildContext context,
      PdfDocumentRef documentRef,
      PdfViewerController controller,
      PdfViewerParams params,
      int initialPageNumber,
    ) {
      identities.add(documentRef.key);
      if (!opens) {
        // What PdfViewer does with a document it failed to load.
        return params.errorBannerBuilder!(
          context,
          const FormatException('Failed to load PDF document'),
          StackTrace.empty,
          documentRef,
        );
      }
      return const Center(child: Text('sample open'));
    }

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sampleBookAvailableProvider.overrideWith((ref) async => true),
          sampleBookFileProvider.overrideWith((ref) async {
            downloads++;
            return '/nonexistent/tomeza-sample-book.pdf';
          }),
          readerViewerBuilderProvider.overrideWithValue(viewer),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const SampleBookScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("This book couldn't be opened"), findsOneWidget);
    expect(find.textContaining('errorBannerBuilder'), findsNothing);
    expect(find.textContaining('Failed to load'), findsNothing);
    // The way out stays on screen beside the error.
    expect(find.text('Make my own'), findsOneWidget);
    expect(downloads, 1);

    opens = true;
    await tester.tap(find.text('Download again'));
    await tester.pumpAndSettle();

    expect(downloads, 2, reason: 'the sample is fetched again');
    expect(find.text("This book couldn't be opened"), findsNothing);
    expect(find.text('sample open'), findsOneWidget);
    expect(
      identities.last,
      isNot(identities.first),
      reason: 'pdfrx will not reopen a document key it already failed on',
    );
  });

  group('downloadSampleBook', () {
    late Directory directory;

    setUp(() async {
      directory = await Directory.systemTemp.createTemp('sample_book_test');
    });

    tearDown(() async {
      await directory.delete(recursive: true);
    });

    test('keeps a PDF', () async {
      final dio = Dio()
        ..httpClientAdapter = _BytesAdapter(utf8.encode('%PDF-1.7\n%…'));

      final path = await downloadSampleBook(dio, directory);

      expect(await File(path).readAsString(), startsWith('%PDF-'));
      expect(File('$path.part').existsSync(), isFalse);
    });

    test(
      'refuses a page that is not a PDF and leaves nothing behind',
      () async {
        // A captive portal answers with a 200 and its own sign-in page.
        final dio = Dio()
          ..httpClientAdapter = _BytesAdapter(
            utf8.encode('<html><body>Sign in to the Wi-Fi</body></html>'),
          );

        await expectLater(
          downloadSampleBook(dio, directory),
          throwsA(isA<FormatException>()),
        );
        expect(directory.listSync(), isEmpty);
      },
    );
  });
}

class _BytesAdapter implements HttpClientAdapter {
  _BytesAdapter(this.bytes);

  final List<int> bytes;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    return ResponseBody.fromBytes(bytes, 200);
  }
}
