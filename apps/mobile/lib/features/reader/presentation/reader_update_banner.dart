import 'package:flutter/material.dart';

/// What the reader shows about the book's compile state, if anything.
enum ReaderUpdateStatus {
  /// Nothing to say — what is on screen is current.
  none,

  /// An edit is in flight and the exports are being rebuilt. The stale PDF
  /// stays on screen rather than blanking the page.
  rebuilding,

  /// A newer compile is ready to load.
  updated,
}

/// The strip above the page telling the reader their edits have landed.
class ReaderUpdateBanner extends StatelessWidget {
  const ReaderUpdateBanner({
    required this.status,
    required this.onReload,
    required this.onDismiss,
    super.key,
  });

  final ReaderUpdateStatus status;
  final VoidCallback onReload;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    if (status == ReaderUpdateStatus.none) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final rebuilding = status == ReaderUpdateStatus.rebuilding;

    return Material(
      color: rebuilding
          ? theme.colorScheme.surfaceContainerHighest
          : theme.colorScheme.primaryContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
          child: Row(
            children: [
              if (rebuilding)
                const SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  Icons.auto_awesome,
                  size: 18,
                  color: theme.colorScheme.onPrimaryContainer,
                ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  rebuilding
                      ? 'Updating this book with your changes…'
                      : 'Your edits are in. Reload to see them.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: rebuilding
                        ? theme.colorScheme.onSurfaceVariant
                        : theme.colorScheme.onPrimaryContainer,
                  ),
                ),
              ),
              if (!rebuilding) ...[
                TextButton(onPressed: onReload, child: const Text('Reload')),
                IconButton(
                  icon: const Icon(Icons.close, size: 18),
                  tooltip: 'Dismiss',
                  onPressed: onDismiss,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
