import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import '../domain/credit_purchase_quote.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';
import 'billing_purchase_success_dialog.dart';

/// "How many credits do you need?" — with the cost of that answer, the pack
/// that delivers it, and the button that buys it.
///
/// The paywall lists fixed shelves; this reads the same shelves from the other
/// end. Someone who is 900 short does not want to work out which pack covers
/// 900, and a store can only sell whole packs — so the number is theirs to type
/// and the arithmetic is ours: what it would cost at the best rate on offer,
/// which pack actually covers it, and what is left over afterwards.
Future<void> showBuyCreditsSheet(
  BuildContext context, {
  String? projectId,
  int? shortfall,
  VoidCallback? onSeePlans,
}) async {
  final success = await showModalBottomSheet<BillingPurchaseSuccess>(
    context: context,
    showDragHandle: true,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (sheetContext) => BuyCreditsSheet(
      projectId: projectId,
      shortfall: shortfall,
      onSeePlans: onSeePlans,
      onPurchaseSuccess: (purchase) {
        if (ModalRoute.of(sheetContext)?.isCurrent ?? false) {
          Navigator.of(sheetContext).pop(purchase);
        }
      },
    ),
  );
  if (success != null && context.mounted) {
    await showBillingPurchaseSuccessDialog(context, success);
  }
}

class BuyCreditsSheet extends ConsumerStatefulWidget {
  const BuyCreditsSheet({
    this.projectId,
    this.shortfall,
    this.onSeePlans,
    this.onPurchaseSuccess,
    super.key,
  });

  final String? projectId;

  /// What the reader was short when the paywall sent them here, so the field
  /// opens on the number they actually need instead of a round guess.
  final int? shortfall;

  /// Closes this sheet and takes the paywall behind it to the plan ladder.
  /// Null when nothing is behind it to take.
  final VoidCallback? onSeePlans;

  /// Returns a verified purchase to the route that presented this sheet.
  final ValueChanged<BillingPurchaseSuccess>? onPurchaseSuccess;

  @override
  ConsumerState<BuyCreditsSheet> createState() => _BuyCreditsSheetState();
}

class _BuyCreditsSheetState extends ConsumerState<BuyCreditsSheet> {
  /// What the field opens on with no shortfall to answer: one standard book's
  /// worth, which is the unit everything else in the app is priced against.
  static const _defaultCredits = 1000;

  /// Well past the largest pack, so the arithmetic below cannot be driven
  /// somewhere absurd by a long press on a keypad.
  static const _maxCredits = 999999;

  final _amount = TextEditingController();
  final _purchasesStartedHere = <String>{};
  late StreamSubscription<BillingPurchaseEvent> _purchaseEventSubscription;
  bool _completionHandled = false;

  @override
  void initState() {
    super.initState();
    _amount.text = '${_openingCredits()}';
    _amount.addListener(_onAmountChanged);
    _listenForPurchaseEvents();
  }

  @override
  void didUpdateWidget(covariant BuyCreditsSheet oldWidget) {
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
    _amount.removeListener(_onAmountChanged);
    _amount.dispose();
    super.dispose();
  }

  void _listenForPurchaseEvents() {
    _purchaseEventSubscription = ref
        .read(billingControllerProvider(widget.projectId))
        .purchaseEvents
        .listen(_onPurchaseEvent);
  }

