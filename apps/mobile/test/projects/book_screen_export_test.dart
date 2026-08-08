import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen_body.dart';
import 'package:tomeza/features/projects/presentation/project_export_panel.dart';

void main() {
  testWidgets('the book page renders progress, pages, visuals, and retry', (
    tester,
  ) async {
    var retried = false;
    // The page is one scrolling list — cover, progress, preview, exports — and
    // the default 800pt test viewport cuts it off before the preview, which a
    // lazy ListView then never builds.
    await tester.binding.setSurfaceSize(const Size(1000, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BookScreenBody(
            status: fakeStatus(
              progressPercent: 38,
              currentAction: 'Writing your book pages.',
              failureMessage:
                  'We hit a problem while writing a page: draft timed out.',
              retryAvailable: true,
            ),
            project: fakeProjectWithPreview(),
            onRefresh: () async {},
            onResume: () async {
              retried = true;
            },
            onOpen: (_) async {},
            onDownload: (_) async {},
            onOpenPaywall: (_) async {},
          ),
        ),
      ),
    );

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing your book pages.'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('3/10 pages'), findsWidgets);
    expect(find.text('1 visuals'), findsWidgets);
    expect(find.text('Book preview'), findsOneWidget);
    expect(find.text('Set the promise'), findsOneWidget);
    expect(find.textContaining('draft timed out'), findsOneWidget);

    await tester.tap(find.text('Retry generation'));
    await tester.pump();

    expect(retried, isTrue);
  });

  testWidgets('scheduled automatic retry remains progress, not failure', (
    tester,
  ) async {
    var resumed = false;
    final status = fakeStatus(
      progressPercent: 38,
      currentAction: 'Writing paused.',
      failureMessage: 'A page timed out.',
      retryAvailable: true,
      nextRetryAt: DateTime.utc(2026, 6, 15, 12, 5),
      retryState: 'scheduled',
      retryMessage: 'Retrying the page automatically.',
    );

    expect(status.isLive, isTrue);
    expect(status.isAutomaticRetryPending, isTrue);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BookScreenBody(
            status: status,
            onRefresh: () async {},
            onResume: () async => resumed = true,
            onOpen: (_) async {},
            onDownload: (_) async {},
            onOpenPaywall: (_) async {},
          ),
        ),
      ),
    );

    expect(find.text('Retry scheduled'), findsOneWidget);
    expect(find.text('Retrying the page automatically.'), findsWidgets);
    expect(find.text('Writing stopped'), findsNothing);
    expect(find.text('Retry generation'), findsNothing);
    expect(resumed, isFalse);
  });

  testWidgets('export panel shows locked and unlocked states', (tester) async {
    final openedFormats = <String>[];
    final downloadedFormats = <String>[];
    final paywalledFormats = <String>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectExportPanel(
            exports: fakeExports(
              pdfUnlocked: false,
              pdfAvailable: true,
              epubUnlocked: true,
              epubAvailable: true,
            ),
            billing: fakeBilling(availableCredits: 200),
            onOpen: (export) async {
              openedFormats.add(export.format);
            },
            onDownload: (export) async {
              downloadedFormats.add(export.format);
            },
            onOpenPaywall: (export) async {
              paywalledFormats.add(export.format);
            },
          ),
        ),
      ),
    );

    expect(find.text('Unlock PDF'), findsOneWidget);
    expect(find.text('Open EPUB'), findsOneWidget);
    expect(find.text('Download'), findsOneWidget);
    expect(
      find.text(
        'Ready after export unlock. This uses 150 credits if not already included.',
      ),
      findsOneWidget,
    );
    expect(find.text('Ready to open or download.'), findsOneWidget);

    await tester.tap(find.text('Unlock PDF'));
    await tester.pump();
    await tester.tap(find.text('Open EPUB'));
    await tester.pump();
    await tester.tap(find.text('Download'));
    await tester.pump();

    expect(openedFormats, ['pdf', 'epub']);
    expect(downloadedFormats, ['epub']);
    expect(paywalledFormats, isEmpty);
  });

  testWidgets(
    'blocked quality issues warn and identify pages but keep exports available',
    (tester) async {
      const quality = MobileProjectQuality(
        state: 'blocked',
        score: 64,
        affectedPageIndexes: [3],
        issues: [
          MobileProjectQualityIssue(
            code: 'PLACEHOLDER_TEXT',
            severity: 'error',
            source: 'deterministic',
            message: 'Page 3 contains placeholder text.',
            guidance: 'Replace the placeholder in Edit Mode.',
            affectedPageIndexes: [3],
          ),
        ],
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: BookScreenBody(
              status: fakeStatus(quality: quality),
              onRefresh: () async {},
              onOpen: (_) async {},
              onDownload: (_) async {},
              onOpenPaywall: (_) async {},
            ),
          ),
        ),
      );

      expect(find.text('Quality checks flagged pages'), findsOneWidget);
      expect(find.text('Page 3 contains placeholder text.'), findsOneWidget);
      expect(find.textContaining('Pages 3 · Open Edit Mode'), findsOneWidget);
      // The warning never withholds the book: exports stay available.
      await tester.dragUntilVisible(
        find.text('Exports'),
        find.byType(ListView),
        const Offset(0, -120),
      );
      expect(find.text('Exports'), findsOneWidget);
    },
  );

  testWidgets('export panel opens paywall when credits are short', (
    tester,
  ) async {
    final paywalledFormats = <String>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectExportPanel(
            exports: fakeExports(
              pdfUnlocked: false,
              pdfAvailable: true,
              epubUnlocked: false,
              epubAvailable: true,
            ),
            billing: fakeBilling(availableCredits: 25),
            onOpen: (_) async {},
            onDownload: (_) async {},
            onOpenPaywall: (export) async {
              paywalledFormats.add(export.format);
            },
          ),
        ),
      ),
    );

    expect(find.text('Get credits'), findsNWidgets(2));
    expect(
      find.text('Ready after export unlock. You need 150 credits and have 25.'),
      findsNWidgets(2),
    );

    await tester.tap(find.text('Get credits').first);
    await tester.pump();

    expect(paywalledFormats, ['pdf']);
  });
}

