import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

// Shared scaffolding for the creation-chat suites: the widget under test,
// its provider overrides, and the fixtures every case builds on.
// Split out of creation_chat_test.dart so the output-stage cases can reuse it
// rather than growing one file past reading.

const greeting = 'Tell me about the book you want to make.';
const reply = 'Great, that is enough for a solid first plan.';
const planTitle = 'Launch Course Workbook';

extension CreationChatTester on WidgetTester {
  /// Tears down the screen so its polling timer and tickers are cancelled.
  Future<void> teardownScreen() async {
    await pumpWidget(const SizedBox());
    await pump();
  }

  /// Steps through the illustrations confirmation, which now stands between
  /// "Build the plan" and the build request.
  ///
  /// Plain pumps rather than `pumpAndSettle`: a second build happens while the
  /// plan poll is running, and settling would never return.
  Future<void> continuePastVisualsPrompt() async {
    await pump();
    await pump(const Duration(milliseconds: 400));
    final continueButton = find.widgetWithText(FilledButton, 'Continue');
    if (continueButton.evaluate().isEmpty) {
      return;
    }
    await tap(continueButton);
    await pump();
    await pump(const Duration(milliseconds: 400));
  }
}

/// Text inside the transcript list (excludes app bar title and footer chips).
Finder bubbleText(String text) =>
    find.descendant(of: find.byType(ListView), matching: find.text(text));

Widget app({
  required CreationRepository creation,
  ProjectsRepository? projects,
  String? draftId,
  bool startFresh = false,
  CreationPrefsStore? prefs,
  PhotoPicker? photoPicker,
}) {
  return ProviderScope(
    overrides: [
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      creationRepositoryProvider.overrideWithValue(creation),
      if (projects != null)
        projectsRepositoryProvider.overrideWithValue(projects),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      // Always overridden: the file-backed store calls path_provider, which has
      // no implementation under `flutter test`.
      creationPrefsStoreProvider.overrideWithValue(
        prefs ?? MemoryCreationPrefsStore(),
      ),
      if (photoPicker != null)
        photoPickerProvider.overrideWithValue(photoPicker),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: CreationChatScreen(draftId: draftId, startFresh: startFresh),
    ),
  );
}

Widget routerApp({
  required CreationRepository creation,
  required ProjectsRepository projects,
  required String initialLocation,
  CreationPrefsStore? prefs,
}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/books/new',
        // Mirrors app_router.dart's real route (fresh + the reset nonce),
        // rather than a placeholder, so tests can exercise the "New book"
        // button through real GoRouter navigation.
        builder: (context, state) => CreationChatScreen(
          startFresh: state.uri.queryParameters['fresh'] == 'true',
          resetToken: state.uri.queryParameters['r'],
        ),
      ),
      GoRoute(
        path: '/books/chat/:draftId',
        builder: (context, state) =>
            CreationChatScreen(draftId: state.pathParameters['draftId']),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            BookScreen(projectId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) => const Scaffold(body: Text('Account')),
      ),
    ],
  );

  return ProviderScope(
    overrides: [
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      creationRepositoryProvider.overrideWithValue(creation),
      projectsRepositoryProvider.overrideWithValue(projects),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      creationPrefsStoreProvider.overrideWithValue(
        prefs ?? MemoryCreationPrefsStore(),
      ),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: router,
    ),
  );
}

Map<String, dynamic> turnJson({
  required String assistantMessage,
  required bool canBuild,
  List<String> quickReplies = const [],
  Map<String, dynamic>? question,
  int? targetPages,
  bool buildRequested = false,
  List<String> warnings = const [],
  String? authorName,
  String? title,
  Map<String, dynamic>? brief,
  List<String> missing = const [],
  List<String> titleSuggestions = const [],
}) {
  return {
    'assistantMessage': assistantMessage,
    'brief': brief ?? {'lane': 'auto'},
    'presets': {
      'bookType': 'lead_magnet',
      'bookTypeChoice': 'auto',
      'lengthPreset': 'short',
      'qualityPreset': 'balanced',
      'imagesEnabled': true,
      'pageCountMode': targetPages == null ? 'auto' : 'custom',
      'targetPages': ?targetPages,
      'pageCountSource': ?(targetPages == null ? null : 'chat'),
    },
    'detectedLane': 'auto',
    'quickReplies': quickReplies,
    'question': question,
    'readiness': {
      'score': canBuild ? 80 : 10,
      'canBuild': canBuild,
      'missing': missing,
    },
    'titleSuggestions': titleSuggestions,
    'shapePreview': ['Intro'],
    'warnings': warnings,
    'authorName': ?authorName,
    'title': ?title,
    'buildRequested': buildRequested,
  };
}

