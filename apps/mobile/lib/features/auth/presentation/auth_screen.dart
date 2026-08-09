import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'auth_controller.dart';
import 'sample_book_screen.dart';

enum AuthScreenMode { signIn, signUp }

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

  bool _obscurePassword = true;
  bool _termsAccepted = false;
  bool _ageGuardianAttested = false;
  bool _showLegalError = false;

  bool get _isSignUp => widget.mode == AuthScreenMode.signUp;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _displayNameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isSubmitting = authState.isLoading;

    ref.listen(authControllerProvider, (previous, next) {
      final error = next.error;
      if (error != null && mounted) {
        ScaffoldMessenger.of(
          context,
        ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
      }
    });

    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: const Alignment(0, -0.1),
            colors: [
              colors.primary.withValues(alpha: 0.10),
              colors.surface.withValues(alpha: 0),
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _BrandMark(),
                    const SizedBox(height: 20),
                    Text(
                      'Tomeza',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.displaySmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Practical books for creators and teachers.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 28),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              _isSignUp
                                  ? 'Create your account'
                                  : 'Welcome back',
                              style: Theme.of(context).textTheme.headlineSmall,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _isSignUp
                                  ? 'Start turning ideas into finished books.'
                                  : 'Sign in to continue your books.',
                              style: Theme.of(context).textTheme.bodyMedium
                                  ?.copyWith(color: colors.onSurfaceVariant),
                            ),
                            const SizedBox(height: 20),
                            _buildForm(isSubmitting),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    AppButton.text(
                      onPressed: isSubmitting ? null : _toggleMode,
                      label: _isSignUp
                          ? 'I already have an account'
                          : 'Create account',
                    ),
                    // Only when the server publishes one; a probe failure
                    // simply draws nothing.
                    if (ref.watch(sampleBookAvailableProvider).value ?? false)
                      AppButton.text(
                        onPressed: isSubmitting
                            ? null
                            : () => context.push('/sample-book'),
                        leading: const Icon(Icons.menu_book_outlined, size: 18),
                        label: 'See a sample book first',
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildForm(bool isSubmitting) {
    return Form(
      key: _formKey,
      child: AutofillGroup(
        child: Column(
          children: [
            if (_isSignUp) ...[
              TextFormField(
                controller: _displayNameController,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.name],
                decoration: const InputDecoration(
                  labelText: 'Name',
                  prefixIcon: Icon(Icons.badge_outlined),
                ),
              ),
              const SizedBox(height: 14),
            ],
            TextFormField(
              controller: _emailController,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
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
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _passwordController,
              obscureText: _obscurePassword,
              textInputAction: TextInputAction.done,
              autofillHints: [
                _isSignUp ? AutofillHints.newPassword : AutofillHints.password,
              ],
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
            if (_isSignUp) ...[
              const SizedBox(height: 14),
              _LegalAttestation(
                checked: _termsAccepted,
                onChanged: isSubmitting
                    ? null
                    : (value) => setState(() {
                        _termsAccepted = value;
                        _showLegalError = false;
                      }),
                label:
                    'I agree to the Terms and acknowledge the Privacy Policy.',
                links: [
                  _LegalLink(
                    label: 'Terms',
                    onTap: () => _openLegalUrl(
                      ref.read(appConfigProvider).termsOfServiceUrl,
                    ),
                  ),
                  _LegalLink(
                    label: 'Privacy Policy',
                    onTap: () => _openLegalUrl(
                      ref.read(appConfigProvider).privacyPolicyUrl,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              _LegalAttestation(
                checked: _ageGuardianAttested,
                onChanged: isSubmitting
                    ? null
                    : (value) => setState(() {
                        _ageGuardianAttested = value;
                        _showLegalError = false;
                      }),
                label:
                    'I confirm that I am at least 13 and, if I am under the age of majority, my parent or guardian has agreed.',
              ),
              if (_showLegalError) ...[
                const SizedBox(height: 8),
                Text(
                  'Accept both statements to create your account.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontSize: 12,
                  ),
                ),
              ],
            ],
            const SizedBox(height: 22),
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
    if (!_formKey.currentState!.validate()) {
      return;
    }
    final notifier = ref.read(authControllerProvider.notifier);
    if (_isSignUp) {
      if (!_termsAccepted || !_ageGuardianAttested) {
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

class _LegalAttestation extends StatelessWidget {
  const _LegalAttestation({
    required this.checked,
    required this.onChanged,
    required this.label,
    this.links = const [],
  });

  final bool checked;
  final ValueChanged<bool>? onChanged;
  final String label;
  final List<_LegalLink> links;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onChanged == null ? null : () => onChanged!(!checked),
      child: Container(
        padding: const EdgeInsets.fromLTRB(8, 10, 10, 10),
        decoration: BoxDecoration(
          border: Border.all(color: colors.outlineVariant),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Checkbox(
              value: checked,
              onChanged: onChanged == null
                  ? null
                  : (value) => onChanged!(value ?? false),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: Theme.of(context).textTheme.bodySmall),
                  if (links.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 4,
                      children: links
                          .map(
                            (link) => TextButton(
                              style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                ),
                                minimumSize: const Size(0, 32),
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              onPressed: link.onTap,
                              child: Text(link.label),
                            ),
                          )
                          .toList(),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LegalLink {
  const _LegalLink({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;
}

class _BrandMark extends StatelessWidget {
  const _BrandMark();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: Center(
        child: Container(
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                colors.primary,
                Color.lerp(colors.primary, colors.tertiary, 0.55)!,
              ],
            ),
            borderRadius: BorderRadius.circular(22),
            boxShadow: [
              BoxShadow(
                color: colors.primary.withValues(alpha: 0.35),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Icon(
            Icons.auto_stories_outlined,
            color: colors.onPrimary,
            size: 34,
          ),
        ),
      ),
    );
  }
}
