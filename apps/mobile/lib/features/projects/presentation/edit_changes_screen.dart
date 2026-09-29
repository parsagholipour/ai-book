import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/motion.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'credit_cost_badge.dart';
import 'edit_changes_chrome.dart';
import 'edit_changes_illustrations.dart';
import 'edit_diff_view.dart';
import 'edit_kind_presentation.dart';
import 'project_route_error.dart';

/// What the reader chose on the diff screen besides reading it.
///
/// The screen answers with the choice and the chat that pushed it does the
/// work: an undo starts a rebuild, and the chat is what shows that rebuild.
enum EditChangesAction { undo, redo }

/// What one applied edit changed, page by page.
///
/// Reached from the chat, where an applied edit otherwise says only that it
/// happened and what it cost. Read-only: the diff is built from the snapshots
/// undo already keeps, so opening it costs nothing. When the edit can still be
/// undone (or put back) the same screen offers that, so the reader who decides
/// here that it was wrong does not have to find their way back to a card.
class EditChangesScreen extends ConsumerWidget {
  const EditChangesScreen({
    required this.projectId,
    required this.operationId,
    super.key,
  });

  final String projectId;
  final String operationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = (projectId: projectId, operationId: operationId);
    final changesValue = ref.watch(editChangesProvider(target));
    // The chat's own operation row is the authority on whether Undo or Redo is
    // still valid for this edit: the diff payload knows only that it was undone.
    final operation = ref.watch(
      projectChatProvider(projectId).select((chat) {
        final operations = chat.asData?.value.operations;
        if (operations == null) return null;
        for (final candidate in operations) {
          if (candidate.id == operationId) return candidate;
        }
        return null;
      }),
    );
    final action = operation == null || !operation.isApplied
        ? null
        : operation.canUndo
        ? EditChangesAction.undo
        : operation.canRedo
        ? EditChangesAction.redo
        : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Changes'),
        actions: [
          IconButton(
            tooltip: 'Open book',
            onPressed: () => context.push('/projects/$projectId/read'),
            icon: const Icon(Icons.menu_book_outlined),
          ),
        ],
      ),
      body: changesValue.when(
        data: (changes) => _EditChangesBody(
          projectId: projectId,
          changes: changes,
          onRefresh: () => ref.invalidate(editChangesProvider(target)),
        ),
        loading: () => const EditChangesSkeleton(),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Changes unavailable',
          onRetry: () => ref.invalidate(editChangesProvider(target)),
          onGoHome: () => context.go('/home'),
        ),
      ),
      bottomNavigationBar: action == null || !changesValue.hasValue
          ? null
          : EditChangesRevertBar(
              undo: action == EditChangesAction.undo,
              onPressed: () => Navigator.of(context).pop(action),
            ),
    );
  }
}

class _EditChangesBody extends StatefulWidget {
  const _EditChangesBody({
    required this.projectId,
    required this.changes,
    required this.onRefresh,
  });

  final String projectId;
  final MobileEditChanges changes;
  final VoidCallback onRefresh;

  @override
  State<_EditChangesBody> createState() => _EditChangesBodyState();
}

class _EditChangesBodyState extends State<_EditChangesBody> {
  EditDiffLayout _layout = EditDiffLayout.inline;
  final Map<int, GlobalKey> _sectionKeys = {};

  GlobalKey _keyFor(int pageIndex) =>
      _sectionKeys.putIfAbsent(pageIndex, GlobalKey.new);

  void _jumpTo(int pageIndex) {
    final target = _keyFor(pageIndex).currentContext;
    if (target == null) return;
    Scrollable.ensureVisible(
      target,
      alignment: 0.05,
      duration: AppMotion.reducedMotion(context)
          ? Duration.zero
          : AppMotion.medium,
      curve: AppMotion.standard,
    );
  }

  @override
  Widget build(BuildContext context) {
    final changes = widget.changes;
    // A structural edit can still list nothing — an insert the reader undid has
    // no pages left to show — and "Nothing was changed" is the one thing that
    // must not be said about an edit that added, removed or moved pages. The
    // summary card names what happened instead.
    if (changes.isEmpty && changes.kind != 'restructure_pages') {
      return RefreshIndicator(
        onRefresh: () async => widget.onRefresh(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            if (changes.request.trim().isNotEmpty) ...[
              EditChangesRequestQuote(request: changes.request),
              const SizedBox(height: AppSpacing.sm),
            ],
            const AppEmptyState(
              title: 'Nothing was changed',
              message:
                  'This edit finished without altering any page text. Nothing '
                  'was written to the book.',
              icon: Icons.check_circle_outline,
            ),
          ],
        ),
      );
    }