MobileChatSession chatSession({
  required String draftId,
  required String title,
  String status = 'ACTIVE',
  String? createdProjectId,
  String? activeProjectId,
  List<MobileCreationOutput> outputs = const [],
}) {
  final now = DateTime.utc(2026, 6, 15);
  return MobileChatSession(
    draftId: draftId,
    title: title,
    preview: 'Latest message',
    messageCount: 2,
    status: status,
    createdProjectId: createdProjectId,
    activeProjectId: activeProjectId ?? createdProjectId,
    outputs: outputs,
    createdAt: now,
    updatedAt: now,
  );
}

MobileCreationOutput creationOutput({
  required String projectId,
  required String title,
  required int sequence,
}) {
  final now = DateTime.utc(2026, 6, 15, 12, sequence);
  return MobileCreationOutput(
    id: 'output-$sequence',
    draftId: 'draft-done',
    projectId: projectId,
    title: title,
    sequence: sequence,
    createdAt: now,
    updatedAt: now,
  );
}

MobileProjectDetail plannedProject({
  String id = 'project-1',
  String status = 'plan_ready',
  String currentAction = 'Ready for review.',
  MobilePlan? plan,
  bool withoutPlan = false,
  bool coverEnabled = true,
  bool illustrationsEnabled = true,
}) {
  return MobileProjectDetail(
    id: id,
    title: planTitle,
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    coverEnabled: coverEnabled,
    illustrationsEnabled: illustrationsEnabled,
    status: status,
    statusLabel: 'Review your book plan',
    progressPercent: 20,
    currentAction: currentAction,
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: !withoutPlan,
    exports: _exports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: withoutPlan ? null : (plan ?? _defaultPlan(projectId: id)),
    pages: const [],
  );
}

MobilePlan _defaultPlan({String projectId = 'project-1'}) =>
    plan(projectId: projectId);

MobileProjectStatus projectStatusFromProject(MobileProjectDetail project) {
  return projectStatus(
    projectId: project.id,
    status: project.status,
    statusLabel: statusLabelForProjectStatus(project.status),
    progressPercent: project.progressPercent,
    currentAction: project.currentAction,
    completedPages: project.pageCount,
    targetPages: project.targetPages,
    imageCount: project.imageCount,
    coverEnabled: project.coverEnabled,
    illustrationsEnabled: project.illustrationsEnabled,
    failureMessage: project.status == 'failed' ? 'Generation failed.' : null,
  );
}

