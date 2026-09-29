import 'package:flutter/material.dart';

import '../app_components.dart';
import '../motion.dart';

/// The icon well every state screen opens with: the glyph on a disc, on a
/// wider, fainter ring. Two steps of the same tint read as a soft glow without
/// any gradient, and both pass 3:1 with the icon on top.
class _StateHalo extends StatelessWidget {
  const _StateHalo({
    required this.icon,
    required this.ring,
    required this.disc,
    required this.glyph,
    this.size = 88,
  });

  final IconData icon;
  final Color ring;
  final Color disc;
  final Color glyph;
  final double size;

  @override
  Widget build(BuildContext context) {
    final inner = size * 0.73;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          alignment: Alignment.center,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(color: ring, shape: BoxShape.circle),
              child: SizedBox.square(dimension: size),
            ),
            DecoratedBox(
              decoration: BoxDecoration(color: disc, shape: BoxShape.circle),
              child: SizedBox.square(dimension: inner),
            ),
            Icon(icon, size: size * 0.34, color: glyph),
          ],
        ),
      ),
    );
  }
}

/// The layout the empty and error states share: halo (or an illustration),
/// title, message, then a primary and an optional secondary action.
class _StateBody extends StatelessWidget {
  const _StateBody({
    required this.halo,
    required this.title,
    required this.message,
    required this.compact,
    this.actions = const [],
  });

  final Widget halo;
  final String title;
  final String message;
  final bool compact;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: compact
          ? const EdgeInsets.symmetric(horizontal: 16, vertical: 12)
          : const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: AppEntrance(
            offset: 8,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                halo,
                SizedBox(height: compact ? 10 : 16),
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  message,
                  style: text.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                if (actions.isNotEmpty) ...[
                  SizedBox(height: compact ? 10 : 18),
                  for (var i = 0; i < actions.length; i++) ...[
                    if (i > 0) const SizedBox(height: AppSpacing.xxs),
                    actions[i],
                  ],
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A wait with nothing to read yet.
///
/// By default a ring on a soft halo and a message. Pass a [skeleton] shaped
/// like the content that is coming (an `AppSkeletonList`, say) and the ring
/// gives way to it, with [message] kept for screen readers: a placeholder that
/// looks like the page makes the wait feel shorter than any spinner.
class AppLoadingState extends StatelessWidget {
  const AppLoadingState({
    this.message = 'Loading',
    this.hint,
    this.skeleton,
    this.compact = false,
    super.key,
  });

  /// A list-shaped skeleton in place of the ring.
  AppLoadingState.list({
    String message = 'Loading',
    int itemCount = 4,
    AppSkeletonLeading leading = AppSkeletonLeading.box,
    bool compact = false,
    Key? key,
  }) : this(
         message: message,
         compact: compact,
         key: key,
         skeleton: AppSkeletonList(
           itemCount: itemCount,
           leading: leading,
           label: message,
         ),
       );

  final String message;

  /// A second, quieter line: what is happening, or how long it may take.
  final String? hint;

  /// Shown instead of the ring. It is responsible for its own shimmer (the
  /// `AppSkeleton*` compositions are) and announces [message] itself.
  final Widget? skeleton;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final padding = compact
        ? const EdgeInsets.symmetric(vertical: 12)
        : const EdgeInsets.symmetric(vertical: 24);
    if (skeleton != null) {
      return Padding(padding: padding, child: skeleton);
    }
    final ring = compact ? 24.0 : 32.0;
    return Semantics(
      container: true,
      liveRegion: true,
      label: message,
      child: Padding(
        padding: padding,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (compact)
                SizedBox.square(
                  dimension: ring,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    semanticsLabel: message,
                  ),
                )
              else
                ExcludeSemantics(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.primaryContainer.withValues(alpha: 0.55),
                      shape: BoxShape.circle,
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: SizedBox.square(
                        dimension: ring,
                        child: CircularProgressIndicator(
                          strokeWidth: 3,
                          semanticsLabel: message,
                        ),
                      ),
                    ),
                  ),
                ),
              SizedBox(height: compact ? 8 : 12),
              Text(
                message,
                style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                textAlign: TextAlign.center,
              ),
              if (hint != null) ...[
                const SizedBox(height: 2),
                Text(
                  hint!,
                  style: text.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Something failed and the reader can try again.
///
/// Says what happened ([title], [message]) and offers [onRetry]. Give it a
/// [secondaryLabel] and [onSecondary] for the other way out (go back, contact
/// support), so an error is never a dead end.
class AppErrorState extends StatelessWidget {
  const AppErrorState({
    required this.title,
    required this.message,
    this.onRetry,
    this.actionLabel = 'Try again',
    this.actionIcon = Icons.refresh,
    this.icon = Icons.wifi_off_outlined,
    this.secondaryLabel,
    this.onSecondary,
    this.illustration,
    this.compact = false,
    super.key,
  });

  final String title;
  final String message;
  final VoidCallback? onRetry;
  final String actionLabel;
  final IconData actionIcon;
  final IconData icon;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  /// Replaces the icon halo with the feature's own artwork.
  final Widget? illustration;

  /// Tighter spacing and a smaller glyph, for an error inside a card or a
  /// section rather than a whole screen.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      child: _StateBody(
        compact: compact,
        title: title,
        message: message,
        halo:
            illustration ??
            _StateHalo(
              icon: icon,
              size: compact ? 64 : 88,
              ring: colors.errorContainer.withValues(alpha: 0.4),
              disc: colors.errorContainer,
              glyph: colors.onErrorContainer,
            ),
        actions: [
          if (onRetry != null)
            AppButton.outlined(
              onPressed: onRetry,
              leading: Icon(actionIcon),
              label: actionLabel,
            ),
          if (secondaryLabel != null && onSecondary != null)
            AppButton.text(label: secondaryLabel!, onPressed: onSecondary),
        ],
      ),
    );
  }
}

/// Nothing here yet, and what to do about it.
///
/// [actionLabel] and [onAction] are the one obvious next step; a
/// [secondaryLabel] adds a quieter alternative beneath it.
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    required this.title,
    required this.message,
    this.icon = Icons.menu_book_outlined,
    this.actionLabel,
    this.onAction,
    this.actionIcon,
    this.secondaryLabel,
    this.onSecondary,
    this.illustration,
    this.compact = false,
    super.key,
  });

  final String title;
  final String message;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;
  final Widget? actionIcon;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  /// Replaces the icon halo with the feature's own artwork.
  final Widget? illustration;

  /// Tighter spacing and a smaller glyph, for an empty list inside a card or a
  /// section rather than a whole screen.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      child: _StateBody(
        compact: compact,
        title: title,
        message: message,
        halo:
            illustration ??
            _StateHalo(
              icon: icon,
              size: compact ? 64 : 88,
              ring: colors.primaryContainer.withValues(alpha: 0.4),
              disc: colors.primaryContainer,
              glyph: colors.primary,
            ),
        actions: [
          if (actionLabel != null && onAction != null)
            AppButton.primary(
              onPressed: onAction,
              label: actionLabel!,
              leading: actionIcon,
            ),
          if (secondaryLabel != null && onSecondary != null)
            AppButton.text(label: secondaryLabel!, onPressed: onSecondary),
        ],
      ),
    );
  }
}
