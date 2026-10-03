import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../data/auth_repository.dart';
import '../data/google_sign_in_client.dart';
import 'auth_controller.dart';
import 'google_auth_dialogs.dart';

class GoogleAuthButton extends ConsumerStatefulWidget {
  const GoogleAuthButton({
    required this.disabled,
    required this.onBusyChanged,
    required this.onError,
    this.termsAccepted = false,
    this.ageGuardianAttested = false,
    super.key,
  });

  final bool disabled;
  final bool termsAccepted;
  final bool ageGuardianAttested;
  final ValueChanged<bool> onBusyChanged;
  final ValueChanged<String?> onError;

  @override
  ConsumerState<GoogleAuthButton> createState() => _GoogleAuthButtonState();
}

class _GoogleAuthButtonState extends ConsumerState<GoogleAuthButton> {
  bool _busy = false;
  bool _promptOpen = false;

  Future<T> _prompt<T>(Future<T> Function() show) async {
    setState(() => _promptOpen = true);
    try {
      return await show();
    } finally {
      if (mounted) setState(() => _promptOpen = false);
    }
  }

  Future<void> _signIn() async {
    if (_busy || widget.disabled) return;
    final client = ref.read(googleSignInClientProvider);
    if (client == null) return;
    setState(() => _busy = true);
    widget.onBusyChanged(true);
    widget.onError(null);
    try {
      final idToken = await client.authenticate();
      if (idToken == null || !mounted) return;
      var terms = widget.termsAccepted;
      var age = widget.ageGuardianAttested;
      String? password;
      while (mounted) {
        try {
          final session = await ref
              .read(authRepositoryProvider)
              .signInWithGoogle(
                idToken: idToken,
                termsAccepted: terms,
                ageGuardianAttested: age,
                password: password,
              );
          if (mounted) {
            ref.read(authControllerProvider.notifier).adoptSession(session);
          }
          return;
        } on ApiException catch (error) {
          if (!mounted) return;
          if (error.code == 'GOOGLE_SIGNUP_REQUIRED') {
            if (!await _prompt(
              () => confirmGoogleSignup(context, ref.read(appConfigProvider)),
            )) {
              return;
            }
            terms = true;
            age = true;
          } else if (error.code == 'GOOGLE_LINK_REQUIRED' ||
              (error.code == 'INVALID_CREDENTIALS' && password != null)) {
            password = await _prompt(
              () => confirmGoogleLink(
                context,
                error: error.code == 'INVALID_CREDENTIALS'
                    ? error.message
                    : null,
              ),
            );
            if (password == null) return;
          } else {
            rethrow;
          }
        }
      }
    } catch (error) {
      if (mounted) widget.onError(userFacingError(error));
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        widget.onBusyChanged(false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => AppButton.outlined(
    onPressed: widget.disabled || _busy ? null : _signIn,
    loading: _busy && !_promptOpen,
    loadingLabel: 'Connecting to Google',
    label: 'Continue with Google',
    leading: Image.asset(
      'assets/brand/google-g.png',
      width: 20,
      height: 20,
      fit: BoxFit.contain,
      excludeFromSemantics: true,
    ),
    expanded: true,
  );
}
