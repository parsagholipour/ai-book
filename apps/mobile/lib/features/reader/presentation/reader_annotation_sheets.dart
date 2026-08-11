import 'package:flutter/material.dart';

import '../domain/reader_annotation.dart';
import 'reader_annotation_painter.dart';

/// What the reader asked to do with a piece of markup.
enum ReaderAnnotationCommand {
  editBody,
  move,
  delete,
  copy,
  share,
  ask,
  rewrite,
  replace,
  editPage,
}

/// Writes or edits the text of a note.
///
/// Owns its controller so it is disposed when the sheet actually leaves the
/// tree. Disposing it when the sheet's future completes — which happens the
/// moment the route is popped, while the field is still on screen animating out
/// — tears down a controller the live [TextField] is still attached to.
class ReaderNoteSheet extends StatefulWidget {
  const ReaderNoteSheet({
    required this.title,
    this.initial = '',
    this.excerpt,
    this.submitLabel = 'Save',
    super.key,
  });

  final String title;
  final String initial;

  /// The passage the note is about, when it came from a selection.
  final String? excerpt;

  final String submitLabel;

  @override
  State<ReaderNoteSheet> createState() => _ReaderNoteSheetState();
}

class _ReaderNoteSheetState extends State<ReaderNoteSheet> {
  late final _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() => Navigator.of(context).pop(_controller.text.trim());

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final excerpt = widget.excerpt;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        20,
        20,
        20 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.title, style: theme.textTheme.titleMedium),
          if (excerpt != null && excerpt.isNotEmpty) ...[
            const SizedBox(height: 12),
            _ExcerptBlock(text: excerpt),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            autofocus: true,
            maxLines: 6,
            minLines: 2,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              labelText: 'Your note',
              hintText: 'What did you want to remember?',
            ),
          ),
          const SizedBox(height: 20),
          FilledButton(onPressed: _submit, child: Text(widget.submitLabel)),
        ],
      ),
    );
  }
}

/// Opens the actions for one piece of markup.
///
/// Colour changes apply straight away through [onColorChanged] rather than
/// waiting for the sheet to close — recolouring is a thing people do two or
/// three times in a row until it looks right, and a sheet that closed after
/// each attempt would make that miserable.
Future<ReaderAnnotationCommand?> showReaderAnnotationSheet({
  required BuildContext context,
  required ReaderAnnotation annotation,
  required List<ReaderMarkupColor> palette,
  required bool editingEnabled,
  required void Function(int colorIndex) onColorChanged,
  bool placementEnabled = true,
  bool bookActionsEnabled = true,
}) {
  return showModalBottomSheet<ReaderAnnotationCommand>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => ReaderAnnotationSheet(
      annotation: annotation,
      palette: palette,
      editingEnabled: editingEnabled,
      placementEnabled: placementEnabled,
      bookActionsEnabled: bookActionsEnabled,
      onColorChanged: onColorChanged,
    ),
  );
}

/// The actions for one piece of markup.
class ReaderAnnotationSheet extends StatefulWidget {
  const ReaderAnnotationSheet({
    required this.annotation,
    required this.palette,
    required this.editingEnabled,
    required this.onColorChanged,
    this.placementEnabled = true,
    this.bookActionsEnabled = true,
    super.key,
  });

  final ReaderAnnotation annotation;
  final List<ReaderMarkupColor> palette;
  final bool editingEnabled;
  final bool placementEnabled;
  final bool bookActionsEnabled;
  final void Function(int colorIndex) onColorChanged;

  @override
  State<ReaderAnnotationSheet> createState() => _ReaderAnnotationSheetState();
}

class _ReaderAnnotationSheetState extends State<ReaderAnnotationSheet> {
  late int _colorIndex = widget.annotation.colorIndex;

  ReaderAnnotation get _annotation => widget.annotation;

  bool get _hasQuote => (_annotation.quote?.trim().isNotEmpty ?? false);

  bool get _hasBody =>
      _annotation is NoteAnnotation || _annotation is TextBoxAnnotation;

  bool get _isPlaced =>
      _annotation is NoteAnnotation || _annotation is TextBoxAnnotation;

  void _pop(ReaderAnnotationCommand command) =>
      Navigator.of(context).pop(command);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body = _annotation.body?.trim() ?? '';
    final quote = _annotation.quote?.trim() ?? '';

