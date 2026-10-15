import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../billing/billing_paywall_harness.dart'
    show
        EmptyCreditLogRepository,
        FakeBillingRepository,
        FakeStoreBillingClient;
import 'book_reader_test_support.dart'
    show FakeReaderRepository, pdfExport, statusWith, stubViewer;

/// Reading a book never asks for credits. There used to be a per-book export
/// unlock, and an older server served the reader through the download route
/// that spent it, so a short balance put a paywall in front of the book; that
/// unlock is gone, and the reader has no lock left to draw.
void main() {
  testWidgets('a book an older server still calls locked opens to read', (
    tester,
  ) async {
    // No read route, and the old fields saying 150 credits against a
    // balance of 100: exactly what used to put up "Unlock to read".
    final locked = MobileExportAvailability.fromJson(const {
      'format': 'pdf',
      'available': true,
      'unlocked': false,
      'creditsRequired': 150,
      'downloadUrl': '/api/mobile/projects/project-1/export/pdf',
      'filename': 'the-race.pdf',
      'contentType': 'application/pdf',
      'revision': 1,
      'byteSize': 100,
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(FakeReaderRepository()),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith(
            (ref, id) => Stream.value(statusWith(locked)),
          ),
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
          storeBillingClientProvider.overrideWithValue(
            FakeStoreBillingClient(),
          ),
          creditLogRepositoryProvider.overrideWithValue(
            EmptyCreditLogRepository(),
          ),
        ],
        child: const MaterialApp(
          home: BookReaderScreen(projectId: 'project-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsNothing);
    expect(find.text('Unlock to read'), findsNothing);
    expect(find.text('Get credits'), findsNothing);
    expect(find.byType(ReaderView), findsOneWidget);
  });

  testWidgets(
    'a download refused because the export is rebuilding offers a retry, '
    'not a failure',
    (tester) async {
      // Reachable in the window an edit opens: it deletes the compiled exports
      // and queues the recompile a moment later. The download itself queues that
      // compile if nothing else has, so retrying is the right move — "Could not
      // download this book" read as a dead end for what is really a wait.
      final repository = FakeReaderRepository(failDownload: true)
        ..downloadError = const ApiException(
          code: 'EXPORT_NOT_READY',
          message: 'This export is not ready yet.',
          statusCode: 404,
        );
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            readerRepositoryProvider.overrideWithValue(repository),
            readerViewerBuilderProvider.overrideWithValue(stubViewer),
          ],
          child: MaterialApp(
            home: ReaderView(
              projectId: 'project-1',
              export: pdfExport(),
              loader: loader,
              status: statusWith(pdfExport()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Still preparing this book'), findsOneWidget);
      expect(find.text('Could not download this book'), findsNothing);
      // The retry has to be there: the compile it queued will land.
      expect(find.text('Try again'), findsOneWidget);

      // And it recovers once the compile does land.
      repository.failDownload = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();

      expect(find.text('Still preparing this book'), findsNothing);
    },
  );
}
