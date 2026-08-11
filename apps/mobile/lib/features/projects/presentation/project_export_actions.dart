import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/export_repair_watch.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

String projectExportDownloadAction(MobileExportAvailability export) =>
    'open-${export.format}';

String projectExportSaveAction(MobileExportAvailability export) =>
    'download-${export.format}';

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
  int? availableCredits,
) {
  if (!export.available) {
    return 'Preparing this file after generation finishes.';
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
  bool needsCredits,
) {
  final format = export.format.toUpperCase();
  if (!export.available) {
    return 'Preparing $format';
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
    'Your ${export.format.toUpperCase()} is being rebuilt after the latest '
    'changes. It is usually ready within a few minutes.';

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
bool _reportExportFailure({
  required ScaffoldMessengerState messenger,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required Object error,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) {
  // An unmounted caller has no UI left to correct and its `ref` may already be
  // disposed, so there is nothing to say and nothing to refresh.
  if (!isMounted()) {
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
    return _reportExportFailure(
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
    return _reportExportFailure(
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
  // Only ever reached through `projectExportNeedsCredits`, so this is a
  // shortfall rather than an offer: the sheet leads with what the unlock costs.
  await showBillingPaywall(
    context,
    projectId: projectId,
    title: null,
    creditsNeeded: PaywallCreditsNeeded(
      credits: export.creditsRequired,
      reason:
          'Your ${export.format.toUpperCase()} is ready. Credits unlock '
          'protected downloads for this book.',
    ),
  );
  if (!isMounted()) {
    return;
  }
  ref.invalidate(billingProvider);
  onRefresh?.call();
}
