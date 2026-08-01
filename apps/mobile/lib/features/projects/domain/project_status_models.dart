// Live status of a project: the streamed progress payload behind the creation
// chat's progress bubble and the /handoff screen. Re-exported from
// project_models.dart so existing imports keep seeing these types.
import 'export_models.dart';

class MobileProjectStatus {
  const MobileProjectStatus({
    required this.projectId,
    required this.status,
    required this.statusLabel,
    required this.progressPercent,
    required this.currentAction,
    this.planningProgress,
    this.generationProgress,
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
  final MobileGenerationProgress? generationProgress;
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
      generationProgress: json['generationProgress'] is Map
          ? MobileGenerationProgress.fromJson(
              (json['generationProgress'] as Map).cast<String, dynamic>(),
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

/// Live milestones for the book itself, once a plan has been approved.
///
/// A superset of [MobilePlanningProgress]: writing has many more meaningful
/// sub-states than planning, so [detail] carries the phrase for what is
/// happening right now while [steps] carry the coarse milestones.
class MobileGenerationProgress {
  const MobileGenerationProgress({
    required this.percent,
    required this.steps,
    this.detail,
  });

  final int percent;
  final String? detail;
  final List<MobileProjectStatusStep> steps;

  factory MobileGenerationProgress.fromJson(Map<String, dynamic> json) {
    final rawSteps = json['steps'] as List<dynamic>? ?? const [];
    final detail = (json['detail'] as String?)?.trim();
    return MobileGenerationProgress(
      percent: ((json['percent'] as num?)?.round() ?? 0).clamp(0, 100),
      detail: detail == null || detail.isEmpty ? null : detail,
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
