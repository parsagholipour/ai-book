import 'package:flutter/material.dart';

import 'app_tokens.dart';

class AppScreenLayout extends StatelessWidget {
  const AppScreenLayout({
    required this.children,
    this.padding = AppInsets.screen,
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
          const SizedBox(height: AppSpacing.xxs),
          Text(
            subtitle!,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ],
    );
    if (icon == null && action == null) return headerText;

    return Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
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
                const SizedBox(width: AppSpacing.xs),
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
