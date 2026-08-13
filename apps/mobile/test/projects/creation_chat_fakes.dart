import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'creation_chat_harness.dart';

// PlanProjectsRepository moved out to keep this file inside its size budget;
// it is re-exported so the suites keep importing one fakes file.
export 'plan_projects_repository_fake.dart';

// The scripted repositories the creation-chat suites run against.
// Fixtures they build live in creation_chat_harness.dart.

class ScriptedCreationRepository implements CreationRepository {
  ScriptedCreationRepository({
    this.replyWithQuestion = false,
    this.replyWithOpenQuestion = false,
    this.replyWithMultiQuestion = false,
    this.replyWithBuildRequest = false,
    this.replyAuthorName,
    this.preflightRequiresPageCount = false,
    this.resumeByIdGate,
    List<MobileChatSession>? sessions,
  }) : sessions = sessions ?? const <MobileChatSession>[];

  final bool replyWithQuestion;

  /// A question whose answer is a value only the reader can supply, so the API
  /// sends it with no options and the card points at the message box.
  final bool replyWithOpenQuestion;

  /// A question several of the options answer at once, sent as answerKind
  /// "multi" so the card collects picks instead of sending the first tap.
  final bool replyWithMultiQuestion;
  final bool replyWithBuildRequest;

  /// The byline the chat captured from the message just sent, as the API
  /// returns it on the turn for the Advanced-settings sheet to pick up.
  final String? replyAuthorName;
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
  final replyRequests = <String?>[];
  final branchSwitches = <({String messageId, String direction})>[];
  final uploadedAttachments = <String, MobileCreationAttachment>{};
  final deletedAttachmentIds = <String>[];
  Object? uploadError;
  Object? sendError;
  List<String> replyWarnings = const [];

  /// The brief the reply turn carries; null keeps the bare `{'lane': 'auto'}`.
  Map<String, dynamic>? replyBrief;

  /// The reply turn's readiness.missing — the "Helpful to add" list.
  List<String> replyMissing = const [];

  /// The reply turn's title suggestions — the header's "Title ideas" chips.
  List<String> replyTitleSuggestions = const [];
  List<String> greetingQuickReplies = const ['A kids book', 'A workbook'];
  int uploadCount = 0;
  final resumedDraftIds = <String>[];
  final resumeAssistantMessages = <String, String>{};
  final resumeMessages = <String, List<Map<String, dynamic>>>{};
  final resumeSyncedOutputs = <String, List<MobileCreationOutput>>{};
  MobileCreationPresets? buildPresets;
  MobileCreationOptionalDetails? buildOptionalDetails;
  String? buildDraftId;
  int buildCount = 0;

  /// Overrides the title the build response stamps on its output — the real
  /// server snapshots "Untitled Book" there until the plan chooses a name.
  String? buildOutputTitle;

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
      List<String>? mentionedCharacterIds,
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
          {
            'id': 'assistant-greeting',
            'role': 'assistant',
            'content': greeting,
          },
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
    String? replyToMessageId,
    String? requestId,
    int? expectedRevision,
    bool skippedQuestion = false,
      List<String>? mentionedCharacterIds,
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
    replyRequests.add(replyToMessageId);
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
            if (replyToMessageId != null)
              'replyTo': {
                'messageId': replyToMessageId,
                'role': 'assistant',
                'excerpt': greeting,
              },
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
        quickReplies:
            (replyWithQuestion ||
                replyWithOpenQuestion ||
                replyWithMultiQuestion)
            ? const []
            : const ['Make it shorter'],
        question: replyWithMultiQuestion
            ? const {
                'prompt': 'Which themes should the tales carry?',
                'answerKind': 'multi',
                'options': ['Forgiveness', 'Patience', 'Justice'],
                'allowCustom': true,
              }
            : replyWithOpenQuestion
            ? const {
                'prompt': 'What name should appear as the author?',
                'answerKind': 'open',
                'options': <String>[],
                'allowCustom': true,
              }
            : replyWithQuestion
            ? const {
                'prompt': 'Who is this book for?',
                'answerKind': 'choice',
                'options': ['New managers', 'Team leads'],
                'allowCustom': true,
              }
            : null,
        buildRequested: replyWithBuildRequest,
        warnings: replyWarnings,
        authorName: replyAuthorName,
        brief: replyBrief,
        missing: replyMissing,
        titleSuggestions: replyTitleSuggestions,
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
    buildOptionalDetails = optionalDetails;
    buildCount += 1;
    final projectId = 'project-$buildCount';
    final project = plannedProject(id: projectId);
    return MobileCreationFinalizeResponse(
      project: project,
      output: MobileCreationOutput(
        id: 'output-$buildCount',
        draftId: draftId,
        projectId: projectId,
        title: buildOutputTitle ?? project.title,
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
    // Mirrors the server's resolveMobilePageCount: presets already carrying a
    // custom page count resolve it, so the sheet is only shown when the answer
    // was never committed.
    final presetsResolvePageCount =
        presets?.pageCountMode == 'custom' && presets?.targetPages != null;
    final requiresPageCount =
        preflightRequiresPageCount && !presetsResolvePageCount;
    return MobileCreationBuildPreflight(
      requiresPageCount: requiresPageCount,
      recommendations: preflightRecommendations,
      detectedPageCount: requiresPageCount
          ? null
          : presetsResolvePageCount
          ? MobileDetectedPageCount(
              targetPages: presets!.targetPages!,
              source: presets.pageCountSource ?? 'settings',
            )
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
