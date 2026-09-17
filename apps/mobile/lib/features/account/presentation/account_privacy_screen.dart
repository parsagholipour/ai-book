import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/account_repository.dart';
import 'account_links.dart';

class AccountPrivacyScreen extends ConsumerStatefulWidget {
  const AccountPrivacyScreen({super.key});

  @override
  ConsumerState<AccountPrivacyScreen> createState() =>
      _AccountPrivacyScreenState();
}

class _AccountPrivacyScreenState extends ConsumerState<AccountPrivacyScreen> {
  bool _requestingDeletion = false;

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Privacy & data')),
      body: AppScreenLayout(
        children: [
          AccountPrivacyControls(
            config: config,
            requestingDeletion: _requestingDeletion,
            onRequestDeletion: _requestAccountDeletion,
          ),
        ],
      ),
    );
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
      ScaffoldMessenger.of(context).showAppSnackBar(
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
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    } finally {
      if (mounted) {
        setState(() => _requestingDeletion = false);
      }
    }
  }
}

/// Public so it can be pumped on its own.
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
          title: 'Privacy & data',
          subtitle: 'How Tomeza uses AI, what it keeps, and how to leave.',
          titleStyle: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: AppSpacing.md),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'How Tomeza uses AI',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 6),
              Text(
                'Books, page previews, covers, and visuals are generated with AI from your prompt and product presets.',
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Data retention',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 6),
              Text(
                'Uploaded source files are kept for up to 180 days. Projects and generated assets remain until you delete them or the account. Limited billing, fraud, security, moderation, support, dispute, and legal records may be retained as required.',
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
        AppSettingsSection(
          title: 'Your data',
          children: [
            AppSettingsRow(
              icon: Icons.manage_accounts_outlined,
              title: 'Account deletion page',
              subtitle: config.accountDeletionUrl.toString(),
              external: true,
              onTap: () => openAccountUri(
                context,
                config.accountDeletionUrl,
                config.accountDeletionUrl.toString(),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        AppCard(
          tone: AppTone.error,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Delete account',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 6),
              const Text(
                'We target verified requests within 30 days. Account deletion removes projects and user content, subject to limited retained records. It does not cancel a Google Play subscription; cancel that separately in Google Play.',
              ),
              const SizedBox(height: 12),
              AppButton.outlined(
                onPressed: requestingDeletion
                    ? null
                    : () => onRequestDeletion(),
                loading: requestingDeletion,
                loadingLabel: 'Requesting account deletion',
                leading: const Icon(Icons.delete_outline),
                label: 'Request account deletion',
              ),
            ],
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
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Cancel',
        ),
        AppButton.primary(
          onPressed: () => Navigator.of(context).pop(_reasonController.text),
          label: 'Send request',
        ),
      ],
    );
  }
}
