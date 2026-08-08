import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../domain/project_models.dart';

Future<MobileGenerationRecoveryQuote?> confirmGenerationRetry(
  BuildContext context,
  WidgetRef ref,
  MobileProjectStatus status,
) async {
  final quote = status.recoveryQuote;
  if (quote == null) return null;

  return confirmPaidGenerationRetry(
    context,
    ref,
    projectId: status.projectId,
    quote: quote,
  );
}

Future<MobileGenerationRecoveryQuote?> confirmPaidGenerationRetry(
  BuildContext context,
  WidgetRef ref, {
  required String projectId,
  required MobileGenerationRecoveryQuote quote,
}) async {

  final billing = await ref.read(billingProvider.future);
  if (!context.mounted) return null;
  if (billing.credits.available < quote.credits) {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded(
        credits: quote.credits,
        reason: 'Retrying the refunded generation attempt.',
      ),
    );
    ref.invalidate(billingProvider);
    return null;
  }

  final confirmed = await showAppConfirmationDialog(
    context,
    title: 'Retry generation?',
    message:
        'This is a new paid attempt. It costs exactly ${quote.credits} credits; '
        'you have ${billing.credits.available} available. Another failure is refunded.',
    confirmLabel: 'Retry for ${quote.credits}',
  );
  return confirmed ? quote : null;
}
