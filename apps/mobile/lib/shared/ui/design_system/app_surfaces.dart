import 'package:flutter/material.dart';

import 'app_buttons.dart';
import 'app_layout.dart';
import 'app_tokens.dart';
import 'app_tones.dart';

enum AppCardDensity { compact, regular }

/// A padded, non-interactive application surface.
class AppCard extends StatelessWidget {
  const AppCard({
    required this.child,
    this.tone = AppTone.neutral,
    this.density = AppCardDensity.regular,
    this.clipBehavior = Clip.none,
    super.key,
  });

  final Widget child;
  final AppTone tone;
  final AppCardDensity density;
  final Clip clipBehavior;

  @override
  Widget build(BuildContext context) {
    final pair = appToneColors(context, tone);
    final themedShape = Theme.of(context).cardTheme.shape;
    final content = Padding(
      padding: EdgeInsets.all(
        density == AppCardDensity.compact ? AppSpacing.sm : AppSpacing.md,
      ),
      child: child,
    );
    return Card(
      color: tone == AppTone.neutral ? null : pair.background,
      clipBehavior: clipBehavior,
      shape: tone == AppTone.neutral
          ? themedShape
          : RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadii.card),
              side: BorderSide(color: pair.foreground.withValues(alpha: 0.18)),
            ),
      child: tone == AppTone.neutral
          ? content
          : DefaultTextStyle.merge(
              style: TextStyle(color: pair.foreground),
              child: IconTheme.merge(
                data: IconThemeData(color: pair.foreground),
                child: content,
              ),
            ),
    );
  }
}

class AppChoiceTile extends StatelessWidget {
  const AppChoiceTile({
    required this.selected,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.semanticLabel,
    super.key,
  });

  final bool selected;
  final IconData icon;
  final String title;
  final String subtitle;
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
      label: semanticLabel ?? '$title. $subtitle',
      child: ExcludeSemantics(
        child: Card(
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
    this.icon = Icons.info_outline,
    this.tone = AppTone.neutral,
    this.actionLabel,
    this.onAction,
    super.key,
  });

  final String title;
  final String message;
  final IconData icon;
  final AppTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final pair = appToneColors(context, tone);
    return Semantics(
      container: true,
      liveRegion: tone == AppTone.error,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: pair.background,
          borderRadius: BorderRadius.circular(AppRadii.control),
          border: Border.all(color: pair.foreground.withValues(alpha: 0.18)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(child: Icon(icon, color: pair.foreground)),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: pair.foreground,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      message,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: pair.foreground),
                    ),
                    if (actionLabel != null && onAction != null) ...[
                      const SizedBox(height: AppSpacing.xs),
                      Theme(
                        data: Theme.of(context).copyWith(
                          textButtonTheme: TextButtonThemeData(
                            style: Theme.of(context).textButtonTheme.style
                                ?.copyWith(
                                  foregroundColor: WidgetStatePropertyAll(
                                    pair.foreground,
                                  ),
                                ),
                          ),
                        ),
                        child: AppButton.text(
                          label: actionLabel!,
                          onPressed: onAction,
                        ),
                      ),
                    ],
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
    final pair = appToneColors(context, tone);
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
              ExcludeSemantics(child: Icon(icon, color: pair.foreground)),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: AppSectionHeader(
                  title: title,
                  subtitle: message,
                  titleStyle: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: pair.foreground,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Align(alignment: Alignment.centerLeft, child: action),
        ],
      ),
    );
  }
}
