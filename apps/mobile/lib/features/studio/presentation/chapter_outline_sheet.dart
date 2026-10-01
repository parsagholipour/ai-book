import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/manuscript_models.dart';
import '../domain/manuscript_word_count.dart';
import 'studio_cast_section.dart';
import 'studio_session.dart';
import 'studio_sheets.dart';

/// Shows a message with an optional action, the way the host surface can.
typedef StudioNotify =
    void Function(
      String message, {
      String? actionLabel,
      VoidCallback? onAction,
    });

/// The book's chapters as a sheet over the editor (phones). On a wide screen
/// the same [ChapterOutline] is a pane beside it instead.
Future<void> showChapterOutlineSheet(
  BuildContext context, {
  required StudioSession session,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (sheetContext) {
      final height = MediaQuery.sizeOf(sheetContext).height;
      return ConstrainedBox(
        constraints: BoxConstraints(maxHeight: height * 0.86),
        child: ChapterOutline(
          session: session,
          shrinkWrap: true,
          onChapterOpened: () => Navigator.of(sheetContext).maybePop(),
        ),
      );
    },
  );
}

/// The outline: the book's word count and goal, every chapter (tap to open,
/// drag to reorder, a menu to rename, set the status or delete), and a way to
/// add one.
///
/// A deletion offers Undo. Over a modal sheet a snack bar would land on the
/// page beneath the barrier, so without a [notify] the outline shows the undo
/// in a bar of its own at its foot; the two-pane layout passes the screen's
/// snack bar.
class ChapterOutline extends StatefulWidget {
  const ChapterOutline({
    required this.session,
    this.onChapterOpened,
    this.notify,
    this.shrinkWrap = false,
    super.key,
  });

  final StudioSession session;

  /// Called after a chapter was opened from here (the sheet closes).
  final VoidCallback? onChapterOpened;
  final StudioNotify? notify;
  final bool shrinkWrap;

  @override
  State<ChapterOutline> createState() => _ChapterOutlineState();
}

class _ChapterOutlineState extends State<ChapterOutline> {
  ({String message, String? actionLabel, VoidCallback? onAction})? _inline;
  Timer? _inlineTimer;

  StudioSession get _session => widget.session;

  @override
  void dispose() {
    _inlineTimer?.cancel();
    super.dispose();
  }

  void _notify(String message, {String? actionLabel, VoidCallback? onAction}) {
    final notify = widget.notify;
    if (notify != null) {
      notify(message, actionLabel: actionLabel, onAction: onAction);
      return;
    }
    _inlineTimer?.cancel();
    setState(
      () => _inline = (
        message: message,
        actionLabel: actionLabel,
        onAction: onAction,
      ),
    );
    _inlineTimer = Timer(const Duration(seconds: 6), () {
      if (mounted) setState(() => _inline = null);
    });
  }

  Future<void> _open(ManuscriptChapterSummary chapter) async {
    if (chapter.id != _session.chapterId) {
      unawaited(_session.switchChapter(chapter.id));
    }
    widget.onChapterOpened?.call();
  }

  /// At the end of the book from the button under the list; after [after]
  /// from a chapter's menu. Either way the sheet closes on the new chapter,
  /// or on the message saying why there is none.
  Future<void> _add({String? after}) async {
    await _session.addChapter(afterChapterId: after);
    if (!mounted) return;
    widget.onChapterOpened?.call();
  }

