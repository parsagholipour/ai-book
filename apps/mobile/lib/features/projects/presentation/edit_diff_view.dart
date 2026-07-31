import 'package:flutter/material.dart';

import '../domain/project_models.dart';

/// Colours for insertions and deletions.
///
/// Deliberately not derived from the app's seed colour: added and removed have
/// to read as green and red at a glance, and the app's palette is teal. The
/// alpha-blended backgrounds keep the text legible on either theme's surface.
class EditDiffPalette {
  const EditDiffPalette({
    required this.insertBackground,
    required this.insertForeground,
    required this.deleteBackground,
    required this.deleteForeground,
  });

  final Color insertBackground;
  final Color insertForeground;
  final Color deleteBackground;
  final Color deleteForeground;

  factory EditDiffPalette.of(BuildContext context) {
    return Theme.of(context).brightness == Brightness.dark
        ? const EditDiffPalette(
            insertBackground: Color(0x3327C46B),
            insertForeground: Color(0xFF86E0AC),
            deleteBackground: Color(0x33F0526D),
            deleteForeground: Color(0xFFFFA3AE),
          )
        : const EditDiffPalette(
            insertBackground: Color(0x3315803D),
            insertForeground: Color(0xFF13502C),
            deleteBackground: Color(0x33DC2626),
            deleteForeground: Color(0xFF7C1D1D),
          );
  }

  Color gutterFor(MobileEditDiffBlockType type) {
    return switch (type) {
      MobileEditDiffBlockType.added => insertForeground,
      MobileEditDiffBlockType.removed => deleteForeground,
      MobileEditDiffBlockType.changed => insertForeground,
      MobileEditDiffBlockType.unchanged => Colors.transparent,
    };
  }
}

/// One page's paragraphs, with long untouched stretches folded away.
///
/// Showing every paragraph would bury a one-word change in a page of text;
/// showing only the changed ones would strip the context that makes the change
/// readable. A lone untouched paragraph between two changes is kept, and runs of
/// two or more collapse behind a tap.
class EditDiffBlockList extends StatelessWidget {
  const EditDiffBlockList({required this.blocks, super.key});

  final List<MobileEditDiffBlock> blocks;

  @override
  Widget build(BuildContext context) {
    final groups = <_DiffGroup>[];
    for (final block in blocks) {
      final last = groups.isEmpty ? null : groups.last;
      if (block.isUnchanged && last != null && last.collapsible) {
        last.blocks.add(block);
        continue;
      }
      groups.add(_DiffGroup(collapsible: block.isUnchanged, blocks: [block]));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final group in groups)
          if (group.collapsible && group.blocks.length > 1)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _CollapsedContext(blocks: group.blocks),
            )
          else
            for (final block in group.blocks)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: EditDiffBlockView(block: block),
              ),
      ],
    );
  }
}

class _DiffGroup {
  _DiffGroup({required this.collapsible, required this.blocks});

  final bool collapsible;
  final List<MobileEditDiffBlock> blocks;
}

/// A run of untouched paragraphs, shown as a single expandable row.
class _CollapsedContext extends StatefulWidget {
  const _CollapsedContext({required this.blocks});

  final List<MobileEditDiffBlock> blocks;

  @override
  State<_CollapsedContext> createState() => _CollapsedContextState();
}

class _CollapsedContextState extends State<_CollapsedContext> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final count = widget.blocks.length;
    if (_expanded) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final block in widget.blocks)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: EditDiffBlockView(block: block),
            ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => setState(() => _expanded = false),
              icon: const Icon(Icons.unfold_less, size: 18),
              label: Text('Hide $count unchanged paragraphs'),
            ),
          ),
        ],
      );
    }
    return InkWell(
      onTap: () => setState(() => _expanded = true),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            Icon(Icons.unfold_more, size: 18, color: colors.onSurfaceVariant),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '$count unchanged paragraphs',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One paragraph, with the words that moved marked in place.
class EditDiffBlockView extends StatelessWidget {
  const EditDiffBlockView({required this.block, super.key});

  final MobileEditDiffBlock block;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final palette = EditDiffPalette.of(context);
    final base =
        theme.textTheme.bodyMedium?.copyWith(height: 1.5) ??
        const TextStyle(height: 1.5);

    final body = SelectableText.rich(
      TextSpan(
        children: [
          for (final run in block.runs)
            TextSpan(
              text: run.text,
              style: switch (run.type) {
                MobileEditDiffRunType.equal => base.copyWith(
                  color: block.isUnchanged
                      ? colors.onSurfaceVariant
                      : colors.onSurface,
                ),
                MobileEditDiffRunType.insert => base.copyWith(
                  color: palette.insertForeground,
                  backgroundColor: palette.insertBackground,
                  fontWeight: FontWeight.w600,
                ),
                MobileEditDiffRunType.delete => base.copyWith(
                  color: palette.deleteForeground,
                  backgroundColor: palette.deleteBackground,
                  decoration: TextDecoration.lineThrough,
                  decorationColor: palette.deleteForeground,
                ),
              },
            ),
        ],
      ),
    );

    if (block.isUnchanged) {
      // Indented to the width of the gutter plus its gap, so changed and
      // unchanged paragraphs share one left edge.
      return Padding(padding: const EdgeInsets.only(left: 11), child: body);
    }
    // A left border rather than a Row with a stretched bar: the bar has to be
    // as tall as the paragraph, and asking a Row for that inside a scroll view
    // means measuring an unbounded height.
    return Container(
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(color: palette.gutterFor(block.type), width: 3),
        ),
      ),
      child: body,
    );
  }
}

/// "+12 · −4", the shape of a change at a glance.
class EditDiffWordCount extends StatelessWidget {
  const EditDiffWordCount({
    required this.addedWords,
    required this.removedWords,
    super.key,
  });

  final int addedWords;
  final int removedWords;

  @override
  Widget build(BuildContext context) {
    final palette = EditDiffPalette.of(context);
    final style = Theme.of(context).textTheme.labelMedium;
    return Semantics(
      label: '$addedWords words added, $removedWords words removed',
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '+$addedWords',
              style: style?.copyWith(
                color: palette.insertForeground,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '−$removedWords',
              style: style?.copyWith(
                color: palette.deleteForeground,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
