/// Reads `coverImage` from a project summary or detail payload.
///
/// Older API builds only sent the cover on the detail response, so a missing
/// key is treated as "no cover yet" rather than an error.
MobileProjectImage? parseProjectCoverImage(Map<String, dynamic> json) {
  final cover = json['coverImage'];
  if (cover is! Map) {
    return null;
  }
  return MobileProjectImage.fromJson(cover.cast<String, dynamic>());
}

class MobileProjectSummary {
  const MobileProjectSummary({
    required this.id,
    required this.title,
    required this.bookType,
    required this.lengthPreset,
    required this.qualityPreset,
    required this.imagesEnabled,
    required this.status,
    required this.statusLabel,
    required this.progressPercent,
    required this.currentAction,
    required this.promptPreview,
    required this.targetPages,
    required this.pageCount,
    required this.imageCount,
    required this.hasPlan,
    required this.exports,
    required this.createdAt,
    required this.updatedAt,
    this.subtitle,
    this.authorName,
    this.source = 'generated',
    this.coverImage,
  });

  final String id;
  final String title;
  final String? subtitle;
  final String? authorName;

  /// Cover art once the cover job has finished; null before that.
  final MobileProjectImage? coverImage;

  /// "imported" for books the author uploaded, "generated" otherwise.
  final String source;
  final String bookType;
  final String lengthPreset;
  final String qualityPreset;
  final bool imagesEnabled;
  final String status;
  final String statusLabel;
  final int progressPercent;
  final String currentAction;
  final String promptPreview;
  final int targetPages;
  final int pageCount;
  final int imageCount;
  final bool hasPlan;
  final MobileExportSet exports;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory MobileProjectSummary.fromJson(Map<String, dynamic> json) {
    return MobileProjectSummary(
      id: json['id'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      authorName: json['authorName'] as String?,
      bookType: json['bookType'] as String,
      lengthPreset: json['lengthPreset'] as String,
      qualityPreset: json['qualityPreset'] as String,
      imagesEnabled: json['imagesEnabled'] as bool,
      status: json['status'] as String,
      statusLabel: json['statusLabel'] as String,
      progressPercent: json['progressPercent'] as int,
      currentAction: json['currentAction'] as String,
      promptPreview: json['promptPreview'] as String,
      targetPages: json['targetPages'] as int,
      pageCount: json['pageCount'] as int,
      imageCount: json['imageCount'] as int,
      hasPlan: json['hasPlan'] as bool,
      exports: MobileExportSet.fromJson(
        json['exports'] as Map<String, dynamic>,
      ),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      source: json['source'] as String? ?? 'generated',
      coverImage: parseProjectCoverImage(json),
    );
  }

  bool get isImported => source == 'imported';

  String get bookTypeLabel {
    return switch (bookType) {
      'lead_magnet' => 'Lead magnet',
      'workbook' => 'Workbook',
      'short_story' => 'Short story',
      _ => 'Book',
    };
  }

  bool get hasReadyExport => exports.pdf.available || exports.epub.available;

  String get lengthPresetLabel {
    return switch (lengthPreset) {
      'short' => 'Short',
      'standard' => 'Standard',
      'expanded' => 'Expanded',
      _ => 'Custom',
    };
  }

  String get qualityPresetLabel {
    return switch (qualityPreset) {
      'fast' => 'Quick draft',
      'balanced' => 'Balanced',
      'premium' => 'Extra polish',
      _ => 'Custom',
    };
  }
}

class MobileProjectDetail extends MobileProjectSummary {
  const MobileProjectDetail({
    required super.id,
    required super.title,
    required super.bookType,
    required super.lengthPreset,
    required super.qualityPreset,
    required super.imagesEnabled,
    required super.status,
    required super.statusLabel,
    required super.progressPercent,
    required super.currentAction,
    required super.promptPreview,
    required super.targetPages,
    required super.pageCount,
    required super.imageCount,
    required super.hasPlan,
    required super.exports,
    required super.createdAt,
    required super.updatedAt,
    required this.prompt,
    required this.language,
    required this.pages,
    super.subtitle,
    super.authorName,
    super.source,
    super.coverImage,
    this.plan,
    this.quality = const MobileProjectQuality.pending(),
  });

  final String prompt;
  final String language;
  final MobilePlan? plan;
  final List<MobileProjectPage> pages;
  final MobileProjectQuality quality;

