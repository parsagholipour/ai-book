import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'edit_diff_view.dart';

// The small pieces of the diff screen that are chrome rather than content: the
// loading skeleton, the Undo/Redo bar, the layout toggle, the page jump strip
// and the quoted request.

/// Undo (or Redo) for the edit being reviewed.
class EditChangesRevertBar extends StatelessWidget {
  const EditChangesRevertBar({
    required this.undo,
    required this.onPressed,
    super.key,
  });

  /// Undo when true, Redo when false.
  final bool undo;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Material(
      color: colors.surface,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.xs + 2,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    undo
                        ? 'Not right? Undo is free.'
                        : 'Changed your mind? Redo is free.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                AppButton.outlined(
                  key: const ValueKey('changes-revert'),
                  onPressed: onPressed,
                  leading: Icon(undo ? Icons.undo : Icons.redo),
                  label: undo ? 'Undo' : 'Redo',
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The shape of the screen while the diff loads: a summary card and a page
/// section, so the layout the reader is about to read is already in place.
class EditChangesSkeleton extends StatelessWidget {
  const EditChangesSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget bar(double? width, {double height = 12}) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(6),
      ),
    );
    Widget card(List<Widget> children) => Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading changes',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: ListView(
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
            children: [
              card([
                Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: colors.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        bar(150, height: 16),
                        const SizedBox(height: 8),
                        bar(100),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                bar(220),
              ]),
              const SizedBox(height: AppSpacing.md),
              card([
                bar(70, height: 16),
                const SizedBox(height: AppSpacing.sm),
                bar(null),
                const SizedBox(height: 8),
                bar(null),
                const SizedBox(height: 8),
                bar(180),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}

/// Inline (words marked in place) or before/after (the paragraph twice).
class EditChangesLayoutToggle extends StatelessWidget {
  const EditChangesLayoutToggle({
    required this.value,
    required this.onChanged,
    super.key,
  });

  final EditDiffLayout value;
  final ValueChanged<EditDiffLayout> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<EditDiffLayout>(
      key: const ValueKey('changes-layout'),
      showSelectedIcon: false,
      segments: const [
        ButtonSegment(
          value: EditDiffLayout.inline,
          icon: Icon(Icons.view_stream_outlined),
          label: Text('Inline'),
        ),
        ButtonSegment(
          value: EditDiffLayout.beforeAfter,
          icon: Icon(Icons.vertical_split_outlined),
          label: Text('Before & after'),
        ),
      ],
      selected: {value},
      onSelectionChanged: (selection) => onChanged(selection.first),
    );
  }
}

/// A row of page numbers that scroll the screen to that page's changes.
///
/// Only drawn for an edit that touched several pages; one page needs no map.
class EditChangesPageJumpStrip extends StatelessWidget {
  const EditChangesPageJumpStrip({
    required this.pages,
    required this.onJump,
    super.key,
  });

  final List<MobileEditPageChange> pages;
  final ValueChanged<int> onJump;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return SizedBox(
      height: AppSizes.minimumTouchTarget,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: pages.length + 1,
        separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.xs),
        itemBuilder: (context, index) {
          if (index == 0) {
            return Center(
              child: Text(
                'Jump to',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            );
          }
          final page = pages[index - 1];
          return Semantics(
            button: true,
            label: 'Jump to page ${page.pageIndex}',
            child: ExcludeSemantics(
              child: Center(
                child: Material(
                  color: colors.surfaceContainerHigh,
                  shape: const StadiumBorder(),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => onJump(page.pageIndex),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        minWidth: AppSizes.minimumTouchTarget,
                        minHeight: 40,
                      ),
                      child: Center(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            '${page.pageIndex}',
                            style: theme.textTheme.labelLarge?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
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
}

/// What the reader asked for, quoted the way the chat shows it.
class EditChangesRequestQuote extends StatelessWidget {
  const EditChangesRequestQuote({required this.request, super.key});

  final String request;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      child: Container(
        padding: const EdgeInsetsDirectional.fromSTEB(
          AppSpacing.sm,
          AppSpacing.xs,
          AppSpacing.sm,
          AppSpacing.xs,
        ),
        decoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          border: BorderDirectional(
            start: BorderSide(color: colors.primary, width: 3),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'You asked',
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 2),
            Text(request, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}
