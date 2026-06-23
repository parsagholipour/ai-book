import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';

const _defaultPresets = MobileCreationPresets(
  bookType: 'lead_magnet',
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
  brief: MobileBookRecipe(lane: 'practical_guide'),
  presets: _defaultPresets,
  detectedLane: 'practical_guide',
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
    this.detectedLane = 'practical_guide',
    this.quickReplies = const <String>[],
    this.question,
    this.readiness = _emptyReadiness,
    this.titleSuggestions = const <String>[],
    this.shapePreview = const <String>[],
    this.warnings = const <String>[],
    this.sourceNotes = '',
    this.optionalDetails = const MobileCreationOptionalDetails(),
    this.language = 'en',
    this.userChoices = const <CreationChoice>{},
    this.initError,
    this.createdProjectId,
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
  final String sourceNotes;
  final MobileCreationOptionalDetails optionalDetails;
  final String language;
  final Set<CreationChoice> userChoices;
  final String? initError;
  final String? createdProjectId;

  bool get hasSession => draftId != null;

  String get displayTitle {
    final title = sessionTitle?.trim();
    return title == null || title.isEmpty ? 'New book' : title;
  }

  bool get isBusy => assistantTyping || building;

  bool get canBuild => hasSession && readiness.canBuild && !isBusy;

  bool get hasSourceNotes => sourceNotes.trim().isNotEmpty;

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
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    Set<CreationChoice>? userChoices,
    Object? initError = _sentinel,
    Object? createdProjectId = _sentinel,
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
      sourceNotes: sourceNotes ?? this.sourceNotes,
      optionalDetails: optionalDetails ?? this.optionalDetails,
      language: language ?? this.language,
      userChoices: userChoices ?? this.userChoices,
      initError: initError == _sentinel ? this.initError : initError as String?,
      createdProjectId: createdProjectId == _sentinel
          ? this.createdProjectId
          : createdProjectId as String?,
    );
  }

  static const _sentinel = Object();
}

class CreationChatController extends Notifier<CreationChatState> {
  int _initRequestId = 0;
  int _messageRequestId = 0;

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
    if (trimmed.isEmpty || state.isBusy) {
      return;
    }
    final presets = state.presets;
    final sourceNotes = state.hasSourceNotes ? state.sourceNotes.trim() : null;
    final optionalDetails = state.optionalDetails.hasContent
        ? state.optionalDetails
        : null;
    final requestId = ++_messageRequestId;
    final optimistic = [
      ...state.messages,
      MobileCreationMessage(role: 'user', content: trimmed),
    ];
    state = state.copyWith(
      messages: optimistic,
      assistantTyping: true,
      quickReplies: const <String>[],
      question: null,
      initError: null,
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
              presets: presets,
              sourceNotes: sourceNotes,
              optionalDetails: optionalDetails,
            );
      if (requestId != _messageRequestId || state.draftId != draftId) return;
      _cache.write(response);
      _applyConversation(response, assistantTyping: false);
      ref.invalidate(chatSessionsProvider);
    } catch (error) {
      state = state.copyWith(
        assistantTyping: false,
        initError: userFacingError(error),
      );
      rethrow;
    }
  }

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
        presets: state.presets,
        sourceNotes: state.hasSourceNotes ? state.sourceNotes.trim() : null,
        optionalDetails: state.optionalDetails.hasContent
            ? state.optionalDetails
            : null,
        language: state.language == 'en' ? null : state.language,
      );
      state = state.copyWith(
        building: false,
        createdProjectId: response.project.id,
      );
      _cacheCreatedProject(response.project.id);
      ref.invalidate(chatSessionsProvider);
      return response;
    } catch (error) {
      state = state.copyWith(building: false);
      rethrow;
    }
  }

  void setBookType(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(bookType: value),
      userChoices: {...state.userChoices, CreationChoice.bookType},
    );
  }

  void setLengthPreset(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(lengthPreset: value),
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

  void _cacheCreatedProject(String projectId) {
    final draftId = state.draftId;
    if (draftId == null) return;
    final current = _cache.readById(draftId);
    final session = current?.session;
    if (current == null || session == null) return;
    _cache.write(
      MobileCreationConversationResponse(
        turn: current.turn,
        session: MobileCreationSession(
          draftId: session.draftId,
          title: session.title,
          status: session.status,
          messages: session.messages,
          createdProjectId: projectId,
          updatedAt: session.updatedAt,
        ),
      ),
    );
  }

  void _applyConversation(
    MobileCreationConversationResponse response, {
    bool? initializing,
    bool? assistantTyping,
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
    state = state.copyWith(
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
    );
  }

  /// Keeps manual advanced-sheet selections sticky across AI turns.
  MobileCreationPresets _mergeUserPresets(MobileCreationPresets incoming) {
    final choices = state.userChoices;
    if (choices.isEmpty) {
      return incoming;
    }
    final current = state.presets;
    return incoming.copyWith(
      bookType: choices.contains(CreationChoice.bookType)
          ? current.bookType
          : null,
      lengthPreset: choices.contains(CreationChoice.length)
          ? current.lengthPreset
          : null,
      qualityPreset: choices.contains(CreationChoice.finish)
          ? current.qualityPreset
          : null,
      imagesEnabled: choices.contains(CreationChoice.visuals)
          ? current.imagesEnabled
          : null,
    );
  }
}

final creationChatControllerProvider =
    NotifierProvider.autoDispose<CreationChatController, CreationChatState>(
      CreationChatController.new,
    );
