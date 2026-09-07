import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/export_repair_watch.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

String projectExportDownloadAction(MobileExportAvailability export) =>
    'open-${export.format}';

String projectExportSaveAction(MobileExportAvailability export) =>
    'download-${export.format}';

/// The name a reader knows the format by. Word is the product, not the
/// extension; the other two are known by their initials.
String projectExportFormatLabel(MobileExportAvailability export) {
  final shipped = export.label;
  if (shipped != null && shipped.isNotEmpty) {
    return shipped;
  }
  return ExportRepairFormat.fromFormat(export.format)?.fallbackLabel ??
      export.format.toUpperCase();
}

IconData projectExportIcon(MobileExportAvailability export) =>
    switch (ExportRepairFormat.fromFormat(export.format)) {
      ExportRepairFormat.pdf => Icons.picture_as_pdf_outlined,
      ExportRepairFormat.docx => Icons.description_outlined,
      ExportRepairFormat.epub || null => Icons.menu_book_outlined,
    };

/// Whether the format is a plan perk this account does not have.
///
/// Locked while the billing state is unknown, the same reading the import
/// tile makes: the tile stays tappable and the server rules on the request, so
/// a wrong guess here costs one paywall sheet, never a download.
bool projectExportLockedBySubscription(
  MobileExportAvailability export,
  MobileBilling? billing,
) {
  return export.requiresSubscription &&
      !(billing?.hasCreatorSubscription ?? false);
}

/// What the paywall says when a plan-gated format is tapped without the plan.
String projectExportSubscriptionMessage(MobileExportAvailability export) =>
    '${projectExportFormatLabel(export)} export is part of the Creator plan.';

bool projectExportNeedsCredits(
  MobileExportAvailability export,
  int? availableCredits,
) {
  return export.available &&
      !export.unlocked &&
      availableCredits != null &&
      availableCredits < export.creditsRequired;
}

String projectExportStateText(
  MobileExportAvailability export,
  int? availableCredits, {
  bool lockedBySubscription = false,
}) {
  if (!export.available) {
    return 'Preparing this file after generation finishes.';
  }
  if (lockedBySubscription) {
    return projectExportSubscriptionMessage(export);
  }
  if (export.unlocked) {
    return 'Ready to open or download.';
  }
  if (availableCredits != null && availableCredits < export.creditsRequired) {
    return 'Ready after export unlock. You need ${export.creditsRequired} credits and have $availableCredits.';
  }
  return 'Ready after export unlock. This uses ${export.creditsRequired} credits if not already included.';
}

String projectExportDownloadLabel(
  MobileExportAvailability export,
  bool needsCredits, {
  bool lockedBySubscription = false,
}) {
  final format = projectExportFormatLabel(export);
  if (!export.available) {
    return 'Preparing $format';
  }
  if (lockedBySubscription) {
    return 'Upgrade for $format';
  }
  if (export.unlocked) {
    return 'Open $format';
  }
  if (needsCredits) {
    return 'Get credits';
  }
  return 'Unlock $format';
}

MobileExportAvailability? primaryUnlockedAvailableExport(
  MobileExportSet exports,
) {
  for (final export in [exports.pdf, exports.epub]) {
    if (export.available && export.unlocked) {
      return export;
    }
  }
  return null;
}

/// Whether [error] is the server saying that file is not on disk yet.
///
/// It is not the action failing so much as arriving early: the download route
/// never renders, it queues the repair compile and answers `EXPORT_NOT_READY`,
/// so the file is on its way by the time this is read.
bool isExportRebuilding(Object error) =>
    error is ApiException && error.code == 'EXPORT_NOT_READY';

/// What to say when a download lands in the window between an edit deleting the
/// compiled files and the recompile publishing them.
///
/// Deliberately no promise that a compile is running *right now*, and none that
/// this screen will open the file when it lands: a repair that already failed
/// is not retried until its five-minute window rolls, and the same copy has to
/// hold for that case. It is the reader's wording from `reader_overlays.dart`,
/// because a reader who meets both surfaces meets one book being rebuilt.
String exportRebuildingMessage(MobileExportAvailability export) =>
    'Your ${projectExportFormatLabel(export)} is being rebuilt after the latest '
    'changes. It is usually ready within a few minutes.';

/// Whether [error] is the server refusing a plan-gated format to a free
/// account. The wire code is the import route's, so it means the same thing
/// on every surface: open the paywall, and wait for nothing.
bool isSubscriptionRequired(Object error) =>
    error is ApiException && error.code == 'SUBSCRIPTION_REQUIRED';

/// Puts the shared status flow back on the file this action was refused.
///
/// Without this the snackbar was the end of it: the status the app is holding
/// still says `available`, nothing re-reads it, and the button keeps offering a
/// download that keeps failing. Refreshing `projectStatusProvider` re-opens the
/// one stream every surface already watches, so the button, the reader's gate
/// and the actions menu all follow the same read — and that read is also what
/// asks the server for the repair.
///
/// The watch behind that stream is metered per project
/// (`ExportRepairWatchBudget`), so this joins a bounded wait rather than
/// starting a poll of its own: it cannot outlive the window, and it queues no
/// compile the status read would not have queued anyway. Registering the format
/// is what makes an EPUB-only repair observable at all — the watch otherwise
/// stands down the moment the PDF is on disk.
void joinExportRepairWatch({
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
}) {
  final format = ExportRepairFormat.fromFormat(export.format);
  if (format != null) {
    ref.read(exportRepairWatchProvider(projectId)).noteExportRequested(format);
  }
  ref.invalidate(projectStatusProvider(projectId));
}

