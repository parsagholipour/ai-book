import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';

/// No masthead: this sheet is reached from the plan and credit cards, so the
/// reader is already looking at their balance and needs the plans, not a
/// heading telling them what credits are for.
Future<void> openAccountBillingPaywall(
  BuildContext context,
  WidgetRef ref,
) async {
  await showBillingPaywall(context, title: null);
  if (context.mounted) {
    ref.invalidate(billingProvider);
  }
}
