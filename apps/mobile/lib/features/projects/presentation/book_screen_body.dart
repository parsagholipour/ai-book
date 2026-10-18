import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../../book_matter/presentation/author_nudge_card.dart';
import '../../book_matter/presentation/book_credits_card.dart';
import '../../notes/presentation/book_notes_card.dart';
import '../../studio/presentation/studio_book_card.dart';
import '../../studio/presentation/studio_location.dart';
import '../domain/project_models.dart';
import 'book_hero.dart';
import 'book_plan_review.dart';
import 'book_preview_section.dart';
import 'book_stage.dart';
import 'book_stage_cards.dart';
import 'generation_progress_overview.dart';
import 'next_book_card.dart';
import 'plan_write_it_myself.dart';
import 'project_export_panel.dart';

/// Everything one book has to say, on one page.
///
/// The order is fixed — what the book is, what is happening to it, the plan
/// behind it, what has been written — and [BookStage] decides which of those
/// are true right now. A reader never has to know which screen a book is "on",
/// because there is only this one. The book's files are not a section: they open
/// from the hero, beside Read, so a finished page is a cover and four buttons
/// rather than a stack of cards.
class BookScreenBody extends ConsumerWidget {
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
    this.onReportPlan,
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

  /// Reports the plan a model wrote; never offered on an author's own book.
  final Future<void> Function(MobilePlan plan)? onReportPlan;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final project = this.project;
    final status = this.status;
    final stage = bookStageFor(project: project, status: status);
    // Asked once, under whatever the book is doing: the author's name.
    final nudgeProfile = authorNudgeProfile(
      ref,
      project: project,
      stage: stage,
    );
    final plan = project?.plan;
    final quality = status?.quality ?? project?.quality;
    final exports = status?.exports ?? project?.exports;
    final projectId = status?.projectId ?? project?.id;
    final finished =
        stage == BookStage.ready || stage == BookStage.reviewRequired;
    // The author owns this text, so every "go and fix it" leads to the Studio,
    // not to Edit Mode's page-by-page markdown.
    final authorManuscript = project?.isAuthorManuscript ?? false;
    final unpublishedChanges =
        stage != BookStage.manuscript &&
        authorManuscript &&
        (project?.manuscript?.hasUnpublishedChanges ?? false);

