import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/presentation/auth_widgets.dart';
import '../data/app_update_repository.dart';
import '../domain/app_update.dart';

/// Shown, with no way past it, while the server says this build must update.
///
/// The router sends every location here for as long as the status is
/// required, signed in or not — the server is refusing every mobile request
/// from this build anyway. "Check again" is for the operator relaxing the
/// policy; an installed update restarts the app on its own.
class AppUpdateRequiredScreen extends ConsumerStatefulWidget {
  const AppUpdateRequiredScreen({super.key});

  @override
  ConsumerState<AppUpdateRequiredScreen> createState() =>
      _AppUpdateRequiredScreenState();
}

class _AppUpdateRequiredScreenState
    extends ConsumerState<AppUpdateRequiredScreen> {
  bool _checking = false;
  bool _storeUnavailable = false;

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(appUpdateStatusProvider);
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return AuthPageShell(
      maxWidth: 520,
      builder: (context, compact) => [
        Center(
          child: ExcludeSemantics(
            child: Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: colors.primaryContainer,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Icon(
                Icons.system_update_outlined,
                size: 32,
                color: colors.onPrimaryContainer,
              ),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        Semantics(
          header: true,
          child: Text(
            'Update Tomeza to keep going',
            textAlign: TextAlign.center,
            style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          status.message ??
              'This version of Tomeza is no longer supported. Your books, '
                  'characters and credits are safe and waiting in the new '
                  'version.',
          textAlign: TextAlign.center,
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
        if (status.latestVersion != null) ...[
          const SizedBox(height: AppSpacing.xs),
          Text(
            'Version ${status.latestVersion} is available.',
            textAlign: TextAlign.center,
            style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        if (_storeUnavailable) ...[
          const AppInlineNotice(
            icon: Icons.info_outline,
            title: 'Open your app store to update',
            message: 'Search for Tomeza and install the latest version.',
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        AppButton.primary(
          onPressed: _openStore,
          leading: const Icon(Icons.download_outlined),
          label: 'Update now',
          expanded: true,
        ),
        const SizedBox(height: AppSpacing.sm),
        AppButton.outlined(
          onPressed: _checking ? null : _checkAgain,
          loading: _checking,
          loadingLabel: 'Checking',
          label: 'Check again',
          expanded: true,
        ),
      ],
    );
  }

  Future<void> _openStore() async {
    final opened = await ref.read(storeListingOpenerProvider)();
    if (mounted) setState(() => _storeUnavailable = !opened);
  }

  Future<void> _checkAgain() async {
    setState(() => _checking = true);
    await ref.read(appUpdateCheckerProvider).refresh();
    if (mounted) setState(() => _checking = false);
  }
}