MobileBilling fakeBilling({int availableCredits = 1000}) {
  return MobileBilling(
    credits: CreditBalance(
      available: availableCredits,
      reserved: 0,
      lifetimeGranted: availableCredits,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: const {'exportUnlock': 150},
  );
}

MobileProjectStatus fakeStatus({
  int progressPercent = 100,
  String currentAction = 'Ready to download.',
  String? failureMessage,
  bool retryAvailable = false,
  MobileExportSet? exports,
  MobileProjectQuality quality = const MobileProjectQuality.pending(),
  DateTime? nextRetryAt,
  String? retryState,
  String? retryMessage,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: progressPercent >= 100 ? 'complete' : 'generating',
    statusLabel: progressPercent >= 100
        ? 'Ready to export'
        : 'Generating your book',
    progressPercent: progressPercent,
    currentAction: currentAction,
    failureMessage: failureMessage,
    retryAvailable: retryAvailable,
    nextRetryAt: nextRetryAt,
    retryState: retryState,
    retryMessage: retryMessage,
    steps: const [
      MobileProjectStatusStep(key: 'plan', label: 'Plan', status: 'done'),
      MobileProjectStatusStep(
        key: 'write',
        label: 'Write',
        status: 'active',
        detail: '3/10 pages',
      ),
      MobileProjectStatusStep(
        key: 'visuals',
        label: 'Visuals',
        status: 'pending',
        detail: '1 visuals',
      ),
      MobileProjectStatusStep(
        key: 'export',
        label: 'Export',
        status: 'pending',
      ),
    ],
    pageProgress: const MobilePageProgress(completed: 3, target: 10),
    imageCount: 1,
    exports: exports ?? fakeExports(),
    quality: quality,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileProjectDetail fakeProjectWithPreview() {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'generating',
    statusLabel: 'Generating your book',
    progressPercent: 38,
    currentAction: 'Writing your book pages.',
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 10,
    pageCount: 3,
    imageCount: 1,
    hasPlan: true,
    exports: fakeExports(),
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    pages: const [
      MobileProjectPage(
        id: 'page-1',
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        previewText:
            'A strong course promise names the audience, the outcome, and the moment when the reader can see progress.',
        status: 'completed',
      ),
    ],
  );
}

MobileExportSet fakeExports({
  bool pdfUnlocked = true,
  bool pdfAvailable = true,
  bool epubUnlocked = true,
  bool epubAvailable = true,
}) {
  return MobileExportSet(
    pdf: MobileExportAvailability(
      format: 'pdf',
      available: pdfAvailable,
      unlocked: pdfUnlocked,
      creditsRequired: pdfUnlocked ? 0 : 150,
      downloadUrl: '/api/mobile/projects/project-1/export/pdf',
      filename: 'Launch-Course-Workbook.pdf',
      contentType: 'application/pdf',
    ),
    epub: MobileExportAvailability(
      format: 'epub',
      available: epubAvailable,
      unlocked: epubUnlocked,
      creditsRequired: epubUnlocked ? 0 : 150,
      downloadUrl: '/api/mobile/projects/project-1/export/epub',
      filename: 'Launch-Course-Workbook.epub',
      contentType: 'application/epub+zip',
    ),
  );
}
