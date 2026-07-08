import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'creation_labels.dart';

const _defaultPresets = MobileCreationPresets(
  bookType: 'lead_magnet',
  bookTypeChoice: 'auto',
  lengthPreset: 'short',
  qualityPreset: 'balanced',
  imagesEnabled: true,
);

const _emptyReadiness = MobileCreationReadiness(
  score: 0,
  canBuild: false,
  missing: <String>[],
);

const _localGreetingText =
    'Hi! Tell me about the book you want to make. Describe your idea in a sentence or two, or tap an example to start.';

const _localGreetingTurn = MobileCreationTurn(
  assistantMessage: _localGreetingText,
  brief: MobileBookRecipe(lane: 'auto'),
  presets: _defaultPresets,
  detectedLane: 'auto',
  quickReplies: <String>[
    'Bedtime story for 5 year olds',
    'Lead magnet about pricing',
    'Workbook for new coaches',
    'Short story about a garden mystery',
  ],
  readiness: _emptyReadiness,
  titleSuggestions: <String>[],
  shapePreview: <String>['Clear reader promise'],
  warnings: <String>[],
);

/// Keys tracked for "Your choice" badges in the live brief / advanced sheet.
enum CreationChoice { bookType, length, finish, visuals, language, tone }

enum PendingAttachmentStatus { uploading, ready, failed }

/// A file picked in the composer: uploading, ready to send, or failed.
@immutable
class PendingCreationAttachment {
  const PendingCreationAttachment({
    required this.localId,
    required this.name,
    required this.kind,
    required this.status,
    this.attachment,
    this.localPath,
    this.bytes,
    this.mimeType,
    this.error,
  });

  final String localId;
  final String name;

  /// 'photo' or 'document'.
  final String kind;
  final PendingAttachmentStatus status;

  /// Server record once the upload and reading finished.
  final MobileCreationAttachment? attachment;

  /// Local file path used for photo thumbnails during this app session.
  final String? localPath;

  /// Kept while uploading/failed so a retry does not re-pick the file.
  final List<int>? bytes;
  final String? mimeType;
  final String? error;

  bool get isPhoto => kind == 'photo';
  bool get isReady => status == PendingAttachmentStatus.ready;
  bool get isUploading => status == PendingAttachmentStatus.uploading;
  bool get isFailed => status == PendingAttachmentStatus.failed;

  PendingCreationAttachment copyWith({
    PendingAttachmentStatus? status,
    MobileCreationAttachment? attachment,
    Object? bytes = _sentinel,
    Object? error = _sentinel,
  }) {
    return PendingCreationAttachment(
      localId: localId,
      name: name,
      kind: kind,
      status: status ?? this.status,
      attachment: attachment ?? this.attachment,
      localPath: localPath,
      bytes: bytes == _sentinel ? this.bytes : bytes as List<int>?,
      mimeType: mimeType,
      error: error == _sentinel ? this.error : error as String?,
    );
  }

  static const _sentinel = Object();
}

@immutable
class CreationChatState {
  const CreationChatState({
    this.initializing = true,
    this.draftId,
    this.sessionTitle,
    this.messages = const <MobileCreationMessage>[],
    this.assistantTyping = false,
    this.building = false,
    this.brief,
    this.presets = _defaultPresets,
    this.detectedLane = 'auto',
    this.quickReplies = const <String>[],
    this.question,
    this.readiness = _emptyReadiness,
    this.titleSuggestions = const <String>[],
    this.shapePreview = const <String>[],
    this.warnings = const <String>[],
    this.outputs = const <MobileCreationOutput>[],
    this.sourceNotes = '',
    this.optionalDetails = const MobileCreationOptionalDetails(),
    this.language = 'en',
    this.userChoices = const <CreationChoice>{},
    this.initError,
    this.createdProjectId,
    this.activeProjectId,
    this.composingNewOutput = false,
    this.pendingBuildRequest = false,
    this.pendingAttachments = const <PendingCreationAttachment>[],
    this.attachmentThumbnails = const <String, String>{},
    this.attachmentUrls = const <String, String>{},
  });

