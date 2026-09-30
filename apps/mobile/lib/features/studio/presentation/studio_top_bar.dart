import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../notes/presentation/notes_location.dart';
import 'studio_ai_controller.dart';
import 'studio_ai_inbox.dart';
import 'studio_session.dart';
import 'studio_sheets.dart';

/// The overflow menu's entries.
///
/// Grouped by what they act on — the book, the open chapter, then the tools —
/// so "Notes" (the book's own notebook) and "Chapter notes" (what this chapter
/// has to do, which the AI drafts from) never sit side by side as twins.
enum StudioMenuAction {
  chapters,
  bookNotes,
  settings,
  notes,
  status,
  versions,
  aiTools,
  illustrateAll,
  focus,
}

/// The Studio's bar: back, the chapter (tap for the outline) with its save
/// state beneath it, the book's notes, the AI inbox when something is in it,
/// Publish / Update book, and the overflow menu.
class StudioTopBar extends StatelessWidget implements PreferredSizeWidget {
  const StudioTopBar({
    required this.session,
    required this.onBack,
    required this.onPublish,
    required this.onMenu,
    this.onOpenOutline,
    this.onOpenNotes,
    this.ai,
    this.onOpenInbox,
    super.key,
  });

  final StudioSession session;
  final VoidCallback onBack;
  final VoidCallback onPublish;
  final ValueChanged<StudioMenuAction> onMenu;

  /// The writing assistant's background work, for the inbox button.
  final StudioAiController? ai;
  final VoidCallback? onOpenInbox;

  /// Null in the two-pane layout, where the outline is always shown.
  final VoidCallback? onOpenOutline;

  /// The book's notes. Null hides the button and the menu entry.
  final VoidCallback? onOpenNotes;

  /// Below this width the bar keeps its room for the chapter's name, and the
  /// notes live in the menu only.
  static const double notesButtonMinWidth = 360;

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context) {
    final publishLabel = session.publishLabel;
    final notesButton =
        onOpenNotes != null &&
        MediaQuery.sizeOf(context).width >= notesButtonMinWidth;
    return AppBar(
      toolbarHeight: 64,
      leading: IconButton(
        tooltip: MaterialLocalizations.of(context).backButtonTooltip,
        icon: const BackButtonIcon(),
        onPressed: onBack,
      ),
      titleSpacing: 0,
      title: _ChapterTitle(session: session, onTap: onOpenOutline),
      actions: [
        if (notesButton)
          IconButton(
            key: const ValueKey('studio-notes'),
            tooltip: 'Notes',
            icon: const Icon(bookNotesIcon),
            onPressed: onOpenNotes,
          ),
        if (ai != null && onOpenInbox != null)
          StudioAiInboxButton(controller: ai!, onPressed: onOpenInbox!),
        if (publishLabel != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: AppSpacing.xs),
            child: FilledButton(
              key: const ValueKey('studio-publish'),
              onPressed: onPublish,
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 38),
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              child: Text(publishLabel),
            ),
          ),
        PopupMenuButton<StudioMenuAction>(
          key: const ValueKey('studio-more'),
          tooltip: 'More options',
          icon: const Icon(Icons.more_vert),
          onSelected: onMenu,
          itemBuilder: (context) => [
            const _MenuHeading('Book'),
            if (onOpenOutline != null)
              const PopupMenuItem(
                value: StudioMenuAction.chapters,
                child: _MenuRow(icon: Icons.toc_rounded, label: 'Chapters'),
              ),
            if (onOpenNotes != null)
              const PopupMenuItem(
                value: StudioMenuAction.bookNotes,
                child: _MenuRow(icon: bookNotesIcon, label: 'Notes'),
              ),
            const PopupMenuItem(
              value: StudioMenuAction.settings,
              child: _MenuRow(icon: Icons.tune_rounded, label: 'Book settings'),
            ),
            const PopupMenuDivider(),
            const _MenuHeading('This chapter'),
            const PopupMenuItem(
              value: StudioMenuAction.notes,
              child: _MenuRow(
                icon: Icons.notes_rounded,
                label: 'Chapter notes',
              ),
            ),
            PopupMenuItem(
              value: StudioMenuAction.status,
              child: _MenuRow(
                icon: chapterStatusIcon(session.status),
                label: 'Status',
                trailing: session.status.label,
              ),
            ),
            const PopupMenuItem(
              value: StudioMenuAction.versions,
              child: _MenuRow(
                icon: Icons.history_rounded,
                label: 'Version history',
              ),
            ),
            const PopupMenuDivider(),
            const PopupMenuItem(
              value: StudioMenuAction.aiTools,
              child: _MenuRow(
                icon: Icons.auto_awesome_outlined,
                label: 'AI tools',
              ),
            ),
            if (session.manuscript?.isPictureBook ?? false)
              const PopupMenuItem(
                value: StudioMenuAction.illustrateAll,
                child: _MenuRow(
                  icon: Icons.collections_outlined,
                  label: 'Illustrate every page',
                ),
              ),
            const PopupMenuItem(
              value: StudioMenuAction.focus,
              child: _MenuRow(
                icon: Icons.center_focus_strong_outlined,
                label: 'Focus mode',
              ),
            ),
          ],
        ),
        const SizedBox(width: AppSpacing.xxs),
      ],
    );
  }
}

