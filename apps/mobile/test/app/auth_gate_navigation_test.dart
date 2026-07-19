import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

void main() {
  testWidgets('auth gate routes signed-out users to sign in and sign up', (
    tester,
  ) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));

    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    await tester.ensureVisible(find.text('Create account'));
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(find.text('Create your account'), findsOneWidget);
    expect(find.text('I already have an account'), findsOneWidget);
  });

  testWidgets('authenticated users land on the book chat', (tester) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(initialSession: fakeSession()),
        projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
        billingRepository: FakeBillingRepository(billing: fakeBilling()),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text('Book brief'), findsWidgets);
    expect(find.text('A kids book'), findsOneWidget);
    expect(find.text('Create your account'), findsNothing);
  });

  testWidgets('restore network errors stay on a retryable splash screen', (
    tester,
  ) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          initialSession: fakeSession(),
          restoreError: const ApiException(
            code: 'NETWORK_ERROR',
            message: 'Check your connection and try again.',
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Connection problem'), findsOneWidget);
    expect(find.text('Check your connection and try again.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Welcome back'), findsNothing);
  });

  testWidgets('failed sign in keeps the email field filled', (tester) async {
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(
          signInError: const ApiException(
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect.',
            statusCode: 401,
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'wrong-password',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();

    final emailField = tester.widget<TextFormField>(
      find.widgetWithText(TextFormField, 'Email'),
    );
    expect(emailField.controller?.text, 'reader@example.com');
    expect(find.text('Email or password is incorrect.'), findsOneWidget);
  });
}

Widget testApp({
  required FakeAuthRepository authRepository,
  FakeProjectsRepository? projectsRepository,
  FakeBillingRepository? billingRepository,
  FakeCreationRepository? creationRepository,
}) {
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(authRepository),
      creationRepositoryProvider.overrideWithValue(
        creationRepository ?? FakeCreationRepository(),
      ),
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
  FakeAuthRepository({
    AuthSession? initialSession,
    this.restoreError,
    this.signInError,
  }) : _session = initialSession;

  AuthSession? _session;
  final Object? restoreError;
  final Object? signInError;

  @override
  Future<AuthSession?> restoreSession() async {
    final error = restoreError;
    if (error != null) {
      throw error;
    }
    return _session;
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    final error = signInError;
    if (error != null) {
      throw error;
    }
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

class FakeCreationRepository implements CreationRepository {
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
    return fakeGreetingConversation(withSession: false);
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    return fakeGreetingConversation(withSession: true);
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? requestId,
  }) async {
    return fakeGreetingConversation(withSession: true);
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
    return fakeGreetingConversation(withSession: true);
  }

  @override
  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  }) async {
    return fakeGreetingConversation(withSession: true);
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
    throw UnimplementedError('Conversation is not used in this test.');
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) {
    throw UnimplementedError('Conversation is not used in this test.');
  }
}

MobileCreationConversationResponse fakeGreetingConversation({
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
      'quickReplies': <dynamic>['A kids book', 'A workbook'],
      'question': null,
      'readiness': {'score': 0, 'canBuild': false, 'missing': <dynamic>[]},
      'titleSuggestions': <dynamic>[],
      'shapePreview': <dynamic>['Intro'],
      'warnings': <dynamic>[],
    },
  });
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
  Future<MobileProjectDetail> getProject(String id) async {
    return projectDetail ?? fakeProjectDetail(id: id);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return fakeProjectStatus(projectId: id);
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    yield await getProjectStatus(id);
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    return fakePlanOperation(projectId: projectId, status: 'planning_queued');
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    return fakePlanOperation(
      projectId: projectDetail?.id ?? 'project-1',
      planId: planId,
      status: 'revision_queued',
    );
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
  }) async {
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

ModerationReportReceipt fakeReportReceipt({
  required String targetType,
  required String reason,
}) {
  return ModerationReportReceipt(
    id: 'report-1',
    targetType: targetType,
    reason: reason,
    status: 'pending',
    createdAt: DateTime.utc(2026, 6, 15),
  );
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
