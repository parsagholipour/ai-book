import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
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
      messenger.showSnackBar(
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
    if (isMounted()) {
      AppHaptics.error();
      messenger.showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
    return false;
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
    if (isMounted()) {
      AppHaptics.error();
      messenger.showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
    return false;
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