  factory MobileProjectDetail.fromJson(Map<String, dynamic> json) {
    final pages = json['pages'] as List<dynamic>;
    final plan = json['plan'];
    return MobileProjectDetail(
      id: json['id'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      authorName: json['authorName'] as String?,
      bookType: json['bookType'] as String,
      lengthPreset: json['lengthPreset'] as String,
      qualityPreset: json['qualityPreset'] as String,
      imagesEnabled: json['imagesEnabled'] as bool,
      status: json['status'] as String,
      statusLabel: json['statusLabel'] as String,
      progressPercent: json['progressPercent'] as int,
      currentAction: json['currentAction'] as String,
      promptPreview: json['promptPreview'] as String,
      targetPages: json['targetPages'] as int,
      pageCount: json['pageCount'] as int,
      imageCount: json['imageCount'] as int,
      hasPlan: json['hasPlan'] as bool,
      exports: MobileExportSet.fromJson(
        json['exports'] as Map<String, dynamic>,
      ),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      source: json['source'] as String? ?? 'generated',
      prompt: json['prompt'] as String,
      language: json['language'] as String,
      plan: plan == null
          ? null
          : MobilePlan.fromJson(plan as Map<String, dynamic>),
      pages: pages
          .map(
            (page) => MobileProjectPage.fromJson(page as Map<String, dynamic>),
          )
          .toList(),
      coverImage: parseProjectCoverImage(json),
      quality: MobileProjectQuality.fromJson(
        (json['quality'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
    );
  }
}

/// Result of uploading a manuscript: the created project plus import status.
class MobileImportedBook {
  const MobileImportedBook({
    required this.project,
    required this.importId,
    required this.importStatus,
    this.stats,
  });

  final MobileProjectDetail project;
  final String importId;
  final String importStatus;
  final Map<String, dynamic>? stats;

  factory MobileImportedBook.fromJson(Map<String, dynamic> json) {
    final importJson =
        (json['import'] as Map?)?.cast<String, dynamic>() ?? const {};
    return MobileImportedBook(
      project: MobileProjectDetail.fromJson(
        json['project'] as Map<String, dynamic>,
      ),
      importId: importJson['id'] as String? ?? '',
      importStatus: importJson['status'] as String? ?? 'UPLOADED',
      stats: (importJson['stats'] as Map?)?.cast<String, dynamic>(),
    );
  }
}

class MobileProjectPage {
  const MobileProjectPage({
    required this.id,
    required this.index,
    required this.title,
    required this.summary,
    required this.status,
    this.previewText = '',
    this.image,
  });

  final String id;
  final int index;
  final String title;
  final String summary;
  final String previewText;
  final String status;
  final MobileProjectImage? image;

  factory MobileProjectPage.fromJson(Map<String, dynamic> json) {
    return MobileProjectPage(
      id: json['id'] as String,
      index: json['index'] as int,
      title: json['title'] as String,
      summary: json['summary'] as String,
      previewText: json['previewText'] as String? ?? '',
      status: json['status'] as String,
      image: json['image'] == null
          ? null
          : MobileProjectImage.fromJson(json['image'] as Map<String, dynamic>),
    );
  }
}

class MobileProjectImage {
  const MobileProjectImage({
    required this.id,
    required this.role,
    required this.url,
    required this.contentType,
    required this.altText,
    this.pageId,
  });

  final String id;
  final String role;
  final String url;
  final String contentType;
  final String altText;
  final String? pageId;

  factory MobileProjectImage.fromJson(Map<String, dynamic> json) {
    return MobileProjectImage(
      id: json['id'] as String,
      role: json['role'] as String,
      url: json['url'] as String,
      contentType: json['contentType'] as String,
      altText: json['altText'] as String,
      pageId: json['pageId'] as String?,
    );
  }
}

class MobilePlan {
  const MobilePlan({
    required this.id,
    required this.projectId,
    required this.version,
    required this.status,
    required this.title,
    required this.premise,
    required this.audience,
    required this.questions,
    required this.chapters,
    required this.createdAt,
    required this.updatedAt,
    this.subtitle,
    this.approvedAt,
  });

  final String id;
  final String projectId;
  final int version;
  final String status;
  final String title;
  final String? subtitle;
  final String premise;
  final String audience;
  final List<MobilePlanQuestion> questions;
  final List<MobilePlanChapter> chapters;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? approvedAt;

  factory MobilePlan.fromJson(Map<String, dynamic> json) {
    final questions = json['questions'] as List<dynamic>;
    final chapters = json['chapters'] as List<dynamic>;
    return MobilePlan(
      id: json['id'] as String,
      projectId: json['projectId'] as String,
      version: json['version'] as int,
      status: json['status'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      premise: json['premise'] as String,
      audience: json['audience'] as String,
      questions: questions
          .map(
            (question) =>
                MobilePlanQuestion.fromJson(question as Map<String, dynamic>),
          )
          .toList(),
      chapters: chapters
          .map(
            (chapter) =>
                MobilePlanChapter.fromJson(chapter as Map<String, dynamic>),
          )
          .toList(),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      approvedAt: json['approvedAt'] == null
          ? null
          : DateTime.parse(json['approvedAt'] as String),
    );
  }

  bool get isApproved => status == 'approved';

  bool get isSuperseded => status == 'superseded';
}

class MobilePlanQuestion {
  const MobilePlanQuestion({
    required this.prompt,
    required this.options,
    required this.allowCustom,
  });

  final String prompt;
  final List<String> options;
  final bool allowCustom;

  factory MobilePlanQuestion.fromJson(Map<String, dynamic> json) {
    final options = json['options'] as List<dynamic>;
    return MobilePlanQuestion(
      prompt: json['prompt'] as String,
      options: options.map((option) => option as String).toList(),
      allowCustom: json['allowCustom'] as bool,
    );
  }
}

class MobilePlanChapter {
  const MobilePlanChapter({
    required this.index,
    required this.title,
    required this.summary,
    required this.targetPages,
  });

  final int index;
  final String title;
  final String summary;
  final int targetPages;

  factory MobilePlanChapter.fromJson(Map<String, dynamic> json) {
    return MobilePlanChapter(
      index: json['index'] as int,
      title: json['title'] as String,
      summary: json['summary'] as String,
      targetPages: json['targetPages'] as int,
    );
  }
}

class MobileProjectCreateRequest {
  const MobileProjectCreateRequest({
    required this.bookType,
    required this.prompt,
    required this.lengthPreset,
    required this.qualityPreset,
    required this.imagesEnabled,
    this.title,
  });

  final String bookType;
  final String? title;
  final String prompt;
  final String lengthPreset;
  final String qualityPreset;
  final bool imagesEnabled;

  Map<String, dynamic> toJson() {
    return {
      'bookType': bookType,
      if (title != null && title!.trim().isNotEmpty) 'title': title!.trim(),
      'prompt': prompt.trim(),
      'lengthPreset': lengthPreset,
      'qualityPreset': qualityPreset,
      'imagesEnabled': imagesEnabled,
    };
  }
}

class MobilePlanOperation {
  const MobilePlanOperation({
    required this.projectId,
    required this.status,
    required this.currentAction,
    required this.job,
    this.planId,
  });

  final String projectId;
  final String? planId;
  final String status;
  final String currentAction;
  final MobileQueuedJob job;

  factory MobilePlanOperation.fromJson(Map<String, dynamic> json) {
    return MobilePlanOperation(
      projectId: json['projectId'] as String,
      planId: json['planId'] as String?,
      status: json['status'] as String,
      currentAction: json['currentAction'] as String,
      job: MobileQueuedJob.fromJson(json['job'] as Map<String, dynamic>),
    );
  }
}

class MobileQueuedJob {
  const MobileQueuedJob({
    required this.id,
    required this.status,
    required this.currentAction,
  });

  final String id;
  final String status;
  final String currentAction;

  factory MobileQueuedJob.fromJson(Map<String, dynamic> json) {
    return MobileQueuedJob(
      id: json['id'] as String,
      status: json['status'] as String,
      currentAction: json['currentAction'] as String,
    );
  }
}

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
  });

  final String id;
  final String kind;
  final String scope;
  final List<int> affectedPageIndexes;
  final int credits;
  final String summary;
  final int? affectedChapterIndex;
  final String? targetLanguage;

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
    this.submittedText,
    this.requestId,
    this.canUndo = false,
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

  /// Original user input and idempotency key, when returned by newer servers.
  final String? submittedText;
  final String? requestId;

  /// True when this applied edit can be undone from the chat transcript.
  final bool canUndo;

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
      submittedText: submittedText is String ? submittedText : null,
      requestId: json['requestId'] as String?,
      canUndo: json['canUndo'] as bool? ?? false,
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
  });

