import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_export_plan_option.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

/// The offer a free reader meets when the book they want is longer than the
/// free tier writes.
///
/// It is built to make the longer book feel within reach rather than refused:
/// the hero names the length *they* asked for, the meter shows how little of
/// it free covers next to what a plan does, and the book is never held
/// hostage — [onShorten] writes it at the free length instead, one tap away.
/// Plan rows only mark a choice; the checkout bar is the one place a purchase
/// starts, the same as the export offer it is modelled on.
class BillingLongBookOffer extends StatefulWidget {
  const BillingLongBookOffer({
    required this.limit,
    required this.state,
    required this.plans,
    required this.onBuy,
    required this.onRestore,
    required this.onRetry,
    required this.onClose,
    required this.onIncluded,
    this.onShorten,
    super.key,
  });

  final BookPageLimit limit;
  final BillingPurchaseState state;
  final List<MobileBillingProduct> plans;
  final ValueChanged<MobileBillingProduct> onBuy;
  final VoidCallback onRestore;
  final VoidCallback onRetry;
  final VoidCallback onClose;

  /// The reader already has a plan (the cap they hit was stale): go ahead.
  final VoidCallback onIncluded;

  /// Write the book at the free length instead. Null where the length cannot
  /// be changed from here — an approved plan is already sized.
  final VoidCallback? onShorten;

  @override
  State<BillingLongBookOffer> createState() => _BillingLongBookOfferState();
}

class _BillingLongBookOfferState extends State<BillingLongBookOffer> {
  String? _selectedSku;

