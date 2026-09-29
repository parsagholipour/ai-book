import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/domain/auth_models.dart';

/// Who is signed in: initials, the name they gave (or the email when they gave
/// none), and how long they have been here.
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
      padding: const EdgeInsetsDirectional.only(
        start: AppSpacing.xxs,
        end: AppSpacing.xxs,
        top: AppSpacing.xs,
        bottom: AppSpacing.md,
      ),
      child: MergeSemantics(
        child: Row(
          children: [
            ExcludeSemantics(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: colors.primary.withValues(alpha: 0.35),
                    width: 2,
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(3),
                  child: CircleAvatar(
                    radius: 30,
                    backgroundColor: colors.primaryContainer,
                    foregroundColor: colors.onPrimaryContainer,
                    child: Text(
                      user.initials,
                      style: text.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    user.displayLabel,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
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
                  const SizedBox(height: AppSpacing.xxs),
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
      ),
    );
  }
}