class _ChapterTitle extends StatelessWidget {
  const _ChapterTitle({required this.session, required this.onTap});

  final StudioSession session;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final title = session.document?.title;
    final titleText = title == null
        ? const SizedBox.shrink()
        : ValueListenableBuilder<TextEditingValue>(
            valueListenable: title,
            builder: (context, value, _) {
              final text = value.text.trim().isEmpty
                  ? 'Untitled chapter'
                  : value.text.trim();
              return Text(
                text,
                key: const ValueKey('studio-bar-title'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.2,
                ),
              );
            },
          );
    final column = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(child: titleText),
            if (onTap != null)
              Icon(
                Icons.expand_more_rounded,
                size: 20,
                color: colors.onSurfaceVariant,
              ),
          ],
        ),
        const SizedBox(height: 1),
        StudioSaveIndicator(session: session),
      ],
    );
    if (onTap == null) return column;
    return Semantics(
      button: true,
      label: 'Chapters',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.compact),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.xxs,
            vertical: AppSpacing.xxs,
          ),
          child: column,
        ),
      ),
    );
  }
}

/// Saved · Saving… · Saved on this device · Retrying…, with an icon so the
/// state never rides on the words alone. A conflict is tappable: it reopens
/// the choice.
class StudioSaveIndicator extends StatelessWidget {
  const StudioSaveIndicator({required this.session, super.key});

  final StudioSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final state = session.saveState;
    final (icon, color) = switch (state) {
      StudioSaveState.saved => (
        Icons.cloud_done_outlined,
        colors.onSurfaceVariant,
      ),
      StudioSaveState.saving => (
        Icons.cloud_upload_outlined,
        colors.onSurfaceVariant,
      ),
      StudioSaveState.savedOnDevice => (
        Icons.smartphone_rounded,
        colors.onSurfaceVariant,
      ),
      StudioSaveState.retrying => (Icons.sync_rounded, colors.onSurfaceVariant),
      StudioSaveState.conflict => (Icons.call_split_rounded, colors.error),
    };
    final indicator = Semantics(
      liveRegion: true,
      label: state.label,
      child: ExcludeSemantics(
        child: AnimatedSwitcher(
          duration: AppMotion.adapt(context, AppMotion.fast),
          child: Row(
            key: ValueKey(state),
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  state.label,
                  key: const ValueKey('studio-save-state'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: color,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (state != StudioSaveState.conflict) return indicator;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: session.reopenConflict,
      child: indicator,
    );
  }
}

/// A group's quiet label: not selectable, read as a heading by screen readers.
class _MenuHeading extends PopupMenuEntry<StudioMenuAction> {
  const _MenuHeading(this.label);

  final String label;

  @override
  double get height => 32;

  @override
  bool represents(StudioMenuAction? value) => false;

  @override
  State<_MenuHeading> createState() => _MenuHeadingState();
}

class _MenuHeadingState extends State<_MenuHeading> {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      header: true,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(
          AppSpacing.md,
          AppSpacing.xs,
          AppSpacing.md,
          AppSpacing.xxs,
        ),
        child: Text(
          widget.label.toUpperCase(),
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.8,
          ),
        ),
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, this.trailing});

  final IconData icon;
  final String label;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 20, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text(label)),
        if (trailing != null) ...[
          const SizedBox(width: AppSpacing.sm),
          Text(
            trailing!,
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }
}
