import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_screen.dart';
import 'package:tomeza/features/projects/presentation/project_detail_screen.dart';

void main() {
  testWidgets('generated preview exposes AI disclosure and report actions', (
    tester,
  ) async {
    var bookReports = 0;
    final visualReports = <String>[];

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(testConfig),
          projectAssetHeadersProvider.overrideWith(
            (ref) async => const <String, String>{},
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: ProjectGenerationView(
              status: fakeStatus(),
              project: fakeProjectWithVisuals(),
              onRefresh: () async {},
              onOpen: (_) async {},
              onDownload: (_) async {},
              onOpenPaywall: (_) async {},
              onReportProject: () async {
                bookReports += 1;
              },
              onReportImage: (image) async {
                visualReports.add(image.id);
              },
            ),
          ),
        ),
      ),
    );

    expect(
      find.text('AI-generated content from your prompt and selected preset.'),
      findsOneWidget,
    );
    expect(find.text('Report book'), findsOneWidget);
    expect(find.text('Report visual'), findsNWidgets(2));

    await tester.tap(find.text('Report book'));
    await tester.pump();
    final reportVisualButton = find
        .widgetWithText(OutlinedButton, 'Report visual')
        .first;
    await tester.ensureVisible(reportVisualButton);
    await tester.pump();
    await tester.tap(reportVisualButton);
    await tester.pump();

    expect(bookReports, 1);
    expect(visualReports, ['cover-image']);
  });

  testWidgets('project privacy actions expose deletion', (tester) async {
    var deleted = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProjectPrivacyActions(
            onDeleteProject: () async {
              deleted = true;
            },
          ),
        ),
      ),
    );

    expect(find.text('Delete project'), findsOneWidget);
    await tester.tap(find.text('Delete project'));
    await tester.pump();

    expect(deleted, isTrue);
  });

  testWidgets(
    'account privacy controls expose legal links and deletion request',
    (tester) async {
      var requested = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AccountPrivacyControls(
                config: testConfig,
                onRequestDeletion: () async {
                  requested = true;
                },
              ),
            ),
          ),
        ),
      );

      expect(find.text('Privacy and support'), findsOneWidget);
      expect(find.text('support@example.com'), findsOneWidget);
      expect(find.text('https://example.com/privacy'), findsOneWidget);
      expect(find.text('https://example.com/terms'), findsOneWidget);
      expect(find.text('Request account deletion'), findsOneWidget);

      final requestDeletionButton = find.widgetWithText(
        OutlinedButton,
        'Request account deletion',
      );
      await tester.ensureVisible(requestDeletionButton);
      await tester.pump();
      await tester.tap(requestDeletionButton);
      await tester.pump();

      expect(requested, isTrue);
    },
  );
}

final testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://10.0.2.2:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete-account'),
  supportEmail: 'support@example.com',
);

MobileProjectStatus fakeStatus() {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: 'generating',
    statusLabel: 'Generating your book',
    progressPercent: 50,
    currentAction: 'Writing your book pages.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 1, target: 2),
    imageCount: 2,
    exports: fakeExports(),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileProjectDetail fakeProjectWithVisuals() {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'generating',
    statusLabel: 'Generating your book',
    progressPercent: 50,
    currentAction: 'Writing your book pages.',
    promptPreview: 'Create a workbook.',
    targetPages: 2,
    pageCount: 1,
    imageCount: 2,
    hasPlan: true,
    exports: fakeExports(),
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for a launch workshop.',
    language: 'en',
    coverImage: const MobileProjectImage(
      id: 'cover-image',
      role: 'cover',
      url: '/api/mobile/projects/project-1/assets/cover-image',
      contentType: 'image/png',
      altText: 'Generated cover',
    ),
    pages: const [
      MobileProjectPage(
        id: 'page-1',
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result.',
        previewText: 'A strong promise names the audience and outcome.',
        status: 'completed',
        image: MobileProjectImage(
          id: 'page-image',
          role: 'page_visual',
          url: '/api/mobile/projects/project-1/assets/page-image',
          contentType: 'image/png',
          altText: 'Generated page visual',
          pageId: 'page-1',
        ),
      ),
    ],
  );
}

MobileExportSet fakeExports() {
  return const MobileExportSet(
    pdf: MobileExportAvailability(
      format: 'pdf',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/pdf',
      filename: 'Launch-Workbook.pdf',
      contentType: 'application/pdf',
    ),
    epub: MobileExportAvailability(
      format: 'epub',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/epub',
      filename: 'Launch-Workbook.epub',
      contentType: 'application/epub+zip',
    ),
  );
}
