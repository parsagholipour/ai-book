import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'book_plan_review.dart';
import 'book_preview_section.dart';
import 'book_stage.dart';
import 'generation_progress_overview.dart';
import 'project_export_panel.dart';

/// Everything one book has to say, on one page.
///
/// The order is fixed — what the book is, what is happening to it, the plan
/// behind it, what has been written, what you can take away — and [BookStage]
/// decides which of those are true right now. A reader never has to know which
/// screen a book is "on", because there is only this one.
class BookScreenBody extends StatelessWidget {
  const BookScreenBody({
    required this.onRefresh,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.status,
    this.project,
    this.billing,
    this.initialMessage,
    this.busyAction,
    this.revisionController,
    this.failedRevision,
    this.onResume,
    this.onGeneratePlan,
    this.onRevisePlan,
    this.onApprovePlan,
    this.onRetryRevision,
    this.onEditFailedRequest,
    this.onDeleteProject,
    this.onReportProject,
    this.onReportImage,
    super.key,
  });

  final MobileProjectStatus? status;
  final MobileProjectDetail? project;
  final MobileBilling? billing;
  final String? initialMessage;
  final String? busyAction;
  final TextEditingController? revisionController;
  final MobileBookEditOperation? failedRevision;
  final Future<void> Function() onRefresh;
  final Future<void> Function()? onResume;
  final Future<void> Function()? onGeneratePlan;
  final Future<void> Function(String message)? onRevisePlan;
  final Future<void> Function()? onApprovePlan;
  final Future<void> Function()? onRetryRevision;
  final VoidCallback? onEditFailedRequest;
  final Future<void> Function()? onDeleteProject;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;
  final Future<void> Function()? onReportProject;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    final project = this.project;
    final status = this.status;
    final stage = bookStageFor(project: project, status: status);
    final plan = project?.plan;
    final quality = status?.quality ?? project?.quality;
    final exports = status?.exports ?? project?.exports;
    final projectId = status?.projectId ?? project?.id;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
        children: [
          if (project != null) ...[
            BookHeaderCard(project: project),
            const SizedBox(height: 12),
          ],
          if (failedRevision != null) ...[
            PlanRevisionFailedBanner(
              operation: failedRevision!,
              busy: busyAction == 'retry-revision',
              onRetry: onRetryRevision,
              onEditRequest: onEditFailedRequest,
            ),
            const SizedBox(height: 12),
          ],

          // What is happening to this book right now, whatever that is.
          if (stage == BookStage.needsPlan && project != null) ...[
            NoPlanCard(
              project: project,
              busyAction: busyAction,
              onGeneratePlan: onGeneratePlan ?? () async {},
            ),
            const SizedBox(height: 12),
          ] else if (stage.leadsWithPlan &&
              project != null &&
              plan != null &&
              revisionController != null) ...[
            ProjectPlanReview(
              project: project,
              plan: plan,
              billing: billing,
              revisionController: revisionController!,
              busyAction: busyAction,
              onQuestionAnswers: onRevisePlan ?? (_) async {},
              onRevisionRequest: onRevisePlan ?? (_) async {},
              onApprovePlan: onApprovePlan,
            ),
            const SizedBox(height: 12),
          ] else if (stage == BookStage.ready && status != null) ...[
            BookReadyCard(status: status, project: project),
            const SizedBox(height: 12),
          ] else if (stage.showsProgress && status != null) ...[
            GenerationProgressOverviewCard(
              status: status,
              initialMessage: initialMessage,
              busyAction: busyAction,
              onResume: onResume,
            ),
            const SizedBox(height: 12),
          ],

          // The plan the book came from: kept, but out of the way, once it is
          // no longer something the reader decides.
          if (!stage.leadsWithPlan && plan != null) ...[
            PlanSummaryCard(plan: plan),
            const SizedBox(height: 12),
          ],

          if (quality != null &&
              (quality.isBlocked || quality.recommendsReview) &&
              projectId != null) ...[
            _QualityGateCard(
              quality: quality,
              onOpenPage: (pageIndex) => context.push(
                '/projects/$projectId/edit?pageIndex=$pageIndex',
              ),
              onRequestRegeneration: () =>
                  context.push('/projects/$projectId/chat'),
            ),
            const SizedBox(height: 12),
          ],

          if (project != null && stage.hasManuscript) ...[
            GeneratedBookPreview(
              project: project,
              onReportProject: onReportProject,
              onReportImage: onReportImage,
            ),
            const SizedBox(height: 12),
          ],

          // Exports only once there is a file to talk about. A locked-format
          // list beside a book that is 30% written is noise about a decision
          // nobody can make yet. Flagged quality issues warn in the card above
          // but never withhold the download — the reader paid for this book.
          if (exports != null &&
              (stage == BookStage.ready ||
                  stage == BookStage.reviewRequired ||
                  exports.pdf.available ||
                  exports.epub.available)) ...[
            ProjectExportPanel(
              exports: exports,
              billing: billing,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
              editBookProjectId:
                  stage == BookStage.ready || stage == BookStage.reviewRequired
                  ? projectId
                  : null,
            ),
            const SizedBox(height: 12),
          ],

          if (onDeleteProject != null)
            ProjectPrivacyActions(
              isDeleting: busyAction == 'delete',
              onDeleteProject: onDeleteProject!,
            ),
        ],
      ),
    );
  }
}

