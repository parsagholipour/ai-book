import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen_body.dart';
import 'package:tomeza/shared/api/api_client.dart';

// The plan and the progress used to be separate screens. These pin the thing
// that replaced them: one page whose shape follows the book's own state.

void main() {
  testWidgets('an unapproved plan is reviewed and approved on the book page', (
    tester,
  ) async {
    await _useTallSurface(tester);
    var approved = false;

    await tester.pumpWidget(
      _app(
        BookScreenBody(
          project: _project(status: 'plan_ready', plan: _plan()),
          status: _status(status: 'plan_ready', progressPercent: 20),
          billing: _billing,
          revisionController: TextEditingController(),
          onRefresh: () async {},
          onOpen: (_) async {},
          onDownload: (_) async {},
          onOpenPaywall: (_) async {},
          onRevisePlan: (_) async {},
          onApprovePlan: () async => approved = true,
        ),
      ),
    );
    await tester.pump();

    // The book it belongs to, then the plan itself — no second screen.
    expect(find.text('Premise'), findsOneWidget);
    expect(find.text('Set the promise'), findsOneWidget);
    expect(find.text('Request a revision'), findsOneWidget);
    // Nothing to export or preview yet, so neither is on the page.
    expect(find.text('Exports'), findsNothing);
    expect(find.text('Book preview'), findsNothing);

    await tester.tap(find.text('Approve and start writing'));
    await tester.pump();

    expect(approved, isTrue);
  });

  testWidgets('a book being written leads with progress and folds the plan', (
    tester,
  ) async {
    await _useTallSurface(tester);

    await tester.pumpWidget(
      _app(
        BookScreenBody(
          project: _project(
            status: 'generating',
            plan: _plan(approved: true),
            pages: const [
              MobileProjectPage(
                id: 'page-1',
                index: 1,
                title: 'Opening',
                summary: 'The first page.',
                previewText: 'Once the workbook begins…',
                status: 'complete',
              ),
            ],
          ),
          status: _status(status: 'generating', progressPercent: 38),
          billing: _billing,
          revisionController: TextEditingController(),
          onRefresh: () async {},
          onOpen: (_) async {},
          onDownload: (_) async {},
          onOpenPaywall: (_) async {},
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Book preview'), findsOneWidget);
    expect(find.text('Once the workbook begins…'), findsOneWidget);

    // The plan is still here, collapsed: no approve button, no premise, until
    // it is opened.
    expect(find.text('Book plan'), findsOneWidget);
    expect(find.text('1 chapter · 8 pages · Version 1'), findsOneWidget);
    expect(find.text('Approve and start writing'), findsNothing);
    expect(find.text('Premise'), findsNothing);

    await tester.tap(find.text('Book plan'));
    await tester.pumpAndSettle();

    expect(find.text('Set the promise'), findsOneWidget);
  });

  testWidgets('a finished book shows the payoff and the exports', (
    tester,
  ) async {
    await _useTallSurface(tester);

    await tester.pumpWidget(
      _app(
        BookScreenBody(
          project: _project(status: 'complete', plan: _plan(approved: true)),
          status: _status(
            status: 'complete',
            progressPercent: 100,
            exports: _readyExports,
          ),
          billing: _billing,
          revisionController: TextEditingController(),
          onRefresh: () async {},
          onOpen: (_) async {},
          onDownload: (_) async {},
          onOpenPaywall: (_) async {},
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Your book is ready'), findsOneWidget);
    expect(find.text('Exports'), findsOneWidget);
    expect(find.text('Read in Tomeza'), findsOneWidget);
    expect(find.text('Book plan'), findsOneWidget);
  });

  testWidgets('a replan copy names the book it was rebuilt from', (
    tester,
  ) async {
    await _useTallSurface(tester);

    await tester.pumpWidget(
      _app(
        BookScreenBody(
          project: _project(
            status: 'generating',
            plan: _plan(approved: true),
            revisedFrom: const MobileProjectRevisionOrigin(
              projectId: 'project-source',
              request: 'Rebuild it in French',
            ),
          ),
          status: _status(status: 'generating', progressPercent: 38),
          billing: _billing,
          revisionController: TextEditingController(),
          onRefresh: () async {},
          onOpen: (_) async {},
          onDownload: (_) async {},
          onOpenPaywall: (_) async {},
        ),
      ),
    );
    await tester.pump();

    expect(
      find.text('Rebuilt from an earlier book — “Rebuild it in French”'),
      findsOneWidget,
    );
  });
}

/// The page is one scrolling list, and the default test viewport cuts it off
/// part-way down — a lazy ListView never builds what falls below.
Future<void> _useTallSurface(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1000, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

Widget _app(Widget child) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(_testConfig),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
    ],
    child: MaterialApp(home: Scaffold(body: child)),
  );
}

final _testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

MobileProjectDetail _project({
  required String status,
  MobilePlan? plan,
  List<MobileProjectPage> pages = const [],
  MobileProjectRevisionOrigin? revisedFrom,
}) {
  return MobileProjectDetail(
    revisedFrom: revisedFrom,
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: 'Status',
    progressPercent: 38,
    currentAction: 'Working.',
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: pages.length,
    imageCount: 0,
    hasPlan: plan != null,
    exports: _exports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: plan,
    pages: pages,
  );
}

MobilePlan _plan({bool approved = false}) {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: approved ? 'approved' : 'draft',
    title: 'Launch Course Workbook',
    premise: 'A practical workbook that turns course ideas into a launch.',
    audience: 'Independent teachers and coaches.',
    questions: const [],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        targetPages: 8,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    approvedAt: approved ? DateTime.utc(2026, 6, 15) : null,
  );
}

MobileProjectStatus _status({
  required String status,
  required int progressPercent,
  MobileExportSet exports = _exports,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: status == 'complete'
        ? 'Ready to export'
        : status == 'generating'
        ? 'Generating your book'
        : 'Review your book plan',
    progressPercent: progressPercent,
    currentAction: 'Working on your book.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 1, target: 28),
    imageCount: 0,
    exports: exports,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

const _billing = MobileBilling(
  credits: CreditBalance(
    available: 1200,
    reserved: 0,
    lifetimeGranted: 1200,
    lifetimeSpent: 0,
  ),
  entitlements: [],
  products: [],
  creditCosts: {
    'fullBookBase': 350,
    'fullBookPerPage': 8,
    'imageGeneration': 45,
    'premiumReview': 200,
    'exportUnlock': 150,
  },
);

const _exports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

const _readyExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    unlocked: true,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    unlocked: true,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);
