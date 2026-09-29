import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
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

/// The words that moved between two strings, as the same runs the server sends
/// for a page diff.
///
/// Used only where the server sent two whole lines and no runs — the exact
/// replacement preview on a proposal card — so the reader sees *which* words
/// change rather than comparing two near-identical sentences by eye. Word level
/// on purpose: a character diff of "night" against "day" reads as noise.
List<MobileEditDiffRun> diffWords(String before, String after) {
  final a = _wordTokens(before);
  final b = _wordTokens(after);
  var start = 0;
  while (start < a.length &&
      start < b.length &&
      a[start].trimRight() == b[start].trimRight()) {
    start++;
  }
  var endA = a.length;
  var endB = b.length;
  while (endA > start &&
      endB > start &&
      a[endA - 1].trimRight() == b[endB - 1].trimRight()) {
    endA--;
    endB--;
  }

  final runs = <MobileEditDiffRun>[];
  void add(MobileEditDiffRunType type, String text) {
    if (text.isEmpty) return;
    if (runs.isNotEmpty && runs.last.type == type) {
      runs[runs.length - 1] = MobileEditDiffRun(
        type: type,
        text: runs.last.text + text,
      );
    } else {
      runs.add(MobileEditDiffRun(type: type, text: text));
    }
  }

  add(MobileEditDiffRunType.equal, b.sublist(0, start).join());

  final midA = a.sublist(start, endA);
  final midB = b.sublist(start, endB);
  // A quadratic table is fine for a sentence and wrong for a chapter; past this
  // size the honest answer is "this whole stretch was replaced".
  if (midA.length * midB.length > 90000) {
    add(MobileEditDiffRunType.delete, midA.join());
    add(MobileEditDiffRunType.insert, midB.join());
  } else if (midA.isEmpty || midB.isEmpty) {
    add(MobileEditDiffRunType.delete, midA.join());
    add(MobileEditDiffRunType.insert, midB.join());
  } else {
    final n = midA.length;
    final m = midB.length;
    final table = List.generate(n + 1, (_) => List<int>.filled(m + 1, 0));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i].trimRight() == midB[j].trimRight()
            ? table[i + 1][j + 1] + 1
            : (table[i + 1][j] >= table[i][j + 1]
                  ? table[i + 1][j]
                  : table[i][j + 1]);
      }
    }
    var i = 0;
    var j = 0;
    while (i < n && j < m) {
      if (midA[i].trimRight() == midB[j].trimRight()) {
        add(MobileEditDiffRunType.equal, midB[j]);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        add(MobileEditDiffRunType.delete, midA[i]);
        i++;
      } else {
        add(MobileEditDiffRunType.insert, midB[j]);
        j++;
      }
    }
    while (i < n) {
      add(MobileEditDiffRunType.delete, midA[i++]);
    }
    while (j < m) {
      add(MobileEditDiffRunType.insert, midB[j++]);
    }
  }

  add(MobileEditDiffRunType.equal, b.sublist(endB).join());
  return runs;
}

List<String> _wordTokens(String text) => [
  for (final match in RegExp(r'\S+\s*|\s+').allMatches(text)) match.group(0)!,
];

/// How a page's changes are laid out.
enum EditDiffLayout {
  /// One paragraph with the removed words struck through and the new ones
  /// marked, in place. The default: it is the shortest way to see a small edit.
  inline,

  /// The paragraph as it was and as it is now, one above the other on a phone
  /// and side by side where there is room.
  beforeAfter,
}

/// One page's paragraphs, with long untouched stretches folded away.
///
/// Showing every paragraph would bury a one-word change in a page of text;
/// showing only the changed ones would strip the context that makes the change
/// readable. A lone untouched paragraph between two changes is kept, and runs of
/// two or more collapse behind a tap.
class EditDiffBlockList extends StatelessWidget {
  const EditDiffBlockList({
    required this.blocks,
    this.layout = EditDiffLayout.inline,
    super.key,
  });

  final List<MobileEditDiffBlock> blocks;
  final EditDiffLayout layout;

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

