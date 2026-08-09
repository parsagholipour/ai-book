import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/export_models.dart';
import 'project_export_actions.dart';

// The exports card on the generation progress screen: one tile per format,
// plus the entry points into reading and manually editing a finished book.

class ProjectExportPanel extends StatelessWidget {
  const ProjectExportPanel({
    required this.exports,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.billing,
    this.busyAction,
    this.editBookProjectId,
    super.key,
  });

  final MobileExportSet exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  /// When set, shows the manual Edit Mode entry for this completed book.
  final String? editBookProjectId;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Exports',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              'Exports stay protected by your account and project unlock.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            if (editBookProjectId != null && exports.pdf.available) ...[
              AppButton.primary(
                onPressed: () =>
                    context.push('/projects/$editBookProjectId/read'),
                leading: const Icon(Icons.auto_stories_outlined),
                label: 'Read in Tomeza',
                expanded: true,
              ),
              const SizedBox(height: 12),
            ],
            _ExportFormatTile(
              export: exports.pdf,
              availableCredits: billing?.credits.available,
              icon: Icons.picture_as_pdf_outlined,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
            ),
            const Divider(height: 22),
            _ExportFormatTile(
              export: exports.epub,
              availableCredits: billing?.credits.available,
              icon: Icons.menu_book_outlined,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
            ),
            if (editBookProjectId != null) ...[
              const Divider(height: 22),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Want to change something yourself? Open Edit Mode and '
                      'rewrite any page before you export.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  AppButton.outlined(
                    onPressed: () =>
                        context.push('/projects/$editBookProjectId/edit'),
                    leading: const Icon(Icons.edit_note_outlined),
                    label: 'Edit book',
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ExportFormatTile extends StatelessWidget {
  const _ExportFormatTile({
    required this.export,
    required this.availableCredits,
    required this.icon,
    required this.busyAction,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
  });

  final MobileExportAvailability export;
  final int? availableCredits;
  final IconData icon;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final openAction = projectExportDownloadAction(export);
    final saveAction = projectExportSaveAction(export);
    final isOpening = busyAction == openAction;
    final isDownloading = busyAction == saveAction;
    final isBusy = isOpening || isDownloading;
    final needsCredits = projectExportNeedsCredits(export, availableCredits);
    final canAct = export.available && !isBusy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: colors.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    export.format.toUpperCase(),
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    projectExportStateText(export, availableCredits),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            AppButton.primary(
              onPressed: canAct
                  ? () => needsCredits ? onOpenPaywall(export) : onOpen(export)
                  : null,
              loading: isOpening,
              loadingLabel: 'Opening export',
              leading: Icon(
                export.unlocked
                    ? Icons.open_in_new_outlined
                    : needsCredits
                    ? Icons.add_card_outlined
                    : Icons.lock_open_outlined,
              ),
              label: projectExportDownloadLabel(export, needsCredits),
            ),
            if (export.unlocked)
              AppButton.outlined(
                onPressed: canAct ? () => onDownload(export) : null,
                loading: isDownloading,
                loadingLabel: 'Downloading export',
                leading: const Icon(Icons.download_outlined),
                label: 'Download',
              ),
          ],
        ),
      ],
    );
  }
}
