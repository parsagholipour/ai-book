import '../domain/project_models.dart';

/// Where a book is right now, reduced to the one thing its page should lead
/// with.
///
/// The plan and the writing used to be two screens, so a book part-way through
/// opened on the one with nothing left to do on it — a plan the reader had
/// already approved, and a button to the screen they actually wanted. One page
/// has to pick what the reader came for, and this is that decision, kept out of
/// the widget tree so it can be read and tested on its own.
enum BookStage {
  /// The idea is saved and nothing has been drafted yet.
  needsPlan,

  /// The plan is being written.
  planning,

  /// A plan is waiting on the reader: approve it, revise it, answer questions.
  planReview,

  /// Approved, and being written or edited.
  writing,

  /// Work stopped and will not resume on its own.
  needsAttention,

  /// Written, but a quality gate is holding the export.
  reviewRequired,

  /// Finished and exportable.
  ready,
}

extension BookStageDisplay on BookStage {
  /// Whether the plan is the page's main content rather than reference
  /// material tucked below what is happening now.
  bool get leadsWithPlan => this == BookStage.planReview;

  /// Whether the live progress card belongs on the page.
  bool get showsProgress =>
      this == BookStage.planning ||
      this == BookStage.writing ||
      this == BookStage.needsAttention ||
      this == BookStage.reviewRequired;

  /// Whether writing has produced pages worth previewing.
  bool get hasManuscript =>
      this == BookStage.writing ||
      this == BookStage.needsAttention ||
      this == BookStage.reviewRequired ||
      this == BookStage.ready;
}

/// Resolves the stage from whichever of the two sources has loaded.
///
/// [status] is the live stream and wins wherever it disagrees; [project] is the
/// slower detail fetch and is the only one that knows whether a plan exists.
BookStage bookStageFor({
  MobileProjectDetail? project,
  MobileProjectStatus? status,
}) {
  final state = (status?.status ?? project?.status ?? 'draft').toLowerCase();

  // A scheduled retry is still the book being written: it is waiting on the
  // server, not on the reader, and must not be dressed up as a failure.
  final retrying = status?.isAutomaticRetryPending ?? false;
  if (!retrying && (state == 'failed' || (status?.hasFailure ?? false))) {
    return BookStage.needsAttention;
  }
  if (status?.requiresReview ?? state == 'review_required') {
    return BookStage.reviewRequired;
  }
  if (state == 'complete') {
    return BookStage.ready;
  }
  if (state == 'generating' || state == 'editing') {
    return BookStage.writing;
  }
  if (state == 'planning') {
    return BookStage.planning;
  }

  final plan = project?.plan;
  if (plan == null) {
    // The detail fetch has not landed yet, or there is genuinely no plan. The
    // project's own status is what separates the two.
    return state == 'plan_ready' ? BookStage.planReview : BookStage.needsPlan;
  }
  if (!plan.isApproved) {
    return BookStage.planReview;
  }
  // Approved, and the writing job has not reported in yet.
  return BookStage.writing;
}