  Future<void> _rowMenu(ManuscriptChapterSummary chapter) async {
    final action = await showAppActionSheet<String>(
      context,
      title: chapter.displayTitle,
      builder: (sheetContext) {
        final colors = Theme.of(sheetContext).colorScheme;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.drive_file_rename_outline),
              title: const Text('Rename'),
              onTap: () => Navigator.of(sheetContext).pop('rename'),
            ),
            ListTile(
              leading: Icon(chapterStatusIcon(chapter.status)),
              title: const Text('Status'),
              trailing: Text(chapter.status.label),
              onTap: () => Navigator.of(sheetContext).pop('status'),
            ),
            ListTile(
              key: const ValueKey('outline-add-after'),
              leading: const Icon(Icons.playlist_add_rounded),
              title: Text('Add a ${_session.chapterNoun} after this one'),
              onTap: () => Navigator.of(sheetContext).pop('addAfter'),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colors.error),
              title: Text(
                'Delete chapter',
                style: TextStyle(color: colors.error),
              ),
              onTap: () => Navigator.of(sheetContext).pop('delete'),
            ),
          ],
        );
      },
    );
    if (!mounted || action == null) return;
    switch (action) {
      case 'rename':
        final title = await showRenameChapterSheet(
          context,
          title: chapter.id == _session.chapterId
              ? _session.document?.title.text ?? chapter.title
              : chapter.title,
        );
        if (title != null) await _session.renameChapter(chapter.id, title);
      case 'status':
        final status = await showChapterStatusSheet(
          context,
          current: chapter.id == _session.chapterId
              ? _session.status
              : chapter.status,
        );
        if (status != null) {
          await _session.setChapterStatus(chapter.id, status);
        }
      case 'addAfter':
        await _add(after: chapter.id);
      case 'delete':
        final refusal = await _session.deleteChapter(chapter.id);
        if (!mounted) return;
        if (refusal != null) {
          _notify(refusal);
          return;
        }
        _notify(
          '“${chapter.displayTitle}” deleted',
          actionLabel: 'Undo',
          onAction: () => _session.restoreChapter(chapter.id),
        );
    }
  }

  /// [newIndex] is where the chapter lands once it has been taken out.
  void _reorder(int oldIndex, int newIndex) {
    final chapters = [...?_session.manuscript?.chapters];
    if (oldIndex < 0 || oldIndex >= chapters.length) return;
    final target = newIndex.clamp(0, chapters.length - 1);
    if (target == oldIndex) return;
    final moved = chapters.removeAt(oldIndex);
    chapters.insert(target, moved);
    unawaited(
      _session.reorderChapters([for (final chapter in chapters) chapter.id]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _session,
      builder: (context, _) {
        final manuscript = _session.manuscript;
        final chapters = manuscript?.chapters ?? const [];
        final list = ReorderableListView.builder(
          shrinkWrap: widget.shrinkWrap,
          buildDefaultDragHandles: false,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
          itemCount: chapters.length,
          onReorderItem: _reorder,
          proxyDecorator: (child, index, animation) => Material(
            elevation: 6,
            borderRadius: BorderRadius.circular(AppRadii.control),
            color: Theme.of(context).colorScheme.surfaceContainerLowest,
            child: child,
          ),
          itemBuilder: (context, index) {
            final chapter = chapters[index];
            return _ChapterRow(
              key: ValueKey('outline-${chapter.id}'),
              index: index,
              chapter: chapter,
              session: _session,
              current: chapter.id == _session.chapterId,
              onOpen: () => _open(chapter),
              onMenu: () => _rowMenu(chapter),
            );
          },
        );
        final inline = _inline;
        return Column(
          mainAxisSize: widget.shrinkWrap ? MainAxisSize.min : MainAxisSize.max,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _OutlineHeader(session: _session),
            StudioCastSection(session: _session, notify: _notify),
            const _ChaptersLabel(),
            if (widget.shrinkWrap)
              Flexible(child: list)
            else
              Expanded(child: list),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md,
                AppSpacing.xs,
                AppSpacing.md,
                AppSpacing.md,
              ),
              child: AppButton.tonal(
                key: const ValueKey('outline-new-chapter'),
                label: _session.addChapterLabel,
                loading: _session.addingChapter,
                expanded: true,
                leading: const Icon(Icons.add_rounded),
                onPressed: _add,
              ),
            ),
            AnimatedSize(
              duration: AppMotion.adapt(context, AppMotion.fast),
              child: inline == null
                  ? const SizedBox(width: double.infinity)
                  : _InlineUndoBar(
                      message: inline.message,
                      actionLabel: inline.actionLabel,
                      onAction: () {
                        setState(() => _inline = null);
                        inline.onAction?.call();
                      },
                    ),
            ),
          ],
        );
      },
    );
  }
}

