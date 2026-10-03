import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../domain/project_models.dart';

/// Answers a refused retry. A paid retry rewrites the whole book, so a plan
/// that lapsed since the book was approved meets the long-book offer here —
/// with no shorter way out, because the plan is already sized. Anything else
/// is the server's own sentence in a snackbar, as before.
Future<void> reportGenerationRetryFailure(
  BuildContext context,
  WidgetRef ref,
  Object error, {
  String? projectId,
}) async {
  final pageLimit = pageLimitFromError(error);
  if (pageLimit != null) {
    await showLongBookOffer(
      context,
      projectId: projectId,
      limit: pageLimit,
      canShorten: false,
    );
    ref.invalidate(billingProvider);
    return;
  }
  ScaffoldMessenger.of(
    context,
  ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
}

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

  if (!quote.requiresConfirmation) {
    return quote;
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
