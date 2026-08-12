import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/auth_repository.dart';
import 'auth_controller.dart';

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

  bool _codeSent = false;
  bool _submitting = false;
  bool _obscurePassword = true;

  @override
  void initState() {
    super.initState();
    _emailController = TextEditingController(
      text: widget.initialEmail?.trim() ?? '',
    );
  }

  @override
  void dispose() {
    _emailController.dispose();
    _codeController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      // Back arrow only: the card's own heading names the screen, and a
      // duplicate "Reset password" title would shadow the submit button.
      appBar: AppBar(backgroundColor: Colors.transparent),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        _codeSent ? 'Check your email' : 'Forgot your password?',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _codeSent
                            ? 'We sent a 6-digit code to '
                                  '${_emailController.text.trim()}. Enter it '
                                  'below with your new password.'
                            : 'Enter your account email and we will send you '
                                  'a 6-digit code to choose a new password.',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 20),
                      _buildForm(),
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

  Widget _buildForm() {
    return Form(
      key: _formKey,
      child: Column(
        children: [
          TextFormField(
            controller: _emailController,
            enabled: !_codeSent,
            keyboardType: TextInputType.emailAddress,
            textInputAction: _codeSent
                ? TextInputAction.none
                : TextInputAction.done,
            autofillHints: const [AutofillHints.email],
            decoration: const InputDecoration(
              labelText: 'Email',
              prefixIcon: Icon(Icons.mail_outline),
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
          if (_codeSent) ...[
            const SizedBox(height: 14),
            TextFormField(
              controller: _codeController,
              keyboardType: TextInputType.number,
              textInputAction: TextInputAction.next,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(6),
              ],
              autofillHints: const [AutofillHints.oneTimeCode],
              decoration: const InputDecoration(
                labelText: '6-digit code',
                prefixIcon: Icon(Icons.pin_outlined),
              ),
              validator: (value) {
                if ((value?.trim().length ?? 0) != 6) {
                  return 'Enter the 6-digit code from the email.';
                }
                return null;
              },
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _passwordController,
              obscureText: _obscurePassword,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.newPassword],
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
          const SizedBox(height: 22),
          AppButton.primary(
            onPressed: _submitting ? null : _submit,
            loading: _submitting,
            loadingLabel: _codeSent ? 'Resetting password' : 'Sending code',
            leading: Icon(
              _codeSent ? Icons.lock_reset : Icons.send_outlined,
            ),
            label: _codeSent ? 'Reset password' : 'Send code',
            expanded: true,
          ),
          if (_codeSent) ...[
            const SizedBox(height: 8),
            AppButton.text(
              onPressed: _submitting
                  ? null
                  : () => setState(() {
                      _codeSent = false;
                      _codeController.clear();
                    }),
              label: 'Send a new code',
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
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
      _showMessage(userFacingError(error));
    } catch (_) {
      _showMessage('Something went wrong. Try again.');
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
    setState(() => _codeSent = true);
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
    _showMessage('Your password has been updated.');
    // Installing the session flips the router's redirect: the reader lands on
    // their books without touching the sign-in form again.
    ref.read(authControllerProvider.notifier).adoptSession(session);
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
