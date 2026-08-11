import 'package:flutter/foundation.dart';

import '../domain/chat_reply_target.dart';
import '../domain/creation_message_models.dart';
import '../domain/creation_models.dart';

/// What the creation chat holds: the conversation, the live brief it is
/// shaping, and the attachments waiting in the composer.
///
/// Split out of `creation_chat_controller.dart`, which re-exports this file so
/// the screen and its part files keep seeing these types.

const defaultCreationPresets = MobileCreationPresets(
  bookType: 'lead_magnet',
  bookTypeChoice: 'auto',
  lengthPreset: 'short',
  qualityPreset: 'balanced',
  coverEnabled: true,
  illustrationsEnabled: true,
);

const emptyCreationReadiness = MobileCreationReadiness(
  score: 0,
  canBuild: false,
  missing: <String>[],
);

/// Keys tracked for "Your choice" badges in the live brief / advanced sheet.
enum CreationChoice {
  bookType,
  length,
  finish,
  cover,
  illustrations,
  language,
  tone,
}

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
    this.sessionRevision = 1,
    this.messages = const <MobileCreationMessage>[],
    this.assistantTyping = false,
    this.building = false,
    this.brief,
    this.presets = defaultCreationPresets,
    this.detectedLane = 'auto',
    this.quickReplies = const <String>[],
    this.question,
    this.readiness = emptyCreationReadiness,
    this.titleSuggestions = const <String>[],
    this.shapePreview = const <String>[],
    this.warnings = const <String>[],
    this.coverPreview,
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
    this.switchingBranchMessageId,
    this.replyTarget,
  });

  final bool initializing;
  final String? draftId;
  final String? sessionTitle;
  final int sessionRevision;
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

  /// Server-derived cover glimpse for the header's mini cover. Kept from the
  /// last turn that carried one, so an old stored turn without the field does
  /// not blink the cover back to the seeded palette.
  final MobileCreationCoverPreview? coverPreview;

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

  /// Message whose branch arrows triggered an in-flight switch, if any.
  final String? switchingBranchMessageId;

  /// The message the composer is currently replying to, if any. Editing a
  /// message and replying to one are mutually exclusive; the screen clears
  /// whichever is set when the other starts.
  final ChatReplyTarget? replyTarget;

  bool get hasSession => draftId != null;

  bool get switchingBranch => switchingBranchMessageId != null;

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
    int? sessionRevision,
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
    MobileCreationCoverPreview? coverPreview,
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
    Object? switchingBranchMessageId = _sentinel,
    Object? replyTarget = _sentinel,
  }) {
    return CreationChatState(
      initializing: initializing ?? this.initializing,
      draftId: draftId ?? this.draftId,
      sessionTitle: sessionTitle == _sentinel
          ? this.sessionTitle
          : sessionTitle as String?,
      sessionRevision: sessionRevision ?? this.sessionRevision,
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
      coverPreview: coverPreview ?? this.coverPreview,
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
      switchingBranchMessageId: switchingBranchMessageId == _sentinel
          ? this.switchingBranchMessageId
          : switchingBranchMessageId as String?,
      replyTarget: replyTarget == _sentinel
          ? this.replyTarget
          : replyTarget as ChatReplyTarget?,
    );
  }

  static const _sentinel = Object();
}
