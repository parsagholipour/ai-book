import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../account/presentation/account_billing_copy.dart';
import '../../projects/domain/project_models.dart';
import '../domain/billing_models.dart';

// Defined beside the models so their own labels can use it; every importer of
// this file has always found it here.
export '../domain/billing_models.dart' show formatCredits;
import 'billing_tier_style.dart';

/// The cards the paywall is built from: the balance panel saying where you are
/// now, a card per plan tier, and the smaller tile for one-off top-ups.

/// Where the reader stands today — balance, allowance, image budget.
///
/// The number people came to check is the balance, so it is the only thing on
/// this panel at display size; everything else explains it in a line.
class BillingPlanBanner extends StatelessWidget {
  const BillingPlanBanner({required this.billing, super.key});

  final MobileBilling? billing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final plan = billing?.plan;
    final allowance = billing?.allowance;
    final quota = billing?.imageQuota;
    final credits = billing?.credits.available;
    final tier = billing?.planTier ?? 'free';
    final style = billingTierStyleForTier(tier);
    // Free has no accent of its own — the pill stays neutral so it never reads
    // as a paid tier — but the panel still borrows the brand colour, because
    // this is the surface most readers will ever see.
    final accent = tier == 'free' ? colors.primary : style.accent(colors);

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: accent.withValues(alpha: 0.26)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            accent.withValues(alpha: 0.16),
            accent.withValues(alpha: 0.04),
            colors.surfaceContainerLowest,
          ],
          stops: const [0, 0.5, 1],
        ),
      ),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Your balance',
                  style: text.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    letterSpacing: 1.2,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _TierPill(style: style, label: plan?.label ?? 'Free'),
            ],
          ),
          const SizedBox(height: 10),
          Semantics(
            container: true,
            label: credits == null
                ? 'Checking your balance'
                : '$credits credits available',
            child: ExcludeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (credits == null)
                    Text(
                      'Checking your balance',
                      style: text.titleMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    )
                  else ...[
                    Text(
                      formatCredits(credits),
                      style: text.displaySmall?.copyWith(
                        fontWeight: FontWeight.w800,
                        color: colors.onSurface,
                      ),
                    ),
                    Text(
                      'credits available',
                      style: text.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          // Explain the one-time free gift or paid renewal after the plan loads.
          if (billing != null) ...[
            const SizedBox(height: 6),
            Text(
              tier == 'free'
                  ? freeTierGrantLine(
                      billing!.freeTier,
                      formatCredits: formatCredits,
                    )
                  : _paidPlanLine(plan),
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
          if (allowance != null && allowance.monthlyCredits > 0) ...[
            const SizedBox(height: 16),
            AppAnimatedProgressBar(
              value: allowance.planCredits / allowance.monthlyCredits,
              minHeight: 8,
              semanticLabel: 'Monthly allowance remaining',
            ),
            const SizedBox(height: 8),
            Text(
              '${formatCredits(allowance.planCredits)} of '
              '${formatCredits(allowance.monthlyCredits)} monthly credits left'
              '${_resetSuffix(allowance.resetsAt)}',
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
          if (quota != null) ...[
            const SizedBox(height: 10),
            _BannerFootnote(
              icon: quota.isExhausted
                  ? Icons.error_outline
                  : Icons.auto_awesome_outlined,
              tone: quota.isExhausted ? colors.error : colors.onSurfaceVariant,
              label: quota.isExhausted
                  ? 'Illustrated books used up${_resetSuffix(quota.resetsAt)}'
                  : '${quota.remaining} of ${quota.limit} illustrated books left this month',
            ),
          ],
        ],
      ),
    );
  }
}

/// One rung of the plan ladder.
class BillingPlanCard extends StatelessWidget {
  const BillingPlanCard({
    required this.product,
    required this.isCurrentPlan,
    required this.pending,
    required this.onBuy,
    this.storeProduct,
    this.currentTier = 'free',
    this.mostPopular = false,
    this.bestValue = false,
    this.savingsPercent,
    this.creditCosts = const {},
    super.key,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;

  /// The live price list: the benefit lines read the plan's page ceiling and
  /// the typical-book count from it.
  final Map<String, dynamic> creditCosts;
  final bool isCurrentPlan;
  final bool pending;
  final VoidCallback onBuy;

  /// The tier the reader is on now, so the call to action can say whether this
  /// card is a step up or a step sideways.
  final String currentTier;
  final bool mostPopular;
  final bool bestValue;
  final int? savingsPercent;

  bool get _featured => (bestValue || mostPopular) && !isCurrentPlan;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final style = billingTierStyleForSku(product.sku);
    final accent = style.accent(colors);
    final ribbon = _ribbonLabel();
    final intro = introOfferFor(product, storeProduct);

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.card),
        boxShadow: _featured
            ? [
                BoxShadow(
                  color: accent.withValues(alpha: 0.18),
                  blurRadius: 28,
                  spreadRadius: -8,
                  offset: const Offset(0, 12),
                ),
              ]
            : null,
      ),
      foregroundDecoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(
          color: _featured || isCurrentPlan
              ? accent.withValues(alpha: 0.55)
              : colors.outlineVariant,
          width: _featured ? 1.6 : 1,
        ),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.card),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: _featured ? null : colors.surfaceContainerLowest,
            gradient: _featured
                ? LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      accent.withValues(alpha: 0.12),
                      colors.surfaceContainerLowest,
                    ],
                    stops: const [0, 0.45],
                  )
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (ribbon != null)
                _CardRibbon(
                  label: ribbon,
                  background: isCurrentPlan
                      ? style.accentContainer(colors)
                      : accent,
                  foreground: isCurrentPlan
                      ? style.onAccentContainer(colors)
                      : style.onAccent(colors),
                ),
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _TierEmblem(style: style),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                product.title,
                                style: text.titleLarge?.copyWith(
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              Text(
                                style.tagline,
                                style: text.bodySmall?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        Text(
                          intro?.price ??
                              storeProduct?.price ??
                              billingPriceUnavailable,
                          style: text.headlineMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                            color: colors.onSurface,
                          ),
                        ),
                        Text(
                          storeProduct == null
                              ? 'Price unavailable'
                              : intro == null
                              ? 'per ${product.periodNoun}'
                              : 'for the ${intro.termLabel}',
                          style: text.bodyMedium?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                        if (savingsPercent != null)
                          _SavingsChip(
                            percent: savingsPercent!,
                            accent: accent,
                          ),
                      ],
                    ),
                    if (intro != null)
                      Text(
                        'Then ${storeProduct!.price} per ${product.periodNoun}',
                        style: text.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    const SizedBox(height: 4),
                    Text(
                      planCreditsLine(product, intro, per: 'every'),
                      style: text.titleSmall?.copyWith(
                        color: accent,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 16),
                    for (final benefit in planBenefits(
                      product,
                      creditCosts: creditCosts,
                    )) ...[
                      BillingBenefitRow(label: benefit, accent: accent),
                      const SizedBox(height: 8),
                    ],
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      // Billing tiers intentionally keep their own accent so
                      // the CTA remains visually tied to the selected plan.
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: _featured
                              ? accent
                              : style.accentContainer(colors),
                          foregroundColor: _featured
                              ? style.onAccent(colors)
                              : style.onAccentContainer(colors),
                        ),
                        onPressed:
                            storeProduct != null && !pending && !isCurrentPlan
                            ? onBuy
                            : null,
                        child: pending
                            ? const SizedBox.square(
                                dimension: AppSizes.buttonProgressIndicator,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  semanticsLabel: 'Purchase pending',
                                ),
                              )
                            : Text(_callToAction()),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String? _ribbonLabel() {
    if (isCurrentPlan) {
      return 'YOUR CURRENT PLAN';
    }
    if (bestValue) {
      return 'BEST VALUE';
    }
    if (mostPopular) {
      return 'MOST POPULAR';
    }
    return null;
  }

  String _callToAction() {
    if (isCurrentPlan) {
      return 'Your plan';
    }
    final from = planTierOrder.indexOf(currentTier);
    final to = planTierOrder.indexOf(billingTierForSku(product.sku));
    if (from < 0 || to < 0) {
      return 'Choose ${product.title}';
    }
    return to > from
        ? 'Upgrade to ${product.title}'
        : 'Switch to ${product.title}';
  }
}

