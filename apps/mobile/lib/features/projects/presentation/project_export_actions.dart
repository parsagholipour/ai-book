import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

String projectExportDownloadAction(MobileExportAvailability export) =>
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
    return 'Ready to save or share.';
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
    return 'Get $format';
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

Future<bool> shareProjectExport({
  required BuildContext context,
  required WidgetRef ref,
  required String projectId,
  required MobileExportAvailability export,
  required bool Function() isMounted,
  VoidCallback? onRefresh,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ref
        .read(projectsRepositoryProvider)
        .shareExport(projectId: projectId, export: export);
    if (!isMounted()) {
      return true;
    }
    ref.invalidate(billingProvider);
    onRefresh?.call();
    return true;
  } catch (error) {
    if (isMounted()) {
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
  await showBillingPaywall(
    context,
    projectId: projectId,
    title: 'Unlock exports',
    message:
        'This ${export.format.toUpperCase()} is ready. Add credits to unlock protected downloads for this book.',
  );
  if (!isMounted()) {
    return;
  }
  ref.invalidate(billingProvider);
  onRefresh?.call();
}
