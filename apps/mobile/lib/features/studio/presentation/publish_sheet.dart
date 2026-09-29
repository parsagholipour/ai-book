import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../data/studio_repository.dart';
import '../domain/assist_models.dart';
import '../domain/manuscript_models.dart';
import 'studio_cover_picker.dart';
import 'studio_location.dart';
import 'studio_progress.dart';

/// Opens the publish sheet for this book: the checklist, then Publish (first
/// time) or Update book. Resolves true once the book was published.
///
/// Writing is free and autosaved to a working copy; the book people read and
/// export changes only here. So the sheet says what publishing will do before
/// it does it — how much book there is, which chapters changed, what is worth
/// a second look — and keeps the one button honest about whether it can.
Future<bool> showPublishSheet(
  BuildContext context, {
  required String projectId,
}) async {
  final published = await showAppBottomSheet<bool>(
    context,
    builder: (_) => PublishSheet(projectId: projectId),
  );
  return published ?? false;
}

enum _Phase { review, publishing, finishing, changed }

@visibleForTesting
class PublishSheet extends ConsumerStatefulWidget {
  const PublishSheet({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<PublishSheet> createState() => _PublishSheetState();
}

class _PublishSheetState extends ConsumerState<PublishSheet> {
  PublishChecklist? _checklist;
  Object? _loadError;
  _Phase _phase = _Phase.review;
  String? _publishError;
  bool _publishErrorIsWait = false;

  /// One key per publish the author asked for, kept across a retry after a
  /// network failure so the server can replay a publish that did land.
  String? _publishRequestId;

  /// A cover request is on its way (an upload): publishing now would race it.
  bool _coverBusy = false;

  /// What the first publish will bind in, for the progress copy.
  ManuscriptCoverSource _coverSource = ManuscriptCoverSource.design;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _checklist = null;
      _loadError = null;
    });
    try {
      final checklist = await ref
          .read(studioRepositoryProvider)
          .publishChecklist(
            widget.projectId,
            requestId: studioRequestId('studio-checklist'),
          );
      if (mounted) setState(() => _checklist = checklist);
    } catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  Future<void> _publish() async {
    final checklist = _checklist;
    if (checklist == null || !checklist.canPublish) return;
    if (_phase == _Phase.publishing || _phase == _Phase.finishing) return;
    _publishRequestId ??= studioRequestId('studio-publish');
    // The container outlives this sheet: a publish that lands after the sheet
    // was dragged away still has to refresh the book behind it.
    final container = ProviderScope.containerOf(context, listen: false);
    final repository = ref.read(studioRepositoryProvider);
    AppHaptics.tap();
    setState(() {
      _phase = _Phase.publishing;
      _publishError = null;
    });
    try {
      await repository.publish(widget.projectId, requestId: _publishRequestId!);
      container
        ..invalidate(projectsProvider)
        ..invalidate(projectDetailProvider(widget.projectId))
        ..invalidate(projectStatusProvider(widget.projectId))
        ..invalidate(manuscriptProvider(widget.projectId));
      if (!mounted) return;
      AppHaptics.success();
      setState(() => _phase = _Phase.finishing);
      // Long enough to see the bar arrive; the book page takes it from here.
      await Future<void>.delayed(
        AppMotion.adapt(context, const Duration(milliseconds: 650)),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (error.code == 'BOOK_CHANGED') {
        container.invalidate(manuscriptProvider(widget.projectId));
        if (!mounted) return;
        AppHaptics.error();
        setState(() => _phase = _Phase.changed);
        return;
      }
      // The server answered and did nothing; the next tap is a new publish.
      _publishRequestId = null;
      if (ManuscriptContentRefusal.isRefusalCode(error.code)) {
        // Refused for its words: each refused chapter becomes a blocking item
        // that opens it, and Publish stays shut until the author has been
        // there — reopening the sheet asks the server again.
        final refusal = ManuscriptContentRefusal.fromJson({
          ...error.details,
          'message': error.message,
        });
        if (!mounted) return;
        AppHaptics.error();
        setState(() {
          _phase = _Phase.review;
          _publishError = null;
          _checklist = _checklist?.withRefusal(refusal);
        });
        return;
      }
      _showPublishError(error);
    } catch (error) {
      _showPublishError(error);
    }
  }

  void _showPublishError(Object error) {
    if (!mounted) return;
    AppHaptics.error();
    final wait = publishWaitMessage(error);
    setState(() {
      _phase = _Phase.review;
      _publishError = wait ?? userFacingError(error);
      _publishErrorIsWait = wait != null;
    });
  }

  /// Leaves the sheet for one chapter of the Studio. From inside the Studio
  /// that replaces the Studio page rather than stacking a second one on it.
  void _openChapter(String chapterId) {
    final router = GoRouter.of(context);
    Navigator.of(context).pop(false);
    final target = studioLocation(widget.projectId, chapterId: chapterId);
    final here = router.routerDelegate.currentConfiguration.uri.path;
    if (here == studioLocation(widget.projectId)) {
      router.pushReplacement(target);
    } else {
      router.push(target);
    }
  }

  @override
  Widget build(BuildContext context) {
    final checklist = _checklist;
    final working = _phase == _Phase.publishing || _phase == _Phase.finishing;
    final first = checklist?.firstPublish ?? false;
    final title = checklist == null
        ? 'Getting your book ready'
        : first
        ? 'Publish your book'
        : 'Update your book';
    final subtitle = checklist == null
        ? null
        : first
        ? 'Your chapters become a book you can read, share and download.'
        : 'Your latest changes go into the book people read and download.';

    return PopScope(
      canPop: !working,
      child: AppSheetScaffold(
        title: title,
        subtitle: subtitle,
        icon: first || checklist == null
            ? Icons.menu_book_outlined
            : Icons.published_with_changes_outlined,
        onClose: working ? null : () => Navigator.of(context).pop(false),
        footer: _footer(context, checklist),
        children: [
          AppSwitcher(
            child: checklist != null
                ? _ChecklistBody(
                    key: const ValueKey('publish-checklist'),
                    projectId: widget.projectId,
                    checklist: checklist,
                    enabled: !working,
                    onOpenChapter: _openChapter,
                    onCoverChanged: (manuscript) =>
                        setState(() => _coverSource = manuscript.cover.source),
                    onCoverBusy: (busy) => setState(() => _coverBusy = busy),
                  )
                : _loadError != null
                ? _LoadFailure(
                    key: const ValueKey('publish-load-error'),
                    error: _loadError!,
                  )
                : const _ChecklistSkeleton(key: ValueKey('publish-loading')),
          ),
        ],
      ),
    );
  }

  Widget? _footer(BuildContext context, PublishChecklist? checklist) {
    if (checklist == null) {
      if (_loadError == null) return null;
      final wait = publishWaitMessage(_loadError!);
      return wait != null
          ? AppButton.outlined(
              label: 'Close',
              expanded: true,
              onPressed: () => Navigator.of(context).pop(false),
            )
          : AppButton.primary(
              label: 'Try again',
              leading: const Icon(Icons.refresh),
              expanded: true,
              onPressed: _load,
            );
    }
    final Widget child = switch (_phase) {
      _Phase.publishing || _Phase.finishing => Padding(
        key: const ValueKey('publish-progress'),
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        child: StudioWorkingProgress(
          semanticLabel: checklist.firstPublish
              ? 'Publishing your book'
              : 'Updating your book',
          done: _phase == _Phase.finishing,
          tau: const Duration(seconds: 6),
          stages: [
            'Setting your pages…',
            'Laying out your chapters…',
            if (checklist.firstPublish)
              _coverSource == ManuscriptCoverSource.design
                  ? 'Designing your cover…'
                  : 'Putting on your cover…',
            checklist.firstPublish
                ? 'Binding your book…'
                : 'Updating your book…',
          ],
        ),
      ),
      _Phase.changed => Column(
        key: const ValueKey('publish-changed'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const AppInlineNotice(
            tone: AppTone.warning,
            title: 'Your book changed',
            message:
                'Your book changed in the chat since you opened it. We\'ve '
                'refreshed your chapters — check them and publish again.',
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton.primary(
            label: 'Check my chapters',
            expanded: true,
            onPressed: () => Navigator.of(context).pop(false),
          ),
        ],
      ),
      _Phase.review => Column(
        key: const ValueKey('publish-review'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_publishError != null) ...[
            AppInlineNotice(
              tone: _publishErrorIsWait ? AppTone.neutral : AppTone.error,
              title: _publishErrorIsWait
                  ? 'Not just yet'
                  : checklist.firstPublish
                  ? 'Could not publish'
                  : 'Could not update your book',
              message: _publishError!,
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          AppButton.primary(
            key: const ValueKey('publish-button'),
            label: checklist.firstPublish ? 'Publish book' : 'Update book',
            leading: Icon(
              checklist.firstPublish
                  ? Icons.menu_book_outlined
                  : Icons.published_with_changes_outlined,
            ),
            expanded: true,
            onPressed: checklist.canPublish && !_coverBusy ? _publish : null,
          ),
          if (!checklist.canPublish) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Sort out what is marked above first.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    };
    return AnimatedSize(
      duration: AppMotion.adapt(context, AppMotion.medium),
      curve: AppMotion.enter,
      alignment: Alignment.topCenter,
      child: AppSwitcher(child: child),
    );
  }
}

/// The sentence for a publish the server refused because something else is
/// running on the book, or null when [error] is not that. Waiting is the whole
/// fix, so it is said as a wait rather than as a failure.
@visibleForTesting
String? publishWaitMessage(Object error) {
  if (error is! ApiException) return null;
  final code = error.code.toUpperCase();
  final message = error.message.toLowerCase();
  if (code.contains('AUDIOBOOK') || message.contains('audiobook')) {
    return ManuscriptPublishBlock.audiobook.message;
  }
  if (code == 'BOOK_NOT_READY' || code.contains('IMPORT')) {
    return ManuscriptPublishBlock.importing.message;
  }
  if (code == 'PROJECT_BUSY') return ManuscriptPublishBlock.busy.message;
  return null;
}

class _ChecklistBody extends StatelessWidget {
  const _ChecklistBody({
    required this.projectId,
    required this.checklist,
    required this.enabled,
    required this.onOpenChapter,
    required this.onCoverChanged,
    required this.onCoverBusy,
    super.key,
  });

  final String projectId;
  final PublishChecklist checklist;
  final bool enabled;
  final ValueChanged<String> onOpenChapter;
  final ValueChanged<Manuscript> onCoverChanged;
  final ValueChanged<bool> onCoverBusy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final blocking = [
      for (final item in checklist.items)
        if (item.blocking) item,
    ];
    final warnings = [
      for (final item in checklist.items)
        if (!item.blocking) item,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _PublishStats(checklist: checklist),
        // The first publish binds the book, so the cover is chosen here — or
        // left as the designed one, which is most people's whole decision.
        // After that the cover lives on the book's page.
        if (checklist.firstPublish) ...[
          const SizedBox(height: AppSpacing.md),
          IgnorePointer(
            ignoring: !enabled,
            child: StudioCoverPicker(
              key: const ValueKey('publish-cover'),
              projectId: projectId,
              collapsible: true,
              onChanged: onCoverChanged,
              onBusyChanged: onCoverBusy,
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        if (checklist.items.isEmpty)
          _QuietLine(
            icon: Icons.check_circle_outline,
            iconColor: colors.primary,
            text: 'Everything looks ready.',
          )
        else ...[
          Text(
            checklist.firstPublish ? 'Before you publish' : 'Before you update',
            style: theme.textTheme.labelLarge?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          for (final item in blocking) ...[
            AppInlineNotice(
              tone: AppTone.error,
              title: _blockingTitle(item.kind),
              message: item.message,
              actionLabel: item.chapterId == null ? null : 'Open chapter',
              onAction: item.chapterId == null || !enabled
                  ? null
                  : () => onOpenChapter(item.chapterId!),
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          if (warnings.isNotEmpty)
            _WarningList(
              items: warnings,
              onOpenChapter: enabled ? onOpenChapter : null,
            ),
        ],
      ],
    );
  }

  static String _blockingTitle(PublishChecklistKind kind) => switch (kind) {
    PublishChecklistKind.conflict => 'A chapter needs your decision',
    PublishChecklistKind.emptyBook => 'There is nothing to publish yet',
    PublishChecklistKind.contentRestricted => 'This can’t be published',
    _ => 'Fix this first',
  };
}

/// Words, pages, chapters: how much book this is, at a glance.
class _PublishStats extends StatelessWidget {
  const _PublishStats({required this.checklist});

  final PublishChecklist checklist;

  @override
  Widget build(BuildContext context) {
    final localizations = MaterialLocalizations.of(context);
    final changed = checklist.changedChapters;
    final stats = [
      (
        value: localizations.formatDecimal(checklist.words),
        label: checklist.words == 1 ? 'word' : 'words',
      ),
      (
        value: '~${localizations.formatDecimal(checklist.estimatedPages)}',
        label: checklist.estimatedPages == 1 ? 'page' : 'pages',
      ),
      (
        value: localizations.formatDecimal(changed),
        label: checklist.firstPublish
            ? (changed == 1 ? 'chapter' : 'chapters')
            : (changed == 1 ? 'chapter changed' : 'chapters changed'),
      ),
    ];
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < stats.length; i++) ...[
            if (i > 0) const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: _StatTile(value: stats[i].value, label: stats[i].label),
            ),
          ],
        ],
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      label: '$value $label',
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: AppSpacing.sm,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: AlignmentDirectional.centerStart,
                  child: Text(
                    value,
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                      height: 1.1,
                    ),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
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

class _QuietLine extends StatelessWidget {
  const _QuietLine({required this.icon, required this.text, this.iconColor});

  final IconData icon;
  final String text;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: Icon(
            icon,
            size: 20,
            color: iconColor ?? colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.onSurfaceVariant,
              height: 1.35,
            ),
          ),
        ),
      ],
    );
  }
}

/// Things worth a look that do not stop a publish: one quiet list, each row
/// opening the chapter it is about.
class _WarningList extends StatelessWidget {
  const _WarningList({required this.items, required this.onOpenChapter});

  final List<PublishChecklistItem> items;
  final ValueChanged<String>? onOpenChapter;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.control),
        child: Column(
          children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) Divider(height: 1, color: colors.outlineVariant),
              _WarningRow(
                item: items[i],
                onTap: items[i].chapterId == null || onOpenChapter == null
                    ? null
                    : () => onOpenChapter!(items[i].chapterId!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _WarningRow extends StatelessWidget {
  const _WarningRow({required this.item, required this.onTap});

  final PublishChecklistItem item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: onTap != null,
      label: onTap == null ? item.message : '${item.message} Open chapter.',
      child: ExcludeSemantics(
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.sm,
                AppSpacing.sm,
                AppSpacing.xs,
                AppSpacing.sm,
              ),
              child: Row(
                children: [
                  Icon(
                    _iconFor(item.kind),
                    size: 20,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      item.message,
                      style: theme.textTheme.bodyMedium?.copyWith(height: 1.3),
                    ),
                  ),
                  if (onTap != null) ...[
                    const SizedBox(width: AppSpacing.xs),
                    Icon(
                      Icons.chevron_right,
                      size: 20,
                      color: colors.onSurfaceVariant,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static IconData _iconFor(PublishChecklistKind kind) => switch (kind) {
    PublishChecklistKind.emptyChapter => Icons.article_outlined,
    PublishChecklistKind.untitledChapter => Icons.title,
    PublishChecklistKind.placeholder => Icons.pending_outlined,
    PublishChecklistKind.unclosedFence => Icons.code,
    _ => Icons.info_outline,
  };
}

class _ChecklistSkeleton extends StatelessWidget {
  const _ChecklistSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return const AppSkeletonGroup(
      label: 'Checking your book',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: AppSkeleton.box(height: 64, radius: 14)),
              SizedBox(width: AppSpacing.xs),
              Expanded(child: AppSkeleton.box(height: 64, radius: 14)),
              SizedBox(width: AppSpacing.xs),
              Expanded(child: AppSkeleton.box(height: 64, radius: 14)),
            ],
          ),
          SizedBox(height: AppSpacing.md),
          AppSkeleton.line(widthFactor: 0.9),
          SizedBox(height: AppSpacing.xs),
          AppSkeleton.line(widthFactor: 0.6),
          SizedBox(height: AppSpacing.lg),
          AppSkeleton.box(height: 52, radius: 14),
        ],
      ),
    );
  }
}

class _LoadFailure extends StatelessWidget {
  const _LoadFailure({required this.error, super.key});

  final Object error;

  @override
  Widget build(BuildContext context) {
    final wait = publishWaitMessage(error);
    return AppInlineNotice(
      tone: wait == null ? AppTone.error : AppTone.neutral,
      title: wait == null ? 'Could not check your book' : 'Not just yet',
      message: wait ?? userFacingError(error),
    );
  }
}
