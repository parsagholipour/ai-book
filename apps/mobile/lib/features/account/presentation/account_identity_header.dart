import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/domain/auth_models.dart';

class AccountIdentityHeader extends StatelessWidget {
  const AccountIdentityHeader({required this.user, super.key});

  final AuthUser user;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final hasName = user.displayName?.trim().isNotEmpty ?? false;
    final memberSince = MaterialLocalizations.of(
      context,
    ).formatMonthYear(user.createdAt.toLocal());

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        children: [
          CircleAvatar(
            radius: 28,
            backgroundColor: colors.primaryContainer,
            foregroundColor: colors.onPrimaryContainer,
            child: Text(
              user.initials,
              style: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  user.displayLabel,
                  style: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                if (hasName) ...[
                  const SizedBox(height: 2),
                  Text(
                    user.email,
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
                const SizedBox(height: 2),
                Text(
                  'Member since $memberSince',
                  style: text.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
