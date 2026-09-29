import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../projects/domain/edit_changes_models.dart';
import '../../projects/presentation/edit_diff_view.dart';
import '../domain/manuscript_blocks.dart';

/// Pinned above a chapter whose book version changed (an edit in the book
/// chat) while the Studio held unpublished edits to it. The author decides
/// which one wins; until then both are kept.
class ChapterConflictCard extends StatelessWidget {
  const ChapterConflictCard({
    required this.onKeepMine,
    required this.onUseBook,
    required this.onCompare,
    this.busy = false,
    super.key,
  });

  final VoidCallback onKeepMine;
  final VoidCallback onUseBook;
  final VoidCallback onCompare;

  /// A choice is being saved; the buttons wait.
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // A tint of the brand, not the button fill: this is a notice, and the
    // buttons inside it are the only things here to press.
    return Semantics(
      container: true,
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.primaryContainer.withValues(alpha: 0.42),
          borderRadius: BorderRadius.circular(AppRadii.card),
          border: Border.all(color: colors.primary.withValues(alpha: 0.18)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.md,
            AppSpacing.md,
            AppSpacing.sm,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Icon(
                      Icons.call_split_rounded,
                      size: 20,
                      color: colors.primary,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      'This chapter changed in the book chat while you were '
                      'editing it.',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: colors.onSurface,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              Wrap(
                spacing: AppSpacing.xs,
                runSpacing: AppSpacing.xs,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  OutlinedButton(
                    key: const ValueKey('conflict-keep-mine'),
                    onPressed: busy ? null : onKeepMine,
                    style: _compact(context, outlined: true),
                    child: const Text('Keep mine'),
                  ),
                  OutlinedButton(
                    key: const ValueKey('conflict-use-book'),
                    onPressed: busy ? null : onUseBook,
                    style: _compact(context, outlined: true),
                    child: const Text('Use the book’s version'),
                  ),
                  TextButton.icon(
                    key: const ValueKey('conflict-compare'),
                    onPressed: busy ? null : onCompare,
                    style: _compact(context, outlined: false),
                    icon: const Icon(Icons.compare_arrows_rounded, size: 18),
                    label: const Text('Compare'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static ButtonStyle _compact(BuildContext context, {required bool outlined}) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(
      context,
    ).textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700);
    return outlined
        ? OutlinedButton.styleFrom(
            minimumSize: const Size(0, 40),
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            foregroundColor: colors.onSurface,
            backgroundColor: colors.surface,
            side: BorderSide(color: colors.outline.withValues(alpha: 0.6)),
            textStyle: text,
          )
        : TextButton.styleFrom(
            minimumSize: const Size(0, 40),
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
            foregroundColor: colors.primary,
            textStyle: text,
          );
  }
}

/// Which version the compare sheet was closed with.
enum ChapterCompareChoice { keepMine, useBook }

/// The two versions side by side as one marked-up text: struck words are only
/// in the Studio's, highlighted words only in the book's.
Future<ChapterCompareChoice?> showChapterCompareSheet(
  BuildContext context, {
  required String mine,
  required String book,
}) {
  final blocks = chapterDiffBlocks(mine, book);
  return showAppBottomSheet<ChapterCompareChoice>(
    context,
    builder: (sheetContext) => AppSheetScaffold(
      title: 'Compare versions',
      subtitle:
          'Struck-through words are only in yours. Highlighted words are only '
          'in the book’s version.',
      icon: Icons.compare_arrows_rounded,
      onClose: () => Navigator.of(sheetContext).pop(),
      footer: AppActionGroup(
        secondary: [
          AppButton.outlined(
            label: 'Use the book’s version',
            onPressed: () =>
                Navigator.of(sheetContext).pop(ChapterCompareChoice.useBook),
          ),
        ],
        primary: AppButton.primary(
          label: 'Keep mine',
          onPressed: () =>
              Navigator.of(sheetContext).pop(ChapterCompareChoice.keepMine),
        ),
      ),
      children: [
        if (blocks.every((block) => block.isUnchanged))
          const AppInlineNotice(
            title: 'The two versions read the same',
            message: 'Keeping either one changes nothing in the text.',
            tone: AppTone.success,
          )
        else
          EditDiffBlockList(blocks: blocks),
      ],
    ),
  );
}

/// Paragraph-then-word diff of two chapters, shaped like the server's page
/// diffs so the book chat's diff view can draw it.
///
/// A chapter is too long for one word-level table, so paragraphs are matched
/// first (longest common subsequence on whole paragraphs); only the
/// paragraphs between two matches are compared word by word, pairwise.
List<MobileEditDiffBlock> chapterDiffBlocks(String mine, String book) {
  final a = splitManuscriptParagraphs(mine);
  final b = splitManuscriptParagraphs(book);
  final n = a.length;
  final m = b.length;
  final blocks = <MobileEditDiffBlock>[];

  MobileEditDiffBlock unchanged(String text) => MobileEditDiffBlock(
    type: MobileEditDiffBlockType.unchanged,
    runs: [MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: text)],
  );

  void mismatched(List<String> removed, List<String> added) {
    final pairs = removed.length < added.length ? removed.length : added.length;
    for (var i = 0; i < pairs; i++) {
      blocks.add(
        MobileEditDiffBlock(
          type: MobileEditDiffBlockType.changed,
          runs: diffWords(removed[i], added[i]),
        ),
      );
    }
    for (final text in removed.skip(pairs)) {
      blocks.add(
        MobileEditDiffBlock(
          type: MobileEditDiffBlockType.removed,
          runs: [
            MobileEditDiffRun(type: MobileEditDiffRunType.delete, text: text),
          ],
        ),
      );
    }
    for (final text in added.skip(pairs)) {
      blocks.add(
        MobileEditDiffBlock(
          type: MobileEditDiffBlockType.added,
          runs: [
            MobileEditDiffRun(type: MobileEditDiffRunType.insert, text: text),
          ],
        ),
      );
    }
  }

  if (n * m > 250000) {
    mismatched(a, b);
    return blocks;
  }
  final table = List.generate(n + 1, (_) => List<int>.filled(m + 1, 0));
  for (var i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] == b[j]
          ? table[i + 1][j + 1] + 1
          : (table[i + 1][j] >= table[i][j + 1]
                ? table[i + 1][j]
                : table[i][j + 1]);
    }
  }
  var i = 0;
  var j = 0;
  final removed = <String>[];
  final added = <String>[];
  void settle() {
    if (removed.isEmpty && added.isEmpty) return;
    mismatched([...removed], [...added]);
    removed.clear();
    added.clear();
  }

  while (i < n && j < m) {
    if (a[i] == b[j]) {
      settle();
      blocks.add(unchanged(a[i]));
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      removed.add(a[i++]);
    } else {
      added.add(b[j++]);
    }
  }
  removed.addAll(a.skip(i));
  added.addAll(b.skip(j));
  settle();
  return blocks;
}
