import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'project_export_actions.dart';

/// Chat card for a manual Edit Mode save: keeps the export actions (Open PDF,
/// Open EPUB) and re-opens Edit Mode targeting the same saved export, so the
/// next save updates this card instead of creating a new message.
class SavedExportCard extends ConsumerStatefulWidget {
  const SavedExportCard({required this.message, super.key});

  final MobileProjectChatMessage message;

  @override
  ConsumerState<SavedExportCard> createState() => _SavedExportCardState();
}

class _SavedExportCardState extends ConsumerState<SavedExportCard> {
  String? _busyAction;
  Timer? _exportRefreshTimer;

  String get _projectId => widget.message.projectId;

  @override
  void dispose() {
    _exportRefreshTimer?.cancel();
    super.dispose();
  }

  /// The status stream ends once the project settles, so if the exports are
  /// still being rebuilt at that point nothing would ever re-check them.
  /// Poll until a file shows up so the buttons flip to "Open PDF" on their own.
  void _ensureExportRefresh(MobileProjectStatus? status) {
    final waitingForExports =
        status != null &&
        status.isComplete &&
        !status.exports.pdf.available &&
        !status.exports.epub.available;
    if (waitingForExports && _exportRefreshTimer == null) {
      _exportRefreshTimer = Timer.periodic(const Duration(seconds: 4), (_) {
        ref.invalidate(projectStatusProvider(_projectId));
      });
    } else if (!waitingForExports && _exportRefreshTimer != null) {
      _exportRefreshTimer!.cancel();
      _exportRefreshTimer = null;
    }
  }

  Future<void> _download(MobileExportAvailability export) async {
    if (_busyAction != null) return;
    setState(() => _busyAction = projectExportDownloadAction(export));
    await openProjectExport(
      context: context,
      ref: ref,
      projectId: _projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refresh,
    );
    if (!mounted) return;
    setState(() => _busyAction = null);
  }

  Future<void> _openPaywall(MobileExportAvailability export) async {
    await openProjectExportPaywall(
      context: context,
      ref: ref,
      projectId: _projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refresh,
    );
  }

  void _refresh() {
    ref.invalidate(projectStatusProvider(_projectId));
    ref.invalidate(projectDetailProvider(_projectId));
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final manualEdit = widget.message.manualEdit;
    final statusValue = ref.watch(projectStatusProvider(_projectId));
    final availableCredits = ref
        .watch(billingProvider)
        .asData
        ?.value
        .credits
        .available;
    final status = statusValue.asData?.value;
    final exports = status?.exports;
    final rebuildingExports =
        status != null &&
        !status.isComplete &&
        (exports == null || (!exports.pdf.available && !exports.epub.available));
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _ensureExportRefresh(status),
    );
    final pageIndexes = manualEdit?.pageIndexes ?? const <int>[];
    final pagesLabel = pageIndexes.isEmpty
        ? 'Saved edit'
        : pageIndexes.length == 1
        ? 'Saved edit · page ${pageIndexes.first}'
        : 'Saved edit · pages ${pageIndexes.join(", ")}';

    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(top: 2, bottom: 6),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.edit_note_outlined, size: 20, color: colors.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      pagesLabel,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ],
              ),
              if (rebuildingExports) ...[
                const SizedBox(height: 10),
                Row(
                  children: [
                    const SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Rebuilding your files with this edit…',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (exports != null) ...[
                    _exportButton(exports.pdf, availableCredits),
                    _exportButton(exports.epub, availableCredits),
                  ],
                  OutlinedButton.icon(
                    onPressed: () => context.push(
                      '/projects/$_projectId/edit?savedExportMessageId=${widget.message.id}',
                    ),
                    icon: const Icon(Icons.edit_outlined, size: 18),
                    label: const Text('Edit'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _exportButton(MobileExportAvailability export, int? availableCredits) {
    final action = projectExportDownloadAction(export);
    final isDownloading = _busyAction == action;
    final needsCredits = projectExportNeedsCredits(export, availableCredits);
    return FilledButton.tonalIcon(
      onPressed: export.available && !isDownloading
          ? () => needsCredits ? _openPaywall(export) : _download(export)
          : null,
      icon: isDownloading
          ? const SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Downloading export',
              ),
            )
          : Icon(
              export.format == 'pdf'
                  ? Icons.picture_as_pdf_outlined
                  : Icons.menu_book_outlined,
              size: 18,
            ),
      label: Text(projectExportDownloadLabel(export, needsCredits)),
    );
  }
}
