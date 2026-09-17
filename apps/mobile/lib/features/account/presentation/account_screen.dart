import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/app_components.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../billing/data/billing_repository.dart';
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
        children: [
          if (session != null) AccountIdentityHeader(user: session.user),
          AccountOverviewCard(
            billing: billing,
            onAddCredits: () => openAccountBillingPaywall(context, ref),
            onManagePlan: () => context.push('/account/plan'),
            onRetry: () => ref.invalidate(billingProvider),
          ),
          AppSettingsSection(
            title: 'Billing',
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
                onTap: () {
                  ref.invalidate(archivedChatSessionsProvider);
                  context.push('/account/archived-chats');
                },
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
            ],
          ),
          AppSettingsSection(
            title: 'Privacy',
            children: [
              AppSettingsRow(
                key: const ValueKey('account-privacy-row'),
                icon: Icons.privacy_tip_outlined,
                title: 'Privacy & data',
                onTap: () => context.push('/account/privacy'),
              ),
            ],
          ),
          AppSettingsSection(
            title: 'Help & legal',
            children: [
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
            Text(
              version,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
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