  bool _isCurrent(MobileBillingProduct plan) =>
      plan.sku == widget.state.billing?.plan?.productSku ||
      billingTierForSku(plan.sku) == widget.state.billing?.planTier;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final limit = widget.limit;
    // A purchase that just landed, or a cap read from a stale payload: either
    // way the reader can already have this book, and the sheet says so.
    final included = state.billing?.isPaidPlan ?? false;
    final plans = widget.plans
        .where((plan) => billingTierForSku(plan.sku) != 'free')
        .toList();
    final available = plans.where(
      (plan) => state.storeProducts.containsKey(plan.sku) && !_isCurrent(plan),
    );
    final selected =
        (included ? plans.where(_isCurrent).firstOrNull : null) ??
        plans.where((plan) => plan.sku == _selectedSku).firstOrNull ??
        nextBetterPlan(available.toList(), state.billing?.planTier ?? 'free') ??
        available.firstOrNull ??
        plans.firstOrNull;
    final pending = state.pendingProductIds.isNotEmpty;
    final busy = pending || state.restoring || state.subscriptionBusy;
    final canBuy =
        selected != null &&
        !included &&
        !state.loading &&
        state.storeAvailable &&
        state.storeProducts.containsKey(selected.sku) &&
        !_isCurrent(selected) &&
        !busy;
    final pricedPlans = plans
        .where((plan) => state.storeProducts.containsKey(plan.sku))
        .toList();
    final currencies = pricedPlans
        .map((plan) => state.storeProducts[plan.sku]!.currencyCode)
        .toSet();
    final value = currencies.length == 1
        ? billingPlanValue(pricedPlans, state.storeProducts)
        : BillingPlanValue.empty;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.94,
      minChildSize: 0.65,
      maxChildSize: 0.98,
      builder: (context, scrollController) => Column(
        children: [
          Expanded(
            child: ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              children: [
                BillingLongBookHero(limit: limit, onClose: widget.onClose),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  included ? 'Your plan is ready' : 'Choose your plan',
                  style: text.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  included
                      ? 'Your plan writes books up to ${limit.maxPages} pages.'
                      : 'Every plan below writes books up to ${limit.maxPages} pages.',
                  style: text.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                if (state.loading)
                  const BillingPlanSkeleton(cards: 1)
                else if (plans.isEmpty)
                  AppInlineNotice(
                    icon: Icons.wifi_off_rounded,
                    title: 'Plans could not be loaded',
                    message: 'Try again to see your subscription options.',
                    actionLabel: 'Try again',
                    onAction: widget.onRetry,
                  )
                else ...[
                  for (final plan in plans) ...[
                    BillingProductOption(
                      key: ValueKey('long-book-plan-${plan.sku}'),
                      product: plan,
                      storeProduct: state.storeProducts[plan.sku],
                      selected: plan.sku == selected?.sku,
                      isCurrent: _isCurrent(plan),
                      bestValue: plan.sku == value.bestValueSku,
                      recommendation:
                          billingTierForSku(plan.sku) == 'creator' &&
                              !_isCurrent(plan) &&
                              state.storeProducts.containsKey(plan.sku)
                          ? 'Start here'
                          : null,
                      onSelect: busy || included
                          ? null
                          : () {
                              AppHaptics.selection();
                              setState(() => _selectedSku = plan.sku);
                            },
                    ),
                    const SizedBox(height: AppSpacing.xs),
                  ],
                  if (!state.storeAvailable ||
                      state.missingProductIds.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 8),
                      child: Text(
                        'Some plans are temporarily unavailable from Google Play.',
                        style: text.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
                const SizedBox(height: AppSpacing.sm),
                _LongBookPerks(maxPages: limit.maxPages),
                const SizedBox(height: AppSpacing.sm),
                if (!included) ...[
                  Text(
                    'Plans renew monthly and cancel anytime in Google Play. '
                    'Books you have already made stay yours.',
                    textAlign: TextAlign.center,
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Center(
                    child: widget.onShorten == null
                        ? AppButton.text(
                            onPressed: widget.onClose,
                            label: 'Not now',
                          )
                        : AppButton.text(
                            key: const ValueKey('long-book-shorten'),
                            onPressed: busy ? null : widget.onShorten,
                            label:
                                'Write it as a ${limit.limit}-page book instead',
                          ),
                  ),
                ],
                Center(
                  child: AppButton.text(
                    onPressed: busy || state.loading ? null : widget.onRestore,
                    loading: state.restoring,
                    loadingLabel: 'Restoring purchases',
                    label: 'Restore purchases',
                  ),
                ),
              ],
            ),
          ),
          BillingExportCheckout(
            format: '',
            includedLabel:
                'Your plan writes books up to ${limit.maxPages} pages.',
            unlockLabel: (name) => 'Unlock ${limit.maxPages} pages with $name',
            includedActionLabel: 'Continue with ${limit.requestedPages} pages',
            buttonKey: const ValueKey('long-book-upgrade'),
            product: selected,
            storeProduct: state.storeProducts[selected?.sku],
            loading: state.loading,
            pending: pending,
            restoring: state.restoring,
            accessIncluded: included,
            isCurrent: selected != null && _isCurrent(selected),
            error: state.error,
            message: state.message,
            onBuy: included
                ? widget.onIncluded
                : canBuy
                ? () => widget.onBuy(selected)
                : null,
          ),
        ],
      ),
    );
  }
}

/// The top of the offer: the length the reader asked for, said back to them,
/// and the meter that shows where free stops.
class BillingLongBookHero extends StatelessWidget {
  const BillingLongBookHero({
    required this.limit,
    required this.onClose,
    super.key,
  });

  final BookPageLimit limit;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'ROOM FOR THE WHOLE BOOK',
                style: text.labelSmall?.copyWith(
                  color: colors.primary,
                  letterSpacing: 1.8,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            IconButton(
              tooltip: 'Close',
              onPressed: onClose,
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
        Semantics(
          header: true,
          child: Text(
            'Your book wants\n${limit.requestedPages} pages.',
            style: text.headlineMedium?.copyWith(
              fontWeight: FontWeight.w800,
              height: 1.1,
              letterSpacing: -0.7,
            ),
          ),
        ),
        const SizedBox(height: 10),
        Text(
          'Free books stop at ${limit.limit} pages. A plan writes up to '
          '${limit.maxPages} — room for every chapter, example and scene '
          'you have in mind.',
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: AppSpacing.md),
        BookLengthMeter(limit: limit),
      ],
    );
  }
}