MobileProjectStatus projectStatus({
  String projectId = 'project-1',
  String status = 'generating',
  String? statusLabel,
  int progressPercent = 38,
  String currentAction = 'Writing your book pages.',
  String? failureMessage,
  bool retryAvailable = false,
  int completedPages = 3,
  int targetPages = 28,
  int imageCount = 1,
  bool? coverEnabled,
  bool? illustrationsEnabled,
  MobilePlanningProgress? planningProgress,
  MobileGenerationProgress? generationProgress,
  MobileExportSet exports = _exports,
}) {
  final complete = status == 'complete';
  final failed = status == 'failed';
  return MobileProjectStatus(
    projectId: projectId,
    status: status,
    statusLabel: statusLabel ?? statusLabelForProjectStatus(status),
    progressPercent: progressPercent,
    currentAction: currentAction,
    planningProgress: planningProgress,
    generationProgress: generationProgress,
    failureMessage: failureMessage,
    retryAvailable: retryAvailable,
    recoveryQuote: retryAvailable
        ? const MobileGenerationRecoveryQuote(
            retryToken: 'confirmed-retry-token',
            credits: 40,
          )
        : null,
    steps: [
      const MobileProjectStatusStep(key: 'plan', label: 'Plan', status: 'done'),
      MobileProjectStatusStep(
        key: 'write',
        label: 'Write',
        status: failed
            ? 'failed'
            : complete
            ? 'done'
            : 'active',
        detail: '$completedPages/$targetPages pages',
      ),
      MobileProjectStatusStep(
        key: 'visuals',
        label: 'Visuals',
        status: complete ? 'done' : 'pending',
        detail: imageCount == 1 ? '1 visual' : '$imageCount visuals',
      ),
      MobileProjectStatusStep(
        key: 'export',
        label: 'Export',
        status: complete ? 'done' : 'pending',
      ),
    ],
    pageProgress: MobilePageProgress(
      completed: completedPages,
      target: targetPages,
    ),
    imageCount: imageCount,
    exports: exports,
    coverEnabled: coverEnabled,
    illustrationsEnabled: illustrationsEnabled,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

String statusLabelForProjectStatus(String status) {
  return switch (status) {
    'generating' => 'Generating your book',
    'editing' => 'Editing your book',
    'complete' => 'Ready to export',
    'failed' => 'Needs attention',
    'planning' => 'Building your outline',
    _ => 'Review your book plan',
  };
}

MobilePlan plan({
  String id = 'plan-1',
  String projectId = 'project-1',
  int version = 1,
  String status = 'draft',
  String title = planTitle,
  List<MobilePlanQuestion> questions = const [],
}) {
  return MobilePlan(
    id: id,
    projectId: projectId,
    version: version,
    status: status,
    title: title,
    premise: 'A practical workbook for a simple paid launch.',
    audience: 'Independent teachers and coaches.',
    questions: questions,
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
  );
}

MobilePlan copyPlan(
  MobilePlan plan, {
  String? id,
  int? version,
  String? status,
  String? title,
  List<MobilePlanQuestion>? questions,
  DateTime? createdAt,
  DateTime? updatedAt,
}) {
  return MobilePlan(
    id: id ?? plan.id,
    projectId: plan.projectId,
    version: version ?? plan.version,
    status: status ?? plan.status,
    title: title ?? plan.title,
    subtitle: plan.subtitle,
    premise: plan.premise,
    audience: plan.audience,
    questions: questions ?? plan.questions,
    chapters: plan.chapters,
    createdAt: createdAt ?? plan.createdAt,
    updatedAt: updatedAt ?? plan.updatedAt,
    approvedAt: plan.approvedAt,
  );
}

MobilePlan approvedPlan() {
  return plan(status: 'approved');
}

MobilePlan longQuestionPlan() {
  return plan(
    questions: const [
      MobilePlanQuestion(
        prompt:
            'Which audience should the examples, exercises, explanations, and practical recommendations serve most directly?',
        options: [
          'Busy solo teachers launching their first live course',
          'New coaches building a detailed recorded program',
          'Small training teams adapting material for several audiences',
          'Independent experts creating a premium hybrid workshop',
          'Consultants turning an existing service into group learning',
          'Community leaders preparing an accessible beginner curriculum',
        ],
        allowCustom: true,
      ),
    ],
  );
}

MobilePlan questionPlan() {
  return plan(
    questions: const [
      MobilePlanQuestion(
        prompt: 'Who is the primary reader?',
        options: ['Busy solo teachers', 'New coaches'],
        allowCustom: true,
      ),
      MobilePlanQuestion(
        prompt: 'Should examples focus on live classes or recorded lessons?',
        options: ['Live classes', 'Recorded lessons'],
        allowCustom: true,
      ),
    ],
  );
}

/// A plan whose one question several of its answers cover at once, which the
/// planner declares so the drawer collects picks instead of sending the first.
MobilePlan multiQuestionPlan() {
  return plan(
    questions: const [
      MobilePlanQuestion(
        prompt: 'Which themes should the tales carry?',
        options: ['Forgiveness', 'Patience', 'Justice'],
        allowCustom: true,
        answerKind: QuestionAnswerKind.multi,
      ),
    ],
  );
}

/// A plan that opens with a question only the reader can answer in their own
/// words (no premade answers), followed by an ordinary choice.
MobilePlan openQuestionPlan() {
  return plan(
    questions: const [
      MobilePlanQuestion(
        prompt: 'What name should appear as the author?',
        options: [],
        allowCustom: true,
      ),
      MobilePlanQuestion(
        prompt: 'Should examples focus on live classes or recorded lessons?',
        options: ['Live classes', 'Recorded lessons'],
        allowCustom: true,
      ),
    ],
  );
}

MobileBilling billing() {
  return const MobileBilling(
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
}

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

const unlockedExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

class FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => billing();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