  final bool initializing;
  final String? draftId;
  final String? sessionTitle;
  final List<MobileCreationMessage> messages;
  final bool assistantTyping;
  final bool building;
  final MobileBookRecipe? brief;
  final MobileCreationPresets presets;
  final String detectedLane;
  final List<String> quickReplies;
  final MobileCreationQuestion? question;
  final MobileCreationReadiness readiness;
  final List<String> titleSuggestions;
  final List<String> shapePreview;
  final List<String> warnings;
  final List<MobileCreationOutput> outputs;
  final String sourceNotes;
  final MobileCreationOptionalDetails optionalDetails;
  final String language;
  final Set<CreationChoice> userChoices;
  final String? initError;
  final String? createdProjectId;
  final String? activeProjectId;
  final bool composingNewOutput;

  /// True when the user asked to build from chat and the screen should start
  /// the same preflight/build flow as the Build button.
  final bool pendingBuildRequest;

  /// Files picked in the composer that have not been sent with a message yet.
  final List<PendingCreationAttachment> pendingAttachments;

  /// Local photo paths by server attachment id, for transcript thumbnails.
  final Map<String, String> attachmentThumbnails;

  /// Server file paths by attachment id, so photos still render after an app
  /// restart or on another device (files are stored server-side for 6 months).
  final Map<String, String> attachmentUrls;

  bool get hasSession => draftId != null;

  bool get hasReadyAttachments =>
      pendingAttachments.any((attachment) => attachment.isReady);

  bool get hasUploadingAttachments =>
      pendingAttachments.any((attachment) => attachment.isUploading);

  String get displayTitle {
    final title = sessionTitle?.trim();
    return title == null || title.isEmpty ? 'New book' : title;
  }

  bool get isBusy => assistantTyping || building;

  bool get canBuild => hasSession && readiness.canBuild && !isBusy;

  bool get hasSourceNotes => sourceNotes.trim().isNotEmpty;

  bool get hasActiveOutput =>
      !composingNewOutput && (activeProjectId ?? createdProjectId) != null;

  CreationChatState copyWith({
    bool? initializing,
    String? draftId,
    Object? sessionTitle = _sentinel,
    List<MobileCreationMessage>? messages,
    bool? assistantTyping,
    bool? building,
    Object? brief = _sentinel,
    MobileCreationPresets? presets,
    String? detectedLane,
    List<String>? quickReplies,
    Object? question = _sentinel,
    MobileCreationReadiness? readiness,
    List<String>? titleSuggestions,
    List<String>? shapePreview,
    List<String>? warnings,
    List<MobileCreationOutput>? outputs,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    Set<CreationChoice>? userChoices,
    Object? initError = _sentinel,
    Object? createdProjectId = _sentinel,
    Object? activeProjectId = _sentinel,
    bool? composingNewOutput,
    bool? pendingBuildRequest,
    List<PendingCreationAttachment>? pendingAttachments,
    Map<String, String>? attachmentThumbnails,
    Map<String, String>? attachmentUrls,
  }) {
    return CreationChatState(
      initializing: initializing ?? this.initializing,
      draftId: draftId ?? this.draftId,
      sessionTitle: sessionTitle == _sentinel
          ? this.sessionTitle
          : sessionTitle as String?,
      messages: messages ?? this.messages,
      assistantTyping: assistantTyping ?? this.assistantTyping,
      building: building ?? this.building,
      brief: brief == _sentinel ? this.brief : brief as MobileBookRecipe?,
      presets: presets ?? this.presets,
      detectedLane: detectedLane ?? this.detectedLane,
      quickReplies: quickReplies ?? this.quickReplies,
      question: question == _sentinel
          ? this.question
          : question as MobileCreationQuestion?,
      readiness: readiness ?? this.readiness,
      titleSuggestions: titleSuggestions ?? this.titleSuggestions,
      shapePreview: shapePreview ?? this.shapePreview,
      warnings: warnings ?? this.warnings,
      outputs: outputs ?? this.outputs,
      sourceNotes: sourceNotes ?? this.sourceNotes,
      optionalDetails: optionalDetails ?? this.optionalDetails,
      language: language ?? this.language,
      userChoices: userChoices ?? this.userChoices,
      initError: initError == _sentinel ? this.initError : initError as String?,
      createdProjectId: createdProjectId == _sentinel
          ? this.createdProjectId
          : createdProjectId as String?,
      activeProjectId: activeProjectId == _sentinel
          ? this.activeProjectId
          : activeProjectId as String?,
      composingNewOutput: composingNewOutput ?? this.composingNewOutput,
      pendingBuildRequest: pendingBuildRequest ?? this.pendingBuildRequest,
      pendingAttachments: pendingAttachments ?? this.pendingAttachments,
      attachmentThumbnails: attachmentThumbnails ?? this.attachmentThumbnails,
      attachmentUrls: attachmentUrls ?? this.attachmentUrls,
    );
  }