    final sections = <Widget>[
      BookHero(
        key: const ValueKey('book-section-hero'),
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
          key: const ValueKey('book-section-revision-failed'),
          operation: failedRevision!,
          busy: busyAction == 'retry-revision',
          onRetry: onRetryRevision,
          onEditRequest: onEditFailedRequest,
        ),

      // What is happening to this book right now, whatever that is.
      if (stage == BookStage.manuscript && project != null)
        StudioBookCard(
          key: const ValueKey('book-section-studio'),
          project: project,
        )
      else if (stage == BookStage.needsPlan && project != null)
        NoPlanCard(
          key: const ValueKey('book-section-no-plan'),
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
          key: const ValueKey('book-section-plan-review'),
          project: project,
          plan: plan,
          billing: billing,
          revisionController: revisionController!,
          busyAction: busyAction,
          onQuestionAnswers: onRevisePlan ?? (_) async {},
          onRevisionRequest: onRevisePlan ?? (_) async {},
          onApprovePlan: onApprovePlan,
          // The quiet door out of the generated road: an outline the author
          // writes themselves. Only while the plan is still theirs to decide.
          approvalFooter: plan.isApproved || project.isAuthorManuscript
              ? null
              : PlanWriteItMyselfLink(
                  projectId: project.id,
                  enabled: busyAction == null,
                ),
          onReport: onReportPlan == null || project.isAuthorManuscript
              ? null
              : () => onReportPlan!(plan),
        )
      else if (stage == BookStage.needsAttention && status != null)
        BookStoppedCard(
          key: const ValueKey('book-section-stopped'),
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
          key: const ValueKey('book-section-progress'),
          status: status,
          initialMessage: initialMessage,
          busyAction: busyAction,
          onResume: onResume,
        ),

      if (nudgeProfile != null && project != null)
        AuthorNudgeCard(
          key: const ValueKey('book-section-author-nudge'),
          projectId: project.id,
          profile: nudgeProfile,
        ),

      // Written in the Studio since the last publish, and not in the book yet.
      if (unpublishedChanges && projectId != null)
        AppInlineNotice(
          key: const ValueKey('book-unpublished-changes'),
          icon: Icons.edit_note_outlined,
          title: 'You have changes that aren\'t in your book yet',
          message:
              'They are saved in the Writing Studio. Update your book when '
              'you want readers to see them.',
          actionLabel: 'Update book',
          onAction: () =>
              context.push(studioLocation(projectId, publish: true)),
        ),

      // Flagged quality issues warn but never withhold the download: the reader
      // paid for this book, and the files are right there in the hero.
      if (stage != BookStage.manuscript &&
          quality != null &&
          (quality.isBlocked || quality.recommendsReview) &&
          projectId != null)
        BookQualityNotice(
          key: const ValueKey('book-section-quality'),
          quality: quality,
          onOpenPage: (pageIndex) => context.push(
            authorManuscript
                ? studioLocation(projectId)
                : '/projects/$projectId/edit?pageIndex=$pageIndex',
          ),
          onReview: () {
            final first = quality.affectedPageIndexes.isNotEmpty
                ? quality.affectedPageIndexes.first
                : null;
            context.push(
              authorManuscript
                  ? studioLocation(projectId)
                  : first == null
                  ? '/projects/$projectId/edit'
                  : '/projects/$projectId/edit?pageIndex=$first',
            );
          },
          onRequestRegeneration: () =>
              context.push('/projects/$projectId/chat'),
        ),

      // The plan the book came from: kept, but out of the way, once it is no
      // longer something the reader decides.
      // An author's own book has a plan only as bookkeeping the publish wrote
      // — chapters and page counts read off their manuscript — so it is not
      // shown back to them as a plan.
      if (!stage.leadsWithPlan && plan != null && !authorManuscript)
        PlanSummaryCard(
          key: const ValueKey('book-section-plan-summary'),
          plan: plan,
          onReport: onReportPlan == null ? null : () => onReportPlan!(plan),
        ),

      // A finished book the reader's own generation wrote can be continued:
      // the same characters, world and look in a new chat. An author's own
      // book is planned from text no model wrote, so the server refuses it.
      if (finished && project != null && !authorManuscript)
        NextBookCard(
          key: const ValueKey('book-section-next-book'),
          projectId: project.id,
        ),

      if (project != null && stage.hasManuscript)
        GeneratedBookPreview(
          key: const ValueKey('book-section-preview'),
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
          stage != BookStage.manuscript &&
          (exports.pdf.available || exports.epub.available))
        ProjectExportPanel(
          key: const ValueKey('book-section-exports'),
          exports: exports,
          billing: billing,
          busyAction: busyAction,
          onOpen: onOpen,
          onDownload: onDownload,
          onOpenPaywall: onOpenPaywall,
          onRefresh: () => onRefresh(),
        ),

      // The book's own title page and credits, on every book in every stage:
      // something set once, so it sits with the notes rather than up top.
      if (project != null)
        BookCreditsCard(
          key: const ValueKey('book-section-credits'),
          projectId: project.id,
        ),

      // The owner's private notes, on every book in every stage: below what
      // the book is doing, above anything that would delete it.
      if (project != null)
        BookNotesCard(
          key: const ValueKey('book-section-notes'),
          projectId: project.id,
        ),

      if (onDeleteProject != null)
        ProjectPrivacyActions(
          key: const ValueKey('book-section-privacy'),
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
        // Every section is keyed, and found by its key, so a section that
        // comes or goes moves the others rather than rebuilding them: when a
        // book finishes, its progress card leaves, and the card below it —
        // the name nudge mid-sentence, say — must keep its state.
        findItemIndexCallback: (key) {
          final index = sections.indexWhere((section) => section.key == key);
          return index < 0 ? null : index;
        },
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
