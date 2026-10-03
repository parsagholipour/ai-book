import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_buy_credits_sheet.dart';
import 'billing_cancel_sheet.dart';
import 'billing_controller.dart';
import 'billing_credits_needed.dart';
import 'billing_export_offer.dart';
import 'billing_long_book_offer.dart';
import 'billing_offers.dart';
import 'billing_purchase_success_dialog.dart';
import 'play_subscriptions_link.dart';

export 'billing_credits_needed.dart' show PaywallCreditsNeeded;

/// Plan comparison and credit packs, with a focused offer for gated exports.
///
/// Browsing starts on monthly plans. [creditsNeeded] starts on one-time packs
/// and recommends the purchase that covers the live shortfall. [title] and
/// [message] preserve context for import and other feature gates.
///
/// Returns the verified purchase when one completed here — a plan or top-up
/// tile, or the amount picker closing the shortfall — and null when the sheet
/// was dismissed without buying. The caller that opened this over something the
/// balance blocked is the only place that can offer to pick that thing back up,
/// which is why the outcome must not be swallowed.
///
/// [exportFormatLabel] opens a focused subscription comparison for a gated
/// export. It keeps the same verification and purchase-result lifecycle.
Future<BillingPurchaseSuccess?> showBillingPaywall(
  BuildContext context, {
  String? projectId,
  String? title = 'Upgrade your plan',
  String? message,
  PaywallCreditsNeeded? creditsNeeded,
  String? exportFormatLabel,
  BookPageLimit? longBook,
  VoidCallback? onShorten,
  VoidCallback? onIncluded,
}) async {
  final outcome = await showAppBottomSheet<_PaywallOutcome>(
    context,
    builder: (sheetContext) => BillingPaywall(
      projectId: projectId,
      title: title,
      message: message,
      creditsNeeded: creditsNeeded,
      exportFormatLabel: exportFormatLabel,
      longBook: longBook,
      onShorten: onShorten == null
          ? null
          : () {
              onShorten();
              Navigator.of(sheetContext).pop();
            },
      onIncluded: onIncluded == null
          ? null
          : () {
              onIncluded();
              Navigator.of(sheetContext).pop();
            },
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

/// What a reader did with the long-book offer.
enum LongBookChoice {
  /// They have a plan now (bought here, or already had one): write it long.
  unlocked,

  /// They chose to write it at the free length instead.
  shorten,
}

/// The offer for a book longer than the free tier writes. Null when the sheet
/// was dismissed without a choice — the caller then leaves everything as it
/// was. Pass [canShorten] false where the length cannot be changed from the
/// calling surface; the sheet then offers only "Not now".
Future<LongBookChoice?> showLongBookOffer(
  BuildContext context, {
  required BookPageLimit limit,
  String? projectId,
  bool canShorten = true,
}) async {
  LongBookChoice? choice;
  final purchase = await showBillingPaywall(
    context,
    projectId: projectId,
    longBook: limit,
    onShorten: canShorten ? () => choice = LongBookChoice.shorten : null,
    onIncluded: () => choice = LongBookChoice.unlocked,
  );
  return purchase != null ? LongBookChoice.unlocked : choice;
}

/// The page limit a `PAGE_LIMIT_EXCEEDED` refusal carries, or null for any
/// other error.
BookPageLimit? pageLimitFromError(Object error) {
  if (error is! ApiException || error.code != 'PAGE_LIMIT_EXCEEDED') {
    return null;
  }
  return BookPageLimit.fromJson(error.details['pageLimit']);
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
    this.exportFormatLabel,
    this.longBook,
    this.onShorten,
    this.onIncluded,
    this.onPurchaseSuccess,
    super.key,
  });

  final String? projectId;
  final String? title;
  final String? message;
  final PaywallCreditsNeeded? creditsNeeded;
  final String? exportFormatLabel;

  /// Opens the long-book offer instead of the plan comparison.
  final BookPageLimit? longBook;
  final VoidCallback? onShorten;
  final VoidCallback? onIncluded;
  final ValueChanged<BillingPurchaseSuccess>? onPurchaseSuccess;

  @override
  ConsumerState<BillingPaywall> createState() => _BillingPaywallState();
}

class _BillingPaywallState extends ConsumerState<BillingPaywall> {
  final _purchasesStartedHere = <String>{};
  late StreamSubscription<BillingPurchaseEvent> _purchaseEventSubscription;
  bool _completionHandled = false;

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
    if (_completionHandled || controller.state.pendingProductIds.isNotEmpty) {
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
      requiredCredits: widget.creditsNeeded?.credits,
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

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(billingControllerProvider(widget.projectId));
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        if (widget.longBook case final limit?) {
          return BillingLongBookOffer(
            limit: limit,
            state: state,
            plans: controller.plans,
            onBuy: (plan) => _buy(controller, plan),
            onRestore: controller.restore,
            onRetry: controller.load,
            onClose: () => Navigator.of(context).pop(),
            onIncluded: widget.onIncluded ?? () => Navigator.of(context).pop(),
            onShorten: widget.onShorten,
          );
        }
        if (widget.exportFormatLabel case final format?) {
          return BillingExportOffer(
            format: format,
            state: state,
            plans: controller.plans,
            onBuy: (plan) => _buy(controller, plan),
            onRestore: controller.restore,
            onRetry: controller.load,
            onClose: () => Navigator.of(context).pop(),
          );
        }
        return BillingOffers(
          state: state,
          title: widget.title,
          message: widget.message,
          creditsNeeded: widget.creditsNeeded,
          onBuy: (product) => _buy(controller, product),
          onClose: () => Navigator.of(context).pop(),
          onRestore: controller.restore,
          onRetry: controller.load,
          onCustomAmount: (shortfall, onSeePlans) => unawaited(
            _openBuyCredits(
              context,
              shortfall: shortfall,
              onSeePlans: onSeePlans,
            ),
          ),
          onSwitchToFree: state.billing == null
              ? null
              : () => showCancelSubscriptionSheet(
                  context,
                  billing: state.billing!,
                  projectId: widget.projectId,
                ),
          onManagePlan: state.billing?.isPaidPlan == true
              ? () => unawaited(
                  ref.read(playSubscriptionsLauncherProvider)(
                    state.billing?.plan?.productSku,
                  ),
                )
              : null,
        );
      },
    );
  }
}
