import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_screen.dart';

void main() {
  testWidgets('generation view renders progress, pages, visuals, and retry', (
    tester,
  ) async {
    var retried = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectGenerationView(
            status: fakeStatus(
              progressPercent: 38,
              currentAction: 'Writing your book pages.',
              failureMessage:
                  'We hit a problem while writing a page: draft timed out.',
              retryAvailable: true,
            ),
            project: fakeProjectWithPreview(),
            downloadedFiles: const {},
            onRefresh: () async {},
            onResume: () async {
              retried = true;
            },
            onDownload: (_) async {},
            onShare: (_) async {},
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

  testWidgets('export panel shows locked and unlocked states', (tester) async {
    final downloadedFormats = <String>[];
    final sharedFormats = <String>[];
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
            downloadedFiles: const {},
            onDownload: (export) async {
              downloadedFormats.add(export.format);
            },
            onShare: (export) async {
              sharedFormats.add(export.format);
            },
            onOpenPaywall: (export) async {
              paywalledFormats.add(export.format);
            },
          ),
        ),
      ),
    );

    expect(find.text('Unlock PDF'), findsOneWidget);
    expect(find.text('Download EPUB'), findsOneWidget);
    expect(
      find.text(
        'Ready after export unlock. This uses 150 credits if not already included.',
      ),
      findsOneWidget,
    );
    expect(find.text('Ready to download and share.'), findsOneWidget);

    await tester.tap(find.text('Unlock PDF'));
    await tester.pump();
    await tester.tap(find.widgetWithText(OutlinedButton, 'Share').last);
    await tester.pump();

    expect(downloadedFormats, ['pdf']);
    expect(sharedFormats, ['epub']);
    expect(paywalledFormats, isEmpty);
  });

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
            downloadedFiles: const {},
            onDownload: (_) async {},
            onShare: (_) async {},
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
