import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/app_components.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../billing/data/billing_repository.dart';
import '../../notifications/presentation/book_notifications_offer.dart';
import '../../characters/presentation/character_library_screen.dart';
import '../../projects/data/creation_repository.dart';
import '../data/app_version.dart';
import '../data/appearance_store.dart';
import '../domain/appearance_prefs.dart';
import 'account_billing_copy.dart';
import 'account_credit_history_row.dart';
import 'account_identity_header.dart';
import 'account_links.dart';
import 'account_overview_card.dart';
import 'account_paywall.dart';
import 'appearance_sheet.dart';

/// Account hub: who you are, what you have, and every setting, grouped by what
/// it is about rather than by which screen it opens.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(appConfigProvider);
    final billing = ref.watch(billingProvider);
    final session = ref.watch(authControllerProvider).asData?.value;
    final appearance =
        ref.watch(appearanceModeProvider).value ?? AppearanceMode.system;
    final version = ref.watch(appVersionProvider).asData?.value;
    final loggingOut = ref.watch(authControllerProvider).isLoading;
    final plan = billing.asData?.value;

    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: AppScreenLayout(
        maxContentWidth: 640,
        children: [
          if (session != null) AccountIdentityHeader(user: session.user),
          AccountOverviewCard(
            billing: billing,
            onGetCredits: () => openAccountBillingPaywall(context, ref),
            onRetry: () => ref.invalidate(billingProvider),
          ),
          AppSettingsSection(
            title: 'Plan & credits',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-plan-row'),
                icon: Icons.workspace_premium_outlined,
                title: 'Plan & billing',
                subtitle: hubPlanSubtitle(context, plan),
                onTap: () => context.push('/account/plan'),
              ),
              AccountCreditHistoryRow(
                key: const ValueKey('account-credit-history'),
              ),
            ],
          ),
          AppSettingsSection(
            title: 'Library',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-archived-chats'),
                icon: Icons.archive_outlined,
                title: 'Archived chats',
                subtitle: 'Chats you have put away',
                onTap: () {
                  ref.invalidate(archivedChatSessionsProvider);
                  context.push('/account/archived-chats');
                },
              ),
              AppSettingsRow(
                key: const ValueKey('account-characters'),
                icon: Icons.people_outline,
                title: 'Characters',
                subtitle: 'People and creatures your books can reuse',
                onTap: () => Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) => const CharacterLibraryScreen(),
                  ),
                ),
              ),
            ],
          ),
          AppSettingsSection(
            title: 'Preferences',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-appearance'),
                icon: Icons.palette_outlined,
                title: 'Appearance',
                value: appearance.label,
                onTap: () => showAppearanceSheet(context),
              ),
              const BookNotificationsSettingsRow(),
            ],
          ),
          AppSettingsSection(
            title: 'Privacy & help',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-privacy-row'),
                icon: Icons.privacy_tip_outlined,
                title: 'Privacy & data',
                subtitle: 'How AI is used, what we keep, deleting your account',
                onTap: () => context.push('/account/privacy'),
              ),
              AppSettingsRow(
                key: const ValueKey('account-support'),
                icon: Icons.support_agent_outlined,
                title: 'Contact support',
                subtitle: config.supportEmail,
                external: true,
                onTap: () => openAccountUri(
                  context,
                  Uri(scheme: 'mailto', path: config.supportEmail),
                  config.supportEmail,
                ),
              ),
            ],
          ),
          AppSettingsSection(
            title: 'Legal',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-privacy-policy'),
                icon: Icons.policy_outlined,
                title: 'Privacy policy',
                subtitle: config.privacyPolicyUrl.toString(),
                external: true,
                onTap: () => openAccountUri(
                  context,
                  config.privacyPolicyUrl,
                  config.privacyPolicyUrl.toString(),
                ),
              ),
              AppSettingsRow(
                key: const ValueKey('account-terms'),
                icon: Icons.description_outlined,
                title: 'Terms of service',
                subtitle: config.termsOfServiceUrl.toString(),
                external: true,
                onTap: () => openAccountUri(
                  context,
                  config.termsOfServiceUrl,
                  config.termsOfServiceUrl.toString(),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          AppButton.outlined(
            key: const ValueKey('account-log-out'),
            onPressed: loggingOut ? null : () => _logOut(context, ref),
            loading: loggingOut,
            loadingLabel: 'Logging out',
            leading: const Icon(Icons.logout),
            label: 'Log out',
            expanded: true,
          ),
          if (version != null) ...[
            const SizedBox(height: AppSpacing.md),
            _VersionFooter(version: version),
          ],
        ],
      ),
    );
  }
}

class _VersionFooter extends StatelessWidget {
  const _VersionFooter({required this.version});

  final String version;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        TomezaBrandMark(
          size: 20,
          color: colors.onSurfaceVariant.withValues(alpha: 0.6),
        ),
        const SizedBox(height: AppSpacing.xxs),
        Text(
          version,
          textAlign: TextAlign.center,
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
      ],
    );
  }
}

Future<void> _logOut(BuildContext context, WidgetRef ref) async {
  final confirmed = await showAppConfirmationDialog(
    context,
    title: 'Log out of this device?',
    confirmLabel: 'Log out',
  );
  if (!confirmed || !context.mounted) {
    return;
  }
  await ref.read(authControllerProvider.notifier).logout();
}
