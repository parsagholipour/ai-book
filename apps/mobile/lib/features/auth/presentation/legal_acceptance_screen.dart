import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../sharing/data/pending_remix.dart';
import '../data/pending_location.dart';
import '../domain/legal_gate.dart';
import 'auth_controller.dart';
import 'auth_widgets.dart';

/// Shown when the account's accepted Terms or Privacy Policy version is no
/// longer the current one. New accounts attest at signup and never see this;
/// agreeing here is deliberately one tap, because the age/guardian attestation
/// from signup does not expire when the documents change. "Not now" lets the
/// reader keep reading — the server refuses writes until they agree, and that
/// refusal re-opens this screen.
class LegalAcceptanceScreen extends ConsumerStatefulWidget {
  const LegalAcceptanceScreen({super.key});

  @override
  ConsumerState<LegalAcceptanceScreen> createState() =>
      _LegalAcceptanceScreenState();
}

class _LegalAcceptanceScreenState extends ConsumerState<LegalAcceptanceScreen> {
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);
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
                Icons.policy_outlined,
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
            'The terms have been updated',
            textAlign: TextAlign.center,
            style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          'By continuing, you agree to the updated Terms and acknowledge the Privacy Policy.',
          textAlign: TextAlign.center,
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: AppSpacing.lg),
        Card(
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              AppSettingsRow(
                icon: Icons.description_outlined,
                title: 'Terms of Service',
                subtitle: 'The rules for using Tomeza',
                external: true,
                onTap: () => _open(config.termsOfServiceUrl),
              ),
              const Divider(height: 1),
              AppSettingsRow(
                icon: Icons.privacy_tip_outlined,
                title: 'Privacy Policy',
                subtitle: 'What we collect and how it is used',
                external: true,
                onTap: () => _open(config.privacyPolicyUrl),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        if (_error != null) ...[
          AppInlineNotice(
            icon: Icons.error_outline,
            tone: AppTone.error,
            title: 'Could not save your agreement',
            message: _error!,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        AppButton.primary(
          onPressed: _busy ? null : _accept,
          loading: _busy,
          loadingLabel: 'Agreeing and continuing',
          leading: const Icon(Icons.check),
          label: 'Agree and continue',
          expanded: true,
        ),
        const SizedBox(height: AppSpacing.sm),
        AppButton.outlined(
          onPressed: _busy ? null : _notNow,
          label: 'Not now',
          expanded: true,
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          'You can keep reading your books without agreeing. Creating and '
          'editing wait until you do.',
          textAlign: TextAlign.center,
          style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        AppButton.text(
          onPressed: _busy
              ? null
              : () => ref.read(authControllerProvider.notifier).logout(),
          label: 'Log out',
          expanded: true,
        ),
      ],
    );
  }

  Future<void> _accept() async {
    // Read before agreeing: the accepted session refreshes the router, whose
    // own landing can reach the screen the app was opened on — and let it go —
    // before this resumes.
    final landing = _landing();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .acceptCurrentLegalDocuments();
      if (mounted) context.go(landing);
    } catch (error) {
      if (mounted) {
        setState(() => _error = userFacingError(error));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Reading stays available without agreeing; creating and editing do not.
  /// The server enforces that split, so this only steps out of the way.
  void _notNow() {
    final landing = _landing();
    ref.read(legalGateDismissedProvider.notifier).dismiss();
    context.go(landing);
  }

  /// Where the reader was going before the terms stood in the way — a remix
  /// link or the screen the app was opened on — or home.
  String _landing() => landingLocation(
    ref.read(pendingRemixProvider),
    ref.read(pendingLocationProvider),
  );

  Future<void> _open(Uri uri) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(content: Text('That legal page could not be opened.')),
      );
    }
  }
}
