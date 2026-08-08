import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';
import 'package:tomeza/features/projects/presentation/projects_home_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

void main() {
  testWidgets('empty home gives new users one dominant start action', (
    tester,
  ) async {
    await tester.pumpWidget(homeTestApp(projects: const []));
    await tester.pumpAndSettle();

    expect(find.text('Start your first book'), findsWidgets);
    expect(
      find.widgetWithText(FilledButton, 'Start your first book'),
      findsOneWidget,
    );
    expect(find.byType(FilledButton), findsOneWidget);
    expect(find.text('No books yet'), findsNothing);
    expect(find.text('850 available'), findsOneWidget);

    await tester.tap(
      find.widgetWithText(FilledButton, 'Start your first book'),
    );
    await tester.pumpAndSettle();

    expect(find.text('New book route'), findsOneWidget);
  });

  testWidgets('home sorts mixed projects by recommended next action', (
    tester,
  ) async {
    await tester.pumpWidget(
      homeTestApp(
        projects: [
          fakeProject(
            id: 'generating',
            title: 'Background Draft',
            status: 'generating',
            progressPercent: 52,
            pageCount: 8,
            hasPlan: true,
            updatedAt: DateTime.utc(2026, 6, 16),
          ),
          fakeProject(
            id: 'draft',
            title: 'Saved Idea',
            status: 'draft',
            hasPlan: false,
            updatedAt: DateTime.utc(2026, 6, 15),
          ),
          fakeProject(
            id: 'planning',
            title: 'Outline Building',
            status: 'planning',
            hasPlan: false,
            progressPercent: 10,
            updatedAt: DateTime.utc(2026, 6, 15, 12),
          ),
          fakeProject(
            id: 'complete',
            title: 'Finished Guide',
            status: 'complete',
            hasPlan: true,
            exportsReady: true,
            progressPercent: 100,
            pageCount: 18,
            updatedAt: DateTime.utc(2026, 6, 14),
          ),
          fakeProject(
            id: 'plan',
            title: 'Outline Waiting',
            status: 'plan_ready',
            hasPlan: true,
            progressPercent: 20,
            updatedAt: DateTime.utc(2026, 6, 13),
          ),
          fakeProject(
            id: 'failed',
            title: 'Needs Fixing',
            status: 'failed',
            hasPlan: true,
            progressPercent: 40,
            pageCount: 6,
            updatedAt: DateTime.utc(2026, 6, 12),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Pick up next'), findsOneWidget);
    expect(find.text('Needs Fixing'), findsOneWidget);
    expect(find.text('Needs your attention'), findsOneWidget);
    expect(find.text('Retry or review the issue'), findsOneWidget);
    expect(find.text('Review plan'), findsOneWidget);
    expect(find.text('Ready for a plan'), findsOneWidget);
    // A finished book leads with reading it; downloads live in the long-press
    // menu and on the progress screen.
    expect(find.text('Read book'), findsOneWidget);
    expect(find.text('Working in the background'), findsOneWidget);
    expect(find.text('Writing in progress'), findsOneWidget);
    expect(find.text('Plan in progress'), findsOneWidget);
    expect(find.text('Backend status: draft'), findsNothing);
    expect(find.text('Backend action: plan ready'), findsNothing);

    final failedTop = tester.getTopLeft(find.text('Needs Fixing')).dy;
    final planTop = tester.getTopLeft(find.text('Outline Waiting')).dy;
    final draftTop = tester.getTopLeft(find.text('Saved Idea')).dy;

    expect(failedTop, lessThan(planTop));
    expect(planTop, lessThan(draftTop));
  });

  testWidgets('home renders in light, dark, and larger text scale', (
    tester,
  ) async {
    final projects = [
      fakeProject(
        id: 'plan',
        title: 'Outline Waiting',
        status: 'plan_ready',
        hasPlan: true,
        progressPercent: 20,
      ),
    ];

    for (final scenario in const [
      _RenderScenario(themeMode: ThemeMode.light),
      _RenderScenario(themeMode: ThemeMode.dark),
      _RenderScenario(textScale: 1.5),
    ]) {
      await tester.pumpWidget(
        homeTestApp(
          projects: projects,
          themeMode: scenario.themeMode,
          textScale: scenario.textScale,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Welcome back, Mira'), findsOneWidget);
      expect(find.text('Review plan'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  testWidgets('missing project route returns users to home', (tester) async {
    final router = GoRouter(
      initialLocation: '/projects/missing',
      routes: [
        GoRoute(
          path: '/home',
          builder: (context, state) =>
              const Scaffold(body: Text('Useful home')),
        ),
        GoRoute(
          path: '/projects/:id',
          builder: (context, state) =>
              BookScreen(projectId: state.pathParameters['id']!),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectsRepositoryProvider.overrideWithValue(
            FakeProjectsRepository(
              projectError: const ApiException(
                code: 'PROJECT_NOT_FOUND',
                message: 'Project not found.',
                statusCode: 404,
              ),
            ),
          ),
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        ],
        child: MaterialApp.router(
          theme: buildTomezaLightTheme(),
          routerConfig: router,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Book not found'), findsOneWidget);
    expect(find.text('Back to projects'), findsOneWidget);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Back to projects'));
    await tester.pumpAndSettle();

    expect(find.text('Useful home'), findsOneWidget);
  });
}

Widget homeTestApp({
  required List<MobileProjectSummary> projects,
  ThemeMode themeMode = ThemeMode.light,
  double textScale = 1,
}) {
  final router = GoRouter(
    initialLocation: '/home',
    routes: [
      GoRoute(
        path: '/home',
        builder: (context, state) => const ProjectsHomeScreen(),
      ),
      GoRoute(
        path: '/books/new',
        builder: (context, state) =>
            const Scaffold(body: Text('New book route')),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            Scaffold(body: Text('Project ${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: '/projects/:id/handoff',
        builder: (context, state) =>
            Scaffold(body: Text('Progress ${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) => const Scaffold(body: Text('Account')),
      ),
    ],
  );

  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(FakeAuthRepository()),
      projectsRepositoryProvider.overrideWithValue(
        FakeProjectsRepository(projects: projects),
      ),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      darkTheme: buildTomezaDarkTheme(),
      themeMode: themeMode,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(textScaler: TextScaler.linear(textScale)),
        child: child ?? const SizedBox.shrink(),
      ),
      routerConfig: router,
    ),
  );
}

class _RenderScenario {
  const _RenderScenario({this.themeMode = ThemeMode.light, this.textScale = 1});

  final ThemeMode themeMode;
  final double textScale;
}

class FakeAuthRepository implements AuthRepository {
  @override
  Future<void> acceptCurrentLegalDocuments() async {}

  @override
  Future<AuthSession?> restoreSession() async => fakeSession();

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    return fakeSession(email: email);
  }

  @override
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
    bool termsAccepted = false,
    bool ageGuardianAttested = false,
  }) async {
    return fakeSession(email: email, displayName: displayName);
  }

  @override
  Future<void> logout() async {}
}

class FakeProjectsRepository implements ProjectsRepository {
  FakeProjectsRepository({this.projects = const [], this.projectError});

  final List<MobileProjectSummary> projects;
  final Object? projectError;

  @override
  Future<List<MobileProjectSummary>> listProjects() async => projects;

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    final error = projectError;
    if (error != null) {
      throw error;
    }
    return fakeProjectDetail(id: id);
  }

  @override
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    return fakeProjectDetail(id: 'created');
  }

  @override
  Future<Map<String, String>> assetHeaders() async => const {};

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return const MobileProjectChat(messages: [], operations: []);
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
  }) async {
    final reply = MobileProjectChatMessage(
      id: 'reply',
      projectId: projectId,
      role: 'assistant',
      content: 'Okay.',
      metadata: const {},
      createdAt: DateTime(2026),
    );
    return MobileProjectChatSendResult(
      messages: [reply],
      operations: const [],
      reply: reply,
    );
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
  }) {
    return sendProjectChatMessage(projectId: projectId, message: message);
  }

  @override
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectChatSendResult> undoLastBookEdit({
    required String projectId,
    String? requestId,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileImportedBook> importBook({
    required List<int> bytes,
    required String filename,
    required String requestId,
    String? mimeType,
    String? title,
    String? language,
    void Function(int sent, int total)? onProgress,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) {
    return getProjectChat(projectId);
  }

  @override
  Future<MobileEditableBook> getEditableBook(String projectId) {
    throw UnimplementedError('Edit Mode is not used in this test.');
  }

  @override
  Future<MobileEditChanges> getEditChanges({
    required String projectId,
    required String operationId,
  }) {
    throw UnimplementedError('Edit review is not used in this test.');
  }

  @override
  Future<MobileManualBookEditResult> saveManualBookEdit({
    required String projectId,
    required List<MobileManualBookPageEdit> pages,
    String? savedExportMessageId,
    String? requestId,
  }) {
    throw UnimplementedError('Edit Mode is not used in this test.');
  }

  @override
  Future<ProjectDeletionReceipt> deleteProject(String id) async {
    return ProjectDeletionReceipt(
      deletedProjectId: id,
      retainedLogs: 'Retained safety records.',
    );
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    return ProjectExportFile(
      format: export.format,
      filename: export.filename,
      path: '/tmp/${export.filename}',
    );
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    return fakeOperation(projectId: projectId, status: 'planning_queued');
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return MobileProjectStatus(
      projectId: id,
      status: 'draft',
      statusLabel: 'Backend status',
      progressPercent: 0,
      currentAction: 'Backend action',
      retryAvailable: false,
      steps: const [],
      pageProgress: const MobilePageProgress(completed: 0, target: 18),
      imageCount: 0,
      exports: fakeExports(),
      updatedAt: DateTime.utc(2026, 6, 16),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    yield await getProjectStatus(id);
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
    bool disableIllustrations = false,
  }) async {
    return fakeOperation(status: 'generation_queued', planId: planId);
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    return fakeOperation(status: 'revision_queued', planId: planId);
  }

  @override
  Future<MobileBookEditOperation> retryOperation({
    required String projectId,
    required String operationId,
    String? requestId,
    String? retryToken,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectRecovery> resumeProject(
    String id, {
    String? requestId,
    String? retryToken,
  }) async {
    return MobileProjectRecovery(
      projectId: id,
      status: 'recovery_started',
      currentAction: 'Retrying generation.',
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0,
    );
  }

  @override
  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  }) async {
    return fakeReportReceipt(targetType: 'image_asset', reason: reason);
  }

  @override
  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  }) async {
    return fakeReportReceipt(targetType: 'project', reason: reason);
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async => ExportOpenOutcome.opened;
}

class FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => fakeBilling();

  @override
  Future<MobileBilling> refreshSubscription() async => fakeBilling();

  @override
  Future<MobileBilling> cancelSubscription() async => fakeBilling();

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  }) async {
    return GooglePlayVerificationResult(
      purchase: const VerifiedPurchase(
        id: 'purchase-1',
        status: 'granted',
        creditsGranted: 1000,
      ),
      billing: await getBilling(),
    );
  }
}

AuthSession fakeSession({
  String email = 'creator@example.com',
  String? displayName = 'Mira Maker',
}) {
  return AuthSession(
    user: AuthUser(
      id: 'user-1',
      email: email,
      displayName: displayName,
      status: 'ACTIVE',
      createdAt: DateTime.utc(2026, 6, 1),
      updatedAt: DateTime.utc(2026, 6, 1),
    ),
    tokens: MobileSessionTokens(
      accessToken: 'access-token',
      accessTokenExpiresAt: DateTime.utc(2999, 1, 1),
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: DateTime.utc(2999, 2, 1),
    ),
  );
}

MobileProjectSummary fakeProject({
  required String id,
  required String title,
  required String status,
  bool hasPlan = false,
  bool exportsReady = false,
  int progressPercent = 0,
  int pageCount = 0,
  DateTime? updatedAt,
}) {
  return MobileProjectSummary(
    id: id,
    title: title,
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: 'Backend status: $status',
    progressPercent: progressPercent,
    currentAction: status == 'plan_ready'
        ? 'Backend action: plan ready'
        : 'Backend action: $status',
    promptPreview: 'Create a practical workbook for creators.',
    targetPages: 18,
    pageCount: pageCount,
    imageCount: 0,
    hasPlan: hasPlan,
    exports: fakeExports(ready: exportsReady),
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: updatedAt ?? DateTime.utc(2026, 6, 1),
  );
}

MobileProjectDetail fakeProjectDetail({required String id}) {
  final summary = fakeProject(id: id, title: 'Saved Idea', status: 'draft');
  return MobileProjectDetail(
    id: summary.id,
    title: summary.title,
    bookType: summary.bookType,
    lengthPreset: summary.lengthPreset,
    qualityPreset: summary.qualityPreset,
    imagesEnabled: summary.imagesEnabled,
    status: summary.status,
    statusLabel: summary.statusLabel,
    progressPercent: summary.progressPercent,
    currentAction: summary.currentAction,
    promptPreview: summary.promptPreview,
    targetPages: summary.targetPages,
    pageCount: summary.pageCount,
    imageCount: summary.imageCount,
    hasPlan: summary.hasPlan,
    exports: summary.exports,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    prompt: 'Create a practical workbook for creators.',
    language: 'en',
    pages: const [],
  );
}

MobilePlanOperation fakeOperation({
  String projectId = 'project-1',
  required String status,
  String? planId,
}) {
  return MobilePlanOperation(
    projectId: projectId,
    planId: planId,
    status: status,
    currentAction: 'Working on your book.',
    job: const MobileQueuedJob(
      id: 'job-1',
      status: 'queued',
      currentAction: 'Working on your book.',
    ),
  );
}

ModerationReportReceipt fakeReportReceipt({
  required String targetType,
  required String reason,
}) {
  return ModerationReportReceipt(
    id: 'report-1',
    targetType: targetType,
    reason: reason,
    status: 'pending',
    createdAt: DateTime.utc(2026, 6, 16),
  );
}

MobileBilling fakeBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 850,
      reserved: 0,
      lifetimeGranted: 1000,
      lifetimeSpent: 150,
    ),
    entitlements: [],
    products: [],
    creditCosts: {},
  );
}

MobileExportSet fakeExports({bool ready = false}) {
  return MobileExportSet(
    pdf: MobileExportAvailability(
      format: 'pdf',
      available: ready,
      unlocked: ready,
      creditsRequired: ready ? 0 : 150,
      downloadUrl: '/api/mobile/projects/project-1/export/pdf',
      filename: 'Book.pdf',
      contentType: 'application/pdf',
    ),
    epub: MobileExportAvailability(
      format: 'epub',
      available: ready,
      unlocked: ready,
      creditsRequired: ready ? 0 : 150,
      downloadUrl: '/api/mobile/projects/project-1/export/epub',
      filename: 'Book.epub',
      contentType: 'application/epub+zip',
    ),
  );
}
