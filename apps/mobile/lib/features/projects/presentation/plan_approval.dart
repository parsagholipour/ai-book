import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../notifications/presentation/book_notifications_offer.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

// The creation chat's part files reach the plan review's shared pieces through
// this file, which the screen already imports.
export '../domain/plan_revision_suggestions.dart'
    show planRevisionSuggestions, planRevisionSuggestionsFor;
export 'book_plan_review.dart' show PlanChapterList, PlanReportButton;

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

  late MobileBilling billing;
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

  if (!context.mounted) {
    return null;
  }
  // Past the longest book any plan writes there is nothing to buy: the server
  // answers BOOK_LENGTH_UNAVAILABLE, so say its sentence before anything else.
  if (billing.exceedsBookPagesCeiling(project.targetPages)) {
    ScaffoldMessenger.of(context).showAppSnackBar(
      SnackBar(
        content: Text(
          "Books longer than ${billing.paidMaxBookPages} pages aren't available yet.",
        ),
      ),
    );
    return null;
  }
  // A plan sized while subscribed, approved after the plan lapsed. The server
  // refuses it too; asking first means the offer, not an error. The length
  // cannot be changed from here — the plan's chapters are already sized to it
  // — so the offer has no "shorter" way out.
  final maxPages = billing.maxBookPages;
  if (maxPages != null && project.targetPages > maxPages) {
    final choice = await showLongBookOffer(
      context,
      projectId: project.id,
      limit: BookPageLimit(
        limit: maxPages,
        requestedPages: project.targetPages,
        maxPages: billing.paidMaxBookPages,
      ),
      canShorten: false,
    );
    ref.invalidate(billingProvider);
    if (choice != LongBookChoice.unlocked) {
      return null;
    }
    try {
      billing = await ref.read(billingProvider.future);
    } catch (_) {
      return null;
    }
  }

  if (!context.mounted) {
    return null;
  }
  // The server refuses an illustrated approval past the monthly budget too,
  // but asking here means the reader picks the outcome — write it without
  // illustrations now, or upgrade — before anything is charged. Never a
  // silent downgrade: only this explicit tap sends `disableIllustrations`.
  var disableIllustrations = false;
  if (project.illustrationsEnabled && billing.isImageQuotaExhausted) {
    final quota = billing.imageQuota!;
    final choice = await _askImageLimitChoice(context, quota);
    if (choice == null) {
      return null;
    }
    if (choice == _ImageLimitChoice.upgrade) {
      if (context.mounted) {
        await showBillingPaywall(
          context,
          projectId: project.id,
          trigger: PaywallTrigger.imageLimit,
          title: 'Out of illustrated books',
          message:
              'Your plan includes ${quota.limit} illustrated books a month and you have used all of them. '
              // Illustrations still cost credits on a plan; only the count
              // of illustrated books stops being capped.
              'Paid plans have no monthly cap on illustrated books.',
        );
        ref.invalidate(billingProvider);
      }
      return null;
    }
    disableIllustrations = true;
  }

  // The book's one price: once it is written its files download free.
  final estimate = disableIllustrations
      ? estimateProjectCredits(
          bookType: project.bookType,
          qualityPreset: project.qualityPreset,
          coverEnabled: project.coverEnabled,
          illustrationsEnabled: false,
          targetPages: project.targetPages,
          creditCosts: billing.creditCosts,
        )
      : estimateApprovalCredits(project, billing.creditCosts);
  if (!context.mounted) {
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
            '${project.bookTypeLabel.toLowerCase()} and preparing its visuals.',
      ),
    );
    ref.invalidate(billingProvider);
    return null;
  }

  final estimateSummary =
      'Book after approval: ${formatCredits(estimate)} credits. You have ${formatCredits(billing.credits.available)} available. Planning is not charged again.';
  final approved = await showAppConfirmationDialog(
    context,
    title: 'Approve this plan?',
    message: disableIllustrations
        ? 'Written without in-book illustrations. $estimateSummary'
        : estimateSummary,
    confirmLabel: 'Approve and start writing',
  );
  if (!approved) {
    return null;
  }

  onStart?.call();
  MobilePlanOperation operation;
  try {
    operation = await ref
        .read(projectsRepositoryProvider)
        .approvePlan(
          plan.id,
          requestId: 'approve-${DateTime.now().microsecondsSinceEpoch}',
          disableIllustrations: disableIllustrations,
        );
    ref.invalidate(projectsProvider);
    ref.invalidate(billingProvider);
    ref.invalidate(projectDetailProvider(project.id));
  } catch (error) {
    final pageLimit = pageLimitFromError(error);
    if (pageLimit != null && context.mounted) {
      await showLongBookOffer(
        context,
        projectId: project.id,
        limit: pageLimit,
        canShorten: false,
      );
      ref.invalidate(billingProvider);
    } else if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
    return null;
  } finally {
    onSettled?.call();
  }
  // The book is being written now: the moment a "tell me when it's ready" is
  // obviously worth saying yes to. Shown at most once, ever.
  if (context.mounted) await offerBookNotifications(context, ref);
  return operation;
}

enum _ImageLimitChoice { withoutIllustrations, upgrade }

/// The month's illustrated books are spent; the book itself is not blocked.
/// Both ways forward sit in one dialog so neither is a dead end: write it
/// without illustrations now, or look at upgrading.
Future<_ImageLimitChoice?> _askImageLimitChoice(
  BuildContext context,
  MobileImageQuota quota,
) {
  return showDialog<_ImageLimitChoice>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Out of illustrated books'),
      content: Text(
        'Your plan includes ${quota.limit} illustrated books a month and you '
        'have used all of them. You can still write this book now without '
        'in-book illustrations, or upgrade to a plan with no monthly cap on '
        'illustrated books.',
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Cancel',
        ),
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(_ImageLimitChoice.upgrade),
          label: 'See upgrades',
        ),
        AppButton.primary(
          onPressed: () =>
              Navigator.of(context).pop(_ImageLimitChoice.withoutIllustrations),
          label: 'Write without illustrations',
        ),
      ],
    ),
  );
}