/// A one-off purchase: a credit pack.
class BillingTopUpTile extends StatelessWidget {
  const BillingTopUpTile({
    required this.product,
    required this.pending,
    required this.onBuy,
    this.storeProduct,
    super.key,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;
  final bool pending;
  final VoidCallback onBuy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: colors.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                product.productType == 'CREDIT_PACK'
                    ? Icons.add_card_outlined
                    : Icons.lock_open_outlined,
                size: 20,
                color: colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    product.title,
                    style: text.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${product.benefitLabel} · never expires',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            AppButton.tonal(
              onPressed: storeProduct != null && !pending ? onBuy : null,
              loading: pending,
              loadingLabel: 'Purchase pending',
              label: storeProduct?.price ?? 'Unavailable',
            ),
          ],
        ),
      ),
    );
  }
}

/// Row-shaped placeholders while the store and the balance are still loading.
///
/// They copy the real plan row — a radio, two lines of text, a price — so the
/// list keeps its height and its rhythm when the prices arrive, and the wait
/// reads as shorter than a spinner does because the layout is already legible.
class BillingPlanSkeleton extends StatelessWidget {
  const BillingPlanSkeleton({this.cards = 3, super.key});

  final int cards;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget bar(double width, double height) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.compact),
      ),
    );
    return Semantics(
      label: 'Loading purchase options',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Column(
            children: [
              for (var index = 0; index < cards; index += 1) ...[
                Container(
                  height: 92,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.md - 2,
                  ),
                  decoration: BoxDecoration(
                    color: colors.surfaceContainerLowest,
                    borderRadius: BorderRadius.circular(AppRadii.card),
                    border: Border.all(color: colors.outlineVariant),
                  ),
                  child: Row(
                    children: [
                      Container(
                        width: 24,
                        height: 24,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: colors.surfaceContainerHigh,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            bar(96, 16),
                            const SizedBox(height: 8),
                            bar(150, 12),
                            const SizedBox(height: 6),
                            bar(110, 12),
                          ],
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          bar(64, 20),
                          const SizedBox(height: 6),
                          bar(40, 12),
                        ],
                      ),
                    ],
                  ),
                ),
                if (index != cards - 1) const SizedBox(height: AppSpacing.xs),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _TierEmblem extends StatelessWidget {
  const _TierEmblem({required this.style});

  final BillingTierStyle style;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      width: 46,
      height: 46,
      decoration: BoxDecoration(
        color: style.accentContainer(colors),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Icon(
        style.emblem,
        size: 24,
        color: style.onAccentContainer(colors),
      ),
    );
  }
}

