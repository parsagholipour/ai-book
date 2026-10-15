import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../billing/data/billing_repository.dart';
import '../../billing/data/first_book_offer_store.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

/// Offers a plan once, the moment a free reader's book is ready.
///
/// The first finished book is the moment there is something to sell: the
/// reader has just seen what Tomeza makes, and the book is theirs to read,
/// download and share whatever they choose. The book page calls this when its status first reads complete. It shows the
/// first-book offer (`BillingFirstBookOffer`) only for a book Tomeza wrote, to
/// an account with no plan, and only the first time on this phone for that
/// account — marked before it opens, so closing it, killing the app under it
/// or buying from it all count. Every way out of it leads back to the book.
Future<void> offerPlanForFirstBook(
  BuildContext context,
  WidgetRef ref, {
  required String projectId,
}) async {
  final MobileProjectDetail project;
  final MobileBilling billing;
  try {
    project = await ref.read(projectDetailProvider(projectId).future);
    billing = await ref.read(billingProvider.future);
  } catch (_) {
    // Nothing to read is nothing to offer; the book page carries on.
    return;
  }
  if (project.source != 'generated' || billing.hasCreatorSubscription) {
    return;
  }
  final store = ref.read(firstBookOfferStoreProvider);
  final account = billing.purchaseAccountId ?? 'account';
  if (await store.wasShown(account) || !context.mounted) {
    return;
  }
  await store.markShown(account);
  if (!context.mounted) {
    return;
  }
  await showBillingPaywall(
    context,
    projectId: projectId,
    firstBookTitle: project.title,
    trigger: PaywallTrigger.firstBook,
  );
  if (context.mounted) {
    ref.invalidate(billingProvider);
    ref.invalidate(projectDetailProvider(projectId));
  }
}
