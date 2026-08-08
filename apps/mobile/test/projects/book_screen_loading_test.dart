import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';

void main() {
  testWidgets('the book page keeps its content while a refetch is in flight', (
    tester,
  ) async {
    final repository = SlowPlanRepository();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectsRepositoryProvider.overrideWithValue(repository),
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        ],
        child: const MaterialApp(home: BookScreen(projectId: 'project-1')),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(repository.getProjectCalls, 1);
    expect(find.text('Create book plan'), findsOneWidget);

    await tester.tap(find.text('Create book plan'));
    await tester.pump();
    await tester.pump();

    expect(repository.getProjectCalls, 2);

    await tester.pump(const Duration(seconds: 5));

    expect(repository.getProjectCalls, 2);

    repository.completePending(planReadyProject());
    await tester.pump();

    // Matched by key, not by text: the title is now also drawn on the book
    // cover beside the header, so a bare text finder matches twice.
    expect(find.byKey(const ValueKey('project-header-title')), findsOneWidget);
  });
}

class SlowPlanRepository implements ProjectsRepository {
  int getProjectCalls = 0;
  Completer<MobileProjectDetail>? _pendingDetail;

  @override
  Future<MobileProjectDetail> getProject(String id) {
    getProjectCalls += 1;
    if (getProjectCalls == 1) {
      return Future.value(draftProject(id: id));
    }
    _pendingDetail = Completer<MobileProjectDetail>();
    return _pendingDetail!.future;
  }

  void completePending(MobileProjectDetail project) {
    _pendingDetail?.complete(project);
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    return MobilePlanOperation(
      projectId: projectId,
      status: 'planning_queued',
      currentAction: 'Creating your book plan.',
      job: const MobileQueuedJob(
        id: 'job-plan',
        status: 'queued',
        currentAction: 'Creating your book plan.',
      ),
    );
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
    bool disableIllustrations = false,
  }) async {
    return planOperation(status: 'generation_queued', planId: planId);
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
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    return draftProject(id: 'project-created');
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
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return MobileProjectStatus(
      projectId: id,
      status: 'draft',
      statusLabel: 'Draft saved',
      progressPercent: 0,
      currentAction: 'Ready to create a book plan.',
      retryAvailable: false,
      steps: const [],
      pageProgress: const MobilePageProgress(completed: 0, target: 18),
      imageCount: 0,
      exports: fakeExports,
      updatedAt: DateTime.utc(2026, 6, 15),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    yield await getProjectStatus(id);
  }

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    return const [];
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    return planOperation(status: 'revision_queued', planId: planId);
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
    return ModerationReportReceipt(
      id: 'report-1',
      targetType: 'image_asset',
      reason: reason,
      status: 'pending',
      createdAt: DateTime.utc(2026, 6, 15),
    );
  }

  @override
  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  }) async {
    return ModerationReportReceipt(
      id: 'report-1',
      targetType: 'project',
      reason: reason,
      status: 'pending',
      createdAt: DateTime.utc(2026, 6, 15),
    );
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async => ExportOpenOutcome.opened;
}

class FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async {
    return const MobileBilling(
      credits: CreditBalance(
        available: 1200,
        reserved: 0,
        lifetimeGranted: 1200,
        lifetimeSpent: 0,
      ),
      entitlements: [],
      products: [],
      creditCosts: {},
    );
  }

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

  @override
  Future<MobileBilling> refreshSubscription() => getBilling();

  @override
  Future<MobileBilling> cancelSubscription() => getBilling();
}

MobileProjectDetail draftProject({String id = 'project-1'}) {
  return projectDetail(
    id: id,
    status: 'draft',
    statusLabel: 'Draft saved',
    currentAction: 'Ready to create a book plan.',
  );
}

MobileProjectDetail planReadyProject() {
  return projectDetail(
    status: 'plan_ready',
    statusLabel: 'Review your book plan',
    currentAction: 'Ready for review.',
    plan: fakePlan(),
  );
}

MobileProjectDetail projectDetail({
  String id = 'project-1',
  required String status,
  required String statusLabel,
  required String currentAction,
  MobilePlan? plan,
}) {
  return MobileProjectDetail(
    id: id,
    title: 'Generated Plan',
    bookType: 'lead_magnet',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: statusLabel,
    progressPercent: plan == null ? 0 : 20,
    currentAction: currentAction,
    promptPreview: 'Create a practical guide for solo consultants.',
    targetPages: 18,
    pageCount: 0,
    imageCount: 0,
    hasPlan: plan != null,
    exports: fakeExports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a practical guide for solo consultants.',
    language: 'en',
    plan: plan,
    pages: const [],
  );
}

MobilePlan fakePlan() {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: 'draft',
    title: 'Generated Plan',
    premise: 'A compact guide that helps consultants package an offer.',
    audience: 'Independent consultants.',
    questions: const [],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Shape the offer',
        summary: 'Define the client, outcome, and promise.',
        targetPages: 6,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobilePlanOperation planOperation({required String status, String? planId}) {
  return MobilePlanOperation(
    projectId: 'project-1',
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

const fakeExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'Generated-Plan.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'Generated-Plan.epub',
    contentType: 'application/epub+zip',
  ),
);
