import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/plan_build_progress.dart';

/// What the reader shows about the book's compile state, if anything.
enum ReaderUpdateStatus {
  /// Nothing to say — what is on screen is current.
  none,

  /// An edit is in flight and the exports are being rebuilt. The stale PDF
  /// stays on screen rather than blanking the page.
  rebuilding,

  /// A newer compile is ready to load.
  updated,

  /// The server is out of reach: the book on screen is the copy on this
  /// phone, and what needs the server (edits, the chat) is paused.
  offline,
}

/// The card over the page telling the reader their edits have landed.
///
/// A card rather than a strip glued under the top bar: it has to be there
/// whether or not the bars are, because the reader who asked for an edit and
/// came back to a book with the controls put away is exactly the reader who
/// needs to be told it is ready. It says what has happened, what the button will
/// do — reloading is the one action that moves the page under the reader — and
/// that it will not lose their place.
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
    return AppSwitcher(
      child: status == ReaderUpdateStatus.none
          ? const SizedBox.shrink(key: ValueKey('reader-update-none'))
          : _card(context, key: ValueKey(status)),
    );
  }

  Widget _card(BuildContext context, {required Key key}) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final rebuilding = status == ReaderUpdateStatus.rebuilding;
    final offline = status == ReaderUpdateStatus.offline;
    final calm = rebuilding || offline;
    final background = calm
        ? colors.surfaceContainerHigh
        : colors.primaryContainer;
    final foreground = calm ? colors.onSurface : colors.onPrimaryContainer;
    final (icon, title, detail) = switch (status) {
      ReaderUpdateStatus.rebuilding => (
        Icons.autorenew,
        'Updating this book with your changes…',
        'You can keep reading while it finishes.',
      ),
      ReaderUpdateStatus.offline => (
        Icons.cloud_off_outlined,
        "You're offline — reading the copy on this phone",
        'Edits and the book chat come back when you reconnect.',
      ),
      _ => (
        Icons.auto_awesome,
        'Your edits are in. Reload to see them.',
        'Reloading keeps your place.',
      ),
    };

    return SafeArea(
      key: key,
      bottom: false,
      minimum: const EdgeInsets.only(top: AppSpacing.xs),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.sm,
          0,
          AppSpacing.sm,
          AppSpacing.xs,
        ),
        child: Semantics(
          container: true,
          liveRegion: true,
          child: Material(
            color: background,
            elevation: 2,
            shadowColor: Colors.black.withValues(alpha: 0.25),
            borderRadius: BorderRadius.circular(AppRadii.control),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(
                    AppSpacing.md,
                    AppSpacing.sm,
                    AppSpacing.xs,
                    AppSpacing.sm,
                  ),
                  child: Row(
                    children: [
                      ExcludeSemantics(
                        child: Icon(icon, size: 20, color: foreground),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: foreground,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              detail,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: foreground.withValues(alpha: 0.8),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (offline)
                        IconButton(
                          icon: const Icon(Icons.close, size: 20),
                          tooltip: 'Dismiss',
                          color: foreground,
                          onPressed: onDismiss,
                        )
                      else if (!rebuilding) ...[
                        const SizedBox(width: AppSpacing.xs),
                        FilledButton(
                          onPressed: onReload,
                          style: FilledButton.styleFrom(
                            visualDensity: VisualDensity.compact,
                            minimumSize: const Size(
                              64,
                              AppSizes.minimumTouchTarget - 8,
                            ),
                          ),
                          child: const Text('Reload'),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, size: 20),
                          tooltip: 'Dismiss',
                          color: foreground,
                          onPressed: onDismiss,
                        ),
                      ],
                    ],
                  ),
                ),
                // Work is in flight for exactly as long as this state lasts,
                // which is the only reason it is allowed to keep moving.
                if (rebuilding)
                  PlanBuildProgressBar(
                    value: null,
                    height: 3,
                    trackColor: colors.outlineVariant.withValues(alpha: 0.4),
                    semanticLabel: 'Updating this book',
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
