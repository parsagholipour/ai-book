import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/auth_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_screen.dart';
import 'package:tomeza/features/projects/presentation/project_detail_screen.dart';

void main() {
  testWidgets('key mobile surfaces render at increased text scale', (
    tester,
  ) async {
    await tester.pumpWidget(
      _withProviders(
        child: const AuthScreen(mode: AuthScreenMode.signUp),
        authRepository: _FakeAuthRepository(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Create your account'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      _withProviders(
        child: const CreationChatScreen(),
        creationRepository: _FakeCreationRepository(),
        projectsRepository: _NeverProjectsRepository(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('New book'), findsOneWidget);
    expect(find.text('Book brief'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      _scaledApp(
        child: ListView(
          children: [
            ProjectPlanReview(
              project: _fakeProjectWithPlan(),
              plan: _fakePlan(),
              billing: _fakeBilling(),
              revisionController: TextEditingController(),
              busyAction: null,
              onQuestionAnswers: (_) async {},
              onRevisionRequest: (_) async {},
              onApprovePlan: () async {},
            ),
          ],
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Launch Course Workbook'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      _scaledApp(
        child: ProjectGenerationView(
          status: _fakeStatus(),
          billing: _fakeBilling(),
          onRefresh: () async {},
          onOpen: (_) async {},
          onDownload: (_) async {},
          onOpenPaywall: (_) async {},
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Generating your book'), findsOneWidget);
    expect(tester.takeException(), isNull);

    final store = DebugStoreBillingClient();
    addTearDown(store.dispose);
    await tester.pumpWidget(
      _withProviders(
        child: const BillingPaywall(projectId: 'project-1'),
        billingRepository: _FakeBillingRepository(),
        storeBillingClient: store,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Add credits'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      _scaledApp(
        child: SingleChildScrollView(
          child: AccountPrivacyControls(
            config: _testConfig,
            onRequestDeletion: () async {},
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Privacy and support'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Widget _withProviders({
  required Widget child,
  AuthRepository? authRepository,
  CreationRepository? creationRepository,
  ProjectsRepository? projectsRepository,
  BillingRepository? billingRepository,
  StoreBillingClient? storeBillingClient,
}) {
  return ProviderScope(
    key: UniqueKey(),
    overrides: [
      if (authRepository != null)
        authRepositoryProvider.overrideWithValue(authRepository),
      if (creationRepository != null)
        creationRepositoryProvider.overrideWithValue(creationRepository),
      if (projectsRepository != null)
        projectsRepositoryProvider.overrideWithValue(projectsRepository),
      if (billingRepository != null)
        billingRepositoryProvider.overrideWithValue(billingRepository),
      if (storeBillingClient != null)
        storeBillingClientProvider.overrideWithValue(storeBillingClient),
    ],
    child: _scaledApp(child: child),
  );
}

Widget _scaledApp({required Widget child}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    darkTheme: buildTomezaDarkTheme(),
    themeMode: ThemeMode.dark,
    builder: (context, appChild) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: const TextScaler.linear(1.6)),
      child: appChild ?? const SizedBox.shrink(),
    ),
    home: Scaffold(body: SafeArea(child: child)),
  );
}

class _FakeAuthRepository implements AuthRepository {
  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<void> logout() async {}

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    return _fakeSession(email: email);
  }

  @override
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
  }) async {
    return _fakeSession(email: email, displayName: displayName);
  }
}

class _NeverProjectsRepository implements ProjectsRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Project repository is not used in this test.');
  }
}

class _FakeCreationRepository implements CreationRepository {
  @override
  Future<List<MobileChatSession>> listSessions() async => const [];

  @override
  Future<void> renameSession({
    required String draftId,
    required String title,
    int? expectedRevision,
  }) async {}

  @override
  Future<void> deleteSession(String draftId) async {}

  @override
  Future<MobileCreationDraft?> getActiveDraft() async => null;

  @override
  Future<MobileCreationDraft> createDraft(MobileCreationDraftPayload payload) {
    throw UnimplementedError('Draft saves are not used in this test.');
  }

  @override
  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  }) {
    throw UnimplementedError('Draft saves are not used in this test.');
  }

  @override
  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  ) {
    throw UnimplementedError('Advisor is not used in this test.');
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) {
    throw UnimplementedError('Finalize is not used in this test.');
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    return fakeCreationConversation(withSession: false);
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    return fakeCreationConversation(withSession: true);
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? requestId,
  }) async {
    return fakeCreationConversation(withSession: true);
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? editMessageId,
    String? requestId,
    int? expectedRevision,
  }) async {
    return fakeCreationConversation(withSession: true);
  }

  @override
  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  }) async {
    return fakeCreationConversation(withSession: true);
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) {
    throw UnimplementedError('Preflight is not used in this test.');
  }

  @override
  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
    int? expectedRevision,
  }) async {
    return MobileCreationAttachment(
      id: 'att-fake',
      kind: 'document',
      name: filename,
      sizeBytes: bytes.length,
    );
  }

  @override
  Future<int?> deleteAttachment({
    required String draftId,
    required String attachmentId,
    int? expectedRevision,
  }) async => expectedRevision;

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    String? requestId,
    int? expectedRevision,
  }) {
    throw UnimplementedError('Build is not used in this test.');
  }
}

