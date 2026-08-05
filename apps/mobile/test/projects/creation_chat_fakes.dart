import 'dart:async';

import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'creation_chat_harness.dart';

// The scripted repositories the creation-chat suites run against.
// Fixtures they build live in creation_chat_harness.dart.

class ScriptedCreationRepository implements CreationRepository {
  ScriptedCreationRepository({
    this.replyWithQuestion = false,
    this.replyWithBuildRequest = false,
    this.preflightRequiresPageCount = false,
    this.resumeByIdGate,
    List<MobileChatSession>? sessions,
  }) : sessions = sessions ?? const <MobileChatSession>[];

  final bool replyWithQuestion;
  final bool replyWithBuildRequest;
  final bool preflightRequiresPageCount;
  final List<MobilePageCountRecommendation> preflightRecommendations = const [
    MobilePageCountRecommendation(
      targetPages: 8,
      label: '8 pages',
      description: 'Recommended for a compact book.',
    ),
    MobilePageCountRecommendation(
      targetPages: 12,
      label: '12 pages',
      description: 'More room for detail.',
    ),
  ];
  Future<void>? resumeByIdGate;

  /// When set, message sends (including the one starting a new chat) wait on
  /// this before responding; completing it with an error fails the send.
  Future<void>? sendGate;
  int listSessionsCalls = 0;
  final List<MobileChatSession> sessions;
  final sentMessages = <String>[];
  final sentAttachmentIds = <List<String>>[];
  final startedMessages = <String>[];
  final editRequests = <String>[];
  final branchSwitches = <({String messageId, String direction})>[];
  final uploadedAttachments = <String, MobileCreationAttachment>{};
  final deletedAttachmentIds = <String>[];
  Object? uploadError;
  Object? sendError;
  List<String> replyWarnings = const [];
  List<String> greetingQuickReplies = const ['A kids book', 'A workbook'];
  int uploadCount = 0;
  final resumedDraftIds = <String>[];
  final resumeAssistantMessages = <String, String>{};
  final resumeMessages = <String, List<Map<String, dynamic>>>{};
  final resumeSyncedOutputs = <String, List<MobileCreationOutput>>{};
  MobileCreationPresets? buildPresets;
  String? buildDraftId;
  int buildCount = 0;

  @override
  Future<List<MobileChatSession>> listSessions() async {
    listSessionsCalls++;
    return List.of(sessions);
  }

  @override
  Future<void> renameSession({
    required String draftId,
    required String title,
    int? expectedRevision,
  }) async {}

