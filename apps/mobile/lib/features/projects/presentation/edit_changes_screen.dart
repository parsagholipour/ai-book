import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/zoomable_image_viewer.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'edit_diff_view.dart';
import 'project_route_error.dart';

/// What one applied edit changed, page by page.
///
/// Reached from the chat, where an applied edit otherwise says only that it
/// happened and what it cost. Read-only: the diff is built from the snapshots
/// undo already keeps, so opening it costs nothing.
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
        loading: () => const AppLoadingState(message: 'Loading changes'),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Changes unavailable',
          onRetry: () => ref.invalidate(editChangesProvider(target)),
          onGoHome: () => context.go('/home'),
        ),
      ),
    );
  }
}

class _EditChangesBody extends StatelessWidget {
  const _EditChangesBody({
    required this.projectId,
    required this.changes,
    required this.onRefresh,
  });

  final String projectId;
  final MobileEditChanges changes;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    if (changes.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
          children: const [
            AppEmptyState(
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

    return RefreshIndicator(
      onRefresh: () async => onRefresh(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          _ChangesSummary(changes: changes),
          const SizedBox(height: 16),
          for (final page in changes.pages) ...[
            _PageChangeSection(projectId: projectId, page: page),
            const SizedBox(height: 20),
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
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (changes.request.trim().isNotEmpty) ...[
              Text(
                'You asked',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 4),
              Text(changes.request, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 12),
            ],
            Row(
              children: [
                Expanded(
                  child: Text(
                    _summaryTitle(changes),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                EditDiffWordCount(
                  addedWords: changes.addedWords,
                  removedWords: changes.removedWords,
                ),
              ],
            ),
            if (changes.undone) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Icon(Icons.undo, size: 18, color: colors.onSurfaceVariant),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'This edit was undone. The book no longer has these '
                      'changes.',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PageChangeSection extends StatelessWidget {
  const _PageChangeSection({required this.projectId, required this.page});

  final String projectId;
  final MobileEditPageChange page;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final palette = EditDiffPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Page ${page.pageIndex}',
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            EditDiffWordCount(
              addedWords: page.addedWords,
              removedWords: page.removedWords,
            ),
            const SizedBox(width: 4),
            AppButton.text(
              onPressed: () => context.push(
                '/projects/$projectId/read?page=${page.pageIndex}',
              ),
              label: 'Open',
            ),
          ],
        ),
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
            'The illustration on this page was replaced.',
            style: theme.textTheme.bodyMedium,
          ),
          if (page.illustrationBefore != null ||
              page.illustrationAfter != null) ...[
            const SizedBox(height: 10),
            _IllustrationSwapPreview(
              beforeUrl: page.illustrationBefore,
              afterUrl: page.illustrationAfter,
            ),
          ],
        ],
        if (page.titleChanged ||
            page.addedWords > 0 ||
            page.removedWords > 0) ...[
          const SizedBox(height: 10),
          EditDiffBlockList(blocks: page.blocks),
        ],
      ],
    );
  }
}

String _summaryTitle(MobileEditChanges changes) {
  final pageCount = changes.pages.length;
  final illustrationOnly =
      changes.pages.isNotEmpty &&
      changes.addedWords == 0 &&
      changes.removedWords == 0 &&
      changes.pages.every(
        (page) => page.illustrationChanged && !page.titleChanged,
      );
  if (illustrationOnly) {
    return pageCount == 1
        ? 'Illustration replaced'
        : '$pageCount illustrations replaced';
  }
  return pageCount == 1 ? '1 page changed' : '$pageCount pages changed';
}

class _IllustrationSwapPreview extends StatelessWidget {
  const _IllustrationSwapPreview({
    required this.beforeUrl,
    required this.afterUrl,
  });

  final String? beforeUrl;
  final String? afterUrl;

  List<({String url, String label})> get _pages => [
    if (beforeUrl != null) (url: beforeUrl!, label: 'Before'),
    if (afterUrl != null) (url: afterUrl!, label: 'After'),
  ];

  void _openViewer(BuildContext context, String label) {
    final pages = _pages;
    if (pages.isEmpty) return;
    final initialIndex = pages.indexWhere((page) => page.label == label);
    showZoomableImageViewer<void>(
      context: context,
      itemCount: pages.length,
      initialIndex: initialIndex < 0 ? 0 : initialIndex,
      itemBuilder: (context, index) => _AuthenticatedSwapImage(
        url: pages[index].url,
        label: pages[index].label,
        fit: BoxFit.contain,
        errorPlaceholder: const Center(
          child: Text(
            "Couldn't load this picture",
            style: TextStyle(color: Colors.white70),
          ),
        ),
      ),
      bottomBar: (context, index) => Text(
        pages[index].label,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Colors.white70),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: _SwapFrame(
            label: 'Before',
            url: beforeUrl,
            onOpen: beforeUrl == null
                ? null
                : () => _openViewer(context, 'Before'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _SwapFrame(
            label: 'After',
            url: afterUrl,
            onOpen: afterUrl == null
                ? null
                : () => _openViewer(context, 'After'),
          ),
        ),
      ],
    );
  }
}

class _SwapFrame extends StatelessWidget {
  const _SwapFrame({required this.label, this.url, this.onOpen});

  final String label;
  final String? url;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 6),
        AspectRatio(
          aspectRatio: 16 / 9,
          child: Material(
            color: colors.surfaceContainerHighest,
            clipBehavior: Clip.antiAlias,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              key: ValueKey('view-illustration-$label'),
              onTap: onOpen,
              child: url == null
                  ? _SwapPlaceholder(label: label)
                  : Semantics(
                      button: true,
                      excludeSemantics: true,
                      label: 'View $label',
                      child: _AuthenticatedSwapImage(url: url!, label: label),
                    ),
            ),
          ),
        ),
      ],
    );
  }
}

class _AuthenticatedSwapImage extends ConsumerWidget {
  const _AuthenticatedSwapImage({
    required this.url,
    required this.label,
    this.fit = BoxFit.cover,
    this.errorPlaceholder,
  });

  final String url;
  final String label;
  final BoxFit fit;
  final Widget? errorPlaceholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(url).toString();
    final broken = errorPlaceholder ?? _SwapPlaceholder(label: label);
    return headersValue.when(
      data: (headers) => Image.network(
        uri,
        headers: headers,
        fit: fit,
        semanticLabel: label,
        errorBuilder: (context, error, stackTrace) => broken,
      ),
      loading: () => broken,
      error: (error, stackTrace) => broken,
    );
  }
}

class _SwapPlaceholder extends StatelessWidget {
  const _SwapPlaceholder({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: Icon(
          Icons.image_outlined,
          color: colors.onSurfaceVariant,
          semanticLabel: '$label unavailable',
        ),
      ),
    );
  }
}
