import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../billing/billing_paywall_harness.dart'
    show EmptyCreditLogRepository, FakeBillingRepository, FakeStoreBillingClient;
import 'book_reader_screen_test.dart'
    show FakeReaderRepository, pdfExport, statusWith, stubViewer;

/// Opening a book the balance cannot unlock.
///
/// The paywall is an offer, not a gate the reader has to get past: closing it
/// has to leave them somewhere they can act from — including by leaving.
void main() {
  testWidgets('closing the paywall leaves the reader, and does not reopen it', (
    tester,
  ) async {
    // The offer used to be scheduled from build, so dismissing the sheet
    // rebuilt the screen underneath it and put the sheet straight back up: the
    // reader could neither buy nor leave, because the back button was never
    // reachable.
    await _openLockedReader(tester);

    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(find.text('Credits needed'), findsOneWidget);

    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();

    expect(
      find.byType(BillingPaywall),
      findsNothing,
      reason: 'a dismissed paywall must stay dismissed',
    );
    // What is left says why the book is not open and keeps a way to change
    // that — a screen that only says no is a dead end.
    expect(find.text('Unlock to read'), findsOneWidget);
    expect(find.text('Get credits'), findsOneWidget);

    // Leaving is what the loop took away.
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();

    expect(find.byType(BookReaderScreen), findsNothing);
    expect(find.text('Open book'), findsOneWidget);
  });

  testWidgets('reopens the paywall when the reader asks for it', (tester) async {
    await _openLockedReader(tester);
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Get credits'));
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsOneWidget);
  });

  testWidgets('a download refused for want of credits offers the paywall', (
    tester,
  ) async {
    // The screen let this download start because the balance covered it, so a
    // 402 here is the balance moving underneath the reader. Retrying would ask
    // the same refusing route again.
    var paywallCalls = 0;
    final repository = FakeReaderRepository(failDownload: true)
      ..downloadError = const ApiException(
        code: 'INSUFFICIENT_CREDITS',
        message: 'You need 150 credits and have 25.',
        statusCode: 402,
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
            onOpenPaywall: () => paywallCalls += 1,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Credits needed to open this book'), findsOneWidget);
    expect(
      find.text('Try again'),
      findsNothing,
      reason: 'the same call would refuse again',
    );

    await tester.tap(find.text('Get credits'));
    await tester.pump();

    expect(paywallCalls, 1);
  });
}

/// Pushes the reader onto a book whose export costs more than the balance
/// holds, from a screen the reader can go back to.
Future<void> _openLockedReader(WidgetTester tester) async {
  final locked = pdfExport(unlocked: false, creditsRequired: 150);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        readerRepositoryProvider.overrideWithValue(FakeReaderRepository()),
        readerViewerBuilderProvider.overrideWithValue(stubViewer),
        projectStatusProvider.overrideWith(
          (ref, id) => Stream.value(statusWith(locked)),
        ),
        // 100 credits against the 150 the unlock costs.
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        storeBillingClientProvider.overrideWithValue(FakeStoreBillingClient()),
        creditLogRepositoryProvider.overrideWithValue(
          EmptyCreditLogRepository(),
        ),
      ],
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        const BookReaderScreen(projectId: 'project-1'),
                  ),
                ),
                child: const Text('Open book'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('Open book'));
  await tester.pumpAndSettle();
}