    return SafeArea(
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(_kindIcon, size: 20, color: theme.colorScheme.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '$_kindLabel · page ${_annotation.page}',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                ],
              ),
              if (_annotation.orphaned) ...[
                const SizedBox(height: 10),
                _Notice(
                  icon: Icons.link_off,
                  text:
                      'The passage this was on is no longer in the book, so it '
                      'is not shown on the page.',
                ),
              ],
              if (!widget.bookActionsEnabled && _hasQuote) ...[
                const SizedBox(height: 10),
                _Notice(
                  icon: Icons.sync_problem_outlined,
                  text: 'Reload to use actions tied to the current book.',
                ),
              ],
              if (body.isNotEmpty) ...[
                const SizedBox(height: 14),
                Text(body, style: theme.textTheme.bodyMedium),
              ],
              if (quote.isNotEmpty) ...[
                const SizedBox(height: 12),
                _ExcerptBlock(text: quote),
              ],
              const SizedBox(height: 18),
              _colorRow(context),
              const SizedBox(height: 8),
              const Divider(height: 24),
              ..._actions(context),
            ],
          ),
        ),
      ),
    );
  }

  Widget _colorRow(BuildContext context) {
    return Wrap(
      spacing: 10,
      runSpacing: 8,
      children: [
        for (var index = 0; index < widget.palette.length; index++)
          Semantics(
            button: true,
            selected: index == _colorIndex,
            label: widget.palette[index].name,
            child: Tooltip(
              message: widget.palette[index].name,
              child: InkResponse(
                radius: 24,
                onTap: () {
                  setState(() => _colorIndex = index);
                  widget.onColorChanged(index);
                },
                child: Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: widget.palette[index].color,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: index == _colorIndex
                          ? Theme.of(context).colorScheme.onSurface
                          : Theme.of(context).colorScheme.outlineVariant,
                      width: index == _colorIndex ? 2.5 : 1,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  List<Widget> _actions(BuildContext context) {
    return [
      if (_hasBody)
        _action(
          Icons.edit_note,
          'Edit note',
          () => _pop(ReaderAnnotationCommand.editBody),
        ),
      if (_isPlaced)
        _action(
          Icons.open_with,
          'Move it',
          () => _pop(ReaderAnnotationCommand.move),
          enabled: widget.placementEnabled,
        ),
      if (_hasQuote) ...[
        _action(
          Icons.copy_all_outlined,
          'Copy the passage',
          () => _pop(ReaderAnnotationCommand.copy),
        ),
        _action(
          Icons.chat_bubble_outline,
          'Ask about it',
          () => _pop(ReaderAnnotationCommand.ask),
          enabled: widget.bookActionsEnabled,
        ),
        _action(
          Icons.auto_fix_high_outlined,
          'Rewrite it',
          () => _pop(ReaderAnnotationCommand.rewrite),
          enabled: widget.bookActionsEnabled && widget.editingEnabled,
        ),
        _action(
          Icons.find_replace_outlined,
          'Replace it',
          () => _pop(ReaderAnnotationCommand.replace),
          enabled: widget.bookActionsEnabled && widget.editingEnabled,
        ),
        _action(
          Icons.edit_outlined,
          'Edit this page',
          () => _pop(ReaderAnnotationCommand.editPage),
          enabled: widget.bookActionsEnabled && widget.editingEnabled,
        ),
      ],
      _action(
        Icons.ios_share_outlined,
        'Share',
        () => _pop(ReaderAnnotationCommand.share),
      ),
      _action(
        Icons.delete_outline,
        'Delete',
        () => _pop(ReaderAnnotationCommand.delete),
        destructive: true,
      ),
    ];
  }

  Widget _action(
    IconData icon,
    String label,
    VoidCallback onTap, {
    bool enabled = true,
    bool destructive = false,
  }) {
    final theme = Theme.of(context);
    final color = destructive ? theme.colorScheme.error : null;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      enabled: enabled,
      leading: Icon(icon, color: color),
      title: Text(label, style: color == null ? null : TextStyle(color: color)),
      onTap: enabled ? onTap : null,
    );
  }

  IconData get _kindIcon => switch (_annotation.kind) {
    ReaderAnnotationKind.highlight => Icons.brush_outlined,
    ReaderAnnotationKind.underline => Icons.format_underlined,
    ReaderAnnotationKind.strikethrough => Icons.format_strikethrough,
    ReaderAnnotationKind.note => Icons.sticky_note_2_outlined,
    ReaderAnnotationKind.ink => Icons.gesture,
    ReaderAnnotationKind.text => Icons.title,
  };

  String get _kindLabel => switch (_annotation.kind) {
    ReaderAnnotationKind.highlight => 'Highlight',
    ReaderAnnotationKind.underline => 'Underline',
    ReaderAnnotationKind.strikethrough => 'Strikethrough',
    ReaderAnnotationKind.note => 'Note',
    ReaderAnnotationKind.ink => 'Drawing',
    ReaderAnnotationKind.text => 'Text',
  };
}

class _ExcerptBlock extends StatelessWidget {
  const _ExcerptBlock({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        maxLines: 5,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}
