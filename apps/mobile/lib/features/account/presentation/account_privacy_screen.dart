import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
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
  String? _requestedFor;

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Privacy & data')),
      body: AppScreenLayout(
        maxContentWidth: 640,
        children: [
          AccountPrivacyControls(
            config: config,
            // The app bar already names the screen.
            showHeading: false,
            requestingDeletion: _requestingDeletion,
            requestedFor: _requestedFor,
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
      AppHaptics.commit();
      if (receipt.status == 'pending') {
        setState(() => _requestedFor = receipt.email);
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
///
/// Reads top to bottom from reassurance to consequence: how the data is used,
/// where to see it, and — set well apart, in the error tone — the one thing
/// that cannot be taken back.
class AccountPrivacyControls extends StatelessWidget {
  const AccountPrivacyControls({
    required this.config,
    required this.onRequestDeletion,
    this.requestingDeletion = false,
    this.requestedFor,
    this.showHeading = true,
    super.key,
  });

  final AppConfig config;
  final bool requestingDeletion;

  /// The email a deletion request was just filed for, once the server has it.
  final String? requestedFor;

  /// Off when the surrounding screen's app bar already carries the title.
  final bool showHeading;
  final Future<void> Function() onRequestDeletion;

  static const _intro = 'How Tomeza uses AI, what it keeps, and how to leave.';

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showHeading)
          AppSectionHeader(
            title: 'Privacy & data',
            subtitle: _intro,
            titleStyle: text.headlineSmall?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xxs),
            child: Text(
              _intro,
              style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
          ),
        const SizedBox(height: AppSpacing.xs),
        const AppSettingsSection(
          title: 'How your data is used',
          children: [
            _Fact(
              icon: Icons.auto_awesome_outlined,
              title: 'AI writes your books',
              body:
                  'Books, page previews, covers, and visuals are generated with AI from your prompt and the options you choose.',
            ),
            _Fact(
              icon: Icons.upload_file_outlined,
              title: 'Files you upload',
              body: 'Uploaded source files are kept for up to 180 days.',
            ),
            _Fact(
              icon: Icons.menu_book_outlined,
              title: 'Your books',
              body:
                  'Projects and generated assets stay until you delete them or the account.',
            ),
            _Fact(
              icon: Icons.receipt_long_outlined,
              title: 'Records we may keep',
              body:
                  'Limited billing, fraud, security, moderation, support, dispute, and legal records may be retained as required.',
            ),
          ],
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
        // The one irreversible action gets its own space, so it is never
        // reached by a thumb aiming for something above it.
        const SizedBox(height: AppSpacing.xl),
        _DeleteAccountCard(
          requesting: requestingDeletion,
          requestedFor: requestedFor,
          onRequest: onRequestDeletion,
        ),
      ],
    );
  }
}

/// A statement about the data with no action on it: an icon tile, a title, and
/// the sentence, laid out like a settings row so the two sit together.
class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(AppRadii.compact),
                ),
                child: SizedBox.square(
                  dimension: 36,
                  child: Icon(icon, size: 20, color: colors.primary),
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
                    style: text.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    body,
                    style: text.bodyMedium?.copyWith(
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

class _DeleteAccountCard extends StatelessWidget {
  const _DeleteAccountCard({
    required this.requesting,
    required this.requestedFor,
    required this.onRequest,
  });

  final bool requesting;
  final String? requestedFor;
  final Future<void> Function() onRequest;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final text = theme.textTheme;
    final tone = appToneColors(context, AppTone.error);
    final requested = requestedFor != null;

    Widget point(String line) => Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xxs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(
              top: 7,
              end: AppSpacing.xs,
            ),
            child: ExcludeSemantics(
              child: Container(
                width: 5,
                height: 5,
                decoration: BoxDecoration(
                  color: tone.foreground,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
          Expanded(child: Text(line)),
        ],
      ),
    );

    return AppCard(
      tone: AppTone.error,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ExcludeSemantics(
                child: Icon(Icons.delete_forever_outlined, color: tone.accent),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Delete account',
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          const Text(
            'This asks us to delete your account and everything in it.',
          ),
          point(
            'Projects and user content are removed, apart from the limited records we may have to keep.',
          ),
          point('We verify each request and aim to finish within 30 days.'),
          point(
            'It does not cancel a Google Play subscription. Cancel that separately in Google Play.',
          ),
          const SizedBox(height: AppSpacing.md),
          if (requested) ...[
            Semantics(
              liveRegion: true,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ExcludeSemantics(
                    child: Icon(
                      Icons.check_circle_outline,
                      size: 18,
                      color: tone.foreground,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      'Request received for $requestedFor. We will be in touch if we need anything.',
                      style: text.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          Theme(
            // Outlined in the notice's own colour, so the button belongs to the
            // card that warns about it rather than to the neutral controls.
            data: theme.copyWith(
              outlinedButtonTheme: OutlinedButtonThemeData(
                style: theme.outlinedButtonTheme.style?.copyWith(
                  foregroundColor: WidgetStatePropertyAll(tone.foreground),
                  side: WidgetStatePropertyAll(
                    BorderSide(color: colors.error.withValues(alpha: 0.7)),
                  ),
                ),
              ),
            ),
            child: AppButton.outlined(
              onPressed: requesting ? null : () => onRequest(),
              loading: requesting,
              loadingLabel: 'Requesting account deletion',
              leading: const Icon(Icons.delete_outline),
              label: 'Request account deletion',
              expanded: true,
            ),
          ),
        ],
      ),
    );
  }
}

/// The last question before a deletion request is sent: what it does, and room
/// for a note to support. Cancelling returns null and sends nothing.
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
      scrollable: true,
      title: const Text('Request account deletion'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'This sends a request to delete your account and everything in it. '
            'We verify each request before anything is removed.',
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _reasonController,
            decoration: const InputDecoration(
              labelText: 'Optional note',
              hintText: 'Anything support should know?',
            ),
            textCapitalization: TextCapitalization.sentences,
            minLines: 3,
            maxLines: 5,
          ),
        ],
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Cancel',
        ),
        AppButton.destructive(
          onPressed: () => Navigator.of(context).pop(_reasonController.text),
          label: 'Send request',
        ),
      ],
    );
  }
}
