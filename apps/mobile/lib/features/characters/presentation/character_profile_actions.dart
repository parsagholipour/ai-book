import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';

/// The three things to do with a character that are not about their picture:
/// talk to them, change who they are, or put them in a book.
///
/// Equal tiles, because none of them is a step the reader is behind on. The one
/// that is filled is "Use in a book", and only while nothing is owed — while a
/// picture is still the next thing to do, the card below carries the page's
/// primary action and this row does not compete with it.
class CharacterProfileActions extends StatelessWidget {
  const CharacterProfileActions({
    required this.calling,
    required this.busy,
    required this.useLeads,
    required this.onCall,
    required this.onEdit,
    required this.onUse,
    super.key,
  });

  /// The cast read that precedes a call is in flight.
  final bool calling;

  /// Something on the page is writing to the character.
  final bool busy;

  /// Whether "Use in a book" gets the primary fill.
  final bool useLeads;

  final VoidCallback onCall;
  final VoidCallback onEdit;
  final VoidCallback onUse;

  @override
  Widget build(BuildContext context) {
    final textScale = MediaQuery.textScalerOf(context).scale(1);
    // At a large text size three tiles abreast would each be a few letters
    // wide, so they stack and read as rows.
    final stacked = textScale >= 1.35;
    final tiles = [
      _ActionTile(
        key: const ValueKey('character-profile-call'),
        icon: Icons.call_outlined,
        label: 'Call',
        loading: calling,
        stacked: stacked,
        onPressed: busy || calling ? null : onCall,
      ),
      _ActionTile(
        key: const ValueKey('character-profile-edit'),
        icon: Icons.edit_outlined,
        label: 'Edit',
        stacked: stacked,
        onPressed: busy ? null : onEdit,
      ),
      _ActionTile(
        key: const ValueKey('character-profile-use'),
        icon: Icons.menu_book_outlined,
        label: 'Use in a book',
        filled: useLeads,
        stacked: stacked,
        onPressed: onUse,
      ),
    ];
    if (stacked) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < tiles.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpacing.xs),
            tiles[i],
          ],
        ],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < tiles.length; i++) ...[
            if (i > 0) const SizedBox(width: AppSpacing.xs),
            Expanded(child: tiles[i]),
          ],
        ],
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.label,
    required this.stacked,
    required this.onPressed,
    this.loading = false,
    this.filled = false,
    super.key,
  });

  final IconData icon;
  final String label;
  final bool stacked;
  final bool loading;
  final bool filled;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final enabled = onPressed != null;
    final background = filled ? colors.primary : colors.surfaceContainerLowest;
    final foreground = filled ? colors.onPrimary : colors.onSurface;
    final iconColor = filled ? colors.onPrimary : colors.primary;

    final glyph = loading
        ? SizedBox.square(
            dimension: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2.2,
              color: iconColor,
            ),
          )
        : Icon(icon, color: iconColor);
    final text = Text(
      label,
      textAlign: stacked ? TextAlign.start : TextAlign.center,
      style: theme.textTheme.labelLarge?.copyWith(
        color: foreground,
        fontWeight: FontWeight.w700,
      ),
    );

    final VoidCallback? tap = onPressed == null
        ? null
        : () {
            AppHaptics.tap();
            onPressed!();
          };

    return Semantics(
      container: true,
      button: true,
      enabled: enabled,
      label: label,
      liveRegion: loading,
      onTap: tap,
      child: ExcludeSemantics(
        child: Opacity(
          opacity: enabled || loading ? 1 : 0.5,
          child: Material(
            color: background,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadii.card),
              side: filled
                  ? BorderSide.none
                  : BorderSide(color: colors.outlineVariant),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: tap,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget + AppSpacing.md,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.sm,
                    vertical: AppSpacing.sm,
                  ),
                  child: stacked
                      ? Row(
                          children: [
                            glyph,
                            const SizedBox(width: AppSpacing.sm),
                            Expanded(child: text),
                          ],
                        )
                      // Top-aligned so the three icons share a line when one
                      // label wraps and its neighbours do not.
                      : Column(
                          mainAxisAlignment: MainAxisAlignment.start,
                          children: [
                            glyph,
                            const SizedBox(height: AppSpacing.xxs),
                            text,
                          ],
                        ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
