import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

/// Shared credit/paywall/confirm + approve flow used by the project detail
/// screen and the in-chat plan stage so approval behaves identically.
///
/// Returns the queued [MobilePlanOperation] when writing started, or `null`
/// when the user cancelled, was blocked by the paywall, or an error occurred
/// (in which case a snackbar is shown). Callers handle navigation.
Future<MobilePlanOperation?> confirmAndApprovePlan(
  BuildContext context,
  WidgetRef ref,
  MobileProjectDetail project, {
  VoidCallback? onStart,
  VoidCallback? onSettled,
}) async {
  final plan = project.plan;
  if (plan == null) {
    return null;
  }

  late final MobileBilling billing;
  try {
    billing = await ref.read(billingProvider.future);
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
    return null;
  }

  final estimate = estimateApprovalCredits(project, billing.creditCosts);
  final hasProjectUnlock = billing.entitlements.any(
    (entitlement) =>
        entitlement.type == 'EXPORT_UNLOCK' &&
        entitlement.projectId == project.id,
  );
  if (!context.mounted) {
    return null;
  }
  // The server refuses this too, but catching it here means the choice — upgrade
  // or write it without visuals — is offered before anything is charged.
  if (project.illustrationsEnabled && billing.isImageQuotaExhausted) {
    final quota = billing.imageQuota!;
    await showBillingPaywall(
      context,
      projectId: project.id,
      title: 'Out of illustrated books',
      message:
          'Your plan includes ${quota.limit} illustrated books a month and you have used all of them. '
          'Upgrade for unlimited illustrations, or turn In-book illustrations off for this book.',
    );
    ref.invalidate(billingProvider);
    return null;
  }
  if (billing.credits.available < estimate) {
    // The estimate and the balance are both known here, so the sheet opens on
    // its credits-needed section: what this costs, how far short the account
    // is, and the two ways to close the gap.
    await showBillingPaywall(
      context,
      projectId: project.id,
      title: null,
      creditsNeeded: PaywallCreditsNeeded(
        credits: estimate,
        reason:
            'Writing this ${project.lengthPresetLabel.toLowerCase()} '
            '${project.bookTypeLabel.toLowerCase()}, preparing its visuals and '
            'unlocking its export.',
      ),
    );
    ref.invalidate(billingProvider);
    return null;
  }

  final approved = await showAppConfirmationDialog(
    context,
    title: 'Approve this plan?',
    message: hasProjectUnlock
        ? 'This project already has an export unlock. Starting the full book can still spend writing credits.'
        : 'Estimated package: $estimate credits. You have ${billing.credits.available} available.',
    confirmLabel: 'Approve and start writing',
  );
  if (!approved) {
    return null;
  }

  onStart?.call();
  try {
    final operation = await ref
        .read(projectsRepositoryProvider)
        .approvePlan(
          plan.id,
          requestId: 'approve-${DateTime.now().microsecondsSinceEpoch}',
        );
    ref.invalidate(projectsProvider);
    ref.invalidate(billingProvider);
    ref.invalidate(projectDetailProvider(project.id));
    return operation;
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
    return null;
  } finally {
    onSettled?.call();
  }
}
