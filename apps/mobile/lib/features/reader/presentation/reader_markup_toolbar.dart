import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/reader_settings.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_painter.dart';

/// The tool tray, shown only while the reader is marking up.
///
/// It takes the bottom of the screen rather than floating over the page,
/// because a tool tray that covers the text is a tool tray you have to move
/// before you can use it. Nothing here exists while reading: the whole point of
/// the overflow menu is that the page is otherwise clear.
///
/// Read top to bottom it answers, in order: what am I doing (the line of
/// instruction, with undo and the way out beside it), with what (the four tools,
/// side by side, the active one filled), and in which colour (named, because a
/// swatch you cannot tell apart from its neighbour by anything but its hue is a
/// guess).
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

  int get _activeColorIndex => tool == ReaderTool.pen || tool == ReaderTool.text
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
            _header(context),
            _tools(context),
            if (tool != ReaderTool.eraser) _colors(context),
            if (tool == ReaderTool.pen) _width(context),
            const SizedBox(height: AppSpacing.xxs),
          ],
        ),
      ),
    );
  }

  /// The instruction for the tool in hand, with undo and the way out.
  Widget _header(BuildContext context) {
    final theme = Theme.of(context);
    final text = pendingMoveLabel ?? _instruction;
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.md,
        AppSpacing.xxs,
        AppSpacing.xxs,
        0,
      ),
      child: Row(
        children: [
          Icon(
            pendingMoveLabel != null ? Icons.open_with : Icons.info_outline,
            size: 15,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: AppSpacing.xs),
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
            style: TextButton.styleFrom(
              minimumSize: const Size(64, AppSizes.minimumTouchTarget),
            ),
            child: const Text('Done'),
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

  /// What the colour row is choosing the colour *of*.
  String get _colorFor => switch (tool) {
    ReaderTool.none => 'Highlighter',
    ReaderTool.pen => 'Pen colour',
    ReaderTool.eraser => '',
    ReaderTool.note => 'Note colour',
    ReaderTool.text => 'Text colour',
  };

  Widget _tools(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
      child: Row(
        children: [
          _toolButton(context, ReaderTool.pen, Icons.edit_outlined, 'Pen'),
          _toolButton(
            context,
            ReaderTool.eraser,
            Icons.cleaning_services_outlined,
            'Eraser',
          ),
          _toolButton(
            context,
            ReaderTool.note,
            Icons.sticky_note_2_outlined,
            'Note',
          ),
          _toolButton(context, ReaderTool.text, Icons.text_fields, 'Text'),
        ],
      ),
    );
  }

  /// One tool. Four of them share the row equally, so none is off the edge and
  /// none has to be found by scrolling — the tray used to hide the fourth.
  Widget _toolButton(
    BuildContext context,
    ReaderTool value,
    IconData icon,
    String label,
  ) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final selected = tool == value;
    final foreground = selected
        ? colors.onPrimaryContainer
        : colors.onSurfaceVariant;
    final reduced = AppMotion.reducedMotion(context);
    return Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Semantics(
          button: true,
          selected: selected,
          label: label,
          hint: selected ? 'Tap again to put it away' : null,
          excludeSemantics: true,
          onTap: () => _chooseTool(value, selected),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppRadii.control),
            onTap: () => _chooseTool(value, selected),
            child: AnimatedContainer(
              duration: reduced ? Duration.zero : AppMotion.fast,
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget + 8,
              ),
              padding: const EdgeInsets.symmetric(vertical: 6),
              decoration: BoxDecoration(
                color: selected ? colors.primaryContainer : Colors.transparent,
                borderRadius: BorderRadius.circular(AppRadii.control),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 22, color: foreground),
                  const SizedBox(height: 2),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: foreground,
                      fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _chooseTool(ReaderTool value, bool selected) {
    AppHaptics.selection();
    // Tapping the active tool puts it away, so getting back to plain
    // reading never needs the Done button to be found first.
    onToolChanged(selected ? ReaderTool.none : value);
  }

  Widget _colors(BuildContext context) {
    final theme = Theme.of(context);
    final active = _activeColorIndex;
    final activeName = readerMarkupColor(palette, active).name;
    return Padding(
      padding: const EdgeInsetsDirectional.only(start: AppSpacing.md),
      child: Row(
        children: [
          // The name of what is being coloured and the colour it is, together:
          // "Pen colour / Ink". Worded so it never repeats a tool's own name.
          // Hue alone is not something everyone can read, and two
          // of the six are near-black and near-red.
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 88, maxWidth: 120),
            child: MediaQuery.withClampedTextScaling(
              maxScaleFactor: 1.3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _colorFor,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  Text(
                    activeName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: SizedBox(
              height: AppSizes.minimumTouchTarget,
              child: ListView.builder(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xxs),
                itemCount: palette.length,
                itemBuilder: (context, index) =>
                    _swatch(context, index, active),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// One colour. The circle is 30 but the target around it is 44, and the chosen
  /// one carries a tick as well as a ring so it is not picked out by outline
  /// alone.
  Widget _swatch(BuildContext context, int index, int active) {
    final colors = Theme.of(context).colorScheme;
    final entry = palette[index];
    final selected = index == active;
    final tick =
        ThemeData.estimateBrightnessForColor(entry.color) == Brightness.dark
        ? Colors.white
        : Colors.black87;
    return Semantics(
      button: true,
      selected: selected,
      label: entry.name,
      excludeSemantics: true,
      onTap: () => _chooseColor(index),
      child: Tooltip(
        message: entry.name,
        excludeFromSemantics: true,
        child: InkResponse(
          radius: 24,
          onTap: () => _chooseColor(index),
          child: SizedBox(
            width: 44,
            height: AppSizes.minimumTouchTarget,
            child: Center(
              child: Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  color: entry.color,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: selected
                        ? colors.onSurface
                        : colors.outlineVariant.withValues(alpha: 0.7),
                    width: selected ? 2.5 : 1,
                  ),
                ),
                child: selected
                    ? Icon(Icons.check, size: 16, color: tick)
                    : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _chooseColor(int index) {
    AppHaptics.selection();
    onColorChanged(index);
  }

  Widget _width(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Row(
        children: [
          Icon(Icons.circle, size: 6, color: colors.onSurfaceVariant),
          Expanded(
            child: Slider(
              value: settings.inkWidth.clamp(
                ReaderSettings.minInkWidth,
                ReaderSettings.maxInkWidth,
              ),
              min: ReaderSettings.minInkWidth,
              max: ReaderSettings.maxInkWidth,
              label: 'Pen thickness',
              semanticFormatterCallback: (_) => 'Pen thickness',
              onChanged: onWidthChanged,
            ),
          ),
          Icon(Icons.circle, size: 15, color: colors.onSurfaceVariant),
        ],
      ),
    );
  }
}
