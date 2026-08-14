import 'dart:async';

import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'creation_chat_harness.dart';

// The scripted projects repository the plan/book suites run against.
// Split from creation_chat_fakes.dart, which re-exports it, to keep that
// file inside its size budget.

class PlanProjectsRepository implements ProjectsRepository {
  PlanProjectsRepository({MobileProjectDetail? project, this.status})
    : project = project ?? plannedProject() {
    final plan = this.project.plan;
    if (plan != null) {
      planSnapshots.add(plan);
    }
  }

  MobileProjectDetail project;
  MobileProjectStatus? status;
  final revisionMessages = <String>[];

  /// Every chat send with the identity the server would dedupe on, so a suite
  /// can prove a retry replays the same turn instead of minting a new one.
  final sendRequests =
      <({String message, String? requestId, String? replyToMessageId})>[];
  final requestedProjectIds = <String>[];
  final chatMessages = <MobileProjectChatMessage>[];
  final planSnapshots = <MobilePlan>[];
  final chatOperations = <MobileBookEditOperation>[];

  /// The proposal the server would still accept an Apply for. Null once every
  /// proposal has been settled, which is what retires a spent card's buttons.
  String? openProposalId;
  final downloadedFormats = <String>[];
  final openedFormats = <String>[];
  final resumedProjectIds = <String>[];

  /// Holds a chat send open so the in-flight UI can be inspected.
  Completer<void>? sendGate;

  /// Holds recovery open so the retry button's in-flight state can be tested.
  Completer<void>? resumeGate;

  /// Makes the next chat send fail.
  Object? sendFailure;

