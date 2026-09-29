import 'package:flutter/material.dart';

import '../motion.dart';
import 'app_buttons.dart';
import 'app_layout.dart';
import 'app_tokens.dart';
import 'app_tones.dart';

enum AppCardDensity { compact, regular }

/// A padded application surface.
///
/// Plain by default. Give it [onTap] (or [onLongPress]) and it becomes a
/// button: ink that follows the card's corners, a press-in scale, and button
/// semantics. [selected] marks it as the chosen one of a group with the same
/// tinted fill and brand ring [AppChoiceTile] uses.
class AppCard extends StatelessWidget {
  const AppCard({
    required this.child,
    this.tone = AppTone.neutral,
    this.density = AppCardDensity.regular,
    this.clipBehavior = Clip.none,
    this.onTap,
    this.onLongPress,
    this.selected = false,
    this.semanticLabel,
    this.padding,
    super.key,
  });

  final Widget child;
  final AppTone tone;
  final AppCardDensity density;
  final Clip clipBehavior;

  /// Makes the whole card a button.
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  /// Draws the card as the chosen one of a group.
  final bool selected;

  /// What a screen reader says for an interactive or selected card, when the
  /// text inside it would not make a good name.
  final String? semanticLabel;

  /// Replaces the density's padding, e.g. `EdgeInsets.zero` for a card whose
  /// content bleeds to its edges.
  final EdgeInsetsGeometry? padding;

  bool get _interactive => onTap != null || onLongPress != null;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pair = appToneColors(context, tone);
    final neutral = tone == AppTone.neutral;
    final themedShape = Theme.of(context).cardTheme.shape;
    final radius = BorderRadius.circular(AppRadii.card);
    final content = Padding(
      padding:
          padding ??
          EdgeInsets.all(
            density == AppCardDensity.compact ? AppSpacing.sm : AppSpacing.md,
          ),
      child: child,
    );
    final tinted = neutral
        ? content
        : DefaultTextStyle.merge(
            style: TextStyle(color: pair.foreground),
            child: IconTheme.merge(
              data: IconThemeData(color: pair.foreground),
              child: content,
            ),
          );
    // Card is a semantic container of its own, so the button semantics have to
    // sit inside it to land on the same node as the tap and the text.
    final Widget body = _interactive
        ? Semantics(
            button: true,
            // "Not selected" is announced only where selection is a thing, so a
            // plain tappable card is not read out as one option of a group.
            selected: selected ? true : null,
            label: semanticLabel,
            onTap: onTap,
            onLongPress: onLongPress,
            excludeSemantics: semanticLabel != null,
            child: InkWell(
              borderRadius: radius,
              onTap: onTap,
              onLongPress: onLongPress,
              child: tinted,
            ),
          )
        : tinted;

    final card = Card(
      color: selected && neutral
          ? colors.primaryContainer
          : neutral
          ? null
          : pair.background,
      // A coloured card is a flat wash on the page; only neutral cards lift.
      elevation: neutral ? null : 0,
      clipBehavior: _interactive && clipBehavior == Clip.none
          ? Clip.hardEdge
          : clipBehavior,
      shape: selected
          ? RoundedRectangleBorder(
              borderRadius: radius,
              side: BorderSide(
                color: (neutral ? colors.primary : pair.foreground).withValues(
                  alpha: 0.55,
                ),
                width: 1.4,
              ),
            )
          : neutral
          ? themedShape
          : RoundedRectangleBorder(
              borderRadius: radius,
              side: BorderSide(color: pair.foreground.withValues(alpha: 0.18)),
            ),
      child: body,
    );

    if (_interactive) return AppPressScale(child: card);
    if (!selected && semanticLabel == null) return card;
    return Semantics(
      container: true,
      selected: selected ? true : null,
      label: semanticLabel,
      child: card,
    );
  }
}

/// The card both tiles are drawn on: the themed [Card], sinking a touch under
/// a finger like every other tappable surface.
class _TileCard extends StatelessWidget {
  const _TileCard({
    required this.color,
    required this.shape,
    required this.child,
  });

