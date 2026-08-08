import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../domain/legal_gate.dart';
import 'auth_controller.dart';

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

class _LegalAcceptanceScreenState
    extends ConsumerState<LegalAcceptanceScreen> {
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(appConfigProvider);
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Icon(
                        Icons.policy_outlined,
                        size: 42,
                        color: colors.primary,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'The terms have been updated',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'By continuing, you agree to the updated Terms and acknowledge the Privacy Policy.',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 20),
                      Wrap(
                        alignment: WrapAlignment.center,
                        spacing: 8,
                        children: [
                          TextButton.icon(
                            onPressed: () => _open(config.termsOfServiceUrl),
                            icon: const Icon(Icons.open_in_new, size: 16),
                            label: const Text('Terms'),
                          ),
                          TextButton.icon(
                            onPressed: () => _open(config.privacyPolicyUrl),
                            icon: const Icon(Icons.open_in_new, size: 16),
                            label: const Text('Privacy Policy'),
                          ),
                        ],
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          _error!,
                          style: TextStyle(color: colors.error),
                          textAlign: TextAlign.center,
                        ),
                      ],
                      const SizedBox(height: 18),
                      FilledButton.icon(
                        onPressed: _busy ? null : _accept,
                        icon: _busy
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.check),
                        label: const Text('Agree and continue'),
                      ),
                      const SizedBox(height: 10),
                      OutlinedButton(
                        onPressed: _busy ? null : _notNow,
                        child: const Text('Not now'),
                      ),
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => ref
                                  .read(authControllerProvider.notifier)
                                  .logout(),
                        child: const Text('Log out'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _accept() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .acceptCurrentLegalDocuments();
      if (mounted) context.go('/home');
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
    ref.read(legalGateDismissedProvider.notifier).dismiss();
    context.go('/home');
  }

  Future<void> _open(Uri uri) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && mounted) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(content: Text('That legal page could not be opened.')),
      );
    }
  }
}
