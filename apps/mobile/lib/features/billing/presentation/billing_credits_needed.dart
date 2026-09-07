import '../../../shared/api/api_error.dart';

/// Why the paywall opened, when the answer is "that costs more credits than
/// this account has".
///
/// [credits] is what the blocked action needs. It is optional because not every
/// refusal knows the number — a client-side estimate and a 402 both carry it,
/// but a call that ran dry mid-sentence only knows that it did. Without it the
/// card drops the arithmetic and keeps the two ways out, which is the part that
/// matters.
class PaywallCreditsNeeded {
  const PaywallCreditsNeeded({this.credits, this.reason});

  /// The numbers `sendInsufficientCredits` puts in a 402 body. Its message —
  /// "You need more credits for this action." — says nothing this card does not
  /// already say, so callers pass their own [reason] instead.
  factory PaywallCreditsNeeded.fromApiError(
    ApiException error, {
    String? reason,
  }) {
    final credits = error.details['requiredCredits'];
    return PaywallCreditsNeeded(
      credits: credits is int && credits > 0 ? credits : null,
      reason: reason,
    );
  }

  /// What the blocked action costs.
  final int? credits;

  /// What those credits would buy, in one line.
  final String? reason;

  /// How many more are needed, or 0 once the balance covers it. Null while
  /// either side of the subtraction is unknown.
  int? shortfallFrom(int? available) {
    final credits = this.credits;
    if (credits == null || available == null) {
      return null;
    }
    return credits > available ? credits - available : 0;
  }
}