  final Color? color;
  final ShapeBorder? shape;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AppPressScale(
      child: Card(color: color, shape: shape, child: child),
    );
  }
}

class AppChoiceTile extends StatelessWidget {
  const AppChoiceTile({
    required this.selected,
    required this.icon,
    required this.title,
    required this.onTap,
    this.subtitle,
    this.semanticLabel,
    super.key,
  });

  final bool selected;
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final foreground = selected ? colors.onPrimaryContainer : colors.onSurface;
    final support = selected
        ? colors.onPrimaryContainer
        : colors.onSurfaceVariant;

    return Semantics(
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      // The card beneath is excluded from semantics, so the node itself has to
      // carry the tap or a screen reader has nothing to activate.
      onTap: onTap,
      label:
          semanticLabel ?? [title, if (subtitle != null) subtitle].join('. '),
      child: ExcludeSemantics(
        child: _TileCard(
          color: selected ? colors.primaryContainer : null,
          shape: selected
              ? RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppRadii.card),
                  side: BorderSide(
                    color: colors.primary.withValues(alpha: 0.45),
                    width: 1.4,
                  ),
                )
              : null,
          child: InkWell(
            borderRadius: BorderRadius.circular(AppRadii.card),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 72),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox.square(
                      dimension: AppSizes.minimumTouchTarget,
                      child: Align(
                        alignment: Alignment.topCenter,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Icon(
                            icon,
                            color: selected
                                ? colors.onPrimaryContainer
                                : colors.primary,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(
                                  fontWeight: FontWeight.w800,
                                  color: foreground,
                                ),
                          ),
                          if (subtitle != null) ...[
                            const SizedBox(height: AppSpacing.xxs),
                            Text(
                              subtitle!,
                              style: Theme.of(
                                context,
                              ).textTheme.bodyMedium?.copyWith(color: support),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Icon(
                      selected
                          ? Icons.radio_button_checked
                          : Icons.radio_button_unchecked,
                      color: selected
                          ? colors.onPrimaryContainer
                          : colors.outline,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The on/off sibling of [AppChoiceTile]: the same card, icon and text
/// arrangement with a switch in the radio's place, and the same tinted-card
/// treatment while it is on. A toggle drawn as a bare list row next to a stack
/// of choice cards reads as a different kind of thing — and the card frame is
/// also what makes the top-aligned icon look placed rather than floating.
class AppToggleTile extends StatelessWidget {
  const AppToggleTile({
    required this.value,
    required this.onChanged,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.titleBadge,
    super.key,
  });

  final bool value;
  final ValueChanged<bool> onChanged;
  final IconData icon;
  final String title;
  final String subtitle;

  /// Drawn beside the title and wrapping beneath it when space runs out, so a
  /// long title never breaks mid-word to make room for it.
  final Widget? titleBadge;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final foreground = value ? colors.onPrimaryContainer : colors.onSurface;
    final support = value ? colors.onPrimaryContainer : colors.onSurfaceVariant;
    final titleText = Text(
      title,
      style: Theme.of(context).textTheme.titleMedium?.copyWith(
        fontWeight: FontWeight.w800,
        color: foreground,
      ),
    );

    return Semantics(
      toggled: value,
      label: '$title. $subtitle',
      onTap: () => onChanged(!value),
      child: ExcludeSemantics(
        child: _TileCard(
          color: value ? colors.primaryContainer : null,
          shape: value
              ? RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppRadii.card),
                  side: BorderSide(
                    color: colors.primary.withValues(alpha: 0.45),
                    width: 1.4,
                  ),
                )
              : null,
          child: InkWell(
            borderRadius: BorderRadius.circular(AppRadii.card),
            onTap: () => onChanged(!value),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 72),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox.square(
                      dimension: AppSizes.minimumTouchTarget,
                      child: Align(
                        alignment: Alignment.topCenter,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Icon(
                            icon,
                            color: value
                                ? colors.onPrimaryContainer
                                : colors.primary,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (titleBadge == null)
                            titleText
                          else
                            Wrap(
                              spacing: AppSpacing.xs,
                              runSpacing: 4,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [titleText, titleBadge!],
                            ),
                          const SizedBox(height: AppSpacing.xxs),
                          Text(
                            subtitle,
                            style: Theme.of(
                              context,
                            ).textTheme.bodyMedium?.copyWith(color: support),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Switch(value: value, onChanged: onChanged),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class AppStatusBadge extends StatelessWidget {
  const AppStatusBadge({
    required this.label,
    this.icon,
    this.tone = AppTone.neutral,
    this.semanticLabel,
    super.key,
  });

  final String label;
  final IconData? icon;
  final AppTone tone;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final pair = appToneColors(context, tone);
    return Semantics(
      label: semanticLabel ?? label,
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: pair.background,
            borderRadius: BorderRadius.circular(AppRadii.pill),
            border: Border.all(color: pair.foreground.withValues(alpha: 0.14)),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 14, color: pair.foreground),
                  const SizedBox(width: 5),
                ],
                Flexible(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: pair.foreground,
                      fontWeight: FontWeight.w700,
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

class AppMetricChip extends StatelessWidget {
  const AppMetricChip({
    required this.label,
    this.value,
    this.icon,
    this.semanticLabel,
    super.key,
  });

  final String label;
  final String? value;
  final IconData? icon;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = value == null ? label : '$label: $value';
    final maxWidth = MediaQuery.sizeOf(context).width - 36;
    return Semantics(
      label: semanticLabel ?? text,
      child: ExcludeSemantics(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: maxWidth.clamp(160, 320).toDouble(),
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              color: colors.surfaceContainerLow,
              borderRadius: BorderRadius.circular(AppRadii.pill),
              border: Border.all(color: colors.outlineVariant),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 16, color: colors.onSurfaceVariant),
                  const SizedBox(width: 6),
                ],
                Flexible(
                  child: Text(
                    text,
                    softWrap: true,
                    style: Theme.of(context).textTheme.labelMedium,
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

class AppInlineNotice extends StatelessWidget {
  const AppInlineNotice({
    required this.title,
    required this.message,
    this.icon,
    this.tone = AppTone.neutral,
    this.actionLabel,
    this.onAction,
    this.onDismiss,
    super.key,
  });

  final String title;
  final String message;

  /// Defaults to the tone's own glyph (a tick for success, a triangle for a
  /// warning, ...) so state never rides on colour alone.
  final IconData? icon;
  final AppTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  /// Adds a close button. The notice does not hide itself; the caller owns
  /// whether it is still shown.
  final VoidCallback? onDismiss;

  static IconData iconFor(AppTone tone) => switch (tone) {
    AppTone.neutral || AppTone.info => Icons.info_outline,
    AppTone.success => Icons.check_circle_outline,
    AppTone.warning => Icons.warning_amber_rounded,
    AppTone.error => Icons.error_outline,
  };

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final pair = appToneColors(context, tone);
    final radius = BorderRadius.circular(AppRadii.control);
    final neutral = tone == AppTone.neutral;
    // A neutral notice is grey on grey; its title still has to lead the
    // message, so it takes the full text colour rather than the muted one.
    final titleColor = neutral ? colors.onSurface : pair.foreground;
    final messageColor = neutral ? colors.onSurfaceVariant : pair.foreground;
    final action = actionLabel != null && onAction != null
        ? Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xxs),
            child: Theme(
              data: Theme.of(context).copyWith(
                textButtonTheme: TextButtonThemeData(
                  style: Theme.of(context).textButtonTheme.style?.copyWith(
                    foregroundColor: WidgetStatePropertyAll(titleColor),
                    // Flush with the message above it, not indented by the
                    // button's own padding.
                    padding: const WidgetStatePropertyAll(
                      EdgeInsetsDirectional.only(end: AppSpacing.md),
                    ),
                  ),
                ),
              ),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: AppButton.text(label: actionLabel!, onPressed: onAction),
              ),
            ),
          )
        : null;

    return Semantics(
      container: true,
      liveRegion: tone == AppTone.error,
      child: ClipRRect(
        borderRadius: radius,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: pair.background,
            borderRadius: radius,
            border: Border.all(color: pair.foreground.withValues(alpha: 0.18)),
          ),
          child: Stack(
            children: [
              // A tone's accent runs down the leading edge: the one place a
              // colour-blind reader and a colour-sighted one both get a cue.
              if (!neutral)
                PositionedDirectional(
                  top: 0,
                  bottom: 0,
                  start: 0,
                  width: 4,
                  child: ColoredBox(color: pair.accent),
                ),
              Padding(
                padding: EdgeInsetsDirectional.fromSTEB(
                  neutral ? AppSpacing.md : AppSpacing.md + 4,
                  AppSpacing.md,
                  onDismiss == null ? AppSpacing.md : AppSpacing.xxs,
                  AppSpacing.md,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ExcludeSemantics(
                      child: Icon(
                        icon ?? iconFor(tone),
                        color: neutral ? colors.onSurfaceVariant : pair.accent,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: text.titleSmall?.copyWith(
                              color: titleColor,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: AppSpacing.xxs),
                          Text(
                            message,
                            style: text.bodySmall?.copyWith(
                              color: messageColor,
                            ),
                          ),
                          ?action,
                        ],
                      ),
                    ),
                    if (onDismiss != null)
                      IconButton(
                        onPressed: onDismiss,
                        tooltip: MaterialLocalizations.of(
                          context,
                        ).closeButtonTooltip,
                        icon: const Icon(Icons.close, size: 20),
                        color: titleColor,
                        // Sits in the corner rather than pushing the message
                        // in: the target stays 48dp, the icon just hugs the
                        // notice's edge.
                        visualDensity: VisualDensity.compact,
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class AppPrimaryActionPanel extends StatelessWidget {
  const AppPrimaryActionPanel({
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
    this.icon = Icons.auto_awesome_outlined,
    this.actionIcon,
    this.tone = AppTone.neutral,
    this.destructive = false,
    this.loading = false,
    this.loadingLabel,
    super.key,
  });

  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback? onAction;
  final IconData icon;
  final Widget? actionIcon;
  final AppTone tone;
  final bool destructive;
  final bool loading;
  final String? loadingLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pair = appToneColors(context, tone);
    final neutral = tone == AppTone.neutral;
    // The panel is the screen's one call to action, so on a neutral card its
    // title is full-strength text and its glyph the brand colour; a tone's own
    // foreground already does that job everywhere else.
    final titleColor = neutral ? colors.onSurface : pair.foreground;
    final iconColor = neutral ? colors.primary : pair.foreground;
    final action = destructive
        ? AppButton.destructive(
            label: actionLabel,
            onPressed: onAction,
            leading: actionIcon ?? const Icon(Icons.arrow_forward),
            loading: loading,
            loadingLabel: loadingLabel,
          )
        : AppButton.primary(
            label: actionLabel,
            onPressed: onAction,
            leading: actionIcon ?? const Icon(Icons.arrow_forward),
            loading: loading,
            loadingLabel: loadingLabel,
          );
    return AppCard(
      tone: tone,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(child: Icon(icon, color: iconColor)),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: AppSectionHeader(
                  title: title,
                  subtitle: message,
                  titleStyle: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: titleColor,
                    fontWeight: FontWeight.w800,
                  ),
                  subtitleStyle: Theme.of(context).textTheme.bodyMedium
                      ?.copyWith(
                        color: neutral
                            ? colors.onSurfaceVariant
                            : pair.foreground,
                      ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Align(alignment: AlignmentDirectional.centerStart, child: action),
        ],
      ),
    );
  }
}