/// Three lengths on one bar: where free stops, the book asked for, and how far
/// a plan goes.
///
/// The bar is on a square-root scale. On a straight one the free tier's 30 of
/// 600 is a sliver nobody can read a label against; on this one it is still
/// plainly the short end, and the reader's own book sits visibly past it.
class BookLengthMeter extends StatelessWidget {
  const BookLengthMeter({required this.limit, super.key});

  final BookPageLimit limit;

  double _position(int pages) {
    final max = math.max(1, limit.maxPages);
    return math.sqrt(pages.clamp(0, max) / max);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final free = _position(limit.limit);
    final wanted = math.max(_position(limit.requestedPages), free + 0.04);
    final duration = AppMotion.adapt(
      context,
      const Duration(milliseconds: 900),
    );
    return Semantics(
      label:
          'Free books go up to ${limit.limit} pages. Your book is '
          '${limit.requestedPages} pages. Plans go up to ${limit.maxPages} pages.',
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.card),
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth;
              return TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: 1),
                duration: duration,
                curve: AppMotion.enter,
                builder: (context, progress, _) {
                  final freeWidth = width * free * math.min(1, progress * 1.6);
                  final wantedWidth =
                      width * (free + (wanted - free) * progress);
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(
                        height: 14,
                        child: Stack(
                          children: [
                            // The whole length a plan writes.
                            Positioned.fill(
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.primaryContainer.withValues(
                                    alpha: 0.55,
                                  ),
                                  borderRadius: BorderRadius.circular(
                                    AppRadii.pill,
                                  ),
                                ),
                              ),
                            ),
                            // The reader's book, reaching past free.
                            Positioned(
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: wantedWidth,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.primary,
                                  borderRadius: BorderRadius.circular(
                                    AppRadii.pill,
                                  ),
                                ),
                              ),
                            ),
                            // Where free stops.
                            Positioned(
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: freeWidth,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.outline,
                                  borderRadius: BorderRadius.circular(
                                    AppRadii.pill,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: _MeterLabel(
                              value: '${limit.limit}',
                              caption: 'Free',
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          Expanded(
                            child: _MeterLabel(
                              value: '${limit.requestedPages}',
                              caption: 'Your book',
                              color: colors.primary,
                              align: CrossAxisAlignment.center,
                            ),
                          ),
                          Expanded(
                            child: _MeterLabel(
                              value: '${limit.maxPages}',
                              caption: 'With a plan',
                              color: colors.onSurface,
                              align: CrossAxisAlignment.end,
                            ),
                          ),
                        ],
                      ),
                    ],
                  );
                },
              );
            },
          ),
        ),
      ),
    );
  }
}

class _MeterLabel extends StatelessWidget {
  const _MeterLabel({
    required this.value,
    required this.caption,
    required this.color,
    this.align = CrossAxisAlignment.start,
  });

  final String value;
  final String caption;
  final Color color;
  final CrossAxisAlignment align;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: align,
      children: [
        Text(
          value,
          style: text.titleMedium?.copyWith(
            fontWeight: FontWeight.w800,
            color: color,
          ),
        ),
        Text(
          caption,
          style: text.labelSmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _LongBookPerks extends StatelessWidget {
  const _LongBookPerks({required this.maxPages});

  final int maxPages;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Every plan includes',
            style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 14),
          _Perk(
            icon: Icons.menu_book_outlined,
            title: 'Books up to $maxPages pages',
            description:
                'Full guides, novels and workbooks, with chapters that have room to breathe.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.palette_outlined,
            title: 'Unlimited illustrated books',
            description: 'No monthly cap on books with pictures.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.auto_stories_outlined,
            title: 'Monthly credits',
            description: 'For writing, edits and illustrations, every month.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.edit_document,
            title: 'Word export and your own manuscripts',
            description:
                'Download an editable .docx, or import a draft and keep writing.',
          ),
        ],
      ),
    );
  }
}

class _Perk extends StatelessWidget {
  const _Perk({
    required this.icon,
    required this.title,
    required this.description,
  });

  final IconData icon;
  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: colors.primary, size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                description,
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
