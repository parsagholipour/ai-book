import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/book_blurb.dart';
import '../domain/project_models.dart';
import '../../studio/presentation/studio_cover_picker.dart';
import '../../studio/presentation/studio_location.dart';
import 'book_cover.dart';
import 'book_screen_skeleton.dart';
import 'book_stage.dart';
import 'project_export_panel.dart';

/// The book, once, at the top of its page.
///
/// This is what used to be two cards — a header with the cover and the brief,
/// and a gradient "your book is ready" banner with the cover again — plus an
/// exports card that repeated the title's neighbourhood a third time. One hero
/// carries the cover, the title, a single line of facts, the state the book is
/// in, and, once there is something to read, the few things you do with a book:
/// read it, listen to it, edit it, take a copy.
///
/// It is drawn from whichever of the two sources has arrived. The status knows
/// the stage and the files; the detail knows the title and the cover. With only
/// the first, the hero still offers its actions and holds the rest as skeleton.
class BookHero extends StatelessWidget {
  const BookHero({
    required this.stage,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.project,
    this.status,
    this.exports,
    this.billing,
    this.busyAction,
    this.onRefresh,
    super.key,
  });

  final BookStage stage;
  final MobileProjectDetail? project;
  final MobileProjectStatus? status;
  final MobileExportSet? exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;
  final Future<void> Function()? onRefresh;

  /// A replan copy says what it is; the original book stays untouched, so the
  /// request is the one piece of context the copy carries with it.
  static String rebuiltFromLabel(MobileProjectRevisionOrigin origin) {
    final request = origin.request?.trim();
    if (request == null || request.isEmpty) {
      return 'Rebuilt from an earlier book.';
    }
    return 'Rebuilt from an earlier book — “$request”';
  }

  bool get _finished =>
      stage == BookStage.ready || stage == BookStage.reviewRequired;

  @override
  Widget build(BuildContext context) {
    final project = this.project;
    final projectId = status?.projectId ?? project?.id;
    // Large text leaves a 96dp cover too little beside it: a long word in the
    // title breaks mid-word. A smaller cover gives the title its width back.
    final largeText = MediaQuery.textScalerOf(context).scale(1) >= 1.3;
    // A book being written by its author is theirs already: it gets the full
    // cover, not the thumbnail a book still being generated wears.
    final fullCover = _finished || stage == BookStage.manuscript;
    final coverWidth = fullCover ? (largeText ? 72.0 : 96.0) : 64.0;
    final canRead = _finished && (exports?.pdf.available ?? false);

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Static, unlike the whole-page skeleton: this is a few hundred
          // milliseconds between the status arriving and the detail, and the
          // rest of the page is already moving.
          if (project == null)
            _identitySkeleton(coverWidth)
          else
            _BookIdentity(
              stage: stage,
              project: project,
              status: status,
              coverWidth: coverWidth,
              onTapCover: canRead && projectId != null
                  ? () {
                      AppHaptics.tap();
                      context.push('/projects/$projectId/read');
                    }
                  : null,
              // An author chooses their own cover. Before the first publish
              // that is the writing card's to offer; after it, here.
              onChangeCover:
                  project.isAuthorManuscript &&
                      stage != BookStage.manuscript &&
                      projectId != null
                  ? () {
                      AppHaptics.tap();
                      showStudioCoverSheet(context, projectId: projectId);
                    }
                  : null,
            ),
          if (_finished && projectId != null && exports != null) ...[
            const SizedBox(height: AppSpacing.md),
            _HeroActions(
              projectId: projectId,
              stage: stage,
              authorManuscript: project?.isAuthorManuscript ?? false,
              exports: exports!,
              billing: billing,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
              onRefresh: onRefresh,
            ),
          ],
        ],
      ),
    );
  }

  Widget _identitySkeleton(double coverWidth) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        BookSkeletonBox(
          width: coverWidth,
          height: coverWidth * 1.5,
          radius: 10,
        ),
        const SizedBox(width: AppSpacing.md),
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              BookSkeletonBox(height: 22),
              SizedBox(height: AppSpacing.xs),
              BookSkeletonBox(height: 12, width: 120),
              SizedBox(height: AppSpacing.sm),
              BookSkeletonBox(height: 12),
            ],
          ),
        ),
      ],
    );
  }
}

/// Cover, title, byline, the one line of facts, the state badge and the
/// description.
class _BookIdentity extends StatelessWidget {
  const _BookIdentity({
    required this.stage,
    required this.project,
    required this.status,
    required this.coverWidth,
    required this.onTapCover,
    this.onChangeCover,
  });

