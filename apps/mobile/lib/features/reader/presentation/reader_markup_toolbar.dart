import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../domain/reader_settings.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_painter.dart';

/// The tool tray, shown only while the reader is marking up.
///
/// It takes the bottom of the screen rather than floating over the page,
/// because a tool tray that covers the text is a tool tray you have to move
/// before you can use it. Nothing here exists while reading: the whole point of
/// the overflow menu is that the page is otherwise clear.
class ReaderMarkupToolbar extends StatelessWidget {
  const ReaderMarkupToolbar({
    required this.tool,
    required this.settings,
    required this.palette,
    required this.canUndo,
    required this.onToolChanged,
    required this.onColorChanged,
    required this.onWidthChanged,
    required this.onUndo,
    required this.onDone,
    this.pendingMoveLabel,
    super.key,
  });

  final ReaderTool tool;
  final ReaderSettings settings;
  final List<ReaderMarkupColor> palette;
  final bool canUndo;
  final void Function(ReaderTool tool) onToolChanged;
  final void Function(int colorIndex) onColorChanged;
  final void Function(double width) onWidthChanged;
  final VoidCallback onUndo;
  final VoidCallback onDone;

  /// Set while something placed is waiting to be put somewhere else, which
  /// replaces the tool's usual instruction.
  final String? pendingMoveLabel;

  int get _activeColorIndex =>
      tool == ReaderTool.pen || tool == ReaderTool.text
      ? settings.inkColorIndex
      : settings.markupColorIndex;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerHigh,
      elevation: 3,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _hint(context),
            _tools(context),
            if (tool != ReaderTool.eraser) _colors(context),
            if (tool == ReaderTool.pen) _width(context),
          ],
        ),
      ),
    );
  }

  Widget _hint(BuildContext context) {
    final theme = Theme.of(context);
    final text = pendingMoveLabel ?? _instruction;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
      child: Row(
        children: [
          Icon(
            pendingMoveLabel != null
                ? Icons.open_with
                : Icons.info_outline,
            size: 15,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String get _instruction => switch (tool) {
    ReaderTool.none => 'Pick a tool, or select text to highlight it.',
    ReaderTool.pen => 'Draw with one finger. Two fingers still move the page.',
    ReaderTool.eraser => 'Drag across a stroke to rub it out.',
    ReaderTool.note => 'Tap the page to pin a note there.',
    ReaderTool.text => 'Tap the page to write on it.',
  };

  Widget _tools(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 4),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _toolButton(context, ReaderTool.pen, Icons.edit_outlined, 'Pen'),
                  _toolButton(
                    context,
                    ReaderTool.eraser,
                    Icons.auto_fix_normal_outlined,
                    'Eraser',
                  ),
                  _toolButton(
                    context,
                    ReaderTool.note,
                    Icons.sticky_note_2_outlined,
                    'Note',
                  ),
                  _toolButton(
                    context,
                    ReaderTool.text,
                    Icons.title,
                    'Text',
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.undo),
            tooltip: 'Undo',
            onPressed: canUndo
                ? () {
                    AppHaptics.tap();
                    onUndo();
                  }
                : null,
          ),
          TextButton(
            onPressed: () {
              AppHaptics.tap();
              onDone();
            },
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Widget _toolButton(
    BuildContext context,
    ReaderTool value,
    IconData icon,
    String label,
  ) {
    final selected = tool == value;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: ChoiceChip(
        selected: selected,
        avatar: Icon(icon, size: 18),
        label: Text(label),
        onSelected: (_) {
          AppHaptics.selection();
          // Tapping the active tool puts it away, so getting back to plain
          // reading never needs the Done button to be found first.
          onToolChanged(selected ? ReaderTool.none : value);
        },
      ),
    );
  }

  Widget _colors(BuildContext context) {
    final active = _activeColorIndex;
    return SizedBox(
      height: 48,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: palette.length,
        itemBuilder: (context, index) {
          final entry = palette[index];
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            child: Semantics(
              button: true,
              selected: index == active,
              label: entry.name,
              child: Tooltip(
                message: entry.name,
                child: InkResponse(
                  radius: 24,
                  onTap: () {
                    AppHaptics.selection();
                    onColorChanged(index);
                  },
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: entry.color,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: index == active
                            ? Theme.of(context).colorScheme.onSurface
                            : Theme.of(
                                context,
                              ).colorScheme.outlineVariant.withValues(
                                alpha: 0.7,
                              ),
                        width: index == active ? 2.5 : 1,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _width(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Row(
        children: [
          const Icon(Icons.line_weight, size: 18),
          Expanded(
            child: Slider(
              value: settings.inkWidth.clamp(
                ReaderSettings.minInkWidth,
                ReaderSettings.maxInkWidth,
              ),
              min: ReaderSettings.minInkWidth,
              max: ReaderSettings.maxInkWidth,
              label: 'Pen thickness',
              onChanged: onWidthChanged,
            ),
          ),
        ],
      ),
    );
  }
}