  static const _sentinel = Object();
}

class CreationChatController extends Notifier<CreationChatState> {
  int _initRequestId = 0;
  int _messageRequestId = 0;
  Future<void>? _syncOutputsRequest;

  @override
  CreationChatState build() => const CreationChatState();

  CreationRepository get _repository => ref.read(creationRepositoryProvider);
  CreationConversationCache get _cache =>
      ref.read(creationConversationCacheProvider);

  Future<void> init({
    bool fresh = false,
    String? draftId,
    bool force = false,
  }) async {
    final sameSpecificDraft = draftId != null && draftId == state.draftId;
    final implicitSessionReady = draftId == null && state.hasSession;
    if (!force &&
        !fresh &&
        !state.initializing &&
        (sameSpecificDraft || implicitSessionReady)) {
      return;
    }
    final requestId = ++_initRequestId;
    final isSessionSwitch =
        force || fresh || (draftId != null && draftId != state.draftId);
    if (isSessionSwitch) {
      _messageRequestId++;
    }
    final messageRequestId = _messageRequestId;
    final cached = fresh
        ? null
        : draftId == null
        ? _cache.readActive()
        : _cache.readById(draftId);
    if (cached != null) {
      _applyConversation(cached, initializing: false, assistantTyping: false);
    } else {
      state = isSessionSwitch
          ? const CreationChatState(initializing: true)
          : state.copyWith(initializing: true, initError: null);
    }
    try {
      if (draftId != null) {
        final resumed = await _repository.resumeConversationById(draftId);
        _cache.write(resumed);
        if (!_canApplyInitResponse(
          requestId: requestId,
          messageRequestId: messageRequestId,
          expectedDraftId: cached == null ? null : draftId,
        )) {
          return;
        }
        _applyConversation(resumed, initializing: false);
        return;
      }
      if (!fresh) {
        final resumed = await _repository.resumeConversation();
        _cache.write(resumed);
        if (!_canApplyInitResponse(
          requestId: requestId,
          messageRequestId: messageRequestId,
          expectedDraftId: cached?.session?.draftId,
        )) {
          return;
        }
        _applyConversation(resumed, initializing: false);
        return;
      }
      _applyConversation(
        const MobileCreationConversationResponse(turn: _localGreetingTurn),
        initializing: false,
      );
    } catch (error) {
      if (requestId != _initRequestId) return;
      if (cached != null) {
        return;
      }
      state = state.copyWith(
        initializing: false,
        initError: userFacingError(error),
      );
    }
  }

