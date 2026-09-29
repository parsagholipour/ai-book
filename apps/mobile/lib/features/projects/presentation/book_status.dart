import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/project_models.dart';

/// What a book looks like to the reader in a list: one of a handful of states,
/// each with a word, a tone and an icon, so the shelf, the library and the chat
/// history all say the same thing about the same book.
enum BookStatusKind { ready, writing, planReady, needsAttention, inProgress }

@immutable
class BookStatusInfo {
  const BookStatusInfo(this.kind, this.label, {this.progress});

  final BookStatusKind kind;
  final String label;

  /// 0..1 while the book is being written; null otherwise.
  final double? progress;

  AppTone get tone => switch (kind) {
    BookStatusKind.ready => AppTone.success,
    BookStatusKind.writing || BookStatusKind.planReady => AppTone.info,
    BookStatusKind.needsAttention => AppTone.error,
    BookStatusKind.inProgress => AppTone.neutral,
  };

  IconData? get icon => switch (kind) {
    BookStatusKind.ready => Icons.check_circle_outline,
    BookStatusKind.writing => null,
    BookStatusKind.planReady => Icons.rate_review_outlined,
    BookStatusKind.needsAttention => Icons.error_outline,
    BookStatusKind.inProgress => Icons.edit_note_outlined,
  };
}

/// Classifies a listed book. Order matters: a failure wins over everything, and
/// a book with a finished export reads as ready even while a later edit is
/// running, because the reader can still open it.
BookStatusInfo bookStatusInfo(MobileProjectSummary project) {
  if (project.status.toLowerCase() == 'failed') {
    return const BookStatusInfo(
      BookStatusKind.needsAttention,
      'Needs attention',
    );
  }
  if (project.hasReadyExport) {
    return const BookStatusInfo(BookStatusKind.ready, 'Ready');
  }
  // Not a book being generated, so no percentage and no "draft saved". The
  // short form suits the shelf; the library spells out the server's own label
  // ("Writing · 3,200 words").
  if (project.isUnpublishedManuscript) {
    return const BookStatusInfo(BookStatusKind.inProgress, 'Writing');
  }
  if (project.isLive) {
    final percent = project.progressPercent.clamp(0, 100);
    return BookStatusInfo(
      BookStatusKind.writing,
      '$percent% complete',
      progress: percent / 100,
    );
  }
  if (project.status.toLowerCase() == 'plan_ready') {
    return const BookStatusInfo(BookStatusKind.planReady, 'Plan to review');
  }
  return const BookStatusInfo(BookStatusKind.inProgress, 'In progress');
}

/// Applies the streamed fields to a cached summary.
///
/// Keeping this merge local avoids making the whole project list refetch on
/// every one-second status event, while menus and navigation still see the
/// newly available exports as soon as generation finishes.
MobileProjectSummary projectWithLiveStatus(
  MobileProjectSummary project,
  MobileProjectStatus status,
) {
  return MobileProjectSummary(
    id: project.id,
    title: project.title,
    subtitle: project.subtitle,
    authorName: project.authorName,
    source: project.source,
    coverImage: project.coverImage,
    bookType: project.bookType,
    lengthPreset: project.lengthPreset,
    qualityPreset: project.qualityPreset,
    coverEnabled: status.imageSettingsReported
        ? status.coverEnabled
        : project.coverEnabled,
    illustrationsEnabled: status.imageSettingsReported
        ? status.illustrationsEnabled
        : project.illustrationsEnabled,
    status: status.status,
    statusLabel: status.statusLabel,
    progressPercent: status.progressPercent,
    currentAction: status.currentAction,
    promptPreview: project.promptPreview,
    targetPages: status.pageProgress.target,
    pageCount: status.pageProgress.completed,
    imageCount: status.imageCount,
    hasPlan: project.hasPlan,
    manuscript: project.manuscript,
    exports: status.exports,
    createdAt: project.createdAt,
    updatedAt: status.updatedAt,
  );
}

/// A compact status chip: the tone says how the book is doing before the
/// reader has read the word.
///
/// The label wraps instead of ellipsising, because "Needs attention" cut to
/// "Needs atte…" is the one word a reader cannot afford to lose, and a shelf
/// tile is only ~90dp wide.
class BookStatusPill extends StatelessWidget {
  const BookStatusPill({required this.info, this.labelOverride, super.key});

  final BookStatusInfo info;

  /// Replaces the label without changing the tone, for a list that wants a
  /// longer phrase (the library says "Writing your book · 42%").
  final String? labelOverride;

  @override
  Widget build(BuildContext context) {
    final pair = appToneColors(context, info.tone);
    final label = labelOverride ?? info.label;
    final progress = info.progress;
    return Semantics(
      label: label,
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: pair.background,
            borderRadius: BorderRadius.circular(AppRadii.compact),
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(7, 3, 8, 3),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (progress != null) ...[
                  SizedBox.square(
                    dimension: 11,
                    child: CircularProgressIndicator(
                      value: progress,
                      strokeWidth: 2,
                      color: pair.foreground,
                      backgroundColor: pair.foreground.withValues(alpha: 0.2),
                    ),
                  ),
                  const SizedBox(width: 5),
                ] else if (info.icon != null) ...[
                  Icon(info.icon, size: 13, color: pair.foreground),
                  const SizedBox(width: 4),
                ],
                Flexible(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: pair.foreground,
                      fontWeight: FontWeight.w700,
                      height: 1.25,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