  final List<MobileProjectChatMessage> messages;
  final List<MobilePlan> plans;
  final List<MobileBookEditOperation> operations;
  final bool hasMore;
  final String? nextCursor;

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

class MobileProjectStatus {
  const MobileProjectStatus({
    required this.projectId,
    required this.status,
    required this.statusLabel,
    required this.progressPercent,
    required this.currentAction,
    this.planningProgress,
    required this.retryAvailable,
    required this.steps,
    required this.pageProgress,
    required this.imageCount,
    required this.exports,
    this.quality = const MobileProjectQuality.pending(),
    required this.updatedAt,
    this.failureMessage,
    this.operationId,
    this.nextRetryAt,
    this.retryState,
    this.retryMessage,
  });

  final String projectId;
  final String status;
  final String statusLabel;
  final int progressPercent;
  final String currentAction;
  final MobilePlanningProgress? planningProgress;
  final String? failureMessage;
  final bool retryAvailable;
  final String? operationId;
  final DateTime? nextRetryAt;
  final String? retryState;
  final String? retryMessage;
  final List<MobileProjectStatusStep> steps;
  final MobilePageProgress pageProgress;
  final int imageCount;
  final MobileExportSet exports;
  final MobileProjectQuality quality;
  final DateTime updatedAt;

  /// Whether the server is still actively working on the book; drives status
  /// streaming and detail-polling cadence. A scheduled automatic retry remains
  /// live even when the operation temporarily reports a failed status.
  bool get isLive =>
      status == 'planning' ||
      status == 'generating' ||
      status == 'editing' ||
      isAutomaticRetryPending;

