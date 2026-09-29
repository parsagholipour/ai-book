import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import 'auth_controller.dart';
import 'auth_legal_checks.dart';
import 'auth_widgets.dart';
import 'sample_book_screen.dart';

enum AuthScreenMode { signIn, signUp }

/// Sign in and create account: one form, two routes.
///
/// Validation is quiet while a field is being filled in — it speaks when the
/// reader leaves the field or presses the button, and after that keeps pace
/// with their edits so a fixed mistake stops shouting at once. A refusal from
/// the server lands in an inline notice beside the button rather than in a
/// snack bar that would be gone before it was read.
class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({required this.mode, super.key});

  final AuthScreenMode mode;

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _displayNameController = TextEditingController();
  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();
  final _noticeKey = GlobalKey();

  bool _obscurePassword = true;
  bool _termsAccepted = false;
  bool _ageGuardianAttested = false;
  bool _showLegalError = false;
  bool _emailLeft = false;
  bool _passwordLeft = false;
  bool _submitted = false;
  String? _serverError;

  bool get _isSignUp => widget.mode == AuthScreenMode.signUp;

  @override
  void initState() {
    super.initState();
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
    _emailController.dispose();
    _passwordController.dispose();
    _displayNameController.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  AutovalidateMode _validateWhen(bool left) => left || _submitted
      ? AutovalidateMode.onUserInteraction
      : AutovalidateMode.disabled;

  void _clearServerError([String? _]) {
    if (_serverError != null) setState(() => _serverError = null);
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isSubmitting = authState.isLoading;

    ref.listen(authControllerProvider, (previous, next) {
      final error = next.error;
      // Sign-in sits beneath sign-up in the stack and hears the same failure;
      // only the screen the reader is looking at reports it.
      if (error == null ||
          !mounted ||
          !(ModalRoute.of(context)?.isCurrent ?? true)) {
        return;
      }
      AppHaptics.error();
      setState(() => _serverError = userFacingError(error));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final noticeContext = _noticeKey.currentContext;
        if (noticeContext != null && noticeContext.mounted) {
          Scrollable.ensureVisible(
            noticeContext,
            duration: AppMotion.reducedMotion(noticeContext)
                ? Duration.zero
                : AppMotion.medium,
            alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
          );
        }
      });
    });

    final text = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    final sampleAvailable =
        ref.watch(sampleBookAvailableProvider).value ?? false;

    return AuthPageShell(
      builder: (context, compact) => [
        AuthBrandHeader(compact: compact || _isSignUp),
        SizedBox(height: compact || _isSignUp ? AppSpacing.md : AppSpacing.xl),
        AuthHeading(
          title: _isSignUp ? 'Create your account' : 'Welcome back',
          subtitle: _isSignUp
              ? 'Start turning ideas into finished books.'
              : 'Sign in to continue your books.',
        ),
        const SizedBox(height: AppSpacing.lg),
        _buildForm(isSubmitting),
        const SizedBox(height: AppSpacing.md),
        if (_isSignUp)
          Center(
            child: AppButton.text(
              onPressed: isSubmitting ? null : _toggleMode,
              label: 'I already have an account',
            ),
          )
        else
          Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                'New to Tomeza?',
                style: text.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              AppButton.text(
                onPressed: isSubmitting ? null : _toggleMode,
                label: 'Create account',
              ),
            ],
          ),
        // Only when the server publishes one; a probe failure simply draws
        // nothing.
        if (sampleAvailable)
          Center(
            child: AppButton.text(
              onPressed: isSubmitting
                  ? null
                  : () => context.push('/sample-book'),
              leading: const Icon(Icons.menu_book_outlined, size: 18),
              label: 'See a sample book first',
            ),
          ),
      ],
    );
  }

  Widget _buildForm(bool isSubmitting) {
    final config = ref.read(appConfigProvider);
    return Form(
      key: _formKey,
      child: AutofillGroup(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_isSignUp) ...[
              TextFormField(
                controller: _displayNameController,
                readOnly: isSubmitting,
                textInputAction: TextInputAction.next,
                textCapitalization: TextCapitalization.words,
                autofillHints: const [AutofillHints.name],
                onChanged: _clearServerError,
                decoration: const InputDecoration(
                  labelText: 'Name (optional)',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
            TextFormField(
              controller: _emailController,
              focusNode: _emailFocus,
              readOnly: isSubmitting,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              autocorrect: false,
              enableSuggestions: false,
              autofillHints: [
                if (!_isSignUp) AutofillHints.username,
                AutofillHints.email,
              ],
              autovalidateMode: _validateWhen(_emailLeft),
              onChanged: _clearServerError,
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
            ),
            const SizedBox(height: AppSpacing.sm),
            TextFormField(
              controller: _passwordController,
              focusNode: _passwordFocus,
              readOnly: isSubmitting,
              obscureText: _obscurePassword,
              textInputAction: TextInputAction.done,
              autocorrect: false,
              enableSuggestions: false,
              autofillHints: [
                _isSignUp ? AutofillHints.newPassword : AutofillHints.password,
              ],
              autovalidateMode: _validateWhen(_passwordLeft),
              onChanged: _clearServerError,
              decoration: InputDecoration(
                labelText: 'Password',
                helperText: _isSignUp ? 'Use at least 8 characters.' : null,
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
                final password = value ?? '';
                if (_isSignUp && password.length < 8) {
                  return 'Use at least 8 characters.';
                }
                if (!_isSignUp && password.isEmpty) {
                  return 'Enter your password.';
                }
                return null;
              },
              onFieldSubmitted: (_) => _submit(),
            ),
            if (!_isSignUp)
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: AppButton.text(
                  onPressed: isSubmitting
                      ? null
                      : () => context.push(
                          '/auth/forgot-password',
                          extra: _emailController.text,
                        ),
                  label: 'Forgot password?',
                ),
              ),
            if (_isSignUp) ...[
              const SizedBox(height: AppSpacing.md),
              AuthLegalAttestations(
                termsAccepted: _termsAccepted,
                ageGuardianAttested: _ageGuardianAttested,
                showError: _showLegalError,
                enabled: !isSubmitting,
                onTermsChanged: (value) => setState(() {
                  _termsAccepted = value;
                  _showLegalError = false;
                }),
                onAgeGuardianChanged: (value) => setState(() {
                  _ageGuardianAttested = value;
                  _showLegalError = false;
                }),
                onOpenTerms: () => _openLegalUrl(config.termsOfServiceUrl),
                onOpenPrivacy: () => _openLegalUrl(config.privacyPolicyUrl),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            if (_serverError != null) ...[
              KeyedSubtree(
                key: _noticeKey,
                child: AppInlineNotice(
                  icon: Icons.error_outline,
                  tone: AppTone.error,
                  title: _isSignUp
                      ? 'Could not create your account'
                      : 'Could not sign in',
                  message: _serverError!,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
            ],
            AppButton.primary(
              onPressed: isSubmitting ? null : _submit,
              loading: isSubmitting,
              loadingLabel: _isSignUp ? 'Creating account' : 'Signing in',
              leading: Icon(_isSignUp ? Icons.person_add_alt_1 : Icons.login),
              label: _isSignUp ? 'Create account' : 'Sign in',
              expanded: true,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit() async {
    setState(() {
      _submitted = true;
      _serverError = null;
    });
    if (!_formKey.currentState!.validate()) {
      AppHaptics.warning();
      return;
    }
    final notifier = ref.read(authControllerProvider.notifier);
    if (_isSignUp) {
      if (!_termsAccepted || !_ageGuardianAttested) {
        AppHaptics.warning();
        setState(() => _showLegalError = true);
        return;
      }
      await notifier.signUp(
        email: _emailController.text,
        password: _passwordController.text,
        displayName: _displayNameController.text,
        termsAccepted: _termsAccepted,
        ageGuardianAttested: _ageGuardianAttested,
      );
    } else {
      await notifier.signIn(
        email: _emailController.text,
        password: _passwordController.text,
      );
    }
    if (ref.read(authControllerProvider).asData?.value != null) {
      TextInput.finishAutofillContext();
    }
  }

  Future<void> _openLegalUrl(Uri uri) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(content: Text('That legal page could not be opened.')),
      );
    }
  }

  void _toggleMode() {
    if (_isSignUp) {
      if (context.canPop()) {
        context.pop();
      } else {
        context.go('/auth/sign-in');
      }
      return;
    }

    context.push('/auth/sign-up');
  }
}
