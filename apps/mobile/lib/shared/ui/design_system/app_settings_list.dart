import 'package:flutter/material.dart';

import '../haptics.dart';
import 'app_tokens.dart';

/// A labelled group of [AppSettingsRow]s on one card.
class AppSettingsSection extends StatelessWidget {
  const AppSettingsSection({
    required this.title,
    required this.children,
    this.footer,
    super.key,
  });

  final String title;
  final List<Widget> children;

  /// A line of explanation under the card, e.g. what a group of switches does.
  final String? footer;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.xxs,
            AppSpacing.sm,
            AppSpacing.xxs,
            AppSpacing.xs,
          ),
          child: Semantics(
            header: true,
            child: Text(
              title.toUpperCase(),
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                color: colors.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
        Card(
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (var index = 0; index < children.length; index++) ...[
                if (index > 0) const Divider(height: 1),
                children[index],
              ],
            ],
          ),
        ),
        if (footer != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.xs,
              AppSpacing.xs,
              AppSpacing.xs,
              0,
            ),
            child: Text(
              footer!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ),
      ],
    );
  }
}

/// One navigable or informational row inside an [AppSettingsSection].
class AppSettingsRow extends StatelessWidget {
  const AppSettingsRow({
    required this.icon,
    required this.title,
    this.subtitle,
    this.value,
    this.onTap,
    this.external = false,
    this.trailing,
    this.destructive = false,
    super.key,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final String? value;
  final VoidCallback? onTap;
  final bool external;

  /// Replaces the chevron, e.g. with a switch. A row with a switch should
  /// pass the same toggle as [onTap] so the whole row is the target.
  final Widget? trailing;

  /// Draws the row in the error colours: sign out, delete account.
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final accessory =
        trailing ??
        (external
            ? Icon(Icons.open_in_new, size: 18, color: colors.onSurfaceVariant)
            : onTap == null
            ? null
            : Icon(Icons.chevron_right, color: colors.onSurfaceVariant));
    final tileColor = destructive
        ? colors.errorContainer
        : colors.primaryContainer.withValues(alpha: 0.7);
    final tileIcon = destructive ? colors.onErrorContainer : colors.primary;
    final titleColor = destructive ? colors.error : colors.onSurface;

    final row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: AppSizes.minimumTouchTarget),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.xs,
        ),
        child: Row(
          children: [
            DecoratedBox(
              decoration: BoxDecoration(
                color: tileColor,
                borderRadius: BorderRadius.circular(AppRadii.compact),
              ),
              child: SizedBox.square(
                dimension: 36,
                child: Icon(icon, size: 20, color: tileIcon),
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
                      fontWeight: FontWeight.w700,
                      color: titleColor,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: text.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (value != null) ...[
              const SizedBox(width: AppSpacing.xs),
              // Sized to its text, up to 45% of the row. It used to be a plain
              // Flexible sharing the row with an Expanded title, so the two
              // split the leftover width evenly and every value floated at the
              // row's midpoint instead of sitting against the chevron.
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width * 0.45,
                ),
                child: Text(
                  value!,
                  textAlign: TextAlign.end,
                  style: text.labelLarge?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
            if (accessory != null) ...[
              const SizedBox(width: AppSpacing.xxs),
              accessory,
            ],
          ],
        ),
      ),
    );

    if (onTap == null) {
      return row;
    }

    return Semantics(
      button: true,
      label: [
        title,
        if (subtitle != null) subtitle,
        if (value != null) value,
        if (external) 'Opens in another app',
      ].join('. '),
      child: ExcludeSemantics(
        child: InkWell(
          onTap: () {
            AppHaptics.tap();
            onTap!();
          },
          child: row,
        ),
      ),
    );
  }
}
