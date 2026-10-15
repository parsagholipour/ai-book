import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../sharing/data/pending_remix.dart';
import '../data/email_verification_repository.dart';
import '../data/pending_location.dart';
import 'auth_code_field.dart';
import 'auth_controller.dart';
import 'auth_widgets.dart';
import 'verify_email_location.dart';

/// What the screen waits before "Resend code" works again when the server did
/// not say. The server refuses an earlier request anyway (one code a minute).
const _defaultResendCooldown = Duration(seconds: 60);

/// Confirms the account's address with an emailed 6-digit code — what the
/// welcome credits wait for. Reached right after an email sign-up (which
/// mails the first code, so [codeAlreadySent]) and from the verify banner.
/// Nothing in the app is behind it: "Not now" always walks on.
class VerifyEmailScreen extends ConsumerStatefulWidget {
  const VerifyEmailScreen({this.codeAlreadySent = false, super.key});

  final bool codeAlreadySent;

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  final _formKey = GlobalKey<FormState>();
  final _codeController = TextEditingController();
  final _codeFocus = FocusNode();

  Timer? _cooldownTimer;
  int _cooldown = 0;
  late bool _codeSent = widget.codeAlreadySent;
  bool _sending = false;
  bool _confirming = false;
  bool _submitted = false;
  String? _error;
  String? _errorTitle;

  /// The free credits this screen was opened to collect, as the billing named
  /// them before the code was confirmed — what lets the outcome tell "none
  /// were added" from "none were ever on offer".
  int? _expectedCredits;

