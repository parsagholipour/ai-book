// The export/download models live in export_models.dart, the chat models in
// project_chat_models.dart, the live status payload in
// project_status_models.dart and the edit diff in edit_changes_models.dart; all
// are re-exported so the many screens that import project_models.dart keep
// seeing them.
export 'edit_changes_models.dart';
export 'export_models.dart';
export 'project_chat_models.dart';
export 'project_status_models.dart';

import 'export_models.dart';
import 'project_status_models.dart';

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