  bool get isAutomaticRetryPending =>
      nextRetryAt != null &&
      (retryState == 'pending' ||
          retryState == 'scheduled' ||
          retryState == 'waiting');

  String get effectiveAction {
    final retryCopy = retryMessage?.trim();
    if (retryCopy != null && retryCopy.isNotEmpty) return retryCopy;
    return currentAction;
  }

  factory MobileProjectStatus.fromJson(Map<String, dynamic> json) {
    final steps = json['steps'] as List<dynamic>? ?? const [];
    final retry = (json['retry'] as Map?)?.cast<String, dynamic>();
    final nextRetryAt = json['nextRetryAt'] ?? retry?['nextRetryAt'];
    return MobileProjectStatus(
      projectId: json['projectId'] as String,
      status: json['status'] as String,
      statusLabel: json['statusLabel'] as String,
      progressPercent: json['progressPercent'] as int,
      currentAction: json['currentAction'] as String,
      planningProgress: json['planningProgress'] is Map
          ? MobilePlanningProgress.fromJson(
              (json['planningProgress'] as Map).cast<String, dynamic>(),
            )
          : null,
      failureMessage: json['failureMessage'] as String?,
      retryAvailable:
          json['retryAvailable'] as bool? ??
          retry?['available'] as bool? ??
          false,
      operationId: json['operationId'] as String?,
      nextRetryAt: nextRetryAt is String
          ? DateTime.tryParse(nextRetryAt)
          : null,
      retryState: json['retryState'] as String? ?? retry?['state'] as String?,
      retryMessage:
          json['retryMessage'] as String? ?? retry?['message'] as String?,
      steps: steps
          .map(
            (step) =>
                MobileProjectStatusStep.fromJson(step as Map<String, dynamic>),
          )
          .toList(),
      pageProgress: MobilePageProgress.fromJson(
        json['pageProgress'] as Map<String, dynamic>,
      ),
      imageCount: json['imageCount'] as int,
      exports: MobileExportSet.fromJson(
        json['exports'] as Map<String, dynamic>,
      ),
      quality: MobileProjectQuality.fromJson(
        (json['quality'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  bool get isComplete => status == 'complete';

  bool get hasReadyExport => exports.pdf.available || exports.epub.available;

  bool get requiresReview => status == 'review_required' || quality.isBlocked;

  bool get hasFailure => failureMessage != null && failureMessage!.isNotEmpty;
}

class MobilePlanningProgress {
  const MobilePlanningProgress({required this.percent, required this.steps});

  final int percent;
  final List<MobileProjectStatusStep> steps;

  factory MobilePlanningProgress.fromJson(Map<String, dynamic> json) {
    final rawSteps = json['steps'] as List<dynamic>? ?? const [];
    return MobilePlanningProgress(
      percent: ((json['percent'] as num?)?.round() ?? 0).clamp(0, 100),
      steps: rawSteps
          .whereType<Map>()
          .map(
            (step) =>
                MobileProjectStatusStep.fromJson(step.cast<String, dynamic>()),
          )
          .toList(),
    );
  }
}

class MobileProjectQuality {
  const MobileProjectQuality({
    required this.state,
    required this.issues,
    required this.affectedPageIndexes,
    this.score,
  });

  const MobileProjectQuality.pending()
    : state = 'pending',
      score = null,
      issues = const [],
      affectedPageIndexes = const [];

  final String state;
  final int? score;
  final List<MobileProjectQualityIssue> issues;
  final List<int> affectedPageIndexes;

  factory MobileProjectQuality.fromJson(Map<String, dynamic> json) {
    final rawIssues = json['issues'] as List<dynamic>? ?? const [];
    final rawIndexes =
        json['affectedPageIndexes'] as List<dynamic>? ?? const [];
    return MobileProjectQuality(
      state: json['state'] as String? ?? 'pending',
      score: (json['score'] as num?)?.round(),
      issues: rawIssues
          .whereType<Map>()
          .map(
            (issue) => MobileProjectQualityIssue.fromJson(
              issue.cast<String, dynamic>(),
            ),
          )
          .toList(),
      affectedPageIndexes: rawIndexes
          .whereType<num>()
          .map((index) => index.toInt())
          .toList(),
    );
  }

  bool get isBlocked => state == 'blocked';
  bool get recommendsReview => state == 'review_recommended';
  bool get passed => state == 'passed';
}

class MobileProjectQualityIssue {
  const MobileProjectQualityIssue({
    required this.code,
    required this.severity,
    required this.source,
    required this.message,
    required this.guidance,
    required this.affectedPageIndexes,
  });

  final String code;
  final String severity;
  final String source;
  final String message;
  final String guidance;
  final List<int> affectedPageIndexes;

  factory MobileProjectQualityIssue.fromJson(Map<String, dynamic> json) {
    final indexes = json['affectedPageIndexes'] as List<dynamic>? ?? const [];
    return MobileProjectQualityIssue(
      code: json['code'] as String? ?? 'QUALITY_ISSUE',
      severity: json['severity'] as String? ?? 'warning',
      source: json['source'] as String? ?? 'model',
      message: json['message'] as String? ?? 'Review this part of the book.',
      guidance: json['guidance'] as String? ?? 'Review the affected pages.',
      affectedPageIndexes: indexes
          .whereType<num>()
          .map((index) => index.toInt())
          .toList(),
    );
  }
}

class MobileProjectStatusStep {
  const MobileProjectStatusStep({
    required this.key,
    required this.label,
    required this.status,
    this.detail,
  });

  final String key;
  final String label;
  final String status;
  final String? detail;

  factory MobileProjectStatusStep.fromJson(Map<String, dynamic> json) {
    return MobileProjectStatusStep(
      key: json['key'] as String,
      label: json['label'] as String,
      status: json['status'] as String,
      detail: json['detail'] as String?,
    );
  }

  bool get isDone => status == 'done';

  bool get isActive => status == 'active';

  bool get isFailed => status == 'failed';
}

class MobilePageProgress {
  const MobilePageProgress({required this.completed, required this.target});

  final int completed;
  final int target;

  factory MobilePageProgress.fromJson(Map<String, dynamic> json) {
    return MobilePageProgress(
      completed: json['completed'] as int,
      target: json['target'] as int,
    );
  }
}

class MobileProjectRecovery {
  const MobileProjectRecovery({
    required this.projectId,
    required this.status,
    required this.currentAction,
    required this.resumedActions,
    required this.skippedActions,
    required this.stoppingActions,
  });

  final String projectId;
  final String status;
  final String currentAction;
  final int resumedActions;
  final int skippedActions;
  final int stoppingActions;

  factory MobileProjectRecovery.fromJson(Map<String, dynamic> json) {
    return MobileProjectRecovery(
      projectId: json['projectId'] as String,
      status: json['status'] as String,
      currentAction: json['currentAction'] as String,
      resumedActions: json['resumedActions'] as int,
      skippedActions: json['skippedActions'] as int,
      stoppingActions: json['stoppingActions'] as int,
    );
  }
}

class ProjectExportFile {
  const ProjectExportFile({
    required this.format,
    required this.filename,
    required this.path,
  });

  final String format;
  final String filename;
  final String path;
}

class ModerationReportReceipt {
  const ModerationReportReceipt({
    required this.id,
    required this.targetType,
    required this.reason,
    required this.status,
    required this.createdAt,
  });

  final String id;
  final String targetType;
  final String reason;
  final String status;
  final DateTime createdAt;

  factory ModerationReportReceipt.fromJson(Map<String, dynamic> json) {
    return ModerationReportReceipt(
      id: json['id'] as String,
      targetType: json['targetType'] as String,
      reason: json['reason'] as String,
      status: json['status'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

class ProjectDeletionReceipt {
  const ProjectDeletionReceipt({
    required this.deletedProjectId,
    required this.retainedLogs,
  });

  final String deletedProjectId;
  final String retainedLogs;

  factory ProjectDeletionReceipt.fromJson(Map<String, dynamic> json) {
    return ProjectDeletionReceipt(
      deletedProjectId: json['deletedProjectId'] as String,
      retainedLogs: json['retainedLogs'] as String? ?? '',
    );
  }
}

int estimateApprovalCredits(
  MobileProjectDetail project,
  Map<String, dynamic> creditCosts,
) {
  return estimateProjectCredits(
    bookType: project.bookType,
    qualityPreset: project.qualityPreset,
    imagesEnabled: project.imagesEnabled,
    targetPages: project.targetPages,
    creditCosts: creditCosts,
  );
}

int estimateProjectCredits({
  required String bookType,
  required String qualityPreset,
  required bool imagesEnabled,
  required int targetPages,
  required Map<String, dynamic> creditCosts,
}) {
  final fullBookBase = _intCost(creditCosts, 'fullBookBase', 350);
  final fullBookPerPage = _intCost(creditCosts, 'fullBookPerPage', 8);
  final imageGeneration = _intCost(creditCosts, 'imageGeneration', 45);
  final premiumReview = _intCost(creditCosts, 'premiumReview', 200);
  final exportUnlock = _intCost(creditCosts, 'exportUnlock', 150);
  final imageCount = _estimatedInteriorImages(
    bookType: bookType,
    imagesEnabled: imagesEnabled,
    targetPages: targetPages,
  );
  final premiumCredits = qualityPreset == 'premium' ? premiumReview : 0;
  return fullBookBase +
      targetPages * fullBookPerPage +
      imageCount * imageGeneration +
      premiumCredits +
      exportUnlock;
}

int _estimatedInteriorImages({
  required String bookType,
  required bool imagesEnabled,
  required int targetPages,
}) {
  if (!imagesEnabled) {
    return 0;
  }
  final customCap = (targetPages / 8).ceil();
  final launchCap = switch (bookType) {
    'workbook' => 6,
    'lead_magnet' || 'short_story' => 4,
    _ => customCap < 1 ? 1 : customCap,
  };
  final estimated = (targetPages / 4).ceil();
  if (estimated < 0) {
    return 0;
  }
  return estimated > launchCap ? launchCap : estimated;
}

int _intCost(Map<String, dynamic> creditCosts, String key, int fallback) {
  final value = creditCosts[key];
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.round();
  }
  return fallback;
}

class MobileExportSet {
  const MobileExportSet({required this.pdf, required this.epub});

  final MobileExportAvailability pdf;
  final MobileExportAvailability epub;

  factory MobileExportSet.fromJson(Map<String, dynamic> json) {
    return MobileExportSet(
      pdf: MobileExportAvailability.fromJson(
        json['pdf'] as Map<String, dynamic>,
      ),
      epub: MobileExportAvailability.fromJson(
        json['epub'] as Map<String, dynamic>,
      ),
    );
  }
}

class MobileExportAvailability {
  const MobileExportAvailability({
    required this.format,
    required this.available,
    required this.unlocked,
    required this.creditsRequired,
    required this.downloadUrl,
    required this.filename,
    required this.contentType,
  });

  final String format;
  final bool available;
  final bool unlocked;
  final int creditsRequired;
  final String downloadUrl;
  final String filename;
  final String contentType;

  factory MobileExportAvailability.fromJson(Map<String, dynamic> json) {
    return MobileExportAvailability(
      format: json['format'] as String,
      available: json['available'] as bool,
      unlocked: json['unlocked'] as bool,
      creditsRequired: json['creditsRequired'] as int,
      downloadUrl: json['downloadUrl'] as String,
      filename: json['filename'] as String,
      contentType: json['contentType'] as String,
    );
  }
}
