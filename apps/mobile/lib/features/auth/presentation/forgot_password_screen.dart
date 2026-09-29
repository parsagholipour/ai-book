import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../data/auth_repository.dart';
import 'auth_code_field.dart';
import 'auth_controller.dart';
import 'auth_widgets.dart';

/// How long "Resend code" waits before it can be pressed again. The server
/// rate-limits the request anyway; the pause is so a reader looking at an empty
/// inbox is told to wait rather than left to hammer a button.
const _resendCooldown = 30;

/// Two steps on one screen: ask for the account email, then take the emailed
/// 6-digit code together with the new password. A successful reset answers
/// with a fresh session, which [AuthController.adoptSession] installs — the
/// router's redirect then walks the reader into the app, already signed in.
///
/// Errors are handled here rather than through the auth controller: the
/// sign-in screen beneath this one listens to the controller too, and a shared
/// error state would announce every failure twice.
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({this.initialEmail, super.key});

  /// Prefilled from whatever the reader had typed on the sign-in screen.
  final String? initialEmail;

  @override
  ConsumerState<ForgotPasswordScreen> createState() =>
      _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _emailController;
  final _codeController = TextEditingController();
  final _passwordController = TextEditingController();
  final _emailFocus = FocusNode();
  final _codeFocus = FocusNode();
  final _passwordFocus = FocusNode();

  Timer? _cooldownTimer;
  int _cooldown = 0;

  bool _codeSent = false;
  bool _submitting = false;
  bool _resending = false;
  bool _obscurePassword = true;
  bool _emailLeft = false;
  bool _passwordLeft = false;
  bool _submitted = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _emailController = TextEditingController(
      text: widget.initialEmail?.trim() ?? '',
    );
    _emailFocus.addListener(() {
      if (!_emailFocus.hasFocus &&
          !_emailLeft &&
          _emailController.text.isNotEmpty) {
        setState(() => _emailLeft = true);
      }
    });
    _passwordFocus.addListener(() {
      if (!_passwordFocus.hasFocus &&
          !_passwordLeft &&
          _passwordController.text.isNotEmpty) {
        setState(() => _passwordLeft = true);
      }
    });
  }

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    _emailController.dispose();
    _codeController.dispose();
    _passwordController.dispose();
    _emailFocus.dispose();
    _codeFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  AutovalidateMode _validateWhen(bool left) => left || _submitted
      ? AutovalidateMode.onUserInteraction
      : AutovalidateMode.disabled;

  void _clearError([String? _]) {
    if (_error != null) setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    return AuthPageShell(
      alignment: Alignment.topCenter,
      // Back arrow only: the heading names the screen, and a duplicate
      // "Reset password" title would shadow the submit button.
      appBar: AppBar(backgroundColor: Colors.transparent),
      builder: (context, compact) => [
        _StepIndicator(step: _codeSent ? 1 : 0),
        const SizedBox(height: AppSpacing.lg),
        AuthHeading(
          title: _codeSent ? 'Check your email' : 'Forgot your password?',
          subtitle: _codeSent
              ? 'We sent a 6-digit code to your email. Enter it below with '
                    'your new password.'
              : 'Enter your account email and we will send you a 6-digit '
                    'code to choose a new password.',
        ),
        const SizedBox(height: AppSpacing.lg),
        _buildForm(context),
      ],
    );
  }

  Widget _buildForm(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    // A locked address should not summon a keyboard it cannot use.
    _emailFocus.canRequestFocus = !_codeSent;
    return Form(
      key: _formKey,
      child: AutofillGroup(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextFormField(
              controller: _emailController,
              focusNode: _emailFocus,
              readOnly: _codeSent || _submitting,
              keyboardType: TextInputType.emailAddress,
              textInputAction: _codeSent
                  ? TextInputAction.none
                  : TextInputAction.done,
              autocorrect: false,
              enableSuggestions: false,
              autofillHints: const [AutofillHints.email],
              autovalidateMode: _validateWhen(_emailLeft),
              onChanged: _clearError,
              decoration: InputDecoration(
                labelText: 'Email',
                prefixIcon: const Icon(Icons.mail_outline),
                // Once the code is out, the address is fixed: it is where the
                // code went. "Use a different email" below is the way back.
                fillColor: _codeSent ? colors.surfaceContainerLow : null,
              ),
              validator: (value) {
                final email = value?.trim() ?? '';
                if (email.isEmpty || !email.contains('@')) {
                  return 'Enter a valid email.';
                }
                return null;
              },
              onFieldSubmitted: (_) => _submit(),
            ),
            AnimatedSize(
              duration: AppMotion.reducedMotion(context)
                  ? Duration.zero
                  : AppMotion.medium,
              curve: AppMotion.standard,
              alignment: Alignment.topCenter,
              child: _codeSent
                  ? _buildCodeStep(context)
                  : const SizedBox(width: double.infinity),
            ),
            const SizedBox(height: AppSpacing.md),
            if (_error != null) ...[
              AppInlineNotice(
                icon: Icons.error_outline,
                tone: AppTone.error,
                title: _codeSent
                    ? 'Could not reset your password'
                    : 'Could not send the code',
                message: _error!,
              ),
              const SizedBox(height: AppSpacing.md),
            ],
            AppButton.primary(
              onPressed: _submitting || _resending ? null : _submit,
              loading: _submitting,
              loadingLabel: _codeSent ? 'Resetting password' : 'Sending code',
              leading: Icon(_codeSent ? Icons.lock_reset : Icons.send_outlined),
              label: _codeSent ? 'Reset password' : 'Send code',
              expanded: true,
            ),
            if (_codeSent) ...[
              const SizedBox(height: AppSpacing.xs),
              Wrap(
                alignment: WrapAlignment.center,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  AppButton.text(
                    onPressed: _submitting || _resending || _cooldown > 0
                        ? null
                        : _resend,
                    loading: _resending,
                    loadingLabel: 'Sending a new code',
                    label: _cooldown > 0
                        ? 'Resend code in ${_clock(_cooldown)}'
                        : 'Resend code',
                  ),
                  AppButton.text(
                    onPressed: _submitting || _resending ? null : _changeEmail,
                    label: 'Use a different email',
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xxs),
                child: Text(
                  'Nothing yet? Check your spam folder.',
                  textAlign: TextAlign.center,
                  style: text.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildCodeStep(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: AppSpacing.lg),
        Row(
          children: [
            Expanded(
              child: Text(
                'Verification code',
                style: text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            AppButton.text(
              onPressed: _submitting ? null : _pasteCode,
              leading: const Icon(Icons.content_paste_outlined, size: 18),
              label: 'Paste code',
            ),
          ],
        ),
        AuthCodeField(
          controller: _codeController,
          focusNode: _codeFocus,
          enabled: !_submitting,
          autovalidate: _submitted,
          errorMessage: 'Enter the 6-digit code from the email.',
          onChanged: _clearError,
          // A finished code is what the reader has been waiting to type; the
          // new password is the only thing left, so hand them the keyboard.
          onCompleted: () => _passwordFocus.requestFocus(),
        ),
        const SizedBox(height: AppSpacing.md),
        TextFormField(
          controller: _passwordController,
          focusNode: _passwordFocus,
          readOnly: _submitting,
          obscureText: _obscurePassword,
          textInputAction: TextInputAction.done,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [AutofillHints.newPassword],
          autovalidateMode: _validateWhen(_passwordLeft),
          onChanged: _clearError,
          decoration: InputDecoration(
            labelText: 'New password',
            helperText: 'Use at least 8 characters.',
            prefixIcon: const Icon(Icons.lock_outline),
            suffixIcon: IconButton(
              tooltip: _obscurePassword ? 'Show password' : 'Hide password',
              onPressed: () =>
                  setState(() => _obscurePassword = !_obscurePassword),
              icon: Icon(
                _obscurePassword
                    ? Icons.visibility_outlined
                    : Icons.visibility_off_outlined,
              ),
            ),
          ),
          validator: (value) {
            if ((value ?? '').length < 8) {
              return 'Use at least 8 characters.';
            }
            return null;
          },
          onFieldSubmitted: (_) => _submit(),
        ),
      ],
    );
  }

  Future<void> _submit() async {
    setState(() {
      _submitted = true;
      _error = null;
    });
    if (!_formKey.currentState!.validate()) {
      AppHaptics.warning();
      return;
    }
    setState(() => _submitting = true);
    try {
      if (_codeSent) {
        await _resetPassword();
      } else {
        await _sendCode();
      }
    } on ApiException catch (error) {
      _fail(userFacingError(error));
    } catch (_) {
      _fail('Something went wrong. Try again.');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  Future<void> _sendCode() async {
    await ref
        .read(authRepositoryProvider)
        .requestPasswordReset(email: _emailController.text);
    if (!mounted) {
      return;
    }
    setState(() {
      _codeSent = true;
      _submitted = false;
    });
    _startCooldown();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _codeFocus.requestFocus();
    });
  }

  Future<void> _resend() async {
    setState(() {
      _resending = true;
      _error = null;
    });
    try {
      await ref
          .read(authRepositoryProvider)
          .requestPasswordReset(email: _emailController.text);
      if (!mounted) return;
      _codeController.clear();
      _startCooldown();
      _showMessage('We sent you a new code.');
      _codeFocus.requestFocus();
    } on ApiException catch (error) {
      _fail(userFacingError(error));
    } catch (_) {
      _fail('Something went wrong. Try again.');
    } finally {
      if (mounted) {
        setState(() => _resending = false);
      }
    }
  }

  Future<void> _resetPassword() async {
    final session = await ref
        .read(authRepositoryProvider)
        .resetPassword(
          email: _emailController.text,
          code: _codeController.text,
          newPassword: _passwordController.text,
        );
    if (!mounted) {
      return;
    }
    TextInput.finishAutofillContext();
    AppHaptics.success();
    _showMessage('Your password has been updated.');
    // Installing the session flips the router's redirect: the reader lands on
    // their books without touching the sign-in form again.
    ref.read(authControllerProvider.notifier).adoptSession(session);
  }

  void _changeEmail() {
    _cooldownTimer?.cancel();
    _codeController.clear();
    _passwordController.clear();
    setState(() {
      _codeSent = false;
      _cooldown = 0;
      _error = null;
      _submitted = false;
    });
    // The field only becomes focusable again once this frame has rebuilt it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _emailFocus.requestFocus();
    });
  }

  Future<void> _pasteCode() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final code = codeFromClipboardText(data?.text);
    if (code == null) {
      _showMessage('There is no 6-digit code on the clipboard.');
      return;
    }
    _codeController.text = code;
  }

  void _startCooldown() {
    _cooldownTimer?.cancel();
    setState(() => _cooldown = _resendCooldown);
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => _cooldown -= 1);
      if (_cooldown <= 0) {
        timer.cancel();
      }
    });
  }

  void _fail(String message) {
    if (!mounted) return;
    AppHaptics.error();
    setState(() => _error = message);
  }

  void _showMessage(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(message)));
  }
}

String _clock(int seconds) =>
    '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';

/// Two segments and a caption: where the reader is in a flow that has no
/// screen of its own for each stage.
class _StepIndicator extends StatelessWidget {
  const _StepIndicator({required this.step});

  final int step;

  static const _labels = ['Your email', 'Code and new password'];

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.medium;
    return Semantics(
      container: true,
      label: 'Step ${step + 1} of ${_labels.length}: ${_labels[step]}',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                for (var i = 0; i < _labels.length; i++) ...[
                  if (i > 0) const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: AnimatedContainer(
                      duration: duration,
                      curve: AppMotion.standard,
                      height: 4,
                      decoration: BoxDecoration(
                        color: i <= step
                            ? colors.primary
                            : colors.outlineVariant,
                        borderRadius: BorderRadius.circular(AppRadii.pill),
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Step ${step + 1} of ${_labels.length} · ${_labels[step]}',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
