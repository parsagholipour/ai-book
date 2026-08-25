import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/billing_models.dart';
import 'billing_buy_credits_sheet.dart';
import 'billing_cancel_sheet.dart';
import 'billing_controller.dart';
import 'billing_credits_needed.dart';
import 'billing_free_plan_card.dart';
import 'billing_plan_tiles.dart';
import 'billing_purchase_success_dialog.dart';
import 'billing_tier_style.dart';
import 'credit_log_screen.dart';

export 'billing_credits_needed.dart' show PaywallCreditsNeeded;

/// Plans first, top-ups underneath.
///
/// The same sheet answers both "I ran out of credits" and "I hit the free
/// tier's image limit", because in both cases the best answer is a plan and the
/// second-best is a one-off purchase — so it leads with the ladder and keeps the
/// packs available below rather than making them the whole offer.
///
/// [title] and [message] are the *reason* this sheet opened, so pass
/// `title: null` where there is nothing to explain — the masthead then shrinks
/// to the close button instead of restating what credits are.
///
/// [creditsNeeded] is that reason in the one case the sheet can do arithmetic
/// about: the balance could not cover something. It becomes the masthead — a
/// "Credits needed" section saying how short the account is and offering both
/// ways out — so [title] and [message] go unused when it is passed.
///
/// Returns the verified purchase when one completed here — a plan or top-up
/// tile, or the amount picker closing the shortfall — and null when the sheet
/// was dismissed without buying. The caller that opened this over something the
/// balance blocked is the only place that can offer to pick that thing back up,
/// which is why the outcome must not be swallowed.
Future<BillingPurchaseSuccess?> showBillingPaywall(
  BuildContext context, {
  String? projectId,
  String? title = 'Upgrade your plan',
  String? message,
  PaywallCreditsNeeded? creditsNeeded,
}) async {
  final outcome = await showAppBottomSheet<_PaywallOutcome>(
    context,
    builder: (sheetContext) => BillingPaywall(
      projectId: projectId,
      title: title,
      message: message,
      creditsNeeded: creditsNeeded,
      onPurchaseSuccess: (purchase) {
        if (ModalRoute.of(sheetContext)?.isCurrent ?? false) {
          Navigator.of(
            sheetContext,
          ).pop(_PaywallOutcome(purchase, successDialogShown: false));
        }
      },
    ),
  );
  if (outcome != null && !outcome.successDialogShown && context.mounted) {
    await showBillingPurchaseSuccessDialog(context, outcome.purchase);
  }
  return outcome?.purchase;
}

/// What the paywall closed with: the purchase, and whether its success dialog
/// was already shown — the amount picker shows its own before the paywall pops,
/// and showing it twice reads as two purchases.
class _PaywallOutcome {
  const _PaywallOutcome(this.purchase, {required this.successDialogShown});

  final BillingPurchaseSuccess purchase;
  final bool successDialogShown;
}

class BillingPaywall extends ConsumerStatefulWidget {
  const BillingPaywall({
    this.projectId,
    this.title = 'Upgrade your plan',
    this.message,
    this.creditsNeeded,
    this.onPurchaseSuccess,
    super.key,
  });

  final String? projectId;
  final String? title;
  final String? message;
  final PaywallCreditsNeeded? creditsNeeded;
  final ValueChanged<BillingPurchaseSuccess>? onPurchaseSuccess;

  @override
  ConsumerState<BillingPaywall> createState() => _BillingPaywallState();
}

class _BillingPaywallState extends ConsumerState<BillingPaywall> {
  final _purchasesStartedHere = <String>{};
  late StreamSubscription<BillingPurchaseEvent> _purchaseEventSubscription;
  bool _completionHandled = false;

  /// One anchor per plan card, so "Upgrade" can land on the rung it names
  /// rather than on the top of a ladder the reader is already halfway up.
  final _planAnchors = <String, GlobalKey>{};

  /// Where the ladder starts, for a reader on the top tier with no rung above.
  final _plansAnchor = GlobalKey();

  /// How many hops [_revealSection] will take before giving up. Four screens
  /// is further than this sheet is tall.
  static const _maxRevealHops = 5;

  @override
  void initState() {
    super.initState();
    _listenForPurchaseEvents();
  }

