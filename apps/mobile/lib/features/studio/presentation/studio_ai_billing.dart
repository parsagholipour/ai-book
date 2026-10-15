import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../billing/presentation/message_allowance_banner.dart';
import '../../projects/data/projects_repository.dart';
import '../domain/assist_models.dart';
import '../domain/studio_pricing.dart';
import '../../billing/domain/billing_models.dart';

/// The book's quality tier, which decides what its AI tools cost. Read off
/// the project, the way the rest of the app quotes a book.
final studioQualityPresetProvider = FutureProvider.autoDispose
    .family<String, String>((ref, projectId) async {
      final project = await ref.watch(projectDetailProvider(projectId).future);
      return project.qualityPreset;
    });

/// What a background tool would cost now, or null while the price table or
/// the book's tier is still loading (the button waits for it: nothing is
/// offered for a tap without its price).
int? watchStudioAssistPrice(
  WidgetRef ref,
  String projectId,
  LongAssistKind kind, {
  int? targetWords,
  int chapterChars = 0,
}) {
  final billing = ref.watch(billingProvider).asData?.value;
  final preset = ref
      .watch(studioQualityPresetProvider(projectId))
      .asData
      ?.value;
  if (billing == null || preset == null) return null;
  return estimateStudioAssistCredits(
    kind: kind,
    qualityPreset: preset,
    creditCosts: billing.creditCosts,
    targetWords: targetWords,
    chapterChars: chapterChars,
  );
}

/// Whether the price could not be read at all (rather than not yet).
bool watchStudioPriceFailed(WidgetRef ref, String projectId) =>
    ref.watch(billingProvider).hasError ||
    ref.watch(studioQualityPresetProvider(projectId)).hasError;

/// Reads the price table and the tier again after a failure.
void retryStudioPrice(WidgetRef ref, String projectId) {
  ref.invalidate(billingProvider);
  ref.invalidate(studioQualityPresetProvider(projectId));
}

/// "45 credits", "1 credit".
String studioCredits(int credits) =>
    credits == 1 ? '1 credit' : '${formatCredits(credits)} credits';

/// The app's existing answers to a refusal about money or allowance: the
/// message-allowance sheet, the paywall. A seam so tests can stand in for the
/// billing sheets, which need the store.
///
/// Each answer resolves true when the author came back able to go on — a
/// purchase, a reset allowance — because a purchase is a turn the Studio must
/// answer (with a way to run what was blocked), never a sheet that closes on
/// the same dead end.
class StudioAiBillingGate {
  const StudioAiBillingGate();

  /// Before a quick tool spends a message: false when the allowance sheet
  /// said the author is out.
  Future<bool> ensureMessages(BuildContext context, WidgetRef ref) =>
      ensureMessageAllowance(context, ref);

  /// 429 `MESSAGE_LIMIT_REACHED`.
  Future<bool> messageLimitReached(BuildContext context, WidgetRef ref) async {
    await showMessageAllowance(context);
    try {
      final billing = await ref.refresh(billingProvider.future);
      final allowance = billing.messageAllowance;
      return allowance == null || !allowance.isExhausted;
    } catch (_) {
      return false;
    }
  }

  /// 402 `INSUFFICIENT_CREDITS`.
  Future<bool> creditsNeeded(
    BuildContext context,
    WidgetRef ref,
    ApiException error, {
    required String projectId,
    required String reason,
  }) async {
    final purchase = await showBillingPaywall(
      context,
      projectId: projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded.fromApiError(error, reason: reason),
    );
    ref.invalidate(billingProvider);
    return purchase != null;
  }

  /// 403 `IMAGE_LIMIT_REACHED` or `SUBSCRIPTION_REQUIRED`: the server's
  /// sentence, and the plans.
  Future<bool> planRequired(
    BuildContext context,
    WidgetRef ref,
    ApiException error, {
    required String projectId,
  }) async {
    final purchase = await showBillingPaywall(
      context,
      projectId: projectId,
      title: error.code == 'IMAGE_LIMIT_REACHED'
          ? 'Out of illustrated books'
          : 'Upgrade your plan',
      message: error.message,
      trigger: error.code == 'IMAGE_LIMIT_REACHED'
          ? PaywallTrigger.imageLimit
          : null,
    );
    ref.invalidate(billingProvider);
    return purchase != null;
  }
}

final studioAiBillingGateProvider = Provider<StudioAiBillingGate>(
  (ref) => const StudioAiBillingGate(),
);

/// How a refusal was answered.
enum StudioAiRecovery {
  /// Not a money refusal: show the error.
  none,

  /// The billing sheet was shown and the author can go on now.
  ready,

  /// The billing sheet was shown and nothing changed.
  blocked,
}

/// Answers a refusal about money or allowance with the app's own sheets.
Future<StudioAiRecovery> answerStudioBillingRefusal(
  BuildContext context,
  WidgetRef ref,
  Object error, {
  required String projectId,
  required String reason,
}) async {
  if (error is! ApiException) return StudioAiRecovery.none;
  final gate = ref.read(studioAiBillingGateProvider);
  final bool ready;
  if (error.code == 'MESSAGE_LIMIT_REACHED') {
    ready = await gate.messageLimitReached(context, ref);
  } else if (error.code == 'INSUFFICIENT_CREDITS' || error.statusCode == 402) {
    ready = await gate.creditsNeeded(
      context,
      ref,
      error,
      projectId: projectId,
      reason: reason,
    );
  } else if (error.code == 'IMAGE_LIMIT_REACHED' ||
      error.code == 'SUBSCRIPTION_REQUIRED') {
    ready = await gate.planRequired(context, ref, error, projectId: projectId);
  } else {
    return StudioAiRecovery.none;
  }
  return ready ? StudioAiRecovery.ready : StudioAiRecovery.blocked;
}

/// The sentence for a writing-assistant failure that no sheet answers.
String studioAiErrorMessage(Object error) {
  if (error is ApiException) {
    if (error.code == 'ASSIST_UNAVAILABLE') {
      return 'The writing assistant couldn’t answer just now.';
    }
    if (error.code == 'NETWORK_ERROR') {
      return 'You’re offline. Check your connection and try again.';
    }
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

/// Whether trying the same request again could help. A 400 is about the
/// request itself, and so is a 422 content refusal; asking again would get the
/// same answer.
bool studioAiErrorRetryable(Object error) =>
    error is! ApiException ||
    (error.statusCode != 400 && error.statusCode != 422);
