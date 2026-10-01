import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/manuscript_formatting.dart';
import '../domain/manuscript_inline.dart' show EmphasisKind;
import '../domain/manuscript_word_count.dart';
import 'studio_document.dart';
import 'studio_session.dart';

/// The formatting bar that rides on top of the keyboard while a text segment
/// has focus. Every button edits the focused segment's text through the pure
/// functions in `manuscript_formatting.dart`, so what it writes is ordinary
/// markdown and every change lands in that segment's undo history. Bold and
/// Italic go through the segment's controller instead: their marks are not
/// drawn, so it knows which text is bold, and it holds the typing style for
/// the case of nothing selected.
///
/// It sits in the text fields' tap region: a tap on it is not a tap outside
/// the field, so the field keeps focus (and the keyboard stays up) on
/// platforms that unfocus on an outside tap.
class StudioToolbar extends StatelessWidget {
  const StudioToolbar({
    required this.entry,
    required this.onPicture,
    this.onAi,
    super.key,
  });

  final StudioTextEntry entry;

  /// Insert a picture at [offset] in [entry].
  final void Function(StudioTextEntry entry, int offset) onPicture;

  /// The writing assistant, for the selection or the cursor in [entry].
  final void Function(StudioTextEntry entry)? onAi;

  void _apply(TextEditingValue Function(TextEditingValue) edit) {
    entry.controller.value = edit(entry.controller.value);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return TextFieldTapRegion(
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: SizedBox(
          height: 52,
          child: Row(
            children: [
              // Formatting scrolls if it must: on a phone the scene break sits
              // just past the edge, behind the pinned tools.
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.xxs,
                  ),
                  child: ValueListenableBuilder<UndoHistoryValue>(
                    valueListenable: entry.undo,
                    builder: (context, undo, _) => Row(
                      children: [
                        _ToolButton(
                          tooltip: 'Undo',
                          icon: Icons.undo_rounded,
                          onPressed: undo.canUndo ? entry.undo.undo : null,
                        ),
                        _ToolButton(
                          tooltip: 'Redo',
                          icon: Icons.redo_rounded,
                          onPressed: undo.canRedo ? entry.undo.redo : null,
                        ),
                        const _ToolDivider(),
                        // Lit while the cursor is in bold (or italic) text, and
                        // after the button is pressed with nothing selected:
                        // the marks are not drawn, so this is the one sign.
                        ListenableBuilder(
                          listenable: entry.controller,
                          builder: (context, _) => Row(
                            children: [
                              _ToolButton(
                                tooltip: 'Bold',
                                icon: Icons.format_bold_rounded,
                                selected: entry.controller.isStyleOn(
                                  EmphasisKind.bold,
                                ),
                                onPressed: () => entry.controller.toggleStyle(
                                  EmphasisKind.bold,
                                ),
                              ),
                              _ToolButton(
                                tooltip: 'Italic',
                                icon: Icons.format_italic_rounded,
                                selected: entry.controller.isStyleOn(
                                  EmphasisKind.italic,
                                ),
                                onPressed: () => entry.controller.toggleStyle(
                                  EmphasisKind.italic,
                                ),
                              ),
                            ],
                          ),
                        ),
                        _ToolButton(
                          tooltip: 'Heading',
                          icon: Icons.title_rounded,
                          onPressed: () => _apply(cycleHeading),
                        ),
                        _ToolButton(
                          tooltip: 'Quote',
                          icon: Icons.format_quote_rounded,
                          onPressed: () => _apply(toggleQuote),
                        ),
                        _ToolButton(
                          tooltip: 'List',
                          icon: Icons.format_list_bulleted_rounded,
                          onPressed: () => _apply(toggleList),
                        ),
                        _ToolButton(
                          tooltip: 'Scene break',
                          icon: Icons.horizontal_rule_rounded,
                          onPressed: () => _apply(insertSceneBreak),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              // The picture and the writing assistant are the tools that are
              // not formatting, and the ones people look for: they never
              // scroll away.
              const _ToolDivider(),
              if (onAi != null)
                _ToolButton(
                  key: const ValueKey('studio-toolbar-ai'),
                  tooltip: 'Writing assistant',
                  icon: Icons.auto_awesome_outlined,
                  color: colors.primary,
                  onPressed: () => onAi!(entry),
                ),
              Padding(
                padding: const EdgeInsetsDirectional.only(end: AppSpacing.xxs),
                child: _ToolButton(
                  tooltip: 'Picture',
                  icon: Icons.add_photo_alternate_outlined,
                  color: colors.primary,
                  onPressed: () {
                    final selection = entry.controller.selection;
                    final offset = selection.isValid
                        ? selection.end
                        : entry.controller.text.length;
                    onPicture(entry, offset);
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.color,
    this.selected = false,
    super.key,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final Color? color;

  /// Lit: the formatting it applies is on where the cursor is.
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    // Never takes focus: the text field it edits keeps it.
    return ExcludeFocus(
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        isSelected: selected,
        icon: Icon(icon, size: 22),
        color: selected ? colors.primary : color ?? colors.onSurface,
        disabledColor: colors.onSurface.withValues(alpha: 0.28),
        // 40 by 44, like a keyboard's own accessory bar: eight tools and the
        // two pinned ones nearly fit a 390dp phone without scrolling.
        style: IconButton.styleFrom(
          backgroundColor: selected
              ? colors.primary.withValues(alpha: 0.12)
              : null,
          minimumSize: const Size(40, 44),
          fixedSize: const Size(40, 44),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.compact),
          ),
        ),
      ),
    );
  }
}

class _ToolDivider extends StatelessWidget {
  const _ToolDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: SizedBox(
        height: 22,
        child: VerticalDivider(
          width: 1,
          color: Theme.of(context).colorScheme.outlineVariant,
        ),
      ),
    );
  }
}

/// The slim line under the page while the keyboard is down:
/// "1,248 words · +312 this session · Chapter 3 of 12".
class StudioStatusLine extends StatelessWidget {
  const StudioStatusLine({required this.session, super.key});

  final StudioSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return ValueListenableBuilder<int>(
      valueListenable: session.chapterWords,
      builder: (context, words, _) {
        final delta = session.sessionWordDelta;
        final parts = [
          formatStudioWords(words),
          if (delta != 0)
            '${delta > 0 ? '+' : ''}${formatStudioCount(delta)} this session',
          if (session.manuscript?.isPictureBook ?? false)
            session.chapterCount == 1
                ? 'Picture book'
                : 'Part ${session.chapterPosition} of ${session.chapterCount}'
          else
            'Chapter ${session.chapterPosition} of ${session.chapterCount}',
        ];
        return DecoratedBox(
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(
                color: colors.outlineVariant.withValues(alpha: 0.6),
              ),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: 10,
            ),
            child: Text(
              parts.join('  ·  '),
              key: const ValueKey('studio-status-line'),
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        );
      },
    );
  }
}
