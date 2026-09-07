import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import '../domain/credit_purchase_quote.dart';
import 'billing_controller.dart';
import 'billing_credit_amount_offer.dart';
import 'billing_purchase_success_dialog.dart';

/// Finds an available pack for the requested amount. The checkout charges for
/// one pack and shows its effect on the balance. Goals that need more than one
/// purchase disclose the count and total separately.
///
/// Returns the verified purchase when one completed, so a paywall that opened
/// this for a shortfall can dismiss itself once the balance covers it.
Future<BillingPurchaseSuccess?> showBuyCreditsSheet(
  BuildContext context, {
  String? projectId,
  int? shortfall,
  int? requiredCredits,
  VoidCallback? onSeePlans,
}) async {
  final success = await showAppBottomSheet<BillingPurchaseSuccess>(
    context,
    builder: (sheetContext) => BuyCreditsSheet(
      projectId: projectId,
      shortfall: shortfall,
      requiredCredits: requiredCredits,
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
  return success;
}

class BuyCreditsSheet extends ConsumerStatefulWidget {
  const BuyCreditsSheet({
    this.projectId,
    this.shortfall,
    this.requiredCredits,
    this.onSeePlans,
    this.onPurchaseSuccess,
    super.key,
  });

  final String? projectId;

  /// What the reader was short when the paywall sent them here, so the field
  /// opens on the number they actually need instead of a round guess.
  final int? shortfall;
  final int? requiredCredits;

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
    if (_completionHandled || controller.state.pendingProductIds.isNotEmpty) {
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
    final controller = ref.watch(billingControllerProvider(widget.projectId));
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        final quote = quotePurchasableCredits(
          credits: _credits,
          products: controller.topUps,
          storeProducts: state.storeProducts,
          plans: state.billing?.isPaidPlan == true
              ? const []
              : controller.plans,
        );
        return BillingCreditAmountOffer(
          state: state,
          amount: _amount,
          quote: quote,
          shortfall: widget.shortfall,
          requiredCredits: widget.requiredCredits,
          onSetAmount: _setCredits,
          onCoverShortfall: () => _setCredits(_openingCredits()),
          onBuy: quote.best == null
              ? null
              : () => _buy(controller, quote.best!.product),
          onRetry: controller.load,
          onClose: () => Navigator.of(context).pop(),
          onSeePlans: widget.onSeePlans == null
              ? null
              : () {
                  Navigator.of(context).pop();
                  widget.onSeePlans!();
                },
        );
      },
    );
  }
}