  void _onPurchaseEvent(BillingPurchaseEvent event) {
    if (event is BillingPurchaseStopped) {
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
    final purchase = event as BillingPurchaseSuccess;
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

  void _onAmountChanged() => setState(() {});

  int _openingCredits() {
    final shortfall = widget.shortfall;
    if (shortfall == null || shortfall <= 0) {
      return _defaultCredits;
    }
    // Rounded up to a number a person would say out loud. Rounding down would
    // open on an amount that does not close the gap it was opened for.
    return ((shortfall + 99) ~/ 100) * 100;
  }

  int get _credits => int.tryParse(_amount.text) ?? 0;

  void _setCredits(int value) {
    AppHaptics.selection();
    final text = '${value.clamp(0, _maxCredits)}';
    _amount.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final controller = ref.watch(billingControllerProvider(widget.projectId));

    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        final available = state.billing?.credits.available;
        final shortfall = widget.shortfall;
        final quote = quoteCredits(
          credits: _credits,
          products: controller.topUps,
          storeProducts: state.storeProducts,
          plans: controller.plans,
        );

        return SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(
              20,
              4,
              20,
              20 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Buy credits',
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  available == null
                      ? 'Bought credits never expire.'
                      : 'You have ${formatCredits(available)} credits, and '
                            'bought credits never expire.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const ValueKey('buy-credits-amount'),
                  controller: _amount,
                  keyboardType: TextInputType.number,
                  textInputAction: TextInputAction.done,
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'How many credits?',
                    suffixText: 'credits',
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (shortfall != null && shortfall > 0)
                      ActionChip(
                        key: const ValueKey('buy-credits-cover-shortfall'),
                        avatar: const Icon(Icons.flag_outlined, size: 16),
                        label: const Text('Cover my shortfall'),
                        onPressed: () => _setCredits(_openingCredits()),
                      ),
                    ActionChip(
                      label: const Text('−500'),
                      onPressed: _credits <= 0
                          ? null
                          : () => _setCredits(_credits - 500),
                    ),
                    ActionChip(
                      label: const Text('+500'),
                      onPressed: () => _setCredits(_credits + 500),
                    ),
                    ActionChip(
                      label: const Text('+1,000'),
                      onPressed: () => _setCredits(_credits + 1000),
                    ),
                  ],
                ),
                if (!quote.isEmpty) ...[
                  const SizedBox(height: 14),
                  Text(
                    '${formatCredits(quote.credits)} credits is about '
                    '${quote.estimateLabel}, at the best rate on offer of '
                    '${quote.ratePerThousandLabel} per 1,000.',
                    key: const ValueKey('buy-credits-estimate'),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 14),
                  _QuotePanel(
                    quote: quote,
                    available: available,
                    pending: state.pendingProductIds.contains(
                      quote.best!.product.sku,
                    ),
                    onBuy: state.storeProducts[quote.best!.product.sku] == null
                        ? null
                        : () => _buy(controller, quote.best!.product),
                  ),
                ],
                if (quote.betterPlan != null) ...[
                  const SizedBox(height: 14),
                  AppInlineNotice(
                    icon: Icons.workspace_premium_outlined,
                    title: '${quote.betterPlan!.title} costs less than this',
                    message:
                        '${formatCredits(quote.betterPlan!.creditAmount)} '
                        'credits every month for '
                        '${quote.betterPlanPriceLabel}, and it renews.',
                    tone: AppNoticeTone.info,
                  ),
                  if (widget.onSeePlans != null) ...[
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        key: const ValueKey('buy-credits-see-plans'),
                        onPressed: () {
                          Navigator.of(context).pop();
                          widget.onSeePlans!();
                        },
                        icon: const Icon(Icons.trending_up, size: 18),
                        label: const Text('See plans'),
                      ),
                    ),
                  ],
                ],
                if (!state.storeAvailable && !state.loading) ...[
                  const SizedBox(height: 14),
                  const AppInlineNotice(
                    icon: Icons.storefront_outlined,
                    title: 'Google Play billing unavailable',
                    message:
                        'Use an Android build installed from a Play testing '
                        'track or a license tester account to buy credits.',
                  ),
                ],
                if (controller.topUps.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text(
                    'EVERYTHING ON SALE',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                    ),
                  ),
                  const SizedBox(height: 10),
                  for (final product in controller.topUps) ...[
                    BillingTopUpTile(
                      key: ValueKey('buy-credits-topup-${product.sku}'),
                      product: product,
                      storeProduct: state.storeProducts[product.sku],
                      pending: state.pendingProductIds.contains(product.sku),
                      onBuy: () => _buy(controller, product),
                    ),
                    const SizedBox(height: 10),
                  ],
                ],
                if (state.message != null) ...[
                  const SizedBox(height: 12),
                  AppInlineNotice(
                    icon: Icons.check_circle_outline,
                    title: 'Purchase update',
                    message: state.message!,
                    tone: AppNoticeTone.success,
                  ),
                ],
                if (state.error != null) ...[
                  const SizedBox(height: 12),
                  AppInlineNotice(
                    icon: Icons.error_outline,
                    title: 'Purchase issue',
                    message: state.error!,
                    tone: AppNoticeTone.error,
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The recommendation: what to buy for the number in the field, what it costs,
/// and what it leaves behind.
class _QuotePanel extends StatelessWidget {
  const _QuotePanel({
    required this.quote,
    required this.available,
    required this.pending,
    required this.onBuy,
  });

  final CreditQuote quote;
  final int? available;
  final bool pending;
  final VoidCallback? onBuy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final best = quote.best!;
    final multiple = quote.quantity > 1;

    return Container(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(TomezaRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.32)),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  multiple
                      ? '${best.product.title} × ${quote.quantity}'
                      : best.product.title,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const AppStatusBadge(
                label: 'Best match',
                icon: Icons.check_circle_outline,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${formatCredits(quote.creditsDelivered)} credits · '
            '${quote.totalLabel}',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _explanation(),
            key: const ValueKey('buy-credits-explanation'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: const ValueKey('buy-credits-buy'),
              onPressed: pending ? null : onBuy,
              icon: pending
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'Purchase pending',
                      ),
                    )
                  : const Icon(Icons.add_card_outlined, size: 18),
              label: Text(
                multiple
                    ? 'Buy one — ${best.unitLabel}'
                    : 'Buy — ${best.unitLabel}',
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// What the purchase does to the number that was asked for, and to the
  /// balance. A store that sells whole packs will nearly always deliver more
  /// than was asked for, and leaving that unsaid makes the price look wrong.
  String _explanation() {
    final balance = available == null
        ? ''
        : ' Balance after: '
              '${formatCredits(available! + quote.creditsDelivered)}.';
    if (quote.quantity > 1) {
      return 'The biggest pack is ${formatCredits(quote.best!.credits)}, so '
          'this takes ${quote.quantity} purchases.$balance';
    }
    if (quote.surplus == 0) {
      return 'Exactly what you asked for.$balance';
    }
    return 'Covers your ${formatCredits(quote.credits)}, with '
        '${formatCredits(quote.surplus)} to spare.$balance';
  }
}
