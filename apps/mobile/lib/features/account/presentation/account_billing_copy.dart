import 'package:flutter/material.dart';

import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_shared_parts.dart'
    show billingPlanChangeLine;
import 'account_links.dart';

/// Shared plan / renew / end / free-tier sentences for the account hub,
/// overview card, and plan card. Amounts stay raw unless a [formatCredits]
/// callback is passed, so account tests can match numbers without formatting.

String monthlyCreditsLeftLine(
  MobileAllowance allowance, {
  String Function(int value)? formatCredits,
}) {
  String credits(int value) => formatCredits?.call(value) ?? '$value';
  return '${credits(allowance.planCredits)} of ${credits(allowance.monthlyCredits)} monthly credits left';
}

String freeTierGrantLine(
  MobileFreeTier freeTier, {
  String Function(int value)? formatCredits,
}) {
  String credits(int value) => formatCredits?.call(value) ?? '$value';
  final welcome = freeTier.welcomeCredits;
  return welcome > 0
      ? '${credits(welcome)} one-time welcome credits · usage spends credits · no monthly refill'
      : 'Usage spends credits · no monthly refill';
}

/// The one line a free account sees while the server is holding its welcome
/// grant (`welcomeCreditsPending`), in place of the free-tier offer.
const welcomeCreditsPendingLine = 'Your welcome credits are on their way.';

String renewsLine(BuildContext context, DateTime renewsAt) {
  return 'Renews ${formatAccountDate(context, renewsAt)}';
}

/// What a paid plan does next: "Switches to Creator on Wed, Nov 4" while Play
/// holds a deferred downgrade (`plan.pendingChange`), else "Renews …", else
/// null. The hub subtitle, the overview card and the plan card all say the
/// same thing; "Renews" beside a scheduled switch read as the plan above
/// carrying on. A cancellation is the caller's to say first ([endsLine]).
String? paidPlanNextLine(BuildContext context, MobileBilling billing) {
  final change = billingPlanChangeLine(context, billing);
  if (change != null) return change;
  final renewsAt = billing.plan?.renewsAt;
  return renewsAt == null ? null : renewsLine(context, renewsAt);
}

/// When a paid plan's monthly credits next arrive, while that is not the day
/// the plan itself renews or ends: "Credits refill Nov 1". Creator yearly
/// renews once a year and refills every month, so a balance surface that gave
/// only the plan's date read as a year's wait for the next credits. The date
/// is always the allowance's `resetsAt`, never `renewsAt`. Null when the two
/// fall on the same day (every monthly plan), or nothing says.
String? creditsRefillLine(BuildContext context, MobileBilling billing) {
  final allowance = billing.allowance;
  final resetsAt = allowance?.resetsAt;
  if (!billing.isPaidPlan ||
      allowance == null ||
      allowance.monthlyCredits <= 0 ||
      resetsAt == null) {
    return null;
  }
  final planDate = billing.plan?.periodEndsAt;
  if (planDate != null) {
    final reset = resetsAt.toLocal();
    final plan = planDate.toLocal();
    final sameDay =
        reset.year == plan.year &&
        reset.month == plan.month &&
        reset.day == plan.day;
    // A refill on or after the plan's own date is the plan's line to give.
    if (sameDay || !reset.isBefore(plan)) return null;
  }
  return 'Credits refill ${formatAccountDate(context, resetsAt)}';
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
  final next = paidPlanNextLine(context, billing);
  if (next != null) {
    return '$label · $next';
  }
  return '$label plan';
}