  final BookStage stage;
  final MobileProjectDetail project;
  final MobileProjectStatus? status;
  final double coverWidth;
  final VoidCallback? onTapCover;
  final VoidCallback? onChangeCover;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final full = coverWidth > 80;
    // The plan under a plan-review hero opens with its own title. Saying it here
    // too, one line above, is the same words twice; a renamed book still says
    // its own.
    final planTitle = project.plan?.title.trim();
    final showTitle =
        stage != BookStage.planReview ||
        planTitle == null ||
        planTitle != project.title.trim();
    final author = project.authorName?.trim();
    final meta = bookMetaLine(stage: stage, project: project, status: status);
    // While the plan is on screen in full its own premise and subtitle sit
    // right below; a second copy of them up here would be the same words twice.
    final blurb = stage == BookStage.planReview
        ? null
        : bookBlurb(project, plan: project.plan);
    final badge = _stageBadge(stage);

    Widget cover = BookCover(
      title: project.title,
      seed: project.id,
      image: project.coverImage,
      authorName: project.authorName,
      width: coverWidth,
    );
    if (onTapCover != null) {
      // The Read button is the accessible way in; the cover is the obvious one.
      cover = ExcludeSemantics(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTapCover,
          child: cover,
        ),
      );
    }

    // At the largest text sizes even a shrunken cover leaves the title a
    // sliver, and a long word breaks mid-word. The title takes the card's full
    // width beneath the cover instead.
    final stackTitle = MediaQuery.textScalerOf(context).scale(1) >= 1.6;
    final title = showTitle
        ? Text(
            project.title,
            key: const ValueKey('project-header-title'),
            maxLines: 6,
            overflow: TextOverflow.ellipsis,
            style:
                (full
                        ? theme.textTheme.headlineSmall
                        : theme.textTheme.titleLarge)
                    ?.copyWith(fontWeight: FontWeight.w800, height: 1.15),
          )
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            cover,
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (badge != null) ...[
                    badge,
                    const SizedBox(height: AppSpacing.xs),
                  ],
                  if (title != null && !stackTitle) title,
                  if (author != null && author.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      'by $author',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                  if (meta != null) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      meta,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                  if (onChangeCover != null)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.xxs),
                      child: _ChangeCoverLink(onTap: onChangeCover!),
                    ),
                ],
              ),
            ),
          ],
        ),
        if (title != null && stackTitle) ...[
          const SizedBox(height: AppSpacing.sm),
          title,
        ],
        if (blurb != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(
            blurb,
            key: const ValueKey('project-header-blurb'),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.onSurfaceVariant,
              height: 1.4,
            ),
          ),
        ],
        if (project.revisedFrom != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.history_outlined,
                size: 16,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  BookHero.rebuiltFromLabel(project.revisedFrom!),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

/// A link-weight way to the cover choice, beside the cover it changes.
class _ChangeCoverLink extends StatelessWidget {
  const _ChangeCoverLink({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: true,
      label: 'Change cover',
      child: ExcludeSemantics(
        child: InkWell(
          key: const ValueKey('hero-change-cover'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.image_outlined, size: 18, color: colors.primary),
                const SizedBox(width: 6),
                Text(
                  'Change cover',
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: colors.primary,
                    fontWeight: FontWeight.w700,
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

/// The state a book is in, when the card below it does not already say so.
///
/// A book being planned or written has a progress card whose title is the state;
/// a badge beside it would be the same words twice. Every other stage is
/// otherwise silent about itself.
Widget? _stageBadge(BookStage stage) {
  return switch (stage) {
    BookStage.ready => const AppStatusBadge(
      label: 'Ready to read',
      icon: Icons.check_circle_outline,
      tone: AppTone.success,
    ),
    BookStage.reviewRequired => const AppStatusBadge(
      label: 'Worth a look',
      icon: Icons.rate_review_outlined,
      tone: AppTone.warning,
    ),
    BookStage.needsAttention => const AppStatusBadge(
      label: 'Needs attention',
      icon: Icons.error_outline,
      tone: AppTone.error,
    ),
    BookStage.planReview => const AppStatusBadge(
      label: 'Plan ready to review',
      icon: Icons.fact_check_outlined,
      tone: AppTone.info,
    ),
    BookStage.needsPlan => const AppStatusBadge(
      label: 'Draft',
      icon: Icons.edit_note_outlined,
    ),
    BookStage.manuscript => const AppStatusBadge(
      label: 'Writing',
      icon: Icons.edit_outlined,
      tone: AppTone.success,
    ),
    BookStage.planning || BookStage.writing => null,
  };
}

/// "6 chapters · 28 pages · Short story": the facts a reader would give if you
/// asked what the book is, on one line.
///
/// The type goes when it is the generic "Book", and gives way to the effort the
/// book was written at, which is the next most useful fact about it. While the
/// plan is being reviewed the plan's own chips say all of this, so the line
/// stays out of its way.
@visibleForTesting
String? bookMetaLine({
  required BookStage stage,
  required MobileProjectDetail project,
  MobileProjectStatus? status,
}) {
  if (stage == BookStage.planReview) {
    return null;
  }
  if (stage == BookStage.manuscript) {
    // The card below counts the words; the line says how the book is built.
    final chapters = project.manuscript?.chapterCount ?? 0;
    if (chapters <= 0) return null;
    return chapters == 1 ? '1 chapter' : '$chapters chapters';
  }
  final parts = <String>[];
  final chapters = project.plan?.chapters.length ?? 0;
  if (chapters > 0) {
    parts.add(chapters == 1 ? '1 chapter' : '$chapters chapters');
  }
  final finished =
      stage == BookStage.ready || stage == BookStage.reviewRequired;
  final pages = finished
      ? (project.pageCount > 0
            ? project.pageCount
            : status?.pageProgress.completed ?? 0)
      : (status?.pageProgress.target ?? 0) > 0
      ? status!.pageProgress.target
      : project.targetPages;
  if (pages > 0) {
    parts.add(pages == 1 ? '1 page' : '$pages pages');
  }
  if (project.hasDistinctBookType) {
    parts.add(project.bookTypeLabel);
  } else if (project.qualityPresetLabel != 'Custom') {
    parts.add(project.qualityPresetLabel);
  }
  return parts.isEmpty ? null : parts.join(' · ');
}

/// Read, and the three things beside it. The export list opens in place under
/// the row, so choosing a file never leaves the page or costs a scroll.
class _HeroActions extends StatefulWidget {
  const _HeroActions({
    required this.projectId,
    required this.stage,
    required this.authorManuscript,
    required this.exports,
    required this.billing,
    required this.busyAction,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    required this.onRefresh,
  });

  final String projectId;
  final BookStage stage;

  /// The author owns this book's text, so its Edit is the Writing Studio.
  final bool authorManuscript;
  final MobileExportSet exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;
  final Future<void> Function()? onRefresh;

  @override
  State<_HeroActions> createState() => _HeroActionsState();
}

class _HeroActionsState extends State<_HeroActions> {
  bool _exportsOpen = false;

  @override
  Widget build(BuildContext context) {
    final id = widget.projectId;
    final pdf = widget.exports.pdf;
    // Listening needs a finished book; a book held for review reads and edits.
    final canListen = widget.stage == BookStage.ready;
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.medium;

    return AppEntrance(
      offset: 12,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // A file that is not on disk yet is a wait, not a missing feature: the
          // button says so, and becomes Read on its own when the status stream
          // reports the file. Deliberately no spinner: a settled book whose file
          // is missing may be waiting on a repair that has stood down, and an
          // endless animation over a wait that may never end is a lie the page
          // cannot correct.
          AppButton.primary(
            onPressed: pdf.available
                ? () {
                    AppHaptics.tap();
                    context.push('/projects/$id/read');
                  }
                : null,
            leading: Icon(
              pdf.available
                  ? Icons.auto_stories_outlined
                  : Icons.hourglass_top_rounded,
            ),
            label: pdf.available ? 'Read' : 'Preparing your book',
            expanded: true,
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              if (canListen) ...[
                Expanded(
                  child: _ActionTile(
                    icon: Icons.headphones_outlined,
                    label: 'Listen',
                    onTap: () {
                      AppHaptics.tap();
                      context.push('/projects/$id/listen');
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.xs),
              ],
              Expanded(
                child: _ActionTile(
                  icon: widget.authorManuscript
                      ? Icons.edit_outlined
                      : Icons.edit_note_outlined,
                  label: widget.authorManuscript ? 'Write' : 'Edit',
                  onTap: () {
                    AppHaptics.tap();
                    context.push(
                      widget.authorManuscript
                          ? studioLocation(id)
                          : '/projects/$id/edit',
                    );
                  },
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: _ActionTile(
                  icon: Icons.ios_share_outlined,
                  label: 'Export',
                  selected: _exportsOpen,
                  semanticLabel: _exportsOpen
                      ? 'Export, expanded'
                      : 'Export, collapsed',
                  onTap: () {
                    AppHaptics.selection();
                    setState(() => _exportsOpen = !_exportsOpen);
                  },
                ),
              ),
            ],
          ),
          AnimatedSize(
            duration: duration,
            curve: AppMotion.enter,
            alignment: Alignment.topCenter,
            child: _exportsOpen
                ? Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.md),
                    child: ProjectExportPanel(
                      embedded: true,
                      exports: widget.exports,
                      billing: widget.billing,
                      busyAction: widget.busyAction,
                      onOpen: widget.onOpen,
                      onDownload: widget.onDownload,
                      onOpenPaywall: widget.onOpenPaywall,
                      onRefresh: widget.onRefresh == null
                          ? null
                          : () => widget.onRefresh!(),
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

/// An icon over a word, on a surface that is clearly pressable and clearly
/// second to the button above it.
class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.semanticLabel,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final foreground = selected ? colors.onPrimaryContainer : colors.onSurface;
    return Semantics(
      button: true,
      selected: selected,
      label: semanticLabel ?? label,
      child: ExcludeSemantics(
        child: Material(
          color: selected ? colors.primaryContainer : Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.control),
            side: BorderSide(
              color: selected ? Colors.transparent : colors.outlineVariant,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 64),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.xs,
                  vertical: AppSpacing.sm,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(icon, size: 22, color: foreground),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: foreground,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
