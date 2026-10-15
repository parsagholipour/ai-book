import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';

/// Narrating a book is a plan perk.
///
/// The server refuses a free account's narration with 403
/// `SUBSCRIPTION_REQUIRED` and this sentence; the app asks first, so a free
/// reader meets the plans instead of a narrator picker whose confirm would be
/// refused. Listening to a narration that already exists is never locked —
/// only starting one (or a new narrator) is.
const audiobooksPlanMessage = 'Audiobooks are part of the Creator plan.';

/// Whether narration is a plan perk this reader does not have yet. Unknown
/// billing is not locked: the server rules on the start, and the picker shows
/// its sentence.
bool audiobooksLockedByPlan(MobileBilling? billing) =>
    billing != null && !billing.hasCreatorSubscription;

/// The plan offer a free reader gets instead of the narrator picker.
Future<void> showAudiobookPlanOffer(
  BuildContext context,
  WidgetRef ref, {
  required String projectId,
}) async {
  await showBillingPaywall(
    context,
    projectId: projectId,
    title: 'Hear your book read aloud',
    message:
        '$audiobooksPlanMessage Choose a plan to have your books narrated, '
        'with the words following along.',
    trigger: PaywallTrigger.other,
  );
  ref.invalidate(billingProvider);
}