  Future<void> retryInit() {
    state = const CreationChatState();
    return init();
  }

  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    final draftId = state.draftId;
    final readyAttachments = state.pendingAttachments
        .where((attachment) => attachment.isReady && attachment.attachment != null)
        .toList();
    if ((trimmed.isEmpty && readyAttachments.isEmpty) ||
        state.isBusy ||
        state.hasUploadingAttachments) {
      return;
    }
    final presets = _presetsForRequest();
    final sourceNotes = state.hasSourceNotes ? state.sourceNotes.trim() : null;
    final optionalDetails = state.optionalDetails.hasContent
        ? state.optionalDetails
        : null;
    final attachmentIds = readyAttachments
        .map((pending) => pending.attachment!.id)
        .toList();
    final requestId = ++_messageRequestId;
    final optimistic = [
      ...state.messages,
      MobileCreationMessage(
        role: 'user',
        content: trimmed,
        attachments: [
          for (final pending in readyAttachments)
            MobileCreationMessageAttachment(
              id: pending.attachment!.id,
              kind: pending.kind,
              name: pending.name,
            ),
        ],
      ),
    ];
    final thumbnails = {
      ...state.attachmentThumbnails,
      for (final pending in readyAttachments)
        if (pending.isPhoto && pending.localPath != null)
          pending.attachment!.id: pending.localPath!,
    };
    final urls = {
      ...state.attachmentUrls,
      for (final pending in readyAttachments)
        if (pending.attachment!.url != null)
          pending.attachment!.id: pending.attachment!.url!,
    };
    state = state.copyWith(
      messages: optimistic,
      assistantTyping: true,
      quickReplies: const <String>[],
      question: null,
      initError: null,
      attachmentThumbnails: thumbnails,
      attachmentUrls: urls,
      pendingAttachments: state.pendingAttachments
          .where((pending) => !readyAttachments.contains(pending))
          .toList(),
    );
    try {
      final response = draftId == null
          ? await _repository.startConversation(
              message: trimmed,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
            )
          : await _repository.sendConversationMessage(
              draftId: draftId,
              message: trimmed,
              attachmentIds: attachmentIds.isEmpty ? null : attachmentIds,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
            );
      if (requestId != _messageRequestId || state.draftId != draftId) return;
      _cache.write(response);
      _applyConversation(
        response,
        assistantTyping: false,
        allowBuildRequest: true,
      );
      ref.invalidate(chatSessionsProvider);
    } catch (error) {
      state = state.copyWith(
        assistantTyping: false,
        initError: userFacingError(error),
      );
      rethrow;
    }
  }

  /// Uploads a picked file into this chat; starts the session first if the
  /// user attaches before saying anything.
  Future<void> attachFile({
    required String filename,
    required List<int> bytes,
    required bool isPhoto,
    String? mimeType,
    String? localPath,
  }) async {
    final localId = 'local_${_nextAttachmentLocalId++}';
    final pending = PendingCreationAttachment(
      localId: localId,
      name: filename,
      kind: isPhoto ? 'photo' : 'document',
      status: PendingAttachmentStatus.uploading,
      localPath: localPath,
      bytes: bytes,
      mimeType: mimeType,
    );
    state = state.copyWith(
      pendingAttachments: [...state.pendingAttachments, pending],
      initError: null,
    );
    await _uploadPendingAttachment(localId);
  }

  Future<void> retryAttachment(String localId) async {
    final pending = _pendingById(localId);
    if (pending == null || !pending.isFailed || pending.bytes == null) {
      return;
    }
    _updatePendingAttachment(
      localId,
      (entry) =>
          entry.copyWith(status: PendingAttachmentStatus.uploading, error: null),
    );
    await _uploadPendingAttachment(localId);
  }

  Future<void> removeAttachment(String localId) async {
    final pending = _pendingById(localId);
    if (pending == null) {
      return;
    }
    state = state.copyWith(
      pendingAttachments: state.pendingAttachments
          .where((entry) => entry.localId != localId)
          .toList(),
    );
    final draftId = state.draftId;
    final attachmentId = pending.attachment?.id;
    if (draftId != null && attachmentId != null) {
      try {
        await _repository.deleteAttachment(
          draftId: draftId,
          attachmentId: attachmentId,
        );
      } catch (_) {
        // The file simply stays in the session pool; harmless.
      }
    }
  }

  /// Uploads run one at a time; parallel uploads would race the server-side
  /// draft update and could drop a file.
  Future<void> _uploadPendingAttachment(String localId) {
    final run = _uploadChain.then(
      (_) => _runPendingAttachmentUpload(localId),
    );
    _uploadChain = run.catchError((_) {});
    return run;
  }

  Future<void> _uploadChain = Future<void>.value();

  Future<void> _runPendingAttachmentUpload(String localId) async {
    try {
      final draftId = await _ensureSession();
      final pending = _pendingById(localId);
      if (pending == null) {
        return;
      }
      final attachment = await _repository.uploadAttachment(
        draftId: draftId,
        bytes: pending.bytes ?? const <int>[],
        filename: pending.name,
        mimeType: pending.mimeType,
      );
      _updatePendingAttachment(
        localId,
        (entry) => entry.copyWith(
          status: PendingAttachmentStatus.ready,
          attachment: attachment,
          bytes: null,
          error: null,
        ),
      );
    } catch (error) {
      _updatePendingAttachment(
        localId,
        (entry) => entry.copyWith(
          status: PendingAttachmentStatus.failed,
          error: userFacingError(error),
        ),
      );
    }
  }

  /// Creates the chat session on demand so files can be attached first.
  Future<String> _ensureSession() async {
    final existing = state.draftId;
    if (existing != null) {
      return existing;
    }
    final response = await _repository.startConversation();
    _cache.write(response);
    if (state.draftId == null) {
      _applyConversation(response, initializing: false);
      ref.invalidate(chatSessionsProvider);
    }
    final draftId = response.session?.draftId ?? state.draftId;
    if (draftId == null) {
      throw const ApiException(
        code: 'SESSION_NOT_READY',
        message: 'Could not start the chat. Try again.',
      );
    }
    return draftId;
  }

  PendingCreationAttachment? _pendingById(String localId) {
    for (final pending in state.pendingAttachments) {
      if (pending.localId == localId) {
        return pending;
      }
    }
    return null;
  }

  void _updatePendingAttachment(
    String localId,
    PendingCreationAttachment Function(PendingCreationAttachment entry) update,
  ) {
    state = state.copyWith(
      pendingAttachments: [
        for (final pending in state.pendingAttachments)
          if (pending.localId == localId) update(pending) else pending,
      ],
    );
  }

  int _nextAttachmentLocalId = 1;

  Future<MobileCreationFinalizeResponse> buildPlan() async {
    final draftId = state.draftId;
    if (draftId == null) {
      throw const ApiException(
        code: 'SESSION_NOT_READY',
        message: 'Start describing your book before building the plan.',
      );
    }
    state = state.copyWith(building: true);
    try {
      final response = await _repository.buildConversation(
        draftId: draftId,
        presets: _presetsForRequest(),
        sourceNotes: state.hasSourceNotes ? state.sourceNotes.trim() : null,
        optionalDetails: state.optionalDetails.hasContent
            ? state.optionalDetails
            : null,
        language: state.language == 'en' ? null : state.language,
      );
      state = state.copyWith(
        building: false,
        createdProjectId: response.project.id,
        activeProjectId: response.project.id,
        composingNewOutput: false,
        outputs: _mergeOutput(response.output),
      );
      _cacheCreatedProject(response.project.id, response.output);
      ref.invalidate(chatSessionsProvider);
      return response;
    } catch (error) {
      state = state.copyWith(building: false);
      rethrow;
    }
  }

  Future<MobileCreationBuildPreflight> preflightBuildPlan() async {
    final draftId = state.draftId;
    if (draftId == null) {
      throw const ApiException(
        code: 'SESSION_NOT_READY',
        message: 'Start describing your book before building the plan.',
      );
    }
    state = state.copyWith(building: true);
    try {
      final response = await _repository.preflightBuildConversation(
        draftId: draftId,
        presets: _presetsForRequest(),
        sourceNotes: state.hasSourceNotes ? state.sourceNotes.trim() : null,
        optionalDetails: state.optionalDetails.hasContent
            ? state.optionalDetails
            : null,
        language: state.language == 'en' ? null : state.language,
      );
      state = state.copyWith(building: false);
      return response;
    } catch (error) {
      state = state.copyWith(building: false);
      rethrow;
    }
  }

  void setBookType(String value) {
    final choices = {...state.userChoices};
    if (value == 'auto') {
      choices.remove(CreationChoice.bookType);
    } else {
      choices.add(CreationChoice.bookType);
    }
    state = state.copyWith(
      presets: state.presets.copyWith(
        bookType: productBookTypeForChoice(
          value,
          detectedLane: state.detectedLane,
        ),
        bookTypeChoice: value,
      ),
      userChoices: choices,
    );
  }

  void setLengthPreset(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(lengthPreset: value),
      userChoices: {...state.userChoices, CreationChoice.length},
    );
  }

  void setPageCountAuto() {
    final choices = {...state.userChoices}..remove(CreationChoice.length);
    state = state.copyWith(
      presets: state.presets.copyWith(
        pageCountMode: 'auto',
        targetPages: null,
        pageCountSource: null,
      ),
      userChoices: choices,
    );
  }

  void setCustomTargetPages(int targetPages, {String source = 'settings'}) {
    if (targetPages < 1 || targetPages > 600) {
      return;
    }
    state = state.copyWith(
      presets: state.presets.copyWith(
        pageCountMode: 'custom',
        targetPages: targetPages,
        pageCountSource: source,
      ),
      userChoices: {...state.userChoices, CreationChoice.length},
    );
  }

  void setQualityPreset(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(qualityPreset: value),
      userChoices: {...state.userChoices, CreationChoice.finish},
    );
  }

  void setImagesEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(imagesEnabled: value),
      userChoices: {...state.userChoices, CreationChoice.visuals},
    );
  }

  void setLanguage(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return;
    }
    state = state.copyWith(
      language: trimmed,
      userChoices: {...state.userChoices, CreationChoice.language},
    );
  }

  void setTone(String value) {
    state = state.copyWith(
      optionalDetails: _copyOptional(tone: value.trim()),
      userChoices: {...state.userChoices, CreationChoice.tone},
    );
  }

  void setTitle(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      state = state.copyWith(optionalDetails: _copyOptional(title: trimmed));
      return;
    }
    state = state.copyWith(
      optionalDetails: _copyOptional(title: trimmed),
      sessionTitle: trimmed,
    );
  }

  void setSessionTitle(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return;
    final draftId = state.draftId;
    if (draftId != null) {
      _cache.updateTitle(draftId: draftId, title: trimmed);
    }
    state = state.copyWith(sessionTitle: trimmed);
  }

  void setAuthorName(String value) {
    state = state.copyWith(
      optionalDetails: _copyOptional(authorName: value.trim()),
    );
  }

  void setSourceNotes(String value) {
    state = state.copyWith(sourceNotes: value);
  }

  void clearError() {
    if (state.initError != null) {
      state = state.copyWith(initError: null);
    }
  }

  void startNewOutput() {
    state = state.copyWith(composingNewOutput: true, activeProjectId: null);
  }

  void selectOutput(String projectId) {
    if (projectId.trim().isEmpty) return;
    state = state.copyWith(
      activeProjectId: projectId,
      composingNewOutput: false,
    );
  }

  Future<void> syncOutputs() {
    final draftId = state.draftId;
    if (draftId == null) {
      return Future<void>.value();
    }
    final existing = _syncOutputsRequest;
    if (existing != null) {
      return existing;
    }
    late final Future<void> request;
    request = _syncOutputsForDraft(draftId).whenComplete(() {
      if (identical(_syncOutputsRequest, request)) {
        _syncOutputsRequest = null;
      }
    });
    _syncOutputsRequest = request;
    return request;
  }

  MobileCreationOptionalDetails _copyOptional({
    String? title,
    String? authorName,
    String? mustInclude,
    String? tone,
  }) {
    final current = state.optionalDetails;
    return MobileCreationOptionalDetails(
      title: title ?? current.title,
      authorName: authorName ?? current.authorName,
      mustInclude: mustInclude ?? current.mustInclude,
      tone: tone ?? current.tone,
    );
  }

  MobileCreationPresets? _presetsForRequest() {
    if (state.userChoices.isEmpty) {
      return null;
    }
    return state.presets.copyWith(
      bookType: productBookTypeForChoice(
        state.presets.bookTypeChoice,
        detectedLane: state.detectedLane,
      ),
    );
  }

  bool _canApplyInitResponse({
    required int requestId,
    required int messageRequestId,
    required String? expectedDraftId,
  }) {
    if (requestId != _initRequestId || messageRequestId != _messageRequestId) {
      return false;
    }
    return expectedDraftId == null || state.draftId == expectedDraftId;
  }

  List<MobileCreationOutput> _mergeOutput(MobileCreationOutput? output) {
    if (output == null) {
      return state.outputs;
    }
    return _mergeOutputsInto(state.outputs, [output]);
  }

  Future<void> _syncOutputsForDraft(String draftId) async {
    final response = await _repository.resumeConversationById(draftId);
    final session = response.session;
    if (state.draftId != draftId ||
        session == null ||
        session.draftId != draftId) {
      return;
    }
    final outputs = session.outputs;
    if (outputs.isEmpty) {
      return;
    }
    final mergedOutputs = _mergeOutputsInto(state.outputs, outputs);
    _cacheSyncedOutputs(
      draftId: draftId,
      response: response,
      outputs: mergedOutputs,
    );
    if (state.draftId != draftId) {
      return;
    }
    state = state.copyWith(outputs: mergedOutputs);
  }

  List<MobileCreationOutput> _mergeOutputsInto(
    List<MobileCreationOutput> current,
    Iterable<MobileCreationOutput> incoming,
  ) {
    final next = [...current];
    for (final output in incoming) {
      final index = next.indexWhere(
        (existing) => existing.projectId == output.projectId,
      );
      if (index == -1) {
        next.add(output);
      } else {
        next[index] = output;
      }
    }
    next.sort((a, b) => a.sequence.compareTo(b.sequence));
    return next;
  }

  void _cacheSyncedOutputs({
    required String draftId,
    required MobileCreationConversationResponse response,
    required List<MobileCreationOutput> outputs,
  }) {
    final current = _cache.readById(draftId);
    final session = current?.session ?? response.session;
    if (session == null) return;
    _cache.write(
      MobileCreationConversationResponse(
        turn: current?.turn ?? response.turn,
        session: MobileCreationSession(
          draftId: session.draftId,
          title: session.title,
          status: session.status,
          messages: session.messages,
          createdProjectId: session.createdProjectId,
          activeProjectId: session.activeProjectId,
          outputs: outputs,
          attachments: session.attachments,
          updatedAt: session.updatedAt,
        ),
      ),
    );
  }

  void _cacheCreatedProject(String projectId, MobileCreationOutput? output) {
    final draftId = state.draftId;
    if (draftId == null) return;
    final current = _cache.readById(draftId);
    final session = current?.session;
    if (current == null || session == null) return;
    final outputs = output == null
        ? session.outputs
        : ([
            ...session.outputs.where((item) => item.projectId != projectId),
            output,
          ]..sort((a, b) => a.sequence.compareTo(b.sequence)));
    _cache.write(
      MobileCreationConversationResponse(
        turn: current.turn,
        session: MobileCreationSession(
          draftId: session.draftId,
          title: session.title,
          status: session.status,
          messages: session.messages,
          createdProjectId: projectId,
          activeProjectId: projectId,
          outputs: outputs,
          attachments: session.attachments,
          updatedAt: session.updatedAt,
        ),
      ),
    );
  }

  /// Marks the chat-initiated build request as handled by the screen.
  void clearBuildRequest() {
    if (state.pendingBuildRequest) {
      state = state.copyWith(pendingBuildRequest: false);
    }
  }

  void _applyConversation(
    MobileCreationConversationResponse response, {
    bool? initializing,
    bool? assistantTyping,
    bool allowBuildRequest = false,
  }) {
    final turn = response.turn;
    final session = response.session;
    final messages =
        session?.messages ??
        (turn.assistantMessage.trim().isEmpty
            ? state.messages
            : <MobileCreationMessage>[
                MobileCreationMessage(
                  role: 'assistant',
                  content: turn.assistantMessage,
                ),
              ]);
    final detectedLanguage = turn.language?.trim();
    final applyDetectedLanguage =
        detectedLanguage != null &&
        detectedLanguage.isNotEmpty &&
        !state.userChoices.contains(CreationChoice.language);
    final pendingAttachments = session == null
        ? state.pendingAttachments
        : _reconcilePendingAttachments(session);
    final attachmentUrls = session == null
        ? state.attachmentUrls
        : {
            ...state.attachmentUrls,
            for (final attachment in session.attachments)
              if (attachment.url != null) attachment.id: attachment.url!,
          };
    state = state.copyWith(
      pendingAttachments: pendingAttachments,
      attachmentUrls: attachmentUrls,
      initializing: initializing ?? state.initializing,
      assistantTyping: assistantTyping ?? state.assistantTyping,
      draftId: session?.draftId ?? state.draftId,
      sessionTitle: session?.title,
      messages: messages,
      createdProjectId: session?.createdProjectId,
      brief: turn.brief,
      presets: _mergeUserPresets(turn.presets),
      detectedLane: turn.detectedLane,
      quickReplies: turn.quickReplies,
      question: turn.question,
      readiness: turn.readiness,
      titleSuggestions: turn.titleSuggestions,
      shapePreview: turn.shapePreview,
      warnings: turn.warnings,
      outputs: session?.outputs ?? state.outputs,
      activeProjectId: session?.activeProjectId ?? session?.createdProjectId,
      language: applyDetectedLanguage ? detectedLanguage : null,
      pendingBuildRequest: allowBuildRequest && turn.buildRequested,
    );
    _lastSyncedPresets = turn.presets;
  }

  /// Keeps composer chips in sync with the server: files uploaded but not yet
  /// sent with a message reappear as ready chips (also across app restarts),
  /// while local uploads still in flight are preserved.
  List<PendingCreationAttachment> _reconcilePendingAttachments(
    MobileCreationSession session,
  ) {
    final referencedIds = <String>{
      for (final message in session.messages)
        for (final attachment in message.attachments) attachment.id,
    };
    final serverIds = session.attachments
        .map((attachment) => attachment.id)
        .toSet();
    final localByServerId = <String, PendingCreationAttachment>{
      for (final pending in state.pendingAttachments)
        if (pending.attachment != null) pending.attachment!.id: pending,
    };
    return [
      for (final attachment in session.attachments)
        if (!referencedIds.contains(attachment.id))
          localByServerId[attachment.id] ??
              PendingCreationAttachment(
                localId: 'server_${attachment.id}',
                name: attachment.name,
                kind: attachment.kind,
                status: PendingAttachmentStatus.ready,
                attachment: attachment,
              ),
      // Local entries the server response does not know about yet: uploads in
      // flight, failures awaiting retry, and just-finished uploads racing a
      // stale response.
      for (final pending in state.pendingAttachments)
        if (pending.attachment == null ||
            (!serverIds.contains(pending.attachment!.id) &&
                !referencedIds.contains(pending.attachment!.id)))
          pending,
    ];
  }

  /// Presets from the previous server turn; used to tell chat-driven setting
  /// changes apart from the server echoing our own sticky selections back.
  MobileCreationPresets? _lastSyncedPresets;

  /// Keeps manual advanced-sheet selections sticky across AI turns, while
  /// accepting changes the user made from chat (the server only alters a
  /// field we sent when the chat asked for it).
  MobileCreationPresets _mergeUserPresets(MobileCreationPresets incoming) {
    final choices = state.userChoices;
    if (choices.isEmpty) {
      return incoming;
    }
    final current = state.presets;
    final synced = _lastSyncedPresets;
    bool serverChanged<T>(T Function(MobileCreationPresets presets) select) {
      return synced != null && select(incoming) != select(synced);
    }

    final keepBookType =
        choices.contains(CreationChoice.bookType) &&
        !serverChanged((presets) => presets.bookTypeChoice);
    final keepLength =
        choices.contains(CreationChoice.length) &&
        !serverChanged(
          (presets) =>
              '${presets.lengthPreset}|${presets.pageCountMode}|${presets.targetPages}',
        );
    final keepFinish =
        choices.contains(CreationChoice.finish) &&
        !serverChanged((presets) => presets.qualityPreset);
    final keepVisuals =
        choices.contains(CreationChoice.visuals) &&
        !serverChanged((presets) => presets.imagesEnabled);
    return incoming.copyWith(
      bookType: keepBookType ? current.bookType : null,
      bookTypeChoice: keepBookType ? current.bookTypeChoice : null,
      lengthPreset: keepLength ? current.lengthPreset : null,
      pageCountMode: keepLength ? current.pageCountMode : null,
      targetPages: keepLength ? current.targetPages : incoming.targetPages,
      pageCountSource: keepLength
          ? current.pageCountSource
          : incoming.pageCountSource,
      qualityPreset: keepFinish ? current.qualityPreset : null,
      imagesEnabled: keepVisuals ? current.imagesEnabled : null,
    );
  }
}

final creationChatControllerProvider =
    NotifierProvider.autoDispose<CreationChatController, CreationChatState>(
      CreationChatController.new,
    );
