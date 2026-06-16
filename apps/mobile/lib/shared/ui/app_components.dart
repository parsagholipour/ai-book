import 'package:flutter/material.dart';

enum AppNoticeTone { neutral, info, success, warning, error }

class AppScreenLayout extends StatelessWidget {
  const AppScreenLayout({
    required this.children,
    this.padding = const EdgeInsets.fromLTRB(18, 8, 18, 32),
    this.maxContentWidth,
    this.physics,
    super.key,
  });

  final List<Widget> children;
  final EdgeInsetsGeometry padding;
  final double? maxContentWidth;
  final ScrollPhysics? physics;

  @override
  Widget build(BuildContext context) {
    Widget content = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );

    if (maxContentWidth != null) {
      content = Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxContentWidth!),
          child: content,
        ),
      );
    }

    return ListView(physics: physics, padding: padding, children: [content]);
  }
}

class AppSectionHeader extends StatelessWidget {
  const AppSectionHeader({
    required this.title,
    this.subtitle,
    this.icon,
    this.action,
    this.titleStyle,
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? action;
  final TextStyle? titleStyle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final headerText = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            title,
            style:
                titleStyle ??
                Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        if (subtitle != null) ...[
          const SizedBox(height: 4),
          Text(
            subtitle!,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ],
    );

    if (icon == null && action == null) {
      return headerText;
    }

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      crossAxisAlignment: WrapCrossAlignment.center,
      alignment: WrapAlignment.spaceBetween,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 0, maxWidth: 520),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (icon != null) ...[
                Icon(icon, color: colors.primary, size: 22),
                const SizedBox(width: 8),
              ],
              Flexible(child: headerText),
            ],
          ),
        ),
        ?action,
      ],
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
          child: InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 72),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox.square(
                      dimension: 48,
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
                    const SizedBox(width: 10),
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
                          const SizedBox(height: 4),
                          Text(
                            subtitle,
                            style: Theme.of(
                              context,
                            ).textTheme.bodyMedium?.copyWith(color: support),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
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
    this.tone = AppNoticeTone.neutral,
    this.semanticLabel,
    super.key,
  });

  final String label;
  final IconData? icon;
  final AppNoticeTone tone;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pair = _toneColors(colors, tone);
    return Semantics(
      label: semanticLabel ?? label,
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: pair.background,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
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
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: colors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(8),
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
    this.tone = AppNoticeTone.neutral,
    this.actionLabel,
    this.onAction,
    super.key,
  });

  final String title;
  final String message;
  final IconData icon;
  final AppNoticeTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pair = _toneColors(colors, tone);
    return Semantics(
      container: true,
      liveRegion: tone == AppNoticeTone.error,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: pair.background,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: pair.foreground.withValues(alpha: 0.18)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(child: Icon(icon, color: pair.foreground)),
              const SizedBox(width: 10),
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
                    const SizedBox(height: 4),
                    Text(
                      message,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: pair.foreground),
                    ),
                    if (actionLabel != null && onAction != null) ...[
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: onAction,
                        style: TextButton.styleFrom(
                          foregroundColor: pair.foreground,
                        ),
                        child: Text(actionLabel!),
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
    this.tone = AppNoticeTone.neutral,
    this.destructive = false,
    super.key,
  });

  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback? onAction;
  final IconData icon;
  final Widget? actionIcon;
  final AppNoticeTone tone;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pair = _toneColors(colors, tone);
    final buttonStyle = destructive
        ? FilledButton.styleFrom(
            backgroundColor: colors.error,
            foregroundColor: colors.onError,
          )
        : null;

    return Card(
      color: tone == AppNoticeTone.neutral ? null : pair.background,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(child: Icon(icon, color: pair.foreground)),
                const SizedBox(width: 10),
                Expanded(
                  child: AppSectionHeader(
                    title: title,
                    subtitle: message,
                    titleStyle: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(
                          color: pair.foreground,
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                onPressed: onAction,
                style: buttonStyle,
                icon: actionIcon ?? const Icon(Icons.arrow_forward),
                label: Text(actionLabel),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class AppBottomActionBar extends StatelessWidget {
  const AppBottomActionBar({
    required this.primary,
    this.secondary,
    this.padding = const EdgeInsets.fromLTRB(18, 10, 18, 18),
    super.key,
  });

  final Widget primary;
  final Widget? secondary;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: SafeArea(
        child: Padding(
          padding: padding,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final textScale = MediaQuery.textScalerOf(context).scale(1);
              final stacked = constraints.maxWidth < 360 || textScale >= 1.35;

              if (secondary == null) {
                return SizedBox(width: double.infinity, child: primary);
              }

              if (stacked) {
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [secondary!, const SizedBox(height: 10), primary],
                );
              }

              return Row(
                children: [
                  secondary!,
                  const SizedBox(width: 12),
                  Expanded(child: primary),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class AppConfirmationDialog extends StatelessWidget {
  const AppConfirmationDialog({
    required this.title,
    required this.message,
    required this.confirmLabel,
    this.cancelLabel = 'Cancel',
    this.destructive = false,
    super.key,
  });

  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: destructive
              ? FilledButton.styleFrom(
                  backgroundColor: colors.error,
                  foregroundColor: colors.onError,
                )
              : null,
          child: Text(confirmLabel),
        ),
      ],
    );
  }
}

Future<bool> showAppConfirmationDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AppConfirmationDialog(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      cancelLabel: cancelLabel,
      destructive: destructive,
    ),
  );
  return result ?? false;
}

({Color background, Color foreground}) _toneColors(
  ColorScheme colors,
  AppNoticeTone tone,
) {
  return switch (tone) {
    AppNoticeTone.neutral => (
      background: colors.surfaceContainerHigh,
      foreground: colors.onSurfaceVariant,
    ),
    AppNoticeTone.info => (
      background: colors.tertiaryContainer,
      foreground: colors.onTertiaryContainer,
    ),
    AppNoticeTone.success => (
      background: colors.primaryContainer,
      foreground: colors.onPrimaryContainer,
    ),
    AppNoticeTone.warning => (
      background: colors.secondaryContainer,
      foreground: colors.onSecondaryContainer,
    ),
    AppNoticeTone.error => (
      background: colors.errorContainer,
      foreground: colors.onErrorContainer,
    ),
  };
}