MobileCreationConversationResponse fakeCreationConversation({
  required bool withSession,
}) {
  return MobileCreationConversationResponse.fromJson({
    if (withSession)
      'session': {
        'draftId': 'draft-1',
        'status': 'ACTIVE',
        'messages': <dynamic>[],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
    'turn': {
      'assistantMessage': 'Tell me about the book you want to make.',
      'brief': {'lane': 'practical_guide'},
      'presets': {
        'bookType': 'lead_magnet',
        'lengthPreset': 'short',
        'qualityPreset': 'balanced',
        'imagesEnabled': true,
      },
      'detectedLane': 'practical_guide',
      'quickReplies': ['A kids book', 'A workbook'],
      'question': null,
      'readiness': {'score': 0, 'canBuild': false, 'missing': <dynamic>[]},
      'titleSuggestions': <dynamic>[],
      'shapePreview': ['Intro'],
      'warnings': <dynamic>[],
    },
  });
}

class _FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => _fakeBilling();

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
      billing: _fakeBilling(),
    );
  }
}

AuthSession _fakeSession({String? email, String? displayName}) {
  final now = DateTime.utc(2026, 6, 15);
  return AuthSession(
    user: AuthUser(
      id: 'user-1',
      email: email ?? 'mira@example.com',
      displayName: displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    ),
    tokens: MobileSessionTokens(
      accessToken: 'access',
      accessTokenExpiresAt: now.add(const Duration(hours: 1)),
      refreshToken: 'refresh',
      refreshTokenExpiresAt: now.add(const Duration(days: 1)),
    ),
  );
}

MobileProjectDetail _fakeProjectWithPlan() {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'plan_ready',
    statusLabel: 'Review your book plan',
    progressPercent: 20,
    currentAction: 'Ready for review.',
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: true,
    exports: _fakeExports(),
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: _fakePlan(),
    pages: const [],
  );
}

MobilePlan _fakePlan() {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: 'draft',
    title: 'Launch Course Workbook',
    premise: 'A practical workbook for a simple paid launch.',
    audience: 'Independent teachers and coaches.',
    questions: const [
      MobilePlanQuestion(
        prompt: 'Who is the primary reader?',
        options: ['Busy solo teachers', 'New coaches'],
        allowCustom: true,
      ),
    ],
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

MobileProjectStatus _fakeStatus() {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: 'generating',
    statusLabel: 'Generating your book',
    progressPercent: 45,
    currentAction: 'Writing your book pages.',
    retryAvailable: false,
    steps: const [
      MobileProjectStatusStep(key: 'plan', label: 'Plan', status: 'done'),
      MobileProjectStatusStep(key: 'write', label: 'Write', status: 'active'),
    ],
    pageProgress: const MobilePageProgress(completed: 4, target: 10),
    imageCount: 1,
    exports: _fakeExports(),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileBilling _fakeBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 1200,
      reserved: 0,
      lifetimeGranted: 1200,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [
      MobileBillingProduct(
        sku: 'tomeza.one_book_export',
        title: 'One book export',
        description: 'Unlock one complete book package.',
        productType: 'ONE_TIME_EXPORT',
        creditAmount: 1000,
        priceMicros: 9990000,
        currency: 'USD',
      ),
    ],
    creditCosts: {
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

MobileExportSet _fakeExports() {
  return const MobileExportSet(
    pdf: MobileExportAvailability(
      format: 'pdf',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/pdf',
      filename: 'Launch-Course-Workbook.pdf',
      contentType: 'application/pdf',
    ),
    epub: MobileExportAvailability(
      format: 'epub',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/epub',
      filename: 'Launch-Course-Workbook.epub',
      contentType: 'application/epub+zip',
    ),
  );
}

final _testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://10.0.2.2:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete-account'),
  supportEmail: 'support@example.com',
);
