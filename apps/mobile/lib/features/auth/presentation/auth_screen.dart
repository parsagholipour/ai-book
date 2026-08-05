import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'auth_controller.dart';

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
                    TextButton(
                      onPressed: isSubmitting ? null : _toggleMode,
                      child: Text(
                        _isSignUp
                            ? 'I already have an account'
                            : 'Create account',
                      ),
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
            const SizedBox(height: 22),
            FilledButton.icon(
              onPressed: isSubmitting ? null : _submit,
              icon: isSubmitting
                  ? SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: _isSignUp
                            ? 'Creating account'
                            : 'Signing in',
                      ),
                    )
                  : Icon(_isSignUp ? Icons.person_add_alt_1 : Icons.login),
              label: Text(_isSignUp ? 'Create account' : 'Sign in'),
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
      await notifier.signUp(
        email: _emailController.text,
        password: _passwordController.text,
        displayName: _displayNameController.text,
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