  @override
  void didUpdateWidget(covariant BillingPaywall oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.projectId != widget.projectId) {
      unawaited(_purchaseEventSubscription.cancel());
      _purchasesStartedHere.clear();
      _completionHandled = false;
      _listenForPurchaseEvents();
    }
  }

  @override
  void dispose() {
    unawaited(_purchaseEventSubscription.cancel());
    super.dispose();
  }

  void _listenForPurchaseEvents() {
    _purchaseEventSubscription = ref
        .read(billingControllerProvider(widget.projectId))
        .purchaseEvents
        .listen(_onPurchaseEvent);
  }

  void _onPurchaseEvent(BillingPurchaseEvent event) {
    if (event is! BillingPurchaseSuccess) {
      _purchasesStartedHere.remove(event.productId);
      return;
    }
    if (!mounted ||
        _completionHandled ||
        !_purchasesStartedHere.contains(event.productId)) {
      return;
    }
    if (ModalRoute.of(context)?.isCurrent != true) {
      _purchasesStartedHere.remove(event.productId);
      return;
    }
    _purchasesStartedHere.remove(event.productId);
    _completionHandled = true;
    final purchase = event;
    ref
        .read(billingControllerProvider(widget.projectId))
        .acknowledgePurchaseSuccess(purchase);
    final onPurchaseSuccess = widget.onPurchaseSuccess;
    if (onPurchaseSuccess != null) {
      onPurchaseSuccess(purchase);
      return;
    }
    unawaited(showBillingPurchaseSuccessDialog(context, purchase));
  }

  void _buy(BillingController controller, MobileBillingProduct product) {
    if (_completionHandled) {
      return;
    }
    _purchasesStartedHere.add(product.sku);
    unawaited(controller.buy(product));
  }

  /// Opens the amount picker, then leaves this sheet if the purchase closed the
  /// shortfall that brought the reader here. A purchase that still leaves them
  /// short keeps the arithmetic on screen so they can buy again or upgrade.
  Future<void> _openBuyCredits(
    BuildContext context, {
    int? shortfall,
    VoidCallback? onSeePlans,
  }) async {
    final success = await showBuyCreditsSheet(
      context,
      projectId: widget.projectId,
      shortfall: shortfall,
      onSeePlans: onSeePlans,
    );
    if (!mounted || !context.mounted || success == null) {
      return;
    }
    final creditsNeeded = widget.creditsNeeded;
    if (creditsNeeded == null) {
      return;
    }
    final available = ref
        .read(billingControllerProvider(widget.projectId))
        .state
        .billing
        ?.credits
        .available;
    if (creditsNeeded.shortfallFrom(available) != 0) {
      return;
    }
    final navigator = Navigator.of(context);
    if (navigator.canPop()) {
      // Carry the picker's purchase out as this sheet's own result — with its
      // dialog marked shown, since showBuyCreditsSheet already presented it —
      // so the caller learns the shortfall it opened for is now closed.
      navigator.pop(_PaywallOutcome(success, successDialogShown: true));
    }
  }

  GlobalKey _planAnchor(String sku) =>
      _planAnchors.putIfAbsent(sku, GlobalKey.new);

  /// Scrolls the sheet to one of its sections.
  ///
  /// A lazy list only mounts what is near the viewport, so an anchor nobody has
  /// scrolled past has no context for `ensureVisible` to reach — and the rung
  /// above yours is below the fold, which is exactly the jump it would ignore.
  /// Everything reachable this way sits *below* the card holding the buttons,
  /// so it walks down a screen at a time: each hop mounts the rows it crosses,
  /// until the anchor itself is one of them. Jumping straight to the end would
  /// only work for a section that lives there, and sails past every card in the
  /// middle without ever building one.
  Future<void> _revealSection(BuildContext origin, GlobalKey anchor) async {
    AppHaptics.tap();
    // Read before the first await: afterwards the card may have scrolled out of
    // the list and its context is no longer safe to reach into.
    final position = Scrollable.maybeOf(origin)?.position;
    final reveal = AppMotion.reducedMotion(origin)
        ? Duration.zero
        : AppMotion.medium;
    if (position == null) {
      return;
    }

    for (var hop = 0; hop < _maxRevealHops; hop += 1) {
      final target = anchor.currentContext;
      if (target != null && target.mounted) {
        await Scrollable.ensureVisible(
          target,
          duration: reveal,
          curve: AppMotion.standard,
        );
        return;
      }
      final hopTo = math.min(
        position.pixels + position.viewportDimension * 0.8,
        position.maxScrollExtent,
      );
      if ((hopTo - position.pixels).abs() < 1) {
        return;
      }
      await position.animateTo(
        hopTo,
        duration: reveal,
        curve: AppMotion.standard,
      );
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) {
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final creditsNeeded = widget.creditsNeeded;
    final controller = ref.watch(billingControllerProvider(widget.projectId));
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        final currentSku = state.billing?.plan?.productSku;
        final currentTier = state.billing?.planTier ?? 'free';
        final plans = controller.plans;
        final value = billingPlanValue(plans, state.storeProducts);

        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.88,
          minChildSize: 0.45,
          maxChildSize: 0.96,
          builder: (context, scrollController) => ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 28),
            children: [
              if (creditsNeeded != null)
                // Built here, inside the list, so the buttons can find the
                // scrollable they are about to move.
                Builder(
                  builder: (context) {
                    final available = state.billing?.credits.available;
                    final nextPlan = nextBetterPlan(plans, currentTier);
                    return CreditsNeededCard(
                      key: const ValueKey('paywall-credits-needed'),
                      creditsNeeded: creditsNeeded,
                      available: available,
                      onClose: () => Navigator.of(context).pop(),
                      onBuyCredits: controller.topUps.isEmpty
                          ? null
                          : () => unawaited(
                              _openBuyCredits(
                                context,
                                shortfall: creditsNeeded.shortfallFrom(
                                  available,
                                ),
                                onSeePlans: () =>
                                    _revealSection(context, _plansAnchor),
                              ),
                            ),
                      onUpgradePlan: plans.isEmpty
                          ? null
                          : () => _revealSection(
                              context,
                              nextPlan == null
                                  ? _plansAnchor
                                  : _planAnchor(nextPlan.sku),
                            ),
                      // Naming the rung is the difference between a direction
                      // and a shelf; on the top tier there is no rung to name.
                      upgradeLabel: nextPlan == null
                          ? 'See plans'
                          : 'Upgrade to ${nextPlan.title}',
                    );
                  },
                )
              else
                _PaywallHero(
                  title: widget.title,
                  message: widget.message,
                  onClose: () => Navigator.of(context).pop(),
                ),
              const SizedBox(height: 14),
              BillingPlanBanner(billing: state.billing),
              const SizedBox(height: 20),
              if (!state.storeAvailable && !state.loading) ...[
                const AppInlineNotice(
                  icon: Icons.storefront_outlined,
                  title: 'Google Play billing unavailable',
                  message:
                      'Use an Android build installed from a Play testing track or a license tester account to buy credits.',
                ),
                const SizedBox(height: 16),
              ],
              if (state.loading)
                const BillingPlanSkeleton()
              else ...[
                if (plans.isNotEmpty) ...[
                  _SectionLabel(
                    key: _plansAnchor,
                    label: currentTier == 'free'
                        ? 'Choose a plan'
                        : 'Change your plan',
                  ),
                  const SizedBox(height: 12),
                  for (final (index, plan) in plans.indexed) ...[
                    AppEntrance(
                      key: _planAnchor(plan.sku),
                      index: index,
                      child: BillingPlanCard(
                        key: ValueKey('paywall-plan-${plan.sku}'),
                        product: plan,
                        storeProduct: state.storeProducts[plan.sku],
                        isCurrentPlan: plan.sku == currentSku,
                        currentTier: currentTier,
                        mostPopular:
                            plan.sku == 'tomeza.pro_monthly' &&
                            plan.sku != value.bestValueSku,
                        bestValue: plan.sku == value.bestValueSku,
                        savingsPercent: value.savingsFor(plan.sku),
                        pending: state.pendingProductIds.contains(plan.sku),
                        onBuy: () => _buy(controller, plan),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                ],
                // Free is not a product, so it gets its own rung — and on a paid
                // plan it is the only place that says what cancelling lands you on.
                BillingFreePlanCard(
                  key: const ValueKey('paywall-plan-free'),
                  freeTier: state.billing?.freeTier ?? const MobileFreeTier(),
                  isCurrentPlan: currentTier == 'free',
                  onSwitchToFree:
                      state.billing == null || state.subscriptionBusy
                      ? null
                      : () => showCancelSubscriptionSheet(
                          context,
                          billing: state.billing!,
                          projectId: widget.projectId,
                        ),
                ),
                const SizedBox(height: 14),
                if (controller.topUps.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  const _SectionRule(label: 'OR TOP UP'),
                  const SizedBox(height: 16),
                  Text(
                    'Credits you buy outright never expire, and they are spent '
                    'only after your monthly allowance runs out.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 4),
                  // The shelves below are fixed sizes. This is the same shelves
                  // read from the other end — "I need this many credits" —
                  // which is the question anyone who ran out actually has.
                  Align(
                    alignment: Alignment.centerLeft,
                    child: AppButton.text(
                      key: const ValueKey('paywall-choose-amount'),
                      onPressed: () => unawaited(
                        _openBuyCredits(
                          context,
                          shortfall: creditsNeeded?.shortfallFrom(
                            state.billing?.credits.available,
                          ),
                        ),
                      ),
                      leading: const Icon(Icons.calculate_outlined, size: 18),
                      label: 'Choose an amount',
                    ),
                  ),
                  const SizedBox(height: 8),
                  for (final product in controller.topUps) ...[
                    BillingTopUpTile(
                      key: ValueKey('paywall-topup-${product.sku}'),
                      product: product,
                      storeProduct: state.storeProducts[product.sku],
                      pending: state.pendingProductIds.contains(product.sku),
                      onBuy: () => _buy(controller, product),
                    ),
                    const SizedBox(height: 10),
                  ],
                ],
                if (state.missingProductIds.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  AppInlineNotice(
                    icon: Icons.info_outline,
                    title: 'Some products are not live yet',
                    message:
                        'Missing in Google Play: ${state.missingProductIds.join(', ')}',
                  ),
                ],
              ],
              if (state.message != null) ...[
                const SizedBox(height: 12),
                AppInlineNotice(
                  icon: Icons.check_circle_outline,
                  title: 'Purchase update',
                  message: state.message!,
                  tone: AppTone.success,
                ),
              ],
              if (state.error != null) ...[
                const SizedBox(height: 12),
                AppInlineNotice(
                  icon: Icons.error_outline,
                  title: 'Purchase issue',
                  message: state.error!,
                  tone: AppTone.error,
                ),
              ],
              const SizedBox(height: 20),
              _PaywallFooter(
                restoring: state.restoring,
                onRestore: controller.restore,
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The masthead: an emblem, the reason the sheet opened, and the way out.
class _PaywallHero extends StatelessWidget {
  const _PaywallHero({
    required this.title,
    required this.onClose,
    this.message,
  });

  final String? title;
  final String? message;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final title = this.title;
    final message = this.message;

    // Nothing to say: whoever opened this already knows why — an emblem over a
    // sentence explaining what credits are for would only push the plans down.
    if (title == null && message == null) {
      return Align(
        alignment: Alignment.centerRight,
        child: IconButton(
          tooltip: 'Close',
          onPressed: onClose,
          icon: const Icon(Icons.close),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.22)),
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
            crossAxisAlignment: CrossAxisAlignment.start,
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
                  Icons.auto_awesome,
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
                if (title != null)
                  Text(
                    title,
                    style: text.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                if (message != null) ...[
                  if (title != null) const SizedBox(height: 6),
                  Text(
                    message,
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.label, super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: Theme.of(context).textTheme.titleSmall?.copyWith(
        fontWeight: FontWeight.w800,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        letterSpacing: 0.4,
      ),
    );
  }
}

/// A centred rule that separates the ladder from the one-off purchases, so the
/// packs read as an alternative rather than as a fourth, cheaper tier.
class _SectionRule extends StatelessWidget {
  const _SectionRule({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final line = Expanded(child: Divider(color: colors.outlineVariant));
    return Row(
      children: [
        line,
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
            ),
          ),
        ),
        line,
      ],
    );
  }
}

class _PaywallFooter extends StatelessWidget {
  const _PaywallFooter({required this.restoring, required this.onRestore});

  final bool restoring;
  final VoidCallback onRestore;

  /// Pushed over the sheet rather than replacing it: someone checking where
  /// their credits went is usually about to decide how many to buy, and closing
  /// the paywall to answer that would make them open it again.
  void _openCreditLog(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (context) => const CreditLogScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        AppButton.outlined(
          key: const ValueKey('paywall-credit-log'),
          onPressed: () => _openCreditLog(context),
          leading: const Icon(Icons.receipt_long_outlined, size: 18),
          label: 'See credit logs',
        ),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(
                Icons.verified_user_outlined,
                size: 15,
                color: colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                'Billed through Google Play. Cancel any time — the books you '
                'have already made stay yours.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        AppButton.text(
          onPressed: restoring ? null : onRestore,
          loading: restoring,
          loadingLabel: 'Restoring purchases',
          leading: const Icon(Icons.restore_outlined, size: 18),
          label: 'Restore purchases',
        ),
      ],
    );
  }
}
