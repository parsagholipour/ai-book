// The post-generation chat: transcript messages, branches, content cards, edit
// proposals and the book-edit operations they produce, plus the manual page
// editor's request/response shapes.
//
// Split out of project_models.dart, which re-exports this file so the screens
// that import it keep seeing these types.

import 'chat_reply_target.dart';
import 'project_models.dart';

class MobileProjectChatMessage {
  const MobileProjectChatMessage({
    required this.id,
    required this.projectId,
    required this.role,
    required this.content,
    required this.metadata,
    required this.createdAt,
    this.parentId,
    this.operationId,
    this.branch,
  });

  final String id;
  final String projectId;
  final String? parentId;
  final String role;
  final String content;
  final String? operationId;
  final Map<String, dynamic> metadata;
  final MobileProjectChatBranch? branch;
  final DateTime createdAt;

  factory MobileProjectChatMessage.fromJson(Map<String, dynamic> json) {
    return MobileProjectChatMessage(
      id: json['id'] as String,
      projectId: json['projectId'] as String,
      parentId: json['parentId'] as String?,
      role: json['role'] as String,
      content: json['content'] as String,
      operationId: json['operationId'] as String?,
      metadata:
          (json['metadata'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{},
      branch: json['branch'] == null
          ? null
          : MobileProjectChatBranch.fromJson(
              json['branch'] as Map<String, dynamic>,
            ),
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  bool get isUser => role == 'user';

  bool get isAssistant => role == 'assistant';

  bool get hasInsufficientCredits =>
      metadata['insufficientCredits'] is Map<String, dynamic> ||
      metadata['insufficientCredits'] is Map;

  /// What the refused edit would have cost, from the same metadata. The paywall
  /// says how far short the balance is, and this is the only place the app is
  /// told the price of an edit that never ran.
  int? get insufficientCreditsRequired {
    final raw = metadata['insufficientCredits'];
    if (raw is! Map) return null;
    final required = raw['requiredCredits'];
    return required is int && required > 0 ? required : null;
  }

  /// Credits this reply spent, when it queued paid work. The server stopped
  /// naming the price in the reply text, so this is what the credit badge in
  /// the bubble's corner shows. Null when the turn was free.
  int? get creditsCharged {
    final charged = metadata['creditsCharged'];
    if (charged is! int || charged <= 0) return null;
    return charged;
  }

  /// Structured read-only book content (outline/chapter/page) attached to
  /// this message by the show-content intent.
  MobileChatContentCard? get contentCard {
    final raw = metadata['contentCard'];
    if (raw is! Map) return null;
    return MobileChatContentCard.fromJson(raw.cast<String, dynamic>());
  }

  /// Priced book-edit proposal waiting for explicit Apply / Cancel.
  MobileEditProposal? get editProposal {
    final pending = metadata['pendingEdit'];
    if (pending is Map && pending['clarification'] != 'confirm') {
      return null;
    }
    final raw = metadata['editProposal'];
    if (raw is! Map) return null;
    return MobileEditProposal.fromJson(raw.cast<String, dynamic>());
  }

  String? get replanCopyTargetProjectId {
    final raw = metadata['replanCopy'];
    if (raw is! Map) return null;
    final targetProjectId = raw['targetProjectId'];
    if (targetProjectId is! String) return null;
    final trimmed = targetProjectId.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  /// The earlier message this turn replies to, quoted above its own text.
  ChatReplyTarget? get replyTo => ChatReplyTarget.fromJson(metadata['replyTo']);

  /// Saved-export marker attached when the user saved a manual Edit Mode
  /// change. Messages carrying it render as a saved export card.
  MobileManualEditInfo? get manualEdit {
    final raw = metadata['manualEdit'];
    if (raw is! Map) return null;
    return MobileManualEditInfo.fromJson(raw.cast<String, dynamic>());
  }
}

class MobileManualEditInfo {
  const MobileManualEditInfo({
    required this.operationId,
    required this.pageIndexes,
    required this.editCount,
  });

  final String? operationId;
  final List<int> pageIndexes;
  final int editCount;

  factory MobileManualEditInfo.fromJson(Map<String, dynamic> json) {
    final pageIndexes = json['pageIndexes'] as List<dynamic>? ?? const [];
    return MobileManualEditInfo(
      operationId: json['operationId'] as String?,
      pageIndexes: pageIndexes.whereType<int>().toList(growable: false),
      editCount: json['editCount'] as int? ?? 1,
    );
  }
}

class MobileProjectChatBranch {
  const MobileProjectChatBranch({
    required this.index,
    required this.total,
    required this.canGoPrevious,
    required this.canGoNext,
  });

  final int index;
  final int total;
  final bool canGoPrevious;
  final bool canGoNext;

  factory MobileProjectChatBranch.fromJson(Map<String, dynamic> json) {
    return MobileProjectChatBranch(
      index: json['index'] as int? ?? 1,
      total: json['total'] as int? ?? 1,
      canGoPrevious: json['canGoPrevious'] as bool? ?? false,
      canGoNext: json['canGoNext'] as bool? ?? false,
    );
  }
}

class MobileChatContentCard {
  const MobileChatContentCard({
    required this.type,
    required this.title,
    required this.sections,
  });

  /// One of: outline, chapter, page.
  final String type;
  final String title;
  final List<MobileChatContentSection> sections;

  factory MobileChatContentCard.fromJson(Map<String, dynamic> json) {
    final sections = json['sections'] as List<dynamic>? ?? const [];
    return MobileChatContentCard(
      type: json['type'] as String? ?? 'outline',
      title: json['title'] as String? ?? '',
      sections: sections
          .whereType<Map>()
          .map(
            (section) => MobileChatContentSection(
              label: section['label'] as String? ?? '',
              body: section['body'] as String? ?? '',
            ),
          )
          .toList(growable: false),
    );
  }
}

/// One line an exact replacement will change, as it reads now and after.
class MobileEditPreviewSample {
  const MobileEditPreviewSample({required this.before, required this.after});

  final String before;
  final String after;

  factory MobileEditPreviewSample.fromJson(Map<String, dynamic> json) {
    return MobileEditPreviewSample(
      before: json['before'] as String? ?? '',
      after: json['after'] as String? ?? '',
    );
  }
}

/// The exact result of a deterministic edit, computed before anything is
/// charged. Only literal find/replace edits can carry one — everything else is
/// a model rewrite whose output does not exist yet.
class MobileEditPreview {
  const MobileEditPreview({required this.samples});

  final List<MobileEditPreviewSample> samples;

  static MobileEditPreview? fromJson(Map<String, dynamic>? json) {
    if (json == null || json['kind'] != 'exact_replace') return null;
    final raw = json['samples'] as List<dynamic>? ?? const [];
    final samples = raw
        .whereType<Map<String, dynamic>>()
        .map(MobileEditPreviewSample.fromJson)
        .where((sample) => sample.before.isNotEmpty || sample.after.isNotEmpty)
        .toList(growable: false);
    return samples.isEmpty ? null : MobileEditPreview(samples: samples);
  }
}

/// A charged book edit the server priced but has not started yet.
class MobileEditProposal {
  const MobileEditProposal({
    required this.id,
    required this.kind,
    required this.scope,
    required this.affectedPageIndexes,
    required this.credits,
    required this.summary,
    this.affectedChapterIndex,
    this.targetLanguage,
    this.preview,
  });

  final String id;
  final String kind;
  final String scope;
  final List<int> affectedPageIndexes;
  final int credits;
  final String summary;
  final int? affectedChapterIndex;
  final String? targetLanguage;
  final MobileEditPreview? preview;

  factory MobileEditProposal.fromJson(Map<String, dynamic> json) {
    final pages = json['affectedPageIndexes'] as List<dynamic>? ?? const [];
    return MobileEditProposal(
      id: json['id'] as String? ?? '',
      kind: json['kind'] as String? ?? 'local_patch',
      scope: json['scope'] as String? ?? 'none',
      affectedPageIndexes: pages.whereType<int>().toList(growable: false),
      credits: json['credits'] as int? ?? 0,
      summary: (json['summary'] as String?)?.trim().isNotEmpty == true
          ? json['summary'] as String
          : 'Apply this edit',
      affectedChapterIndex: json['affectedChapterIndex'] as int?,
      targetLanguage: json['targetLanguage'] as String?,
      preview: MobileEditPreview.fromJson(
        json['preview'] as Map<String, dynamic>?,
      ),
    );
  }

  String get pageLabel {
    if (scope == 'all_pages') return 'Whole book';
    if (affectedChapterIndex != null) {
      return 'Chapter $affectedChapterIndex';
    }
    if (affectedPageIndexes.length == 1) {
      return 'Page ${affectedPageIndexes.first}';
    }
    if (affectedPageIndexes.isNotEmpty) {
      return 'Pages ${affectedPageIndexes.join(', ')}';
    }
    return 'Matching pages';
  }
}

class MobileChatContentSection {
  const MobileChatContentSection({required this.label, required this.body});

  final String label;
  final String body;
}

class MobileBookEditOperation {
  const MobileBookEditOperation({
    required this.id,
    required this.projectId,
    required this.kind,
    required this.status,
    required this.affectedPageIndexes,
    required this.creditsCharged,
    required this.currentAction,
    required this.createdAt,
    this.error,
    this.job,
    this.appliedAt,
    this.retryAvailable = false,
    this.nextRetryAt,
    this.retryState,
    this.retryMessage,
    this.recoveryQuote,
    this.submittedText,
    this.requestId,
    this.anchorMessageId,
    this.canUndo = false,
    this.changesAvailable = false,
    this.creditsRefunded = false,
  });

  final String id;
  final String projectId;
  final String kind;
  final String status;
  final List<int> affectedPageIndexes;
  final int creditsCharged;
  final String currentAction;
  final String? error;
  final MobileQueuedJob? job;
  final DateTime createdAt;
  final DateTime? appliedAt;

  /// Retry metadata is optional so responses from older servers still parse.
  final bool retryAvailable;
  final DateTime? nextRetryAt;
  final String? retryState;
  final String? retryMessage;
  final MobileGenerationRecoveryQuote? recoveryQuote;

  /// Original user input and idempotency key, when returned by newer servers.
  final String? submittedText;
  final String? requestId;

  /// The transcript message this operation belongs under. Null on older servers
  /// and for edits made outside the chat, which fall back to the transcript tail.
  final String? anchorMessageId;

  /// True when this applied edit can be undone from the chat transcript.
  final bool canUndo;

  /// True when the server kept before/after snapshots, so the edit can be
  /// reviewed as a diff. False for older rows and for edits that never touched
  /// page text.
  final bool changesAvailable;

  /// True when the credits this operation reserved were given back. Failures are
  /// refunded, so the charge must never be shown as if it stood.
  final bool creditsRefunded;

  factory MobileBookEditOperation.fromJson(Map<String, dynamic> json) {
    final affected = json['affectedPageIndexes'] as List<dynamic>? ?? const [];
    final retry = (json['retry'] as Map?)?.cast<String, dynamic>();
    final nextRetryAt = json['nextRetryAt'] ?? retry?['nextRetryAt'];
    final submittedText =
        json['submittedText'] ??
        json['requestMessage'] ??
        json['message'] ??
        (json['request'] is Map ? (json['request'] as Map)['message'] : null);
    return MobileBookEditOperation(
      id: (json['id'] ?? json['operationId']) as String,
      projectId: json['projectId'] as String,
      kind: json['kind'] as String,
      status: json['status'] as String,
      affectedPageIndexes: affected.map((value) => value as int).toList(),
      creditsCharged: json['creditsCharged'] as int? ?? 0,
      currentAction:
          json['currentAction'] as String? ??
          json['retryMessage'] as String? ??
          retry?['message'] as String? ??
          '',
      error: json['error'] as String?,
      job: json['job'] == null
          ? null
          : MobileQueuedJob.fromJson(json['job'] as Map<String, dynamic>),
      createdAt: DateTime.parse(json['createdAt'] as String),
      appliedAt: json['appliedAt'] == null
          ? null
          : DateTime.parse(json['appliedAt'] as String),
      retryAvailable:
          json['retryAvailable'] as bool? ??
          retry?['available'] as bool? ??
          false,
      nextRetryAt: nextRetryAt is String
          ? DateTime.tryParse(nextRetryAt)
          : null,
      retryState: json['retryState'] as String? ?? retry?['state'] as String?,
      retryMessage:
          json['retryMessage'] as String? ?? retry?['message'] as String?,
      recoveryQuote: json['recoveryQuote'] is Map
          ? MobileGenerationRecoveryQuote.fromJson(
              (json['recoveryQuote'] as Map).cast<String, dynamic>(),
            )
          : null,
      submittedText: submittedText is String ? submittedText : null,
      requestId: json['requestId'] as String?,
      anchorMessageId:
          json['anchorMessageId'] as String? ??
          json['assistantMessageId'] as String? ??
          json['userMessageId'] as String?,
      canUndo: json['canUndo'] as bool? ?? false,
      changesAvailable: json['changesAvailable'] as bool? ?? false,
      creditsRefunded: json['creditsRefunded'] as bool? ?? false,
    );
  }

  bool get isRunning =>
      status == 'queued' || status == 'active' || isAutomaticRetryPending;

  bool get isApplied => status == 'applied';

  bool get isFailed => status == 'failed';

  bool get isPlanRevision => kind == 'plan_revision';

  bool get isAutomaticRetryPending =>
      nextRetryAt != null &&
      (retryState == 'pending' ||
          retryState == 'scheduled' ||
          retryState == 'waiting');

  String get displayAction {
    final retryCopy = retryMessage?.trim();
    if (retryCopy != null && retryCopy.isNotEmpty) return retryCopy;
    final action = currentAction.trim();
    if (action.isNotEmpty) return action;
    return isAutomaticRetryPending
        ? 'Retrying this update automatically.'
        : 'This update needs attention.';
  }
}

class MobileProjectChat {
  const MobileProjectChat({
    required this.messages,
    required this.operations,
    this.plans = const [],
    this.hasMore = false,
    this.nextCursor,
    this.openProposalId,
  });

  final List<MobileProjectChatMessage> messages;
  final List<MobilePlan> plans;
  final List<MobileBookEditOperation> operations;
  final bool hasMore;
  final String? nextCursor;

  /// The one priced proposal the server would still accept an Apply for. Null
  /// once every proposal has been applied or cancelled, which is what retires
  /// a spent card's buttons.
  final String? openProposalId;

  factory MobileProjectChat.fromJson(Map<String, dynamic> json) {
    final messages = json['messages'] as List<dynamic>? ?? const [];
    final plans = json['plans'] as List<dynamic>? ?? const [];
    final operations = json['operations'] as List<dynamic>? ?? const [];
    return MobileProjectChat(
      messages: messages
          .map(
            (message) => MobileProjectChatMessage.fromJson(
              message as Map<String, dynamic>,
            ),
          )
          .toList(),
      plans: plans
          .map((plan) => MobilePlan.fromJson(plan as Map<String, dynamic>))
          .toList(),
      operations: operations
          .map(
            (operation) => MobileBookEditOperation.fromJson(
              operation as Map<String, dynamic>,
            ),
          )
          .toList(),
      hasMore: json['hasMore'] as bool? ?? false,
      nextCursor: json['nextCursor'] as String?,
      openProposalId: json['openProposalId'] as String?,
    );
  }
}

class MobileProjectChatSendResult extends MobileProjectChat {
  const MobileProjectChatSendResult({
    required super.messages,
    required super.operations,
    super.plans,
    super.hasMore,
    super.nextCursor,
    super.openProposalId,
    required this.reply,
    this.operation,
  });

  final MobileProjectChatMessage reply;
  final MobileBookEditOperation? operation;

  factory MobileProjectChatSendResult.fromJson(Map<String, dynamic> json) {
    final chat = MobileProjectChat.fromJson(json);
    return MobileProjectChatSendResult(
      messages: chat.messages,
      plans: chat.plans,
      operations: chat.operations,
      hasMore: chat.hasMore,
      nextCursor: chat.nextCursor,
      openProposalId: chat.openProposalId,
      reply: MobileProjectChatMessage.fromJson(
        json['reply'] as Map<String, dynamic>,
      ),
      operation: json['operation'] == null
          ? null
          : MobileBookEditOperation.fromJson(
              json['operation'] as Map<String, dynamic>,
            ),
    );
  }
}

class MobileEditableBook {
  const MobileEditableBook({
    required this.projectId,
    required this.title,
    required this.pages,
  });

  final String projectId;
  final String title;
  final List<MobileEditableBookPage> pages;

  factory MobileEditableBook.fromJson(Map<String, dynamic> json) {
    final pages = json['pages'] as List<dynamic>? ?? const [];
    return MobileEditableBook(
      projectId: json['projectId'] as String,
      title: json['title'] as String,
      pages: pages
          .map(
            (page) =>
                MobileEditableBookPage.fromJson(page as Map<String, dynamic>),
          )
          .toList(),
    );
  }
}

class MobileEditableBookPage {
  const MobileEditableBookPage({
    required this.id,
    required this.index,
    required this.title,
    required this.markdown,
    required this.revision,
  });

  final String id;
  final int index;
  final String title;
  final String markdown;
  final int revision;

  factory MobileEditableBookPage.fromJson(Map<String, dynamic> json) {
    return MobileEditableBookPage(
      id: json['id'] as String,
      index: json['index'] as int,
      title: json['title'] as String,
      markdown: json['markdown'] as String,
      revision: json['revision'] as int,
    );
  }
}

class MobileManualBookPageEdit {
  const MobileManualBookPageEdit({
    required this.id,
    required this.title,
    required this.markdown,
    required this.baseRevision,
  });

  final String id;
  final String title;
  final String markdown;
  final int baseRevision;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'markdown': markdown,
      'baseRevision': baseRevision,
    };
  }
}

class MobileManualBookEditResult extends MobileProjectChat {
  const MobileManualBookEditResult({
    required super.messages,
    required super.operations,
    super.plans,
    super.hasMore,
    super.nextCursor,
    required this.savedExportMessage,
    required this.operation,
  });

  final MobileProjectChatMessage savedExportMessage;
  final MobileBookEditOperation operation;

  factory MobileManualBookEditResult.fromJson(Map<String, dynamic> json) {
    final chat = MobileProjectChat.fromJson(json);
    return MobileManualBookEditResult(
      messages: chat.messages,
      plans: chat.plans,
      operations: chat.operations,
      hasMore: chat.hasMore,
      nextCursor: chat.nextCursor,
      savedExportMessage: MobileProjectChatMessage.fromJson(
        json['savedExportMessage'] as Map<String, dynamic>,
      ),
      operation: MobileBookEditOperation.fromJson(
        json['operation'] as Map<String, dynamic>,
      ),
    );
  }
}
