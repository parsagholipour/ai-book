import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../data/creation_repository.dart';
import '../domain/creation_message_models.dart';
import '../domain/creation_models.dart';
import 'chat_reply_quote.dart';
import 'creation_chat_helpers.dart';
import 'creation_chat_state.dart';
import 'creation_labels.dart';
import 'creation_preset_merge.dart';
import 'pending_chat_sessions.dart';

// The state types moved out to keep this file inside its size budget; they are
// re-exported so the screen and its part files keep importing one file.
export 'creation_chat_state.dart';


class CreationChatController extends Notifier<CreationChatState> {
  int _initRequestId = 0;
  int _messageRequestId = 0;
  int _nextOptimisticMessageId = 0;
  int _nextServerRequestId = 0;
  String? _pendingBuildServerRequestId;
  String? _pendingBuildFingerprint;
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
        const MobileCreationConversationResponse(turn: creationChatLocalGreetingTurn),
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

  Future<void> retryInit({bool fresh = false, String? draftId}) {
    return init(fresh: fresh, draftId: draftId, force: true);
  }

  Future<void> sendMessage(
    String text, {
    String? editMessageId,
    ChatReplyTarget? replyTo,
  }) async {
    final trimmed = text.trim();
    final draftId = state.draftId;
    final readyAttachments = state.pendingAttachments
        .where(
          (attachment) => attachment.isReady && attachment.attachment != null,
        )
        .toList();
    if ((trimmed.isEmpty && readyAttachments.isEmpty) ||
        state.isBusy ||
        state.switchingBranch ||
        state.hasUploadingAttachments) {
      return;
    }
    // Editing needs a persisted session and a persisted message to fork from.
    if (editMessageId != null && draftId == null) {
      return;
    }
    final presets = _presetsForRequest();
    final sourceNotes = state.hasSourceNotes ? state.sourceNotes.trim() : null;
    final includedSourceNotes = sourceNotes != null && sourceNotes.isNotEmpty;
    final optionalDetails = state.optionalDetails.hasContent
        ? state.optionalDetails
        : null;
    final attachmentIds = readyAttachments
        .map((pending) => pending.attachment!.id)
        .toList();
    final requestId = ++_messageRequestId;
    final localId = 'local_msg_${_nextOptimisticMessageId++}';
    final serverRequestId = _newServerRequestId('message');
    final optimisticMessage = MobileCreationMessage(
      role: 'user',
      content: trimmed,
      localId: localId,
      requestId: serverRequestId,
      createdAt: DateTime.now(),
      sendStatus: CreationMessageSendStatus.sending,
      includedSourceNotes: includedSourceNotes,
      // Carried on the optimistic message so the quote renders straight away
      // rather than appearing when the server's copy lands.
      replyTo: replyTo,
      attachments: [
        for (final pending in readyAttachments)
          MobileCreationMessageAttachment(
            id: pending.attachment!.id,
            kind: pending.kind,
            name: pending.name,
          ),
      ],
    );
    // An edit forks a new branch: everything from the edited message down is
    // replaced by the new text until the server responds with the new thread.
    final editIndex = editMessageId == null
        ? -1
        : state.messages.indexWhere((message) => message.id == editMessageId);
    final optimistic = [
      if (editIndex >= 0)
        ...state.messages.sublist(0, editIndex)
      else
        ...state.messages,
      optimisticMessage,
    ];
    final thumbnails = {
      ...state.attachmentThumbnails,
      for (final pending in readyAttachments)
        if (pending.localPath != null)
          pending.attachment!.id: pending.localPath!,
    };
    final urls = {
      ...state.attachmentUrls,
      for (final pending in readyAttachments)
        if (pending.attachment!.url != null)
          pending.attachment!.id: pending.attachment!.url!,
    };
    final wasComposingNewOutput = state.composingNewOutput;
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
      // Forking the brainstorm abandons the thread any built output came
      // from, so the chat drops back to the pre-build stage; earlier outputs
      // stay reachable through the output switcher.
      composingNewOutput: editMessageId != null ? true : null,
    );
    final pendingSessions = ref.read(pendingChatSessionsProvider.notifier);
    final isNewChat = draftId == null;
    if (isNewChat) {
      pendingSessions.add(
        PendingChatSession(
          localKey: localId,
          title: trimmed.isEmpty ? 'New book' : trimmed,
          startedAt: DateTime.now(),
        ),
      );
    }
    final cache = _cache;
    // The server creates a brand-new chat only when this request completes;
    // keep this notifier alive so the completion is persisted even if the
    // user navigates away mid-send.
    final keepAliveLink = ref.keepAlive();
    try {
      final response = draftId == null
          ? await _repository.startConversation(
              message: trimmed,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
              requestId: serverRequestId,
            )
          : await _repository.sendConversationMessage(
              draftId: draftId,
              message: trimmed,
              attachmentIds: attachmentIds.isEmpty ? null : attachmentIds,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
              editMessageId: editMessageId,
              replyToMessageId: replyTo?.messageId,
              requestId: serverRequestId,
              expectedRevision: state.sessionRevision,
            );
      cache.write(response);
      final createdDraftId = response.session?.draftId;
      if (isNewChat && createdDraftId != null) {
        pendingSessions.resolve(localId, createdDraftId);
      }
      if (requestId == _messageRequestId && state.draftId == draftId) {
        _applyConversation(
          response,
          assistantTyping: false,
          allowBuildRequest: true,
        );
      }
      ref.invalidate(chatSessionsProvider);
    } catch (error) {
      if (isNewChat) {
        pendingSessions.remove(localId);
      }
      // The user switched chats mid-send: this chat's state is gone, so
      // don't smear the failure onto whichever chat is showing now.
      if (requestId != _messageRequestId || state.draftId != draftId) {
        rethrow;
      }
      final message = userFacingError(error);
      if (_isSessionConflict(error) && draftId != null) {
        final failedMessage = optimisticMessage.copyWith(
          sendStatus: CreationMessageSendStatus.failed,
          sendError: message,
        );
        if (await _refreshAfterSessionConflict(
          draftId,
          failedMessages: [failedMessage],
        )) {
          state = state.copyWith(
            assistantTyping: false,
            composingNewOutput: wasComposingNewOutput,
          );
          return;
        }
      }
      state = state.copyWith(
        assistantTyping: false,
        initError: message,
        // The fork did not happen, so restore the pre-edit stage.
        composingNewOutput: wasComposingNewOutput,
        messages: [
          for (final entry in state.messages)
            if (entry.localId == localId)
              entry.copyWith(
                sendStatus: CreationMessageSendStatus.failed,
                sendError: message,
              )
            else
              entry,
        ],
      );
      rethrow;
    } finally {
      keepAliveLink.close();
    }
  }

  /// Moves the visible thread to the previous/next sibling branch of a
  /// message that was edited before ([direction] is 'previous' or 'next').
  Future<void> switchBranch({
    required String messageId,
    required String direction,
  }) async {
    final draftId = state.draftId;
    if (draftId == null || state.isBusy || state.switchingBranch) {
      return;
    }
    final requestId = ++_messageRequestId;
    // Failed optimistic sends live only in local state; carry them across the
    // server refresh so retry/dismiss keep working.
    final failedLocals = state.messages
        .where((message) => message.isFailedSend)
        .toList();
    state = state.copyWith(switchingBranchMessageId: messageId);
    final keepAliveLink = ref.keepAlive();
    try {
      final response = await _repository.switchConversationBranch(
        draftId: draftId,
        messageId: messageId,
        direction: direction,
        expectedRevision: state.sessionRevision,
      );
      _cache.write(response);
      ref.invalidate(chatSessionsProvider);
      if (requestId != _messageRequestId || state.draftId != draftId) return;
      _applyConversation(response, assistantTyping: false);
      if (failedLocals.isNotEmpty) {
        state = state.copyWith(messages: [...state.messages, ...failedLocals]);
      }
    } catch (error) {
      if (_isSessionConflict(error)) {
        await _refreshAfterSessionConflict(
          draftId,
          failedMessages: failedLocals,
        );
      }
      if (requestId == _messageRequestId) {
        state = state.copyWith(initError: userFacingError(error));
      }
    } finally {
      if (state.switchingBranchMessageId == messageId) {
        state = state.copyWith(switchingBranchMessageId: null);
      }
      keepAliveLink.close();
    }
  }

  /// Retries a failed optimistic user message without re-picking attachments.
  Future<void> retryFailedMessage(String localId) async {
    MobileCreationMessage? failed;
    for (final message in state.messages) {
      if (message.localId == localId && message.isFailedSend) {
        failed = message;
        break;
      }
    }
    if (failed == null || state.isBusy || state.hasUploadingAttachments) {
      return;
    }
    final draftId = state.draftId;
    final presets = _presetsForRequest();
    final sourceNotes = failed.includedSourceNotes && state.hasSourceNotes
        ? state.sourceNotes.trim()
        : null;
    final optionalDetails = state.optionalDetails.hasContent
        ? state.optionalDetails
        : null;
    final attachmentIds = [
      for (final attachment in failed.attachments) attachment.id,
    ];
    final requestId = ++_messageRequestId;
    final serverRequestId = failed.requestId ?? _newServerRequestId('message');
    state = state.copyWith(
      messages: [
        for (final entry in state.messages)
          if (entry.localId == localId)
            entry.copyWith(
              sendStatus: CreationMessageSendStatus.sending,
              sendError: null,
            )
          else
            entry,
      ],
      assistantTyping: true,
      initError: null,
    );
    final pendingSessions = ref.read(pendingChatSessionsProvider.notifier);
    final isNewChat = draftId == null;
    if (isNewChat) {
      pendingSessions.add(
        PendingChatSession(
          localKey: localId,
          title: failed.content.trim().isEmpty ? 'New book' : failed.content,
          startedAt: DateTime.now(),
        ),
      );
    }
    final cache = _cache;
    final keepAliveLink = ref.keepAlive();
    try {
      final response = draftId == null
          ? await _repository.startConversation(
              message: failed.content,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
              requestId: serverRequestId,
            )
          : await _repository.sendConversationMessage(
              draftId: draftId,
              message: failed.content,
              attachmentIds: attachmentIds.isEmpty ? null : attachmentIds,
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
              // A retry keeps the quote the failed send carried, or it would
              // reach the model as a bare fragment the second time.
              replyToMessageId: failed.replyTo?.messageId,
              requestId: serverRequestId,
              expectedRevision: state.sessionRevision,
            );
      cache.write(response);
      final createdDraftId = response.session?.draftId;
      if (isNewChat && createdDraftId != null) {
        pendingSessions.resolve(localId, createdDraftId);
      }
      if (requestId == _messageRequestId && state.draftId == draftId) {
        _applyConversation(
          response,
          assistantTyping: false,
          allowBuildRequest: true,
        );
      }
      ref.invalidate(chatSessionsProvider);
    } catch (error) {
      if (isNewChat) {
        pendingSessions.remove(localId);
      }
      if (requestId != _messageRequestId || state.draftId != draftId) {
        rethrow;
      }
      final message = userFacingError(error);
      if (_isSessionConflict(error) && draftId != null) {
        final failedRetry = failed.copyWith(
          sendStatus: CreationMessageSendStatus.failed,
          sendError: message,
        );
        if (await _refreshAfterSessionConflict(
          draftId,
          failedMessages: [failedRetry],
        )) {
          state = state.copyWith(assistantTyping: false);
          return;
        }
      }
      state = state.copyWith(
        assistantTyping: false,
        initError: message,
        messages: [
          for (final entry in state.messages)
            if (entry.localId == localId)
              entry.copyWith(
                sendStatus: CreationMessageSendStatus.failed,
                sendError: message,
              )
            else
              entry,
        ],
      );
      rethrow;
    } finally {
      keepAliveLink.close();
    }
  }

  void dismissFailedMessage(String localId) {
    state = state.copyWith(
      messages: [
        for (final entry in state.messages)
          if (entry.localId != localId) entry,
      ],
    );
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
      (entry) => entry.copyWith(
        status: PendingAttachmentStatus.uploading,
        error: null,
      ),
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
        final revision = await _repository.deleteAttachment(
          draftId: draftId,
          attachmentId: attachmentId,
          expectedRevision: state.sessionRevision,
        );
        if (revision != null) {
          state = state.copyWith(sessionRevision: revision);
        }
      } catch (_) {
        // The file simply stays in the session pool; harmless.
      }
    }
  }

  /// Uploads run one at a time; parallel uploads would race the server-side
  /// draft update and could drop a file.
  Future<void> _uploadPendingAttachment(String localId) {
    final run = _uploadChain.then((_) => _runPendingAttachmentUpload(localId));
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
        expectedRevision: state.sessionRevision,
      );
      if (attachment.sessionRevision != null) {
        state = state.copyWith(sessionRevision: attachment.sessionRevision);
      }
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
    final cache = _cache;
    final keepAliveLink = ref.keepAlive();
    try {
      final response = await _repository.startConversation(
        requestId: _newServerRequestId('session'),
      );
      cache.write(response);
      if (state.draftId == null) {
        _applyConversation(response, initializing: false);
      }
      ref.invalidate(chatSessionsProvider);
      final draftId = response.session?.draftId ?? state.draftId;
      if (draftId == null) {
        throw const ApiException(
          code: 'SESSION_NOT_READY',
          message: 'Could not start the chat. Try again.',
        );
      }
      return draftId;
    } finally {
      keepAliveLink.close();
    }
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
    final presets = _presetsForRequest();
    final sourceNotes = state.hasSourceNotes ? state.sourceNotes.trim() : null;
    final optionalDetails = state.optionalDetails.hasContent
        ? state.optionalDetails
        : null;
    final language = state.language == 'en' ? null : state.language;
    final fingerprint =
        '$draftId|${presets?.toJson()}|$sourceNotes|${optionalDetails?.toJson()}|$language';
    if (_pendingBuildFingerprint != fingerprint) {
      _pendingBuildServerRequestId = _newServerRequestId('build');
      _pendingBuildFingerprint = fingerprint;
    }
    final buildRequestId = _pendingBuildServerRequestId!;
    try {
      final response = await _repository.buildConversation(
        draftId: draftId,
        presets: presets,
        sourceNotes: sourceNotes,
        optionalDetails: optionalDetails,
        language: language,
        requestId: buildRequestId,
        expectedRevision: state.sessionRevision,
      );
      _pendingBuildServerRequestId = null;
      _pendingBuildFingerprint = null;
      state = state.copyWith(
        building: false,
        createdProjectId: response.project.id,
        activeProjectId: response.project.id,
        composingNewOutput: false,
        outputs: _mergeOutput(response.output),
        sessionRevision: response.sessionRevision ?? state.sessionRevision,
      );
      _cacheCreatedProject(response.project.id, response.output);
      ref.invalidate(chatSessionsProvider);
      return response;
    } catch (error) {
      if (_isSessionConflict(error)) {
        _pendingBuildServerRequestId = null;
        _pendingBuildFingerprint = null;
        await _refreshAfterSessionConflict(draftId);
      }
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

  void setCoverEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(coverEnabled: value),
      userChoices: {...state.userChoices, CreationChoice.cover},
    );
  }

  void setIllustrationsEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(illustrationsEnabled: value),
      userChoices: {...state.userChoices, CreationChoice.illustrations},
    );
  }

  /// Compatibility helper for code that still treats all generated images as
  /// one choice. New UI controls must call the independent setters above.
  @Deprecated('Use setCoverEnabled and setIllustrationsEnabled.')
  void setImagesEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(
        coverEnabled: value,
        illustrationsEnabled: value,
      ),
      userChoices: {
        ...state.userChoices,
        CreationChoice.cover,
        CreationChoice.illustrations,
      },
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
      optionalDetails: copyOptionalDetails(
        state.optionalDetails,
        tone: value.trim(),
      ),
      userChoices: {...state.userChoices, CreationChoice.tone},
    );
  }

  void setTitle(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      state = state.copyWith(
        optionalDetails: copyOptionalDetails(
          state.optionalDetails,
          title: trimmed,
        ),
      );
      return;
    }
    state = state.copyWith(
      optionalDetails: copyOptionalDetails(
        state.optionalDetails,
        title: trimmed,
      ),
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
      optionalDetails: copyOptionalDetails(
        state.optionalDetails,
        authorName: value.trim(),
      ),
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

  String _newServerRequestId(String prefix) {
    final sequence = _nextServerRequestId++;
    return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$sequence';
  }

  bool _isSessionConflict(Object error) {
    return error is ApiException && error.code == 'SESSION_CONFLICT';
  }

  Future<bool> _refreshAfterSessionConflict(
    String draftId, {
    List<MobileCreationMessage> failedMessages = const [],
  }) async {
    try {
      final latest = await _repository.resumeConversationById(draftId);
      if (state.draftId != draftId) {
        return false;
      }
      _cache.write(latest);
      _applyConversation(latest, assistantTyping: false);
      state = state.copyWith(
        messages: [...state.messages, ...failedMessages],
        initError:
            'This chat changed on another device. I reloaded the latest version; your unsent message is still available to retry.',
      );
      ref.invalidate(chatSessionsProvider);
      return true;
    } catch (_) {
      return false;
    }
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
    return mergeCreationOutputsInto(state.outputs, [output]);
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
    final mergedOutputs = mergeCreationOutputsInto(state.outputs, outputs);
    _cacheSyncedOutputs(
      draftId: draftId,
      response: response,
      outputs: mergedOutputs,
    );
    if (state.draftId != draftId) {
      return;
    }
    state = state.copyWith(
      outputs: mergedOutputs,
      sessionRevision: session.revision,
    );
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
          revision: session.revision,
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
          revision: session.revision,
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
        : reconcilePendingCreationAttachments(session, state.pendingAttachments);
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
      sessionRevision: session?.revision,
      sessionTitle: session?.title,
      messages: messages,
      createdProjectId: session?.createdProjectId,
      brief: turn.brief,
      optionalDetails: mergeChatOptionalDetails(state.optionalDetails, turn),
      presets: mergeStickyCreationPresets(
        incoming: turn.presets,
        current: state.presets,
        synced: _lastSyncedPresets,
        bookTypeChosen: state.userChoices.contains(CreationChoice.bookType),
        lengthChosen: state.userChoices.contains(CreationChoice.length),
        finishChosen: state.userChoices.contains(CreationChoice.finish),
        coverChosen: state.userChoices.contains(CreationChoice.cover),
        illustrationsChosen: state.userChoices.contains(
          CreationChoice.illustrations,
        ),
      ),
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
      initError: null,
    );
    _lastSyncedPresets = turn.presets;
  }


  MobileCreationPresets? _lastSyncedPresets;
}

final creationChatControllerProvider =
    NotifierProvider.autoDispose<CreationChatController, CreationChatState>(
      CreationChatController.new,
    );
