import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../billing/domain/billing_models.dart';

/// The verify-email screen. Under `/account` so the updated-terms gate, which
/// leaves `/account*` open, never stands between a reader and their code.
const verifyEmailPath = '/account/verify-email';

/// [codeSent] opens straight onto code entry, with the resend countdown
/// running — right after sign-up, which mails the first code itself.
String verifyEmailLocation({bool codeSent = false}) =>
    codeSent ? '$verifyEmailPath?sent=1' : verifyEmailPath;

/// Set by an email sign-up whose account still has its address to prove, and
/// read by the router's landing: a new account opens on the verify screen
/// rather than at home. The screen clears it once it is open.
///
/// A plain object for the reason `PendingRemix` is one: the router's
/// `redirect` reads it synchronously and may run twice for one navigation, so
/// it is only ever peeked there, never taken.
class VerifyEmailAfterSignUp {
  bool _pending = false;

  bool get pending => _pending;

  void remember() => _pending = true;

  void clear() => _pending = false;
}

final verifyEmailAfterSignUpProvider = Provider<VerifyEmailAfterSignUp>(
  (ref) => VerifyEmailAfterSignUp(),
);

/// "Not now" on the verify banner, for this run of the app. It comes back on
/// the next launch: the credits are still waiting, and that is worth one
/// reminder a launch, not one a screen.
class VerifyEmailBannerDismissed extends Notifier<bool> {
  @override
  bool build() => false;

  void dismiss() => state = true;
}

final verifyEmailBannerDismissedProvider =
    NotifierProvider<VerifyEmailBannerDismissed, bool>(
      VerifyEmailBannerDismissed.new,
    );

/// "Verify your email to get your … free credits", with the amount the billing
/// payload names. Null when nothing waits on verification, so a caller shows
/// nothing rather than a promise.
String? verifyEmailCreditsLine(MobileBilling? billing) {
  if (billing == null || !billing.welcomeCreditsAwaitEmailVerification) {
    return null;
  }
  final credits = billing.welcomeCreditsPendingCredits ?? 0;
  return credits > 0
      ? 'Verify your email to get your ${formatCredits(credits)} free credits.'
      : 'Verify your email to get your free credits.';
}