class _OutlineHeader extends StatelessWidget {
  const _OutlineHeader({required this.session});

  final StudioSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final manuscript = session.manuscript;
    final goal = manuscript?.goalWords;
    final count = manuscript?.chapters.length ?? 0;
    return ValueListenableBuilder<int>(
      valueListenable: session.chapterWords,
      builder: (context, _, _) {
        final words = session.bookWords;
        final subtitle = goal != null && goal > 0
            ? '${formatStudioCount(words)} of ${formatStudioWords(goal)}'
            : '${formatStudioWords(words)} · '
                  '$count ${count == 1 ? 'chapter' : 'chapters'}';
        return Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpacing.lg - AppSpacing.xxs,
            AppSpacing.xs,
            AppSpacing.md,
            AppSpacing.sm,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        manuscript?.title.trim().isNotEmpty ?? false
                            ? manuscript!.title.trim()
                            : 'Chapters',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      key: const ValueKey('outline-words'),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              if (goal != null && goal > 0)
                StudioGoalRing(progress: (words / goal).clamp(0, 1).toDouble()),
            ],
          ),
        );
      },
    );
  }
}

/// Names the list under the cast, so the two read as two sections.
class _ChaptersLabel extends StatelessWidget {
  const _ChaptersLabel();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.lg - AppSpacing.xxs,
        AppSpacing.xs,
        AppSpacing.md,
        AppSpacing.xxs,
      ),
      child: Semantics(
        header: true,
        child: Text(
          'Chapters',
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

/// Progress toward the book's word goal, as a ring with the percentage in it.
class StudioGoalRing extends StatelessWidget {
  const StudioGoalRing({required this.progress, this.size = 48, super.key});

  final double progress;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final percent = (progress * 100).round();
    return Semantics(
      label: '$percent percent of your word goal',
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: size,
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: progress),
            duration: AppMotion.adapt(context, AppMotion.slow),
            curve: AppMotion.enter,
            builder: (context, value, _) => CustomPaint(
              painter: _RingPainter(
                progress: value,
                track: colors.primaryContainer,
                fill: colors.primary,
              ),
              child: Center(
                child: Text(
                  '$percent%',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: colors.onSurface,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({
    required this.progress,
    required this.track,
    required this.fill,
  });

  final double progress;
  final Color track;
  final Color fill;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 4.5;
    final rect = (Offset.zero & size).deflate(stroke / 2);
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(rect, 0, math.pi * 2, false, paint..color = track);
    if (progress > 0) {
      canvas.drawArc(
        rect,
        -math.pi / 2,
        math.pi * 2 * progress,
        false,
        paint..color = fill,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.track != track ||
      oldDelegate.fill != fill;
}

class _ChapterRow extends StatelessWidget {
  const _ChapterRow({
    required this.index,
    required this.chapter,
    required this.session,
    required this.current,
    required this.onOpen,
    required this.onMenu,
    super.key,
  });

  final int index;
  final ManuscriptChapterSummary chapter;
  final StudioSession session;
  final bool current;
  final VoidCallback onOpen;
  final VoidCallback onMenu;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final radius = BorderRadius.circular(AppRadii.control);
    final title = current
        ? ValueListenableBuilder<TextEditingValue>(
            valueListenable: session.document!.title,
            builder: (context, value, _) => _titleText(
              context,
              value.text.trim().isEmpty
                  ? 'Untitled chapter'
                  : value.text.trim(),
            ),
          )
        : _titleText(context, chapter.displayTitle);
    final words = current
        ? ValueListenableBuilder<int>(
            valueListenable: session.chapterWords,
            builder: (context, words, _) => _wordsText(context, words),
          )
        : _wordsText(context, chapter.wordCount);
    final status = current ? session.status : chapter.status;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color: current
            ? colors.primaryContainer.withValues(alpha: 0.45)
            : Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          onTap: onOpen,
          child: Padding(
            padding: const EdgeInsetsDirectional.only(
              top: AppSpacing.xs,
              bottom: AppSpacing.xs,
            ),
            child: Row(
              children: [
                ReorderableDragStartListener(
                  index: index,
                  child: SizedBox(
                    width: 40,
                    height: 44,
                    child: Tooltip(
                      message: 'Drag to reorder',
                      child: Icon(
                        Icons.drag_indicator_rounded,
                        color: colors.onSurfaceVariant.withValues(alpha: 0.7),
                      ),
                    ),
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(child: title),
                          if (chapter.hasConflict) ...[
                            const SizedBox(width: 6),
                            Tooltip(
                              message: 'Changed in the book chat',
                              child: Icon(
                                Icons.call_split_rounded,
                                size: 16,
                                color: colors.error,
                              ),
                            ),
                          ],
                          if (chapter.hasUnpublishedChanges &&
                              (session.manuscript?.published ?? false)) ...[
                            const SizedBox(width: 6),
                            Tooltip(
                              message: 'Not in your book yet',
                              child: Container(
                                key: ValueKey(
                                  'outline-unpublished-${chapter.id}',
                                ),
                                width: 7,
                                height: 7,
                                decoration: BoxDecoration(
                                  color: colors.primary,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          _StatusChip(status: status),
                          const SizedBox(width: AppSpacing.xs),
                          // The pane is narrow beside the editor; the count
                          // gives way before the chip does.
                          Flexible(child: words),
                        ],
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Chapter options',
                  icon: const Icon(Icons.more_vert, size: 20),
                  onPressed: onMenu,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _titleText(BuildContext context, String text) {
    final theme = Theme.of(context);
    return Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: theme.textTheme.titleSmall?.copyWith(
        fontWeight: current ? FontWeight.w800 : FontWeight.w600,
      ),
    );
  }

  Widget _wordsText(BuildContext context, int words) {
    final theme = Theme.of(context);
    return Text(
      formatStudioWords(words),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: theme.textTheme.labelMedium?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final ManuscriptChapterStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // Teal steps from quiet to settled; none of them is the button fill.
    final (background, foreground) = switch (status) {
      ManuscriptChapterStatus.idea => (
        colors.surfaceContainerHigh,
        colors.onSurfaceVariant,
      ),
      ManuscriptChapterStatus.drafting => (
        colors.surfaceContainerHighest,
        colors.onSurface,
      ),
      ManuscriptChapterStatus.revised => (
        colors.secondaryContainer,
        colors.onSecondaryContainer,
      ),
      ManuscriptChapterStatus.finalDraft => (
        colors.primaryContainer,
        colors.onPrimaryContainer,
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(chapterStatusIcon(status), size: 12, color: foreground),
            const SizedBox(width: 4),
            Text(
              status.label,
              style: theme.textTheme.labelSmall?.copyWith(
                color: foreground,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InlineUndoBar extends StatelessWidget {
  const _InlineUndoBar({
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final String message;
  final String? actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.md,
      ),
      child: Semantics(
        liveRegion: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.inverseSurface,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(
              AppSpacing.md,
              AppSpacing.xxs,
              AppSpacing.xxs,
              AppSpacing.xxs,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    message,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onInverseSurface,
                    ),
                  ),
                ),
                if (actionLabel != null)
                  TextButton(
                    onPressed: onAction,
                    style: TextButton.styleFrom(
                      foregroundColor: colors.inversePrimary,
                    ),
                    child: Text(actionLabel!),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
