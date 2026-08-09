import 'package:flutter/material.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import 'billing_plan_tiles.dart' show formatCredits;

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

/// The section the plans sheet leads with when credits ran short.
///
/// It replaces the masthead rather than sitting under one: nobody opened this
/// to browse, so the first thing on screen is what is missing and the two ways
/// out of it. Neither button opens anything — both scroll to a rung of this
/// same sheet, because the packs sit two screens below the plans and that
/// distance is what made the sheet read as subscriptions only.
class CreditsNeededCard extends StatelessWidget {
  const CreditsNeededCard({
    required this.creditsNeeded,
    required this.available,
    required this.onClose,
    this.onBuyCredits,
    this.onUpgradePlan,
    this.upgradeLabel = 'Upgrade plan',
    super.key,
  });

  final PaywallCreditsNeeded creditsNeeded;

  /// The live balance, or null while it is still loading. Read from the
  /// paywall's own billing state rather than from whoever opened the sheet, so
  /// a pack bought here settles the arithmetic on screen instead of leaving it
  /// saying you are short of credits you now hold.
  final int? available;

  final VoidCallback onClose;

  /// Null when the sheet has no such section to scroll to — still loading, or a
  /// catalogue without packs. A disabled button says that; a live one that goes
  /// nowhere does not.
  final VoidCallback? onBuyCredits;
  final VoidCallback? onUpgradePlan;

  /// "Upgrade" is a lie on the top tier, where the ladder only goes sideways.
  final String upgradeLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final needed = creditsNeeded.credits;
    final available = this.available;
    final shortfall = creditsNeeded.shortfallFrom(available);
    final covered = shortfall == 0;
    final balanceLine = _balanceLine(needed, available, shortfall);

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.28)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colors.primary.withValues(alpha: 0.2),
            colors.tertiary.withValues(alpha: 0.08),
            colors.surfaceContainerLowest,
          ],
          stops: const [0, 0.5, 1],
        ),
      ),
      padding: const EdgeInsets.fromLTRB(18, 14, 12, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [colors.primary, colors.tertiary],
                  ),
                ),
                child: Icon(
                  covered
                      ? Icons.check_rounded
                      : Icons.account_balance_wallet_outlined,
                  size: 24,
                  color: colors.onPrimary,
                ),
              ),
              const Spacer(),
              IconButton(
                tooltip: 'Close',
                onPressed: onClose,
                icon: const Icon(Icons.close),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  covered ? 'You have enough credits' : 'Credits needed',
                  style: text.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                if (creditsNeeded.reason != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    creditsNeeded.reason!,
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
                // The bar is the gap made visible: how much of what this costs
                // the balance already covers. Without a price there is nothing
                // to be a fraction of, so it is left out rather than faked.
                if (needed != null && needed > 0) ...[
                  const SizedBox(height: 14),
                  AppAnimatedProgressBar(
                    value: available == null ? 0 : available / needed,
                    minHeight: 8,
                    semanticLabel: 'Credits you have towards this',
                  ),
                ],
                if (balanceLine != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    balanceLine,
                    style: text.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: covered ? colors.primary : colors.onSurface,
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    // Once the balance covers it there is nothing left to do
                    // here, and the way back to the blocked action is out of
                    // this sheet — so that becomes the button carrying the
                    // weight, and buying more stays available beside it.
                    if (covered)
                      AppButton.primary(
                        key: const ValueKey('paywall-credits-done'),
                        onPressed: onClose,
                        leading: const Icon(Icons.check, size: 18),
                        label: 'Done',
                      ),
                    _buyButton(promoted: !covered),
                    AppButton.outlined(
                      key: const ValueKey('paywall-upgrade-plan'),
                      onPressed: onUpgradePlan,
                      leading: const Icon(Icons.trending_up, size: 18),
                      label: upgradeLabel,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buyButton({required bool promoted}) {
    const key = ValueKey('paywall-buy-credits');
    const icon = Icon(Icons.add_card_outlined, size: 18);
    return promoted
        ? AppButton.primary(
            key: key,
            onPressed: onBuyCredits,
            leading: icon,
            label: 'Buy credits',
          )
        : AppButton.outlined(
            key: key,
            onPressed: onBuyCredits,
            leading: icon,
            label: 'Buy credits',
          );
  }

  /// The arithmetic in one sentence, or null when neither number is known yet.
  String? _balanceLine(int? needed, int? available, int? shortfall) {
    if (needed == null) {
      return available == null
          ? null
          : 'You have ${formatCredits(available)} credits.';
    }
    if (available == null) {
      return 'This needs ${formatCredits(needed)} credits. '
          'Checking your balance…';
    }
    if (shortfall == null || shortfall <= 0) {
      return 'You have ${formatCredits(available)} credits — enough for this. '
          'Close this and try again.';
    }
    return 'You have ${formatCredits(available)} of the '
        '${formatCredits(needed)} credits this needs — '
        '${formatCredits(shortfall)} short.';
  }
}
