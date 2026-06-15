import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

void main() {
  testWidgets('auth gate routes signed-out users to sign in and sign up', (
    tester,
  ) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));

    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(find.text('Create your account'), findsOneWidget);
    expect(find.text('I already have an account'), findsOneWidget);
  });

  testWidgets(
    'authenticated users land on projects home and can open the book wizard',
    (tester) async {
      await tester.pumpWidget(
        testApp(
          authRepository: FakeAuthRepository(initialSession: fakeSession()),
          projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
          billingRepository: FakeBillingRepository(billing: fakeBilling()),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('Your book projects'), findsOneWidget);
      expect(find.text('Credits'), findsOneWidget);
      expect(find.text('Audience Growth Workbook'), findsOneWidget);
      expect(find.text('Create your account'), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'New'));
      await tester.pumpAndSettle();

      expect(find.text('New book'), findsOneWidget);
      expect(find.text('Choose a book type'), findsOneWidget);
    },
  );
}

Widget testApp({
  required FakeAuthRepository authRepository,
  FakeProjectsRepository? projectsRepository,
  FakeBillingRepository? billingRepository,
}) {
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(authRepository),
      projectsRepositoryProvider.overrideWithValue(
        projectsRepository ?? FakeProjectsRepository(),
      ),
      billingRepositoryProvider.overrideWithValue(
        billingRepository ?? FakeBillingRepository(),
      ),
    ],
    child: const TomezaApp(),
  );
}

class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({AuthSession? initialSession}) : _session = initialSession;

  AuthSession? _session;

  @override
  Future<AuthSession?> restoreSession() async => _session;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    _session = fakeSession(email: email);
    return _session!;
  }

  @override
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
  }) async {
    _session = fakeSession(email: email, displayName: displayName);
    return _session!;
  }

  @override
  Future<void> logout() async {
    _session = null;
  }
}

class FakeProjectsRepository implements ProjectsRepository {
  FakeProjectsRepository({
    List<MobileProjectSummary>? projects,
    this.projectDetail,
  }) : _projects = projects ?? [];

  final List<MobileProjectSummary> _projects;
  final MobileProjectDetail? projectDetail;

  MobileProjectCreateRequest? lastCreateRequest;

  @override
  Future<List<MobileProjectSummary>> listProjects() async => _projects;

  @override
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    lastCreateRequest = request;
    return projectDetail ?? fakeProjectDetail();
  }

  @override
  Future<Map<String, String>> assetHeaders() async {
    return const {};
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
  Future<MobileProjectDetail> getProject(String id) async {
    return projectDetail ?? fakeProjectDetail(id: id);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return fakeProjectStatus(projectId: id);
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    return fakePlanOperation(projectId: projectId, status: 'planning_queued');
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
  }) async {
    return fakePlanOperation(
      projectId: projectDetail?.id ?? 'project-1',
      planId: planId,
      status: 'revision_queued',
    );
  }

  @override
  Future<MobilePlanOperation> approvePlan(String planId) async {
    return fakePlanOperation(
      projectId: projectDetail?.id ?? 'project-1',
      planId: planId,
      status: 'generation_queued',
    );
  }

  @override
  Future<MobileProjectRecovery> resumeProject(String id) async {
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
  Future<void> shareExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {}
}

class FakeBillingRepository implements BillingRepository {
  FakeBillingRepository({MobileBilling? billing})
    : _billing = billing ?? fakeBilling();

  final MobileBilling _billing;

  @override
  Future<MobileBilling> getBilling() async => _billing;

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
      billing: _billing,
    );
  }
}

AuthSession fakeSession({
  String email = 'creator@example.com',
  String? displayName = 'Mira',
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

MobileProjectSummary fakeProject() {
  return MobileProjectSummary(
    id: 'project-1',
    title: 'Audience Growth Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'draft',
    statusLabel: 'Draft saved',
    progressPercent: 0,
    currentAction: 'Ready to create a book plan.',
    promptPreview:
        'Create a workbook for independent teachers building a simple audience funnel.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: false,
    exports: const MobileExportSet(
      pdf: MobileExportAvailability(
        format: 'pdf',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '/api/mobile/projects/project-1/export/pdf',
        filename: 'Audience-Growth-Workbook.pdf',
        contentType: 'application/pdf',
      ),
      epub: MobileExportAvailability(
        format: 'epub',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '/api/mobile/projects/project-1/export/epub',
        filename: 'Audience-Growth-Workbook.epub',
        contentType: 'application/epub+zip',
      ),
    ),
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: DateTime.utc(2026, 6, 1),
  );
}

MobileProjectDetail fakeProjectDetail({String id = 'project-1'}) {
  final summary = fakeProject();
  return MobileProjectDetail(
    id: id,
    title: summary.title,
    subtitle: summary.subtitle,
    authorName: summary.authorName,
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
    prompt:
        'Create a workbook for independent teachers building a simple audience funnel.',
    language: 'en',
    pages: const [],
  );
}

MobilePlanOperation fakePlanOperation({
  required String projectId,
  required String status,
  String? planId,
}) {
  return MobilePlanOperation(
    projectId: projectId,
    planId: planId,
    status: status,
    currentAction: 'Working on your book plan.',
    job: const MobileQueuedJob(
      id: 'job-1',
      status: 'queued',
      currentAction: 'Working on your book plan.',
    ),
  );
}

MobileProjectStatus fakeProjectStatus({required String projectId}) {
  return MobileProjectStatus(
    projectId: projectId,
    status: 'draft',
    statusLabel: 'Draft saved',
    progressPercent: 0,
    currentAction: 'Ready to create a book plan.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 0, target: 28),
    imageCount: 0,
    exports: fakeProject().exports,
    updatedAt: DateTime.utc(2026, 6, 1),
  );
}

MobileBilling fakeBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 850,
      reserved: 150,
      lifetimeGranted: 1000,
      lifetimeSpent: 150,
    ),
    entitlements: [],
    products: [],
    creditCosts: {},
  );
}