class _TierPill extends StatelessWidget {
  const _TierPill({required this.style, required this.label});

  final BillingTierStyle style;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: style.accentContainer(colors),
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: style.onAccentContainer(colors),
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}

class _CardRibbon extends StatelessWidget {
  const _CardRibbon({
    required this.label,
    required this.background,
    required this.foreground,
  });

  final String label;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: background,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        child: Text(
          label,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: foreground,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.3,
          ),
        ),
      ),
    );
  }
}

/// One ticked line of what a plan includes. Shared with the free rung.
class BillingBenefitRow extends StatelessWidget {
  const BillingBenefitRow({
    required this.label,
    required this.accent,
    super.key,
  });

  final String label;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 20,
          height: 20,
          margin: const EdgeInsets.only(top: 2),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: accent.withValues(alpha: 0.16),
          ),
          child: Icon(Icons.check_rounded, size: 13, color: accent),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
        ),
      ],
    );
  }
}

class _SavingsChip extends StatelessWidget {
  const _SavingsChip({required this.percent, required this.accent});

  final int percent;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AppRadii.pill),
        border: Border.all(color: accent.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Text(
          'Save $percent%',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: accent,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}

class _BannerFootnote extends StatelessWidget {
  const _BannerFootnote({
    required this.icon,
    required this.label,
    required this.tone,
  });

  final IconData icon;
  final String label;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icon, size: 16, color: tone),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            label,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: tone),
          ),
        ),
      ],
    );
  }
}

/// What a plan is actually worth, in the order someone comparing cares about.
///
/// The monthly credit figure is deliberately absent: the card already shows it
/// beside the price, and repeating it here would spend the first line of the
/// list on something the eye has just read.
List<String> planBenefits(
  MobileBillingProduct product, {
  Map<String, dynamic> creditCosts = const {},
}) {
  return <String>[
    'Books up to ${planMaxBookPages(creditCosts)} pages',
    'No monthly cap on illustrated books',
    'Bring your own manuscript',
    planBooksLine(product, creditCosts),
  ];
}

/// The longest book a plan writes: the server's `paidMaxBookPages` from the
/// price list, or the 600-page request ceiling from a server that sends none.
int planMaxBookPages(Map<String, dynamic> creditCosts) {
  final raw = creditCosts['paidMaxBookPages'];
  if (raw is! num || raw < 1) return maxPlanBookPages;
  return raw.toInt().clamp(1, maxPlanBookPages);
}