    Widget blockView(MobileEditDiffBlock block) =>
        layout == EditDiffLayout.beforeAfter && !block.isUnchanged
        ? EditBeforeAfterBlockView(block: block)
        : EditDiffBlockView(block: block);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final group in groups)
          if (group.collapsible && group.blocks.length > 1)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: _CollapsedContext(blocks: group.blocks),
            )
          else
            for (final block in group.blocks)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: blockView(block),
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
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: EditDiffBlockView(block: block),
            ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Hide $count unchanged paragraphs',
              onPressed: () => setState(() => _expanded = false),
              leading: const Icon(Icons.unfold_less, size: 18),
            ),
          ),
        ],
      );
    }
    return Semantics(
      button: true,
      label: '$count unchanged paragraphs. Tap to show them.',
      child: ExcludeSemantics(
        child: InkWell(
          onTap: () => setState(() => _expanded = true),
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: Container(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: 10,
            ),
            decoration: BoxDecoration(
              color: colors.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(AppRadii.compact),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.unfold_more,
                  size: 18,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.xs),
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
      // unchanged paragraphs share one leading edge.
      return Padding(
        padding: const EdgeInsetsDirectional.only(start: 11),
        child: body,
      );
    }
    // A leading border rather than a Row with a stretched bar: the bar has to be
    // as tall as the paragraph, and asking a Row for that inside a scroll view
    // means measuring an unbounded height.
    return Container(
      padding: const EdgeInsetsDirectional.only(start: 8),
      decoration: BoxDecoration(
        border: BorderDirectional(
          start: BorderSide(color: palette.gutterFor(block.type), width: 3),
        ),
      ),
      child: body,
    );
  }
}

/// A changed paragraph shown as it was and as it is now.
///
/// Stacked on a phone, side by side once there is room for two readable
/// columns. The removed words stay marked in the "before" pane and the new ones
/// in the "after" pane, so the eye still lands on what moved.
class EditBeforeAfterBlockView extends StatelessWidget {
  const EditBeforeAfterBlockView({required this.block, super.key});

  final MobileEditDiffBlock block;

  @override
  Widget build(BuildContext context) {
    final before = _EditPane(
      side: _PaneSide.before,
      runs: [
        for (final run in block.runs)
          if (run.type != MobileEditDiffRunType.insert) run,
      ],
      emptyLabel: 'Not in the book before',
    );
    final after = _EditPane(
      side: _PaneSide.after,
      runs: [
        for (final run in block.runs)
          if (run.type != MobileEditDiffRunType.delete) run,
      ],
      emptyLabel: 'Removed',
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= 520) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: before),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: after),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            before,
            const SizedBox(height: AppSpacing.xs),
            after,
          ],
        );
      },
    );
  }
}

enum _PaneSide { before, after }

class _EditPane extends StatelessWidget {
  const _EditPane({
    required this.side,
    required this.runs,
    required this.emptyLabel,
  });

  final _PaneSide side;
  final List<MobileEditDiffRun> runs;
  final String emptyLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final palette = EditDiffPalette.of(context);
    final isBefore = side == _PaneSide.before;
    final accent = isBefore
        ? palette.deleteForeground
        : palette.insertForeground;
    final tint = isBefore ? palette.deleteBackground : palette.insertBackground;
    final base =
        theme.textTheme.bodyMedium?.copyWith(height: 1.5) ??
        const TextStyle(height: 1.5);
    final hasText = runs.any((run) => run.text.trim().isNotEmpty);
    return Semantics(
      container: true,
      label: isBefore ? 'Before' : 'After',
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.sm),
        decoration: BoxDecoration(
          color: tint.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(AppRadii.compact),
          border: BorderDirectional(start: BorderSide(color: accent, width: 3)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(
              child: Text(
                isBefore ? 'Before' : 'After',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: accent,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xxs),
            if (!hasText)
              Text(
                emptyLabel,
                style: base.copyWith(
                  color: colors.onSurfaceVariant,
                  fontStyle: FontStyle.italic,
                ),
              )
            else
              SelectableText.rich(
                TextSpan(
                  children: [
                    for (final run in runs)
                      TextSpan(
                        text: run.text,
                        style: switch (run.type) {
                          MobileEditDiffRunType.equal => base.copyWith(
                            color: colors.onSurface,
                          ),
                          MobileEditDiffRunType.insert => base.copyWith(
                            color: palette.insertForeground,
                            backgroundColor: palette.insertBackground,
                            fontWeight: FontWeight.w600,
                          ),
                          MobileEditDiffRunType.delete => base.copyWith(
                            color: palette.deleteForeground,
                            backgroundColor: palette.deleteBackground,
                          ),
                        },
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
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
    if (addedWords == 0 && removedWords == 0) {
      return const SizedBox.shrink();
    }
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