    final hasTextChanges = changes.pages.any(
      (page) => page.blocks.any((block) => !block.isUnchanged),
    );
    return RefreshIndicator(
      onRefresh: () async => widget.onRefresh(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          _ChangesSummary(changes: changes),
          if (hasTextChanges) ...[
            const SizedBox(height: AppSpacing.md),
            EditChangesLayoutToggle(
              value: _layout,
              onChanged: (value) => setState(() => _layout = value),
            ),
          ],
          if (changes.pages.length > 1) ...[
            const SizedBox(height: AppSpacing.sm),
            EditChangesPageJumpStrip(pages: changes.pages, onJump: _jumpTo),
          ],
          const SizedBox(height: AppSpacing.md),
          for (final page in changes.pages) ...[
            KeyedSubtree(
              key: _keyFor(page.pageIndex),
              child: _PageChangeSection(
                projectId: widget.projectId,
                page: page,
                kind: changes.kind,
                layout: _layout,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
          ],
        ],
      ),
    );
  }
}

class _ChangesSummary extends StatelessWidget {
  const _ChangesSummary({required this.changes});

  final MobileEditChanges changes;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = editKindStyle(changes.kind);
    final applied = changes.appliedAt;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: colors.primaryContainer,
                    borderRadius: BorderRadius.circular(AppRadii.control),
                  ),
                  child: Icon(style.icon, color: colors.onPrimaryContainer),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        _summaryTitle(changes),
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    Text(
                      [
                        style.label,
                        if (applied != null) describeEditWhen(context, applied),
                      ].join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (changes.addedWords > 0 ||
              changes.removedWords > 0 ||
              changes.creditsCharged > 0) ...[
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                EditDiffWordCount(
                  addedWords: changes.addedWords,
                  removedWords: changes.removedWords,
                ),
                if (changes.creditsCharged > 0)
                  CreditCostBadge(credits: changes.creditsCharged),
              ],
            ),
          ],
          if (changes.request.trim().isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            EditChangesRequestQuote(request: changes.request),
          ],
          if (changes.undone) ...[
            const SizedBox(height: AppSpacing.sm),
            const AppInlineNotice(
              icon: Icons.undo,
              title: 'Undone',
              message:
                  'This edit was undone. The book no longer has these '
                  'changes.',
            ),
          ],
        ],
      ),
    );
  }
}

class _PageChangeSection extends StatelessWidget {
  const _PageChangeSection({
    required this.projectId,
    required this.page,
    required this.kind,
    required this.layout,
  });

  final String projectId;
  final MobileEditPageChange page;