  /// Makes the next generation recovery fail.
  Object? resumeFailure;

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    requestedProjectIds.add(id);
    return project.id == id ? project : plannedProject(id: id);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return status ??
        projectStatusFromProject(
          project.id == id ? project : plannedProject(id: id),
        );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    final status = await getProjectStatus(id);
    yield status;
    // The server holds this open for as long as the book is live and closes it
    // the moment it settles — and a stream that ends early is exactly what
    // makes the client fall back to polling. Ending one here on a live book
    // would leave that poll's timer pending past the end of the test.
    if (status.isLive) {
      await Completer<void>().future;
    }
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
    bool disableIllustrations = false,
  }) async {
    final plan = project.plan;
    MobilePlan? approvedPlan;
    if (plan != null) {
      approvedPlan = copyPlan(plan, status: 'approved');
      final index = planSnapshots.indexWhere(
        (snapshot) => snapshot.id == plan.id,
      );
      if (index >= 0) {
        planSnapshots[index] = approvedPlan;
      } else {
        planSnapshots.add(approvedPlan);
      }
    }
    project = plannedProject(
      status: 'generating',
      currentAction: 'Writing your book.',
      plan: approvedPlan,
      coverEnabled: project.coverEnabled,
      illustrationsEnabled: project.illustrationsEnabled,
    );
    status ??= projectStatusFromProject(project);
    return MobilePlanOperation(
      projectId: project.id,
      planId: planId,
      status: 'generation_queued',
      currentAction: 'Writing your book.',
      job: const MobileQueuedJob(
        id: 'job-generate',
        status: 'queued',
        currentAction: 'Writing your book.',
      ),
    );
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    revisionMessages.add(message);
    project = plannedProject(
      status: 'planning',
      currentAction: 'Revising your book plan.',
      plan: project.plan,
    );
    return MobilePlanOperation(
      projectId: project.id,
      planId: planId,
      status: 'revision_queued',
      currentAction: 'Revising your book plan.',
      job: const MobileQueuedJob(
        id: 'job-revise',
        status: 'queued',
        currentAction: 'Revising your book plan.',
      ),
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return MobileProjectChat(
      messages: List.unmodifiable(chatMessages),
      plans: List.unmodifiable(planSnapshots),
      operations: List.unmodifiable(chatOperations),
      openProposalId: openProposalId,
    );
  }

  void failLatestPlanRevision() {
    final index = chatOperations.lastIndexWhere(
      (operation) => operation.isPlanRevision,
    );
    if (index < 0) return;
    final operation = chatOperations[index];
    chatOperations[index] = MobileBookEditOperation(
      id: operation.id,
      projectId: operation.projectId,
      kind: operation.kind,
      status: 'failed',
      affectedPageIndexes: operation.affectedPageIndexes,
      creditsCharged: operation.creditsCharged,
      currentAction: 'Plan revision failed.',
      error: 'AI plan revision failed.',
      job: const MobileQueuedJob(
        id: 'job-revise',
        status: 'failed',
        currentAction: 'Plan revision failed.',
      ),
      createdAt: operation.createdAt,
      appliedAt: operation.appliedAt,
      anchorMessageId: operation.anchorMessageId,
    );
    project = plannedProject(
      status: 'plan_ready',
      currentAction: 'Ready for review.',
      plan: project.plan,
    );
  }

  void completeLatestPlanRevision({required String title}) {
    final current = project.plan;
    if (current == null) return;
    final completedAt = DateTime.utc(2026, 6, 15, 12, chatMessages.length + 2);
    final currentIndex = planSnapshots.indexWhere(
      (plan) => plan.id == current.id,
    );
    final superseded = copyPlan(
      current,
      status: 'superseded',
      updatedAt: completedAt,
    );
    if (currentIndex >= 0) {
      planSnapshots[currentIndex] = superseded;
    }
    final revised = copyPlan(
      current,
      id: 'plan-${current.version + 1}',
      version: current.version + 1,
      status: 'draft',
      title: title,
      questions: const [],
      createdAt: completedAt,
      updatedAt: completedAt,
    );
    planSnapshots.add(revised);
    project = plannedProject(
      status: 'plan_ready',
      currentAction: 'Ready for review.',
      plan: revised,
    );
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, int>? readerContext,
  }) async {
    revisionMessages.add(message);
    sendRequests.add((
      message: message,
      requestId: requestId,
      replyToMessageId: replyToMessageId,
    ));
    final gate = sendGate;
    if (gate != null) {
      sendGate = null;
      await gate.future;
    }
    final failure = sendFailure;
    if (failure != null) {
      sendFailure = null;
      throw failure;
    }
    final isPlanQuestion =
        !(project.plan?.isApproved ?? false) && message.trim().endsWith('?');
    final userMessage = MobileProjectChatMessage(
      id: 'chat-user-${chatMessages.length + 1}',
      projectId: projectId,
      role: 'user',
      content: message,
      metadata: const {},
      createdAt: DateTime.utc(2026, 6, 15, 12, chatMessages.length),
    );
    final assistantMessage = MobileProjectChatMessage(
      id: 'chat-assistant-${chatMessages.length + 2}',
      projectId: projectId,
      role: 'assistant',
      content: isPlanQuestion
          ? 'Here’s the current plan.'
          : (project.plan?.isApproved ?? false)
          ? 'I can help edit this book.'
          : 'I’ll revise the plan now.',
      metadata: const {},
      createdAt: DateTime.utc(2026, 6, 15, 12, chatMessages.length + 1),
    );
    chatMessages.addAll([userMessage, assistantMessage]);
    MobileBookEditOperation? operation;
    if (!(project.plan?.isApproved ?? false) && !isPlanQuestion) {
      project = plannedProject(
        status: 'planning',
        currentAction: 'Revising your book plan.',
        plan: project.plan,
      );
      operation = MobileBookEditOperation(
        id: 'operation-${chatOperations.length + 1}',
        projectId: projectId,
        kind: 'plan_revision',
        status: 'queued',
        affectedPageIndexes: const [],
        creditsCharged: 100,
        currentAction: 'Revising the plan.',
        createdAt: DateTime.utc(2026, 6, 15),
        // The server stamps the reply onto the operation, which is what places
        // the card under the turn that asked for the revision.
        anchorMessageId: assistantMessage.id,
      );
      chatOperations.add(operation);
    }
    return MobileProjectChatSendResult(
      messages: List.unmodifiable(chatMessages),
      plans: List.unmodifiable(planSnapshots),
      operations: List.unmodifiable(chatOperations),
      reply: assistantMessage,
      operation: operation,
    );
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
      List<String>? mentionedCharacterIds,
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
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) {
    return getProjectChat(projectId);
  }

  @override
  Future<MobileProjectRecovery> resumeProject(
    String id, {
    String? requestId,
    String? retryToken,
  }) async {
    resumedProjectIds.add(id);
    final gate = resumeGate;
    resumeGate = null;
    if (gate != null) await gate.future;
    final failure = resumeFailure;
    resumeFailure = null;
    if (failure != null) throw failure;
    project = plannedProject(
      id: id,
      status: 'planning',
      currentAction: 'Retrying your book plan.',
      withoutPlan: true,
      coverEnabled: project.coverEnabled,
      illustrationsEnabled: project.illustrationsEnabled,
    );
    status = projectStatus(
      projectId: id,
      status: 'planning',
      currentAction: 'Retrying your book plan.',
      completedPages: 0,
      targetPages: project.targetPages,
      imageCount: 0,
    );
    return MobileProjectRecovery(
      projectId: id,
      status: 'recovery_started',
      currentAction: 'Retrying your book plan.',
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0,
    );
  }

  @override
  Future<List<MobileProjectSummary>> listProjects() async => const [];

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    downloadedFormats.add(export.format);
    return ProjectExportFile(
      format: export.format,
      filename: export.filename,
      path: '/tmp/${export.filename}',
    );
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    openedFormats.add(export.format);
    return ExportOpenOutcome.opened;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