  @override
  Future<void> deleteSession(String draftId) async {}

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    return MobileCreationConversationResponse.fromJson({
      'turn': turnJson(
        assistantMessage: greeting,
        canBuild: false,
        quickReplies: greetingQuickReplies,
      ),
    });
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    resumedDraftIds.add(draftId);
    await resumeByIdGate;
    final session = sessionFor(draftId);
    final resumeCount = resumedDraftIds.where((id) => id == draftId).length;
    final sessionOutputs = session?.outputs ?? const <MobileCreationOutput>[];
    final outputs = resumeCount > 1
        ? resumeSyncedOutputs[draftId] ?? sessionOutputs
        : sessionOutputs;
    final assistantMessage =
        resumeAssistantMessages[draftId] ?? 'Selected chat $draftId';
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': draftId,
        'title': session?.title ?? 'Title for $draftId',
        'status': session?.status ?? 'ACTIVE',
        'messages':
            resumeMessages[draftId] ??
            [
              {'role': 'assistant', 'content': assistantMessage},
            ],
        'createdProjectId': session?.createdProjectId,
        'activeProjectId': session?.activeProjectId,
        'outputs': [
          for (final output in outputs)
            {
              'id': output.id,
              'draftId': output.draftId,
              'projectId': output.projectId,
              'title': output.title,
              'sequence': output.sequence,
              'createdAt': output.createdAt.toIso8601String(),
              'updatedAt': output.updatedAt.toIso8601String(),
            },
        ],
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': turnJson(
        assistantMessage: assistantMessage,
        canBuild: false,
        quickReplies: const [],
      ),
    });
  }

  MobileChatSession? sessionFor(String draftId) {
    for (final session in sessions) {
      if (session.draftId == draftId) {
        return session;
      }
    }
    return null;
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? requestId,
  }) async {
    if (message != null) {
      startedMessages.add(message);
      return sendConversationMessage(draftId: 'draft-1', message: message);
    }
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': 'New book',
        'status': 'ACTIVE',
        'messages': [
          {'role': 'assistant', 'content': greeting},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': turnJson(
        assistantMessage: greeting,
        canBuild: false,
        quickReplies: greetingQuickReplies,
      ),
    });
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
    await sendGate;
    final error = sendError;
    if (error != null) {
      throw error;
    }
    if (editMessageId != null) {
      // An edit forks a branch: remember the replaced text for switch-back.
      editRequests.add(editMessageId);
      _originalUserContent ??= sentMessages.isEmpty ? null : sentMessages.last;
    }
    sentMessages.add(message);
    sentAttachmentIds.add(attachmentIds ?? const <String>[]);
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': message,
        'status': 'ACTIVE',
        'messages': [
          {
            'id': 'assistant-greeting',
            'role': 'assistant',
            'content': greeting,
          },
          {
            'id': 'user-current',
            'role': 'user',
            'content': message,
            if (editMessageId != null)
              'branch': {
                'index': 2,
                'total': 2,
                'canGoPrevious': true,
                'canGoNext': false,
              },
            if (attachmentIds != null && attachmentIds.isNotEmpty)
              'attachments': [
                for (final id in attachmentIds)
                  {
                    'id': id,
                    'kind': uploadedAttachments[id]?.kind ?? 'document',
                    'name': uploadedAttachments[id]?.name ?? 'file',
                  },
              ],
          },
          {'id': 'assistant-reply', 'role': 'assistant', 'content': reply},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': turnJson(
        assistantMessage: reply,
        // A question never blocks the build: the API keeps canBuild true and
        // the app offers "Skip and build the plan".
        canBuild: true,
        quickReplies: replyWithQuestion ? const [] : const ['Make it shorter'],
        question: replyWithQuestion
            ? const {
                'prompt': 'Who is this book for?',
                'options': ['New managers', 'Team leads'],
                'allowCustom': true,
              }
            : null,
        buildRequested: replyWithBuildRequest,
        warnings: replyWarnings,
      ),
    });
  }

  /// Text of the user turn that was replaced by the most recent edit.
  String? _originalUserContent;

  @override
  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  }) async {
    branchSwitches.add((messageId: messageId, direction: direction));
    final showOriginal = direction == 'previous';
    final content = showOriginal
        ? (_originalUserContent ?? 'Original message')
        : (sentMessages.isEmpty ? 'Edited message' : sentMessages.last);
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': content,
        'status': 'ACTIVE',
        'messages': [
          {
            'id': 'assistant-greeting',
            'role': 'assistant',
            'content': greeting,
          },
          {
            'id': 'user-current',
            'role': 'user',
            'content': content,
            'branch': {
              'index': showOriginal ? 1 : 2,
              'total': 2,
              'canGoPrevious': !showOriginal,
              'canGoNext': showOriginal,
            },
          },
          {'id': 'assistant-reply', 'role': 'assistant', 'content': reply},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': turnJson(
        assistantMessage: '',
        canBuild: true,
        quickReplies: const [],
      ),
    });
  }

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    String? requestId,
    int? expectedRevision,
  }) async {
    buildDraftId = draftId;
    buildPresets = presets;
    buildCount += 1;
    final projectId = 'project-$buildCount';
    final project = plannedProject(id: projectId);
    return MobileCreationFinalizeResponse(
      project: project,
      output: MobileCreationOutput(
        id: 'output-$buildCount',
        draftId: draftId,
        projectId: projectId,
        title: project.title,
        sequence: buildCount,
        createdAt: DateTime.utc(2026, 6, 15, 12, buildCount),
        updatedAt: DateTime.utc(2026, 6, 15, 12, buildCount),
      ),
      operation: MobilePlanOperation(
        projectId: projectId,
        planId: 'plan-1',
        status: 'planning_queued',
        currentAction: 'Building your plan.',
        job: const MobileQueuedJob(
          id: 'job-1',
          status: 'queued',
          currentAction: 'Building your plan.',
        ),
      ),
    );
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    return MobileCreationBuildPreflight(
      requiresPageCount: preflightRequiresPageCount,
      recommendations: preflightRecommendations,
      detectedPageCount: preflightRequiresPageCount
          ? null
          : const MobileDetectedPageCount(targetPages: 8, source: 'chat'),
    );
  }

  @override
  Future<MobileCreationDraft?> getActiveDraft() async => null;

  @override
  Future<MobileCreationDraft> createDraft(MobileCreationDraftPayload payload) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  ) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) {
    throw UnimplementedError();
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
    final error = uploadError;
    if (error != null) {
      uploadError = null;
      throw error;
    }
    uploadCount += 1;
    final attachment = MobileCreationAttachment(
      id: 'att-$uploadCount',
      kind: (mimeType ?? '').startsWith('image/') ? 'photo' : 'document',
      name: filename,
      sizeBytes: bytes.length,
      summary: 'Summary of $filename',
      url:
          '/api/mobile/creation-sessions/$draftId/attachments/att-$uploadCount/file',
    );
    uploadedAttachments[attachment.id] = attachment;
    return attachment;
  }

  @override
  Future<int?> deleteAttachment({
    required String draftId,
    required String attachmentId,
    int? expectedRevision,
  }) async {
    deletedAttachmentIds.add(attachmentId);
    return expectedRevision;
  }
}

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
  final requestedProjectIds = <String>[];
  final chatMessages = <MobileProjectChatMessage>[];
  final planSnapshots = <MobilePlan>[];
  final chatOperations = <MobileBookEditOperation>[];
  final downloadedFormats = <String>[];
  final openedFormats = <String>[];

  /// Holds a chat send open so the in-flight UI can be inspected.
  Completer<void>? sendGate;

  /// Makes the next chat send fail.
  Object? sendFailure;

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
    yield await getProjectStatus(id);
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
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
  }) async {
    revisionMessages.add(message);
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