  /// The operation kind, so a page can say whether its picture moved or went.
  final String kind;
  final EditDiffLayout layout;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final palette = EditDiffPalette.of(context);
    final structural = page.structuralChange;
    // A removed page has no page to open: the number it carries is the one it
    // used to hold, and some other page holds it now.
    final canOpen = structural != MobileEditPageStructuralChange.removed;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Page ${page.pageIndex}',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
              EditDiffWordCount(
                addedWords: page.addedWords,
                removedWords: page.removedWords,
              ),
              if (canOpen) ...[
                const SizedBox(width: 4),
                AppButton.text(
                  onPressed: () => context.push(
                    '/projects/$projectId/read?page=${page.pageIndex}',
                  ),
                  label: 'Open',
                ),
              ],
            ],
          ),
          if (structural != null) ...[
            const SizedBox(height: 4),
            Text(
              _structuralCopy(structural, page.pageIndexBefore),
              style: theme.textTheme.bodySmall?.copyWith(
                // A move gained and lost nothing, so it is not coloured as a
                // change to the text — the diff palette answers for words.
                color: switch (structural) {
                  MobileEditPageStructuralChange.added =>
                    palette.insertForeground,
                  MobileEditPageStructuralChange.removed =>
                    palette.deleteForeground,
                  MobileEditPageStructuralChange.moved =>
                    colors.onSurfaceVariant,
                },
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
          if (page.titleChanged) ...[
            const SizedBox(height: 4),
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              children: [
                Text(
                  page.titleBefore,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: palette.deleteForeground,
                    decoration: TextDecoration.lineThrough,
                    decorationColor: palette.deleteForeground,
                  ),
                ),
                Icon(
                  Icons.arrow_forward,
                  size: 14,
                  color: colors.onSurfaceVariant,
                ),
                Text(
                  page.titleAfter,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: palette.insertForeground,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ] else if (page.titleAfter.trim().isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              page.titleAfter,
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
          if (page.illustrationChanged) ...[
            const SizedBox(height: 10),
            Text(
              editIllustrationCopy(page, kind),
              style: theme.textTheme.bodyMedium,
            ),
            if (page.illustrationBefore != null ||
                page.illustrationAfter != null) ...[
              const SizedBox(height: 10),
              EditIllustrationSwap(
                beforeUrl: page.illustrationBefore,
                afterUrl: page.illustrationAfter,
              ),
            ],
          ],
          if (page.titleChanged ||
              page.addedWords > 0 ||
              page.removedWords > 0 ||
              (structural != null && page.blocks.isNotEmpty)) ...[
            const SizedBox(height: 10),
            EditDiffBlockList(blocks: page.blocks, layout: layout),
          ],
        ],
      ),
    );
  }
}

String _summaryTitle(MobileEditChanges changes) {
  if (changes.kind == 'restructure_pages') {
    return _structuralSummaryTitle(changes.pages);
  }
  final pageCount = changes.pages.length;
  final illustrationOnly =
      changes.pages.isNotEmpty &&
      changes.addedWords == 0 &&
      changes.removedWords == 0 &&
      changes.pages.every(
        (page) => page.illustrationChanged && !page.titleChanged,
      );
  if (illustrationOnly) {
    // A move is checked first, and by kind: within one page it produces a
    // single change whose before and after are both set, which is exactly the
    // shape a replacement has.
    if (changes.kind == 'move_image') {
      return 'Illustration moved';
    }
    final removed = changes.pages
        .where(
          (page) =>
              page.illustrationBefore != null && page.illustrationAfter == null,
        )
        .length;
    if (changes.kind == 'remove_image' || removed == pageCount) {
      // Counted in illustrations, not pages: removing two pictures from one
      // page is two illustrations gone, and the card said so when it asked.
      final count = removed > 0 ? removed : pageCount;
      return count == 1
          ? 'Illustration removed'
          : '$count illustrations removed';
    }
    if (pageCount > 1) {
      return 'Illustration moved';
    }
    return 'Illustration replaced';
  }
  return pageCount == 1 ? '1 page changed' : '$pageCount pages changed';
}

/// What a structural edit did, counted in the pages it listed.
///
/// One operation only ever inserts, only ever deletes or only ever moves, so a
/// homogeneous list names itself. The generic line is still reachable and still
/// has to be right: an insert the reader undid lists nothing, because the revert
/// deleted the pages it made.
String _structuralSummaryTitle(List<MobileEditPageChange> pages) {
  if (pages.isEmpty) {
    return 'The book’s pages changed';
  }
  bool every(MobileEditPageStructuralChange change) =>
      pages.every((page) => page.structuralChange == change);
  final count = pages.length;
  if (every(MobileEditPageStructuralChange.added)) {
    return count == 1 ? '1 page added' : '$count pages added';
  }
  if (every(MobileEditPageStructuralChange.removed)) {
    return count == 1 ? '1 page removed' : '$count pages removed';
  }
  if (every(MobileEditPageStructuralChange.moved)) {
    return count == 1 ? '1 page moved' : '$count pages moved';
  }
  return 'The book’s pages changed';
}

String _structuralCopy(
  MobileEditPageStructuralChange change,
  int? pageIndexBefore,
) {
  return switch (change) {
    MobileEditPageStructuralChange.added => 'Added to the book',
    MobileEditPageStructuralChange.removed => 'Removed from the book',
    // A move rewrote nothing, so where the page came from is the whole change.
    MobileEditPageStructuralChange.moved =>
      pageIndexBefore == null
          ? 'Moved to a new place in the book'
          : 'Moved here from page $pageIndexBefore',
  };
}