/// The book every plan line is counted in: Balanced, 20 pages, illustrated,
/// with a drawn cover — what the app suggests to someone who has not chosen.
const _typicalBookPages = 20;

/// How many typical books a plan's monthly credits buy at today's prices.
///
/// Read from the live price list through the same formula the creation chat
/// quotes with, so a price change moves this line too. A fixed sentence here
/// once told Creator buyers "around two books a month" for an allowance that
/// covers six. Every plan is granted monthly, the yearly one included, so this
/// is always a month's count.
int typicalBooksPerMonth(
  MobileBillingProduct product,
  Map<String, dynamic> creditCosts,
) {
  final perBook =
      estimatePlanGenerationCredits(
        qualityPreset: 'balanced',
        creditCosts: creditCosts,
      ) +
      estimateProjectCredits(
        bookType: 'custom',
        qualityPreset: 'balanced',
        coverEnabled: true,
        illustrationsEnabled: true,
        targetPages: _typicalBookPages,
        creditCosts: creditCosts,
      );
  return perBook <= 0 ? 0 : product.creditsPerGrant ~/ perBook;
}

/// "About 8 illustrated 20-page books a month", the yearly plan too: its
/// credits arrive every month.
String planBooksLine(
  MobileBillingProduct product,
  Map<String, dynamic> creditCosts,
) {
  final books = typicalBooksPerMonth(product, creditCosts);
  if (books <= 1) {
    return 'About one illustrated $_typicalBookPages-page book a month';
  }
  return 'About $books illustrated $_typicalBookPages-page books a month';
}

/// Where a price goes when Play gave none. The server's catalog price is never
/// shown in its place: it is in dollars before tax, and read beside Play's own
/// prices it looked like what the reader would be charged.
const billingPriceUnavailable = '—';

/// A plan's price in one line, intro offer and all: "$19.99 / month", or
/// "$9.99 first month, then $19.99 / month". Play's policy is that an offer's
/// price is never shown without the price it renews at.
String planPriceLine(MobileBillingProduct plan, StoreProduct? store) {
  if (store == null) return 'Price unavailable from Google Play';
  final regular = '${store.price} / ${plan.periodNoun}';
  final intro = introOfferFor(plan, store);
  if (intro == null) return regular;
  return '${intro.price} ${intro.termLabel}, then $regular';
}

/// What a plan grants, in the same breath as [planPriceLine]: "6,000 credits
/// / month", or, sold through an intro offer, "4,000 credits the first month,
/// then 6,000 / month" — the intro period grants `introOfferCredits`, fewer
/// than the plan, and a surface beside the intro price must not promise more.
/// [per] is "/" for a compact row and "every" for a card.
///
/// Every plan's credits arrive monthly, so a yearly plan says "6,000 credits
/// every month, billed yearly" — never the year's total, which it no longer
/// grants at once.
String planCreditsLine(
  MobileBillingProduct plan,
  StoreIntroOffer? intro, {
  String per = '/',
}) {
  final monthly = plan.creditsPerGrant;
  final billed = plan.isYearly ? ', billed yearly' : '';
  final regular = '${formatCredits(monthly)} $per month$billed';
  final introCredits = plan.introOfferCredits;
  if (intro == null || introCredits == null || introCredits == monthly) {
    return '${formatCredits(monthly)} credits $per month$billed';
  }
  return '${formatCredits(introCredits)} credits the ${intro.termLabel}, '
      'then $regular';
}

/// A paid plan in one line: when it renews, or when it stops.
String _paidPlanLine(MobileSubscriptionPlan? plan) {
  if (plan == null) {
    return 'No monthly cap on illustrated books';
  }
  final endsAt = plan.periodEndsAt;
  if (endsAt == null) {
    return 'No monthly cap on illustrated books';
  }
  final local = endsAt.toLocal();
  final date = '${local.day}/${local.month}/${local.year}';
  return plan.cancelAtPeriodEnd ? 'Ends $date · then Free' : 'Renews $date';
}

String _resetSuffix(DateTime? resetsAt) {
  if (resetsAt == null) {
    return '';
  }
  // The server decides when the period turns over, so the date comes from it
  // rather than from the device's idea of the month.
  final local = resetsAt.toLocal();
  return ' · resets ${local.day}/${local.month}';
}
