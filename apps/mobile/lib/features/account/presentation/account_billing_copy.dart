import 'package:flutter/material.dart';

import '../../billing/domain/billing_models.dart';
import 'account_links.dart';

/// Shared plan / renew / end / free-tier sentences for the account hub,
/// overview card, and plan card. Amounts stay raw so tests can match them
/// without `formatCredits`.

String monthlyCreditsLeftLine(MobileAllowance allowance) {
  return '${allowance.planCredits} of ${allowance.monthlyCredits} monthly credits left';
}

String freeTierGrantLine(MobileFreeTier freeTier) {
  return 'Free includes ${freeTier.monthlyCredits} credits and '
      '${freeTier.illustratedBooksPerMonth} illustrated books each month';
}

String renewsLine(BuildContext context, DateTime renewsAt) {
  return 'Renews ${formatAccountDate(context, renewsAt)}';
}

/// Plan-card uses [thenFree]; the hub subtitle and overview hero do not.
String endsLine(
  BuildContext context,
  DateTime endsAt, {
  bool thenFree = false,
}) {
  final line = 'Ends ${formatAccountDate(context, endsAt)}';
  if (thenFree) {
    return '$line · you move to Free then';
  }
  return line;
}

String hubPlanSubtitle(BuildContext context, MobileBilling? billing) {
  if (billing == null) {
    return 'Checking your plan';
  }
  final plan = billing.plan;
  final label = plan?.label ?? 'Free';
  if (!billing.isPaidPlan) {
    return '$label plan';
  }
  if (plan?.cancelAtPeriodEnd == true && plan?.endsAt != null) {
    return '$label · ${endsLine(context, plan!.endsAt!)}';
  }
  if (plan?.renewsAt != null) {
    return '$label · ${renewsLine(context, plan!.renewsAt!)}';
  }
  return '$label plan';
}
