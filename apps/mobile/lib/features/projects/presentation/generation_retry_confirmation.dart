import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
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
  final MobileBilling billing;
  try {
    billing = await _currentBilling(ref);
  } catch (error) {
    // The balance could not be read, so nothing can be confirmed. Said once,
    // here, so no caller's busy state waits on a confirmation that will never
    // come — the chat's "Retry generation" used to spin for good on this.
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(_balanceFailure(error))));
    }
    return null;
  }
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

/// The balance a paid retry is confirmed against.
///
/// Watched while it is read. `billingProvider` is autoDispose and the screens
/// that offer a retry do not all watch it, and a failing read of an unwatched
/// one is disposed in the middle of Riverpod's own retry: its future then
/// fails with "disposed during loading" instead of the failure. A read that
/// already failed is made again rather than handed back, because
/// `billingProvider.future` rethrows the old failure for as long as the
/// provider holds it. And it is bounded: Riverpod retries a failure for ~38 s
/// before giving up, and the button is busy all that time.
Future<MobileBilling> _currentBilling(WidgetRef ref) async {
  final watching = ref.listenManual(billingProvider, (_, _) {});
  try {
    final current = ref.read(billingProvider);
    final read = current.hasError && !current.isLoading
        ? ref.refresh(billingProvider.future)
        : ref.read(billingProvider.future);
    return await read.timeout(_balanceReadTimeout);
  } finally {
    watching.close();
  }
}

const _balanceReadTimeout = Duration(seconds: 15);

String _balanceFailure(Object error) {
  final message = userFacingError(error);
  if (message != userFacingError(Object())) return message;
  return "Couldn't check your credits. Check your connection and try again.";
}