/// Which book this page is about: the cover, the way it would sit on a shelf.
class BookHeaderCard extends StatelessWidget {
  const BookHeaderCard({required this.project, super.key});

  final MobileProjectDetail project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                BookCover(
                  title: project.title,
                  seed: project.id,
                  image: project.coverImage,
                  authorName: project.authorName,
                  width: 76,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        project.title,
                        key: const ValueKey('project-header-title'),
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      if (project.authorName?.trim().isNotEmpty == true) ...[
                        const SizedBox(height: 4),
                        Text(
                          'by ${project.authorName!.trim()}',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Text(
                        project.prompt,
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                AppMetricChip(label: 'Type', value: project.bookTypeLabel),
                AppMetricChip(
                  label: 'Length',
                  value: project.lengthPresetLabel,
                ),
                AppMetricChip(
                  label: 'Finish',
                  value: project.qualityPresetLabel,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// The payoff: shown in place of the progress breakdown once the book exists.
///
/// Finishing a book is the moment the whole product is for, and before this it
/// was marked only by a progress bar quietly reaching 100%. Showing the cover
/// the user just made, at size, is the reward.
class BookReadyCard extends StatelessWidget {
  const BookReadyCard({required this.status, this.project, super.key});

  final MobileProjectStatus status;
  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final title = project?.title ?? 'Your book';
    final pages = status.pageProgress.completed;

    return AppEntrance(
      offset: 16,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              colors.primary,
              Color.lerp(colors.primary, colors.tertiary, 0.55)!,
            ],
          ),
          borderRadius: BorderRadius.circular(TomezaRadii.card),
        ),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              BookCover(
                title: title,
                seed: status.projectId,
                image: project?.coverImage,
                authorName: project?.authorName,
                width: 84,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Your book is ready',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: colors.onPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: colors.onPrimary.withValues(alpha: 0.92),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      pages > 0
                          ? '$pages pages written. Download or share it below.'
                          : 'Download or share it below.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onPrimary.withValues(alpha: 0.85),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ProjectPrivacyActions extends StatelessWidget {
  const ProjectPrivacyActions({
    required this.onDeleteProject,
    this.isDeleting = false,
    super.key,
  });

  final bool isDeleting;
  final Future<void> Function() onDeleteProject;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton.icon(
        onPressed: isDeleting ? null : () => onDeleteProject(),
        icon: isDeleting
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  semanticsLabel: 'Deleting project',
                ),
              )
            : const Icon(Icons.delete_outline),
        label: const Text('Delete project'),
      ),
    );
  }
}

class _QualityGateCard extends StatelessWidget {
  const _QualityGateCard({
    required this.quality,
    required this.onOpenPage,
    required this.onRequestRegeneration,
  });

  final MobileProjectQuality quality;
  final void Function(int pageIndex) onOpenPage;
  final VoidCallback onRequestRegeneration;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final blocked = quality.isBlocked;
    return Card(
      color: blocked ? colors.errorContainer : colors.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  blocked ? Icons.gpp_bad_outlined : Icons.rate_review_outlined,
                  color: blocked
                      ? colors.onErrorContainer
                      : colors.onTertiaryContainer,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    blocked
                        ? 'Quality checks flagged pages'
                        : 'Review recommended',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              blocked
                  ? 'Fix the deterministic integrity issues below, then save to rerun the checks.'
                  : 'The book is exportable, but these prose concerns may be worth reviewing.',
            ),
            const SizedBox(height: 12),
            for (final issue in quality.issues.take(8))
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: issue.affectedPageIndexes.isEmpty
                      ? null
                      : () => onOpenPage(issue.affectedPageIndexes.first),
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          issue.message,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 3),
                        Text(issue.guidance),
                        if (issue.affectedPageIndexes.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            'Pages ${issue.affectedPageIndexes.join(', ')} · Open Edit Mode',
                            style: TextStyle(
                              color: colors.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (quality.affectedPageIndexes.isNotEmpty)
                  FilledButton.tonalIcon(
                    onPressed: () =>
                        onOpenPage(quality.affectedPageIndexes.first),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Open Edit Mode'),
                  ),
                OutlinedButton.icon(
                  onPressed: onRequestRegeneration,
                  icon: const Icon(Icons.auto_fix_high_outlined),
                  label: const Text('Request regeneration'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