  @override
  void initState() {
    super.initState();
    // The router's after-sign-up landing has arrived.
    ref.read(verifyEmailAfterSignUpProvider).clear();
    if (_codeSent) {
      _startCooldown(_defaultResendCooldown);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _codeFocus.requestFocus();
      });
    }
  }

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    _codeController.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authControllerProvider).asData?.value;
    final email = session?.user.email ?? 'your email';
    final billing = ref.watch(billingProvider).asData?.value;
    if (billing != null && billing.welcomeCreditsAwaitEmailVerification) {
      _expectedCredits = billing.welcomeCreditsPendingCredits;
    }
    final creditsLine = verifyEmailCreditsLine(billing);
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final busy = _sending || _confirming;
    return AuthPageShell(
      alignment: Alignment.topCenter,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        leading: IconButton(
          tooltip: 'Close',
          icon: const Icon(Icons.close),
          onPressed: busy ? null : _leave,
        ),
      ),
      builder: (context, compact) => [
        AuthHeading(
          title: _codeSent ? 'Check your email' : 'Verify your email',
          subtitle: _codeSent
              ? 'We sent a 6-digit code to $email. It works for 30 minutes.'
              : 'We will email a 6-digit code to $email.',
        ),
        if (creditsLine != null) ...[
          const SizedBox(height: AppSpacing.md),
          AppInlineNotice(
            key: const ValueKey('verify-email-credits'),
            icon: Icons.card_giftcard_outlined,
            tone: AppTone.info,
            title: 'Welcome credits',
            message: creditsLine,
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_codeSent) ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Verification code',
                        style: text.labelLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    AppButton.text(
                      onPressed: busy ? null : _pasteCode,
                      leading: const Icon(
                        Icons.content_paste_outlined,
                        size: 18,
                      ),
                      label: 'Paste code',
                    ),
                  ],
                ),
                AuthCodeField(
                  controller: _codeController,
                  focusNode: _codeFocus,
                  enabled: !busy,
                  autovalidate: _submitted,
                  errorMessage: 'Enter the 6-digit code from the email.',
                  onChanged: (_) => _clearError(),
                  onCompleted: _confirm,
                ),
                const SizedBox(height: AppSpacing.md),
              ],
              if (_error != null) ...[
                AppInlineNotice(
                  icon: Icons.error_outline,
                  tone: AppTone.error,
                  title:
                      _errorTitle ??
                      (_codeSent
                          ? 'Could not verify your email'
                          : 'Could not send the code'),
                  message: _error!,
                ),
                const SizedBox(height: AppSpacing.md),
              ],
              if (_codeSent)
                AppButton.primary(
                  onPressed: busy ? null : _confirm,
                  loading: _confirming,
                  loadingLabel: 'Verifying',
                  leading: const Icon(Icons.verified_outlined),
                  label: 'Verify email',
                  expanded: true,
                )
              else
                AppButton.primary(
                  key: const ValueKey('verify-email-send'),
                  // Held through a wait the server named: asking sooner is
                  // only refused again.
                  onPressed: busy || _cooldown > 0 ? null : _send,
                  loading: _sending,
                  loadingLabel: 'Sending code',
                  leading: const Icon(Icons.send_outlined),
                  label: _cooldown > 0
                      ? 'Send code in ${_clock(_cooldown)}'
                      : 'Send code',
                  expanded: true,
                ),
              const SizedBox(height: AppSpacing.xs),
              Wrap(
                alignment: WrapAlignment.center,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (_codeSent)
                    AppButton.text(
                      key: const ValueKey('verify-email-resend'),
                      onPressed: busy || _cooldown > 0 ? null : _send,
                      loading: _sending,
                      loadingLabel: 'Sending a new code',
                      label: _cooldown > 0
                          ? 'Resend code in ${_clock(_cooldown)}'
                          : 'Resend code',
                    ),
                  AppButton.text(
                    onPressed: busy ? null : _leave,
                    label: 'Not now',
                  ),
                ],
              ),
              if (_codeSent)
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
          ),
        ),
      ],
    );
  }

  void _clearError() {
    if (_error != null) {
      setState(() {
        _error = null;
        _errorTitle = null;
      });
    }
  }

  Future<void> _send() async {
    setState(() {
      _sending = true;
      _error = null;
      _errorTitle = null;
    });
    try {
      final sent = await ref
          .read(emailVerificationRepositoryProvider)
          .sendCode();
      if (!mounted) return;
      final wasSent = _codeSent;
      _codeController.clear();
      setState(() {
        _codeSent = true;
        _submitted = false;
      });
      _startCooldown(sent.resendAfter);
      if (wasSent) _showMessage('We sent you a new code.');
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _codeFocus.requestFocus();
      });
    } on ApiException catch (error) {
      if (error.code == 'EMAIL_ALREADY_VERIFIED') {
        await _verified();
        return;
      }
      if (error.statusCode == 429) {
        // One code a minute and ten a day: the server says how long is left,
        // and the button counts it down rather than being refused again.
        _startCooldown(error.retryAfter ?? _defaultResendCooldown);
        _fail(
          'You asked for a code too recently. You can ask for another one '
          'when the countdown ends.',
          title: _codeSent
              ? 'Could not send a new code yet'
              : 'Could not send the code yet',
        );
        return;
      }
      _fail(
        userFacingError(error),
        title: _codeSent ? 'Could not send a new code' : null,
      );
    } catch (_) {
      _fail('Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _confirm() async {
    setState(() {
      _submitted = true;
      _error = null;
      _errorTitle = null;
    });
    if (!(_formKey.currentState?.validate() ?? false) ||
        _codeController.text.trim().length != 6) {
      AppHaptics.warning();
      return;
    }
    setState(() => _confirming = true);
    try {
      await ref
          .read(emailVerificationRepositoryProvider)
          .confirm(_codeController.text);
      if (!mounted) return;
      await _verified();
    } on ApiException catch (error) {
      _fail(userFacingError(error));
    } catch (_) {
      _fail('Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  /// The address is proven. The next balance read settles the welcome grant,
  /// so the billing is read again before the reader is told what arrived.
  Future<void> _verified() async {
    AppHaptics.success();
    TextInput.finishAutofillContext();
    final auth = ref.read(authControllerProvider.notifier);
    ref.invalidate(billingProvider);
    MobileBilling? billing;
    try {
      billing = await ref.read(billingProvider.future);
    } catch (_) {
      // The grant still settles on the next read that succeeds.
    }
    if (!mounted) {
      auth.markEmailVerified();
      return;
    }
    final outcome = verifiedEmailMessage(
      billing,
      expectedCredits: _expectedCredits,
    );
    _showMessage(
      outcome,
      duration: outcome == _verifiedOnly ? null : const Duration(seconds: 8),
    );
    _leave();
    // Only once the screen has gone: a session change refreshes the router,
    // and a refresh that lands mid-pop rebuilds this screen instead of
    // leaving it.
    auth.markEmailVerified();
  }

  void _leave() {
    if (context.canPop()) {
      context.pop();
      return;
    }
    context.go(
      landingLocation(
        ref.read(pendingRemixProvider),
        ref.read(pendingLocationProvider),
      ),
    );
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

  void _startCooldown(Duration duration) {
    _cooldownTimer?.cancel();
    setState(() => _cooldown = duration.inSeconds);
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => _cooldown -= 1);
      if (_cooldown <= 0) timer.cancel();
    });
  }

  void _fail(String message, {String? title}) {
    if (!mounted) return;
    AppHaptics.error();
    setState(() {
      _error = message;
      _errorTitle = title;
    });
  }

  void _showMessage(String message, {Duration? duration}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showAppSnackBar(
      SnackBar(
        content: Text(message),
        duration: duration ?? const Duration(milliseconds: 4000),
      ),
    );
  }
}

const _verifiedOnly = 'Email verified.';

/// What a confirmed code is answered with, read off the billing fetched right
/// after it — the read that settles the welcome grant. [expectedCredits] is
/// what the billing promised before the code was confirmed; with none on
/// offer, there is nothing to report but the address.
///
/// "Email verified." alone used to answer every outcome, so a reader whose
/// grant the per-network cap refused was left looking for credits that were
/// never coming.
String verifiedEmailMessage(MobileBilling? billing, {int? expectedCredits}) {
  if (billing == null) return _verifiedOnly;
  final granted = billing.freeTier.welcomeCredits;
  if (!billing.welcomeCreditsPending && granted > 0) {
    return 'Email verified. Your ${formatCredits(granted)} welcome credits '
        'are in your balance.';
  }
  if (billing.welcomeCreditsPending &&
      billing.welcomeCreditsPendingReason == 'spend_hold') {
    return 'Email verified. Your free credits are on hold while Tomeza is '
        'very busy, and will reach your balance on their own.';
  }
  if (!billing.welcomeCreditsPending &&
      expectedCredits != null &&
      expectedCredits > 0) {
    // Settled without paying: another account on the same network was
    // welcomed first, or the operator turned the grant off meanwhile.
    return 'Email verified, but no free credits could be added to this '
        'account. Free credits go to a limited number of new accounts on '
        'each network.';
  }
  return _verifiedOnly;
}

/// "0:42" under an hour; past it — the day's limit — hours and minutes, since
/// a countdown of seconds over hours reads as a fault.
String _clock(int seconds) {
  if (seconds >= 3600) {
    final hours = seconds ~/ 3600;
    final minutes = (seconds % 3600) ~/ 60;
    return '$hours h ${minutes.toString().padLeft(2, '0')} min';
  }
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}
