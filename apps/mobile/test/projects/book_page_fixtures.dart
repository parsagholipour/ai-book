import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen_body.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/shared/api/api_client.dart';

// Fixtures for the single book page: a book in any stage, and a harness that
// draws the page inside a router so buttons that navigate can be tapped.

/// What the server composes for a chat-made book: the planner's instruction,
/// not something to read.
const composedPrompt =
    'Create a short story.\n'
    'Book type choice: Short story\n'
    'Creation chat: Assistant: Hi! Tell me about the book you want to make.\n'
    'User: A lighthouse keeper finds a bottle with a letter from her future self.\n'
    'Assistant: Lovely. Who is it for?\n'
    'User: Adults who like quiet fiction.\n'
    'Audience or reader: Adults who like quiet fiction\n'
    'Recommended shape: A short story in three parts.';

MobileExportAvailability exportFile(
  String format, {
  bool available = true,
  bool subscription = false,
  int? bytes,
}) {
  return MobileExportAvailability(
    format: format,
    available: available,
    requiresSubscription: subscription,
    downloadUrl: '/api/mobile/projects/project-1/export/$format',
    filename: 'book.$format',
    contentType: 'application/octet-stream',
    byteSize: available ? bytes : null,
  );
}

MobileExportSet exportSet({bool available = true, int? pdfBytes}) {
  return MobileExportSet(
    pdf: exportFile('pdf', available: available, bytes: pdfBytes),
    epub: exportFile('epub', available: available, bytes: 612000),
  );
}

MobilePlan bookPlan({String title = 'The Lighthouse Letter'}) {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: 'approved',
    title: title,
    premise: 'A keeper decides whether to answer a letter from tomorrow.',
    audience: 'Adults.',
    questions: const [],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'The bottle',
        summary: 'She finds it.',
        targetPages: 8,
      ),
      MobilePlanChapter(
        index: 2,
        title: 'The answer',
        summary: 'She writes back.',
        targetPages: 8,
      ),
    ],
    createdAt: DateTime.utc(2026, 9, 1),
    updatedAt: DateTime.utc(2026, 9, 1),
    approvedAt: DateTime.utc(2026, 9, 1),
  );
}

const reviewQuality = MobileProjectQuality(
  state: 'review_recommended',
  score: 71,
  affectedPageIndexes: [4, 9],
  issues: [
    MobileProjectQualityIssue(
      code: 'REPETITION',
      severity: 'warning',
      source: 'model',
      message: 'Pages 4 and 9 end on the same image.',
      guidance: 'Rewrite one closing.',
      affectedPageIndexes: [4, 9],
    ),
    MobileProjectQualityIssue(
      code: 'PACING',
      severity: 'warning',
      source: 'model',
      message: 'Chapter three summarises the winter.',
      guidance: 'Expand the middle.',
      affectedPageIndexes: [17],
    ),
  ],
);

MobileProjectDetail bookProject({
  String status = 'complete',
  String prompt = composedPrompt,
  MobilePlan? plan,
  bool withPlan = true,
  String? subtitle,
  int pageCount = 16,
  MobileExportSet? exports,
  String source = 'generated',
  MobileManuscriptSummary? manuscript,
  String statusLabel = 'Status',
  MobileProjectQuality quality = const MobileProjectQuality.pending(),
  String bookType = 'short_story',
  String bookShape = 'book',
}) {
  final resolvedPlan = withPlan ? (plan ?? bookPlan()) : null;
  return MobileProjectDetail(
    id: 'project-1',
    title: 'The Lighthouse Letter',
    subtitle: subtitle,
    authorName: 'Parsa',
    bookType: bookType,
    bookShape: bookShape,
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: statusLabel,
    progressPercent: 100,
    currentAction: 'Working.',
    promptPreview: prompt.length > 180 ? prompt.substring(0, 180) : prompt,
    targetPages: 16,
    pageCount: pageCount,
    imageCount: 0,
    hasPlan: resolvedPlan != null,
    exports: exports ?? exportSet(),
    createdAt: DateTime.utc(2026, 9, 1),
    updatedAt: DateTime.utc(2026, 9, 1),
    prompt: prompt,
    language: 'en',
    plan: resolvedPlan,
    pages: const [],
    source: source,
    manuscript: manuscript,
    quality: quality,
  );
}

MobileProjectStatus bookStatus({
  String status = 'complete',
  String? failure,
  bool retry = false,
  int completed = 16,
  MobileExportSet? exports,
  MobileProjectQuality quality = const MobileProjectQuality.pending(),
  List<MobileProjectStatusStep> steps = const [],
  MobileGenerationRecoveryQuote? recoveryQuote,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: 'Status',
    progressPercent: 100,
    currentAction: 'Working on your book.',
    failureMessage: failure,
    retryAvailable: retry,
    recoveryQuote: recoveryQuote,
    steps: steps,
    pageProgress: MobilePageProgress(completed: completed, target: 16),
    imageCount: 0,
    exports: exports ?? exportSet(),
    quality: quality,
    updatedAt: DateTime.utc(2026, 9, 1),
  );
}

const creditsBilling = MobileBilling(
  credits: CreditBalance(
    available: 1000,
    reserved: 0,
    lifetimeGranted: 1000,
    lifetimeSpent: 0,
  ),
  entitlements: [],
  products: [],
  creditCosts: {'exportUnlock': 150},
);

final _config = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

/// The book page's body inside a router that records where a tap went.
Widget bookPageApp({
  required List<String> visited,
  MobileProjectDetail? project,
  MobileProjectStatus? status,
  Future<void> Function()? onResume,
  Future<void> Function()? onRefresh,
  String? busyAction,
  TextScaler textScaler = TextScaler.noScaling,
  List<Override> overrides = const [],
}) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: BookScreenBody(
            project: project,
            status: status,
            billing: creditsBilling,
            busyAction: busyAction,
            revisionController: TextEditingController(),
            onRefresh: onRefresh ?? () async {},
            onResume: onResume,
            onOpen: (_) async {},
            onDownload: (_) async {},
            onOpenPaywall: (_) async {},
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/:page',
        builder: (context, state) {
          visited.add(state.uri.toString());
          return const Scaffold(body: Text('elsewhere'));
        },
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(_config),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      ...overrides,
    ],
    child: MaterialApp.router(
      routerConfig: router,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: textScaler),
        child: child!,
      ),
    ),
  );
}
