import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/billing_models.dart';
import 'billing_product_option.dart';
import 'billing_tier_style.dart';

/// Small pieces the paywall, the plan screen and the cancel sheet share, so a
/// date, a tier or an allowance reads the same wherever it turns up.

/// A calendar date the way the reader's locale writes it ("Oct 11, 2026").
///
/// The billing surfaces used to mix `11/10/2026` with `Sun, Oct 11`, and a
/// day/month string is ambiguous the moment the reader is not in the country
/// the developer was in. Money-adjacent dates must not be.
String billingDate(BuildContext context, DateTime value) {
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}

/// [billingDate] for a sentence composed away from any widget — a purchase's
/// result message. The app ships only the default localizations, so the words
/// are the ones every billing surface prints.
String billingMessageDate(DateTime value) {
  return const DefaultMaterialLocalizations().formatMediumDate(value.toLocal());
}

/// "Switches to Creator on Wed, Nov 4": a downgrade Play deferred to the
/// renewal date (`plan.pendingChange`), or null when nothing is scheduled.
/// Until then the reader keeps — and `productSku` names — the plan being run
/// out, so every plan surface says when that changes rather than "Renews".
String? billingPlanChangeLine(BuildContext context, MobileBilling? billing) {
  final plan = billing?.plan;
  final sku = plan?.pendingChangeSku;
  if (billing == null || plan == null || sku == null) return null;
  final name = billingPlanNameForSku(sku, billing.products);
  final at = plan.pendingChangeAt;
  return at == null
      ? 'Switches to $name when your ${plan.label} plan renews'
      : 'Switches to $name on ${billingDate(context, at)}';
}

/// Said above a list of plans or packs whose prices Play did not send: Play
/// is unreachable ([storeDown]), its product query failed, or a product is not
/// active in Play Console yet. The rows are greyed out either way; this says
/// why and carries the retry. Without it the list was a column of
/// "Unavailable" over a disabled button, with nothing to press.
class BillingStorePricesNotice extends StatelessWidget {
  const BillingStorePricesNotice({
    required this.storeDown,
    required this.allUnpriced,
    required this.onRetry,
    super.key,
  });

  final bool storeDown;

  /// Nothing on offer has a price, as against a few rows without one.
  final bool allUnpriced;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return AppInlineNotice(
      key: const ValueKey('billing-store-prices-notice'),
      tone: AppTone.warning,
      icon: storeDown ? Icons.cloud_off_outlined : Icons.sync_problem_outlined,
      title: storeDown
          ? 'Google Play is unavailable'
          : allUnpriced
          ? 'Couldn’t load prices from Google Play'
          : 'Some prices didn’t load from Google Play',
      message: storeDown
          ? 'Purchases are temporarily unavailable. Your current credits and books are still here.'
          : allUnpriced
          ? 'Nothing can be bought until Google Play sends its prices. Your current credits and books are still here.'
          : 'Options without a price can’t be bought until it loads.',
      actionLabel: storeDown ? 'Try again' : 'Retry',
      onAction: onRetry,
    );
  }
}

/// True once the reader has asked for larger type. Rows that put a price
/// beside a name stack instead of squeezing the price, which must never wrap.
bool billingLargeText(BuildContext context) =>
    MediaQuery.textScalerOf(context).scale(16) / 16 > 1.25;

/// The tier's name in the tier's own colours, with its emblem.
///
/// Free stays neutral — it must never read as a paid rung — and gold appears
/// only because the Max style paints it.
class BillingTierBadge extends StatelessWidget {
  const BillingTierBadge({required this.tier, required this.label, super.key});

  final String tier;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final style = billingTierStyleForTier(tier);
    return Semantics(
      label: '$label plan',
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: style.accentContainer(colors),
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: AppSpacing.xxs + 1,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  style.emblem,
                  size: 16,
                  color: style.onAccentContainer(colors),
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: style.onAccentContainer(colors),
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// How much of an allowance is left: a label, a figure and a bar.
///
/// The bar goes amber when the allowance is nearly gone and red when it is —
/// the words say the same thing, so colour is never the only signal.
class BillingUsageMeter extends StatelessWidget {
  const BillingUsageMeter({
    required this.label,
    required this.remaining,
    this.value,
    this.caption,
    super.key,
  });

  /// What is being counted, e.g. "Monthly credits".
  final String label;

  /// What is left, 0..1.
  final double remaining;

  /// The figure, right-aligned on the label's line, e.g. "9,300 of 15,000".
  final String? value;

  /// Small print under the bar, e.g. when it resets.
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final semantic = AppSemanticColors.of(context);
    final text = Theme.of(context).textTheme;
    final fraction = remaining.clamp(0.0, 1.0);
    final barColor = fraction <= 0
        ? colors.error
        : fraction <= 0.1
        ? semantic.warning
        : colors.primary;

    final bar = ClipRRect(
      borderRadius: BorderRadius.circular(AppRadii.pill),
      child: AppMotion.reducedMotion(context)
          ? LinearProgressIndicator(
              value: fraction,
              minHeight: 8,
              color: barColor,
            )
          : TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 0, end: fraction),
              duration: AppMotion.slow,
              curve: AppMotion.standard,
              builder: (context, animated, _) => LinearProgressIndicator(
                value: animated,
                minHeight: 8,
                color: barColor,
              ),
            ),
    );

    return Semantics(
      container: true,
      label: [label, ?value, ?caption].join(', '),
      value: '${(fraction * 100).round()} percent left',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: AppSpacing.xs,
              children: [
                Text(
                  label,
                  style: text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
                if (value != null)
                  Text(
                    value!,
                    style: text.labelLarge?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            bar,
            if (caption != null) ...[
              const SizedBox(height: AppSpacing.xxs + 2),
              Text(
                caption!,
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// One line of status or trouble under a control: an icon and what happened.
///
/// A purchase that fails says so beside the button that started it, in the
/// error colours, and is announced to a screen reader when it appears.
class BillingNoticeLine extends StatelessWidget {
  const BillingNoticeLine({
    required this.message,
    this.tone = AppTone.neutral,
    this.icon,
    super.key,
  });

  final String message;
  final AppTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final pair = appToneColors(context, tone);
    final neutral = tone == AppTone.neutral;
    final glyph =
        icon ??
        switch (tone) {
          AppTone.error => Icons.error_outline,
          AppTone.warning => Icons.info_outline,
          AppTone.success => Icons.check_circle_outline,
          _ => Icons.info_outline,
        };
    return Semantics(
      liveRegion: true,
      container: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: neutral ? Colors.transparent : pair.background,
          borderRadius: BorderRadius.circular(AppRadii.compact),
        ),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: neutral ? 0 : AppSpacing.sm,
            vertical: neutral ? 0 : AppSpacing.xs,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Icon(glyph, size: 16, color: pair.foreground),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: pair.foreground),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