/// Reports a failed export action, and re-reads the book when the failure was
/// the file not being there yet.
///
/// Shared by open and download because they fail the same way and are reached
/// from the same buttons: the reader, the book page, the actions menu and the
/// saved-export card.
///
/// A plan refusal is neither a wait nor an error to read aloud: the server
/// said the format needs a plan this account lacks, so the answer is the
/// paywall, with no snackbar and no repair watch — nothing is coming.
Future<bool> _reportExportFailure({
  required BuildContext context,
  required ScaffoldMessengerState messenger,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required Object error,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) async {
  // An unmounted caller has no UI left to correct and its `ref` may already be
  // disposed, so there is nothing to say and nothing to refresh.
  if (!isMounted()) {
    return false;
  }
  if (isSubscriptionRequired(error)) {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: 'Export to ${projectExportFormatLabel(export)}',
      message: projectExportSubscriptionMessage(export),
      exportFormatLabel: projectExportFormatLabel(export),
    );
    if (isMounted()) {
      ref.invalidate(billingProvider);
      onRefresh?.call();
    }
    return false;
  }
  AppHaptics.error();
  final rebuilding = isExportRebuilding(error);
  messenger.showAppSnackBar(
    SnackBar(
      content: Text(
        rebuilding ? exportRebuildingMessage(export) : userFacingError(error),
      ),
    ),
  );
  if (rebuilding) {
    joinExportRepairWatch(ref: ref, projectId: projectId, export: export);
    // The caller's own refresh as well: it carries the project detail, which
    // draws its own export state and would otherwise stay on the stale one.
    onRefresh?.call();
  }
  return false;
}

Future<bool> openProjectExport({
  required BuildContext context,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final outcome = await ref
        .read(projectsRepositoryProvider)
        .openExport(projectId: projectId, export: export);
    if (!isMounted()) {
      return true;
    }
    if (outcome == ExportOpenOutcome.sharedFallback) {
      messenger.showAppSnackBar(
        const SnackBar(
          content: Text(
            'No app can open this file, so sharing was opened instead.',
          ),
        ),
      );
    }
    AppHaptics.success();
    ref.invalidate(billingProvider);
    onRefresh?.call();
    return true;
  } catch (error) {
    // The mounted check the lint wants is the same fact `isMounted` reports;
    // both are asked so a disposed caller neither shows nor refreshes anything.
    if (!context.mounted || !isMounted()) {
      return false;
    }
    return _reportExportFailure(
      context: context,
      messenger: messenger,
      ref: ref,
      projectId: projectId,
      export: export,
      error: error,
      isMounted: isMounted,
      onRefresh: onRefresh,
    );
  }
}

Future<bool> downloadProjectExport({
  required BuildContext context,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final file = await ref
        .read(projectsRepositoryProvider)
        .downloadExport(projectId: projectId, export: export);
    if (!isMounted()) {
      return true;
    }
    await SharePlus.instance.share(
      ShareParams(
        title: file.filename,
        subject: file.filename,
        files: [XFile(file.path, mimeType: export.contentType)],
        fileNameOverrides: [file.filename],
      ),
    );
    AppHaptics.success();
    ref.invalidate(billingProvider);
    onRefresh?.call();
    return true;
  } catch (error) {
    // The mounted check the lint wants is the same fact `isMounted` reports;
    // both are asked so a disposed caller neither shows nor refreshes anything.
    if (!context.mounted || !isMounted()) {
      return false;
    }
    return _reportExportFailure(
      context: context,
      messenger: messenger,
      ref: ref,
      projectId: projectId,
      export: export,
      error: error,
      isMounted: isMounted,
      onRefresh: onRefresh,
    );
  }
}

Future<void> openProjectExportPaywall({
  required BuildContext context,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) async {
  // Reached two ways. A format this account's plan does not include is an
  // offer — the sheet leads with the plan. A credit shortfall on an ordinary
  // format is not: the sheet leads with what the unlock costs.
  final billing = ref.read(billingProvider).asData?.value;
  if (projectExportLockedBySubscription(export, billing)) {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: 'Export to ${projectExportFormatLabel(export)}',
      message: projectExportSubscriptionMessage(export),
      exportFormatLabel: projectExportFormatLabel(export),
    );
  } else {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded(
        credits: export.creditsRequired,
        reason:
            'Your ${projectExportFormatLabel(export)} is ready. Credits unlock '
            'protected downloads for this book.',
      ),
    );
  }
  if (!isMounted()) {
    return;
  }
  ref.invalidate(billingProvider);
  onRefresh?.call();
}
