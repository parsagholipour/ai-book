import 'package:flutter/material.dart';

import '../../../shared/ui/authed_network_image.dart';
import '../../../shared/ui/zoomable_image_viewer.dart';
import '../domain/project_models.dart';

// How the diff screen shows a picture that was replaced, moved or removed:
// what the page's change says about it in words, and the before/after frames.

String editIllustrationCopy(MobileEditPageChange page, String kind) {
  if (page.illustrationBefore != null && page.illustrationAfter == null) {
    return kind == 'move_image'
        ? 'The illustration was moved off this page.'
        : 'The illustration on this page was removed.';
  }
  if (page.illustrationBefore == null && page.illustrationAfter != null) {
    return 'An illustration was moved onto this page.';
  }
  // Both sides set: a replacement, or a move within this same page.
  return kind == 'move_image'
      ? 'The illustration moved to a different place on this page.'
      : 'The illustration on this page was replaced.';
}

class EditIllustrationSwap extends StatelessWidget {
  const EditIllustrationSwap({
    super.key,
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

class _AuthenticatedSwapImage extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final broken = errorPlaceholder ?? _SwapPlaceholder(label: label);
    return AuthedNetworkImage(
      url: url,
      cacheBuster: null,
      fit: fit,
      semanticLabel: label,
      loadingPlaceholder: broken,
      errorPlaceholder: broken,
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
