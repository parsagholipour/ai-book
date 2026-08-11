import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
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

/// How long the card keeps re-checking for a rebuilt export, and when that
/// allowance starts over.
///
/// The allowance belongs to one *wait*, not to the card. It exists only to stop
/// a poll for a file that is never coming — the EPUB is best-effort and a
/// compile finishes without it — so it has to start over whenever a new wait
/// begins: when everything has landed, and when a file that was there goes
/// missing. A lifetime counter looks equivalent and is not: a book whose EPUB
/// never compiles spends it once and then never polls again, so the next edit,
/// which deletes the PDF too, leaves the card "preparing" until the user leaves
/// the screen. It also drained across ordinary edits, a few polls at a time.
@visibleForTesting
class ExportRefreshBudget {
  ExportRefreshBudget({this.maxAttempts = 30});

  /// Two minutes at the card's four-second interval.
  final int maxAttempts;

  int _attempts = 0;
  bool? _lastPdfAvailable;
  bool? _lastEpubAvailable;

  int get attempts => _attempts;

  /// Whether to be polling, given the latest status. Call once per status seen —
  /// it is what notices a file disappearing.
  bool shouldPoll({
    required bool isSettled,
    required bool pdfAvailable,
    required bool epubAvailable,
  }) {
    final rebuildStarted =
        (_lastPdfAvailable == true && !pdfAvailable) ||
        (_lastEpubAvailable == true && !epubAvailable);
    _lastPdfAvailable = pdfAvailable;
    _lastEpubAvailable = epubAvailable;

    if (!isSettled || (pdfAvailable && epubAvailable)) {
      _attempts = 0;
      return false;
    }
    if (rebuildStarted) {
      _attempts = 0;
    }
    return _attempts < maxAttempts;
  }

  /// Counts one poll, and reports whether that was the last one.
  bool recordAttempt() => ++_attempts >= maxAttempts;
}

class _SavedExportCardState extends ConsumerState<SavedExportCard> {
  String? _busyAction;
  Timer? _exportRefreshTimer;
  final ExportRefreshBudget _exportRefresh = ExportRefreshBudget();

  String get _projectId => widget.message.projectId;

  @override
  void dispose() {
    _exportRefreshTimer?.cancel();
    super.dispose();
  }

  /// The SSE connection ends once the project settles. The shared provider
  /// keeps polling a missing PDF, but EPUB is best-effort and intentionally
  /// does not hold every project listener open. This bounded card refresh keeps
  /// both buttons current without polling a failed EPUB forever.
  ///
  /// Either format missing is enough to keep polling. Requiring *both* meant a
  /// book whose PDF alone was still rebuilding — the ordinary case, since the
  /// compile writes the PDF and the EPUB in separate steps — sat on a button
  /// that never recovered.
  void _ensureExportRefresh(MobileProjectStatus? status) {
    // Every poll invalidates the provider, which drops it to loading — so a null
    // status is this card's own refresh in flight, not a change of state.
    // Feeding it to the budget would read as "both files just vanished" and
    // restart the allowance on every cycle, leaving the poll unbounded.
    if (status == null) {
      return;
    }
    final shouldPoll = _exportRefresh.shouldPoll(
      isSettled: status.isSettled,
      pdfAvailable: status.exports.pdf.available,
      epubAvailable: status.exports.epub.available,
    );
    if (!shouldPoll) {
      _stopExportRefresh();
      return;
    }
    _exportRefreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      if (_exportRefresh.recordAttempt()) {
        _stopExportRefresh();
      }
      ref.invalidate(projectStatusProvider(_projectId));
    });
  }

  void _stopExportRefresh() {
    _exportRefreshTimer?.cancel();
    _exportRefreshTimer = null;
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
        (exports == null ||
            (!exports.pdf.available && !exports.epub.available));
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
                  Icon(
                    Icons.edit_note_outlined,
                    size: 20,
                    color: colors.primary,
                  ),
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
                  AppButton.outlined(
                    onPressed: () => context.push(
                      '/projects/$_projectId/edit?savedExportMessageId=${widget.message.id}',
                    ),
                    leading: const Icon(Icons.edit_outlined, size: 18),
                    label: 'Edit',
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
    return AppButton.tonal(
      onPressed: export.available && !isDownloading
          ? () => needsCredits ? _openPaywall(export) : _download(export)
          : null,
      loading: isDownloading,
      loadingLabel: 'Downloading export',
      leading: Icon(
        export.format == 'pdf'
            ? Icons.picture_as_pdf_outlined
            : Icons.menu_book_outlined,
        size: 18,
      ),
      label: projectExportDownloadLabel(export, needsCredits),
    );
  }
}
