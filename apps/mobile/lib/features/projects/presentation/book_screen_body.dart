import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/project_models.dart';
import 'book_hero.dart';
import 'book_plan_review.dart';
import 'book_preview_section.dart';
import 'book_stage.dart';
import 'book_stage_cards.dart';
import 'generation_progress_overview.dart';
import 'project_export_panel.dart';

/// Everything one book has to say, on one page.
///
/// The order is fixed — what the book is, what is happening to it, the plan
/// behind it, what has been written — and [BookStage] decides which of those
/// are true right now. A reader never has to know which screen a book is "on",
/// because there is only this one. The book's files are not a section: they open
/// from the hero, beside Read, so a finished page is a cover and four buttons
/// rather than a stack of cards.
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
    final finished =
        stage == BookStage.ready || stage == BookStage.reviewRequired;

    final sections = <Widget>[
      BookHero(
        stage: stage,
        project: project,
        status: status,
        exports: exports,
        billing: billing,
        busyAction: busyAction,
        onOpen: onOpen,
        onDownload: onDownload,
        onOpenPaywall: onOpenPaywall,
        onRefresh: onRefresh,
      ),
      if (failedRevision != null)
        PlanRevisionFailedBanner(
          operation: failedRevision!,
          busy: busyAction == 'retry-revision',
          onRetry: onRetryRevision,
          onEditRequest: onEditFailedRequest,
        ),

      // What is happening to this book right now, whatever that is.
      if (stage == BookStage.needsPlan && project != null)
        NoPlanCard(
          project: project,
          billing: billing,
          busyAction: busyAction,
          onGeneratePlan: onGeneratePlan ?? () async {},
        )
      else if (stage.leadsWithPlan &&
          project != null &&
          plan != null &&
          revisionController != null)
        ProjectPlanReview(
          project: project,
          plan: plan,
          billing: billing,
          revisionController: revisionController!,
          busyAction: busyAction,
          onQuestionAnswers: onRevisePlan ?? (_) async {},
          onRevisionRequest: onRevisePlan ?? (_) async {},
          onApprovePlan: onApprovePlan,
        )
      else if (stage == BookStage.needsAttention && status != null)
        BookStoppedCard(
          status: status,
          busyAction: busyAction,
          hasPlan: plan != null || (project?.hasPlan ?? false),
          onResume: onResume,
          onAskInChat: projectId == null
              ? null
              : () => context.push('/projects/$projectId/chat'),
        )
      else if ((stage == BookStage.planning || stage == BookStage.writing) &&
          status != null)
        GenerationProgressOverviewCard(
          status: status,
          initialMessage: initialMessage,
          busyAction: busyAction,
          onResume: onResume,
        ),

      // Flagged quality issues warn but never withhold the download: the reader
      // paid for this book, and the files are right there in the hero.
      if (quality != null &&
          (quality.isBlocked || quality.recommendsReview) &&
          projectId != null)
        BookQualityNotice(
          quality: quality,
          onOpenPage: (pageIndex) =>
              context.push('/projects/$projectId/edit?pageIndex=$pageIndex'),
          onReview: () {
            final first = quality.affectedPageIndexes.isNotEmpty
                ? quality.affectedPageIndexes.first
                : null;
            context.push(
              first == null
                  ? '/projects/$projectId/edit'
                  : '/projects/$projectId/edit?pageIndex=$first',
            );
          },
          onRequestRegeneration: () =>
              context.push('/projects/$projectId/chat'),
        ),

      // The plan the book came from: kept, but out of the way, once it is no
      // longer something the reader decides.
      if (!stage.leadsWithPlan && plan != null) PlanSummaryCard(plan: plan),

      if (project != null && stage.hasManuscript)
        GeneratedBookPreview(
          project: project,
          live: !finished,
          onReportProject: onReportProject,
          onReportImage: onReportImage,
        ),

      // A book being edited keeps its last files on offer while the new ones
      // are built. A finished one has them in the hero; a book still being
      // written has none worth listing, and a locked-format list beside a book
      // that is 30% written is noise about a decision nobody can make yet.
      if (exports != null &&
          !finished &&
          (exports.pdf.available || exports.epub.available))
        ProjectExportPanel(
          exports: exports,
          billing: billing,
          busyAction: busyAction,
          onOpen: onOpen,
          onDownload: onDownload,
          onOpenPaywall: onOpenPaywall,
          onRefresh: () => onRefresh(),
        ),

      if (onDeleteProject != null)
        ProjectPrivacyActions(
          isDeleting: busyAction == 'delete',
          onDeleteProject: onDeleteProject!,
        ),
    ];

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: AppInsets.screen,
        itemCount: sections.length,
        separatorBuilder: (context, index) =>
            const SizedBox(height: AppSpacing.sm),
        itemBuilder: (context, index) => sections[index],
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
      alignment: AlignmentDirectional.centerStart,
      child: AppButton.outlined(
        onPressed: isDeleting ? null : () => onDeleteProject(),
        loading: isDeleting,
        loadingLabel: 'Deleting project',
        leading: const Icon(Icons.delete_outline),
        label: 'Delete project',
      ),
    );
  }
}
