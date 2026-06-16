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

/// Keys tracked for "Your choice" badges in the live brief / advanced sheet.
enum CreationChoice { bookType, length, finish, visuals, language, tone }

@immutable
class CreationChatState {
  const CreationChatState({
    this.initializing = true,
    this.draftId,
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

  bool get isBusy => assistantTyping || building;

  bool get canBuild => hasSession && readiness.canBuild && !isBusy;

  bool get hasSourceNotes => sourceNotes.trim().isNotEmpty;

  CreationChatState copyWith({
    bool? initializing,
    String? draftId,
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
  @override
  CreationChatState build() => const CreationChatState();

  CreationRepository get _repository => ref.read(creationRepositoryProvider);

  Future<void> init() async {
    if (!state.initializing && state.hasSession) {
      return;
    }
    state = state.copyWith(initializing: true, initError: null);
    try {
      final resumed = await _repository.resumeConversation();
      if (resumed.session != null) {
        _applyConversation(resumed, initializing: false);
        return;
      }
      final started = await _repository.startConversation();
      _applyConversation(started, initializing: false);
    } catch (error) {
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
    if (trimmed.isEmpty || draftId == null || state.isBusy) {
      return;
    }
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
      final response = await _repository.sendConversationMessage(
        draftId: draftId,
        message: trimmed,
        presets: state.presets,
        sourceNotes: state.hasSourceNotes ? state.sourceNotes.trim() : null,
        optionalDetails: state.optionalDetails.hasContent
            ? state.optionalDetails
            : null,
      );
      _applyConversation(response, assistantTyping: false);
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
    state = state.copyWith(optionalDetails: _copyOptional(title: value.trim()));
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

  void _applyConversation(
    MobileCreationConversationResponse response, {
    bool? initializing,
    bool? assistantTyping,
  }) {
    final turn = response.turn;
    final session = response.session;
    state = state.copyWith(
      initializing: initializing ?? state.initializing,
      assistantTyping: assistantTyping ?? state.assistantTyping,
      draftId: session?.draftId ?? state.draftId,
      messages: session?.messages ?? state.messages,
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
