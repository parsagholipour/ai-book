import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/account_repository.dart';

class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  bool _requestingDeletion = false;

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);
    final billing = ref.watch(billingProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: AppScreenLayout(
        children: [
          _AccountCreditsCard(
            billing: billing,
            onAddCredits: _openBillingPaywall,
            onRetry: () => ref.invalidate(billingProvider),
          ),
          const SizedBox(height: 12),
          AccountPrivacyControls(
            config: config,
            requestingDeletion: _requestingDeletion,
            onRequestDeletion: _requestAccountDeletion,
          ),
          const SizedBox(height: 12),
          const _AccountSessionCard(),
        ],
      ),
    );
  }

  Future<void> _openBillingPaywall() async {
    await showBillingPaywall(
      context,
      title: 'Add book credits',
      message:
          'Credits are used when you approve a full book or unlock finished exports.',
    );
    if (mounted) {
      ref.invalidate(billingProvider);
    }
  }

  Future<void> _requestAccountDeletion() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const AccountDeletionRequestDialog(),
    );
    if (reason == null || !mounted) {
      return;
    }

    setState(() => _requestingDeletion = true);
    try {
      final receipt = await ref
          .read(accountRepositoryProvider)
          .requestAccountDeletion(reason: reason);
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            receipt.status == 'pending'
                ? 'Deletion request received for ${receipt.email}.'
                : 'Deletion request updated.',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    } finally {
      if (mounted) {
        setState(() => _requestingDeletion = false);
      }
    }
  }
}

class _AccountCreditsCard extends StatelessWidget {
  const _AccountCreditsCard({
    required this.billing,
    required this.onAddCredits,
    required this.onRetry,
  });

  final AsyncValue<MobileBilling> billing;
  final VoidCallback onAddCredits;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final balance = billing.when(
      data: (value) => '${value.credits.available} credits available',
      loading: () => 'Checking your credit balance',
      error: (error, stackTrace) => userFacingError(error),
    );

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_balance_wallet_outlined,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Book credits',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(balance, style: TextStyle(color: colors.onSurfaceVariant)),
            const SizedBox(height: 12),
            billing.hasError
                ? OutlinedButton.icon(
                    onPressed: onRetry,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  )
                : FilledButton.icon(
                    onPressed: onAddCredits,
                    icon: const Icon(Icons.add_card_outlined),
                    label: const Text('Add credits'),
                  ),
          ],
        ),
      ),
    );
  }
}

class _AccountSessionCard extends ConsumerWidget {
  const _AccountSessionCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    final loggingOut = authState.isLoading;
    final colors = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Session',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Log out of this device when you are finished.',
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: loggingOut
                  ? null
                  : () => ref.read(authControllerProvider.notifier).logout(),
              icon: loggingOut
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'Logging out',
                      ),
                    )
                  : const Icon(Icons.logout),
              label: const Text('Log out'),
            ),
          ],
        ),
      ),
    );
  }
}

class AccountPrivacyControls extends StatelessWidget {
  const AccountPrivacyControls({
    required this.config,
    required this.onRequestDeletion,
    this.requestingDeletion = false,
    super.key,
  });

  final AppConfig config;
  final bool requestingDeletion;
  final Future<void> Function() onRequestDeletion;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSectionHeader(
          title: 'Privacy and support',
          subtitle: 'Support, policies, AI disclosure, and deletion controls.',
          titleStyle: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SettingsRow(
                  icon: Icons.support_agent_outlined,
                  title: 'Support',
                  value: config.supportEmail,
                ),
                const Divider(height: 24),
                _SettingsRow(
                  icon: Icons.privacy_tip_outlined,
                  title: 'Privacy policy',
                  value: config.privacyPolicyUrl.toString(),
                ),
                const Divider(height: 24),
                _SettingsRow(
                  icon: Icons.description_outlined,
                  title: 'Terms',
                  value: config.termsOfServiceUrl.toString(),
                ),
                const Divider(height: 24),
                _SettingsRow(
                  icon: Icons.manage_accounts_outlined,
                  title: 'Account deletion page',
                  value: config.accountDeletionUrl.toString(),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'AI-generated content',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Books, page previews, covers, and visuals are generated with AI from your prompt and product presets.',
                  style: TextStyle(color: colors.onSurfaceVariant),
                ),
                const SizedBox(height: 14),
                Text(
                  'Data retention',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Deleted projects remove generated project records and local generated files. Billing, safety, moderation, abuse-prevention, and support records may be retained as required.',
                  style: TextStyle(color: colors.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Delete account',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Request deletion of your account and associated app data. Support will review retained billing, safety, and compliance records.',
                  style: TextStyle(color: colors.onSurfaceVariant),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: requestingDeletion
                      ? null
                      : () => onRequestDeletion(),
                  icon: requestingDeletion
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            semanticsLabel: 'Requesting account deletion',
                          ),
                        )
                      : const Icon(Icons.delete_outline),
                  label: const Text('Request account deletion'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class AccountDeletionRequestDialog extends StatefulWidget {
  const AccountDeletionRequestDialog({super.key});

  @override
  State<AccountDeletionRequestDialog> createState() =>
      _AccountDeletionRequestDialogState();
}

class _AccountDeletionRequestDialogState
    extends State<AccountDeletionRequestDialog> {
  final _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Request account deletion'),
      content: TextField(
        controller: _reasonController,
        decoration: const InputDecoration(
          labelText: 'Optional note',
          hintText: 'Anything support should know?',
        ),
        minLines: 3,
        maxLines: 5,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_reasonController.text),
          child: const Text('Send request'),
        ),
      ],
    );
  }
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.icon,
    required this.title,
    required this.value,
  });

  final IconData icon;
  final String title;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: colors.primary),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: 3),
              SelectableText(
                value,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
