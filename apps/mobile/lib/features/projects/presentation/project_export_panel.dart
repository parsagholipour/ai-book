import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/export_models.dart';
import 'project_export_actions.dart';

// The files a finished book can leave the app as: one row per format, each
// saying plainly what state it is in — being prepared, ready and how big, ready
// after an unlock, or part of a plan the account does not have yet.
//
// Drawn two ways. Embedded, it is the body of the hero's Export drawer; as a
// card it is the "files from your last version" list that a book being edited
// keeps while its new files are being built.

class ProjectExportPanel extends StatelessWidget {
  const ProjectExportPanel({
    required this.exports,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.billing,
    this.busyAction,
    this.onRefresh,
    this.embedded = false,
    super.key,
  });

  final MobileExportSet exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  /// Re-reads the book's files. Offered beside any file still being prepared,
  /// because a wait with no way to ask again is a dead end when the repair that
  /// was meant to end it has stood down.
  final VoidCallback? onRefresh;

  /// Draws only the rows, for a surface that already supplies the card and its
  /// heading.
  final bool embedded;

  @override
  Widget build(BuildContext context) {
    final preparing = exports.all.any((export) => !export.available);
    final rows = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, export) in exports.all.indexed) ...[
          if (index > 0) const Divider(height: AppSpacing.md, thickness: 1),
          ProjectExportRow(
            export: export,
            billing: billing,
            busyAction: busyAction,
            onOpen: onOpen,
            onDownload: onDownload,
            onOpenPaywall: onOpenPaywall,
          ),
        ],
        if (preparing && onRefresh != null)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              onPressed: onRefresh,
              leading: const Icon(Icons.refresh),
              label: 'Check again',
            ),
          ),
      ],
    );
    if (embedded) {
      return rows;
    }
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Exports',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: AppSpacing.sm),
          rows,
        ],
      ),
    );
  }
}

/// One format, one line of state, and the one thing that can be done with it.
class ProjectExportRow extends StatelessWidget {
  const ProjectExportRow({
    required this.export,
    required this.billing,
    required this.busyAction,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    super.key,
  });

  final MobileExportAvailability export;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final availableCredits = billing?.credits.available;
    final name = projectExportFormatLabel(export);
    final isOpening = busyAction == projectExportDownloadAction(export);
    final isDownloading = busyAction == projectExportSaveAction(export);
    final locked = projectExportLockedBySubscription(export, billing);
    final needsCredits = projectExportNeedsCredits(export, availableCredits);
    // A locked row stays tappable: the tap opens the paywall, and the server
    // rules on the request either way.
    final toPaywall = locked || needsCredits;
    final canAct = export.available && !(isOpening || isDownloading);
    final phase = !export.available
        ? _ExportPhase.preparing
        : locked
        ? _ExportPhase.plan
        : export.unlocked
        ? _ExportPhase.ready
        : _ExportPhase.unlock;

    final info = _RowInfo(
      export: export,
      phase: phase,
      state: _stateLine(export, phase, availableCredits),
    );

    final actions = switch (phase) {
      _ExportPhase.preparing => null,
      _ExportPhase.plan => AppButton.outlined(
        onPressed: canAct ? () => onOpenPaywall(export) : null,
        leading: const Icon(Icons.workspace_premium_outlined),
        label: 'Upgrade',
      ),
      _ExportPhase.unlock => AppButton.tonal(
        onPressed: canAct
            ? () => toPaywall ? onOpenPaywall(export) : onOpen(export)
            : null,
        loading: isOpening,
        loadingLabel: 'Opening export',
        leading: Icon(
          needsCredits ? Icons.add_card_outlined : Icons.lock_open_outlined,
        ),
        label: needsCredits ? 'Get credits' : 'Unlock',
      ),
      _ExportPhase.ready => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppButton.tonal(
            onPressed: canAct ? () => onOpen(export) : null,
            loading: isOpening,
            loadingLabel: 'Opening export',
            label: 'Open',
          ),
          const SizedBox(width: AppSpacing.xs),
          _ShareButton(
            tooltip: 'Share $name',
            busy: isDownloading,
            onPressed: canAct ? () => onDownload(export) : null,
          ),
        ],
      ),
    };

    return LayoutBuilder(
      builder: (context, constraints) {
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        // Open and Share fit beside the state line on a phone; Upgrade and
        // Unlock carry a longer label and would squeeze it to a sliver, so they
        // sit beneath it. Large text stacks everything.
        final wideAction =
            phase == _ExportPhase.plan || phase == _ExportPhase.unlock;
        final stacked =
            textScale >= 1.3 ||
            constraints.maxWidth < 300 ||
            (wideAction && constraints.maxWidth < 420);
        if (actions == null) {
          return info;
        }
        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              info,
              const SizedBox(height: AppSpacing.sm),
              Align(alignment: AlignmentDirectional.centerEnd, child: actions),
            ],
          );
        }
        return Row(
          children: [
            Expanded(child: info),
            const SizedBox(width: AppSpacing.sm),
            actions,
          ],
        );
      },
    );
  }

  /// One short line. The long form of each state lives in the paywall and the
  /// reader's gate; a row only has to say what is true and what it costs.
  static String _stateLine(
    MobileExportAvailability export,
    _ExportPhase phase,
    int? availableCredits,
  ) {
    switch (phase) {
      case _ExportPhase.preparing:
        return 'Preparing…';
      case _ExportPhase.plan:
        return 'Included with the Creator plan';
      case _ExportPhase.ready:
        final size = export.byteSize;
        return size == null ? 'Ready' : 'Ready · ${formatExportSize(size)}';
      case _ExportPhase.unlock:
        if (export.creditsRequired <= 0) {
          return 'Ready to unlock';
        }
        final cost =
            'Unlock for ${formatCredits(export.creditsRequired)} credits';
        return availableCredits != null &&
                availableCredits < export.creditsRequired
            ? '$cost · you have $availableCredits'
            : cost;
    }
  }
}

enum _ExportPhase { preparing, plan, ready, unlock }

/// "2.4 MB", "612 KB": what a reader deciding whether to share over a slow
/// connection wants to know, without the false precision of bytes.
String formatExportSize(int bytes) {
  if (bytes < 1000 * 1000) {
    final kb = (bytes / 1000).ceil().clamp(1, 999);
    return '$kb KB';
  }
  final mb = bytes / (1000 * 1000);
  return mb < 10 ? '${mb.toStringAsFixed(1)} MB' : '${mb.round()} MB';
}

class _RowInfo extends StatelessWidget {
  const _RowInfo({
    required this.export,
    required this.phase,
    required this.state,
  });

  final MobileExportAvailability export;
  final _ExportPhase phase;
  final String state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final name = projectExportFormatLabel(export);
    final upgrade = phase == _ExportPhase.plan;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        ExcludeSemantics(
          child: Container(
            width: AppSizes.minimumTouchTarget - AppSpacing.xs,
            height: AppSizes.minimumTouchTarget - AppSpacing.xs,
            decoration: BoxDecoration(
              color: upgrade
                  ? colors.surfaceContainerHigh
                  : colors.primaryContainer,
              borderRadius: BorderRadius.circular(AppRadii.compact),
            ),
            child: Icon(
              projectExportIcon(export),
              color: upgrade
                  ? colors.onSurfaceVariant
                  : colors.onPrimaryContainer,
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Semantics(
            container: true,
            label: '$name. $state',
            child: ExcludeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    state,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (phase == _ExportPhase.preparing)
          ExcludeSemantics(
            child: Icon(
              Icons.hourglass_top_rounded,
              size: 20,
              color: colors.onSurfaceVariant,
            ),
          ),
      ],
    );
  }
}

class _ShareButton extends StatelessWidget {
  const _ShareButton({
    required this.tooltip,
    required this.busy,
    required this.onPressed,
  });

  final String tooltip;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    if (busy) {
      return Semantics(
        label: 'Preparing to share',
        liveRegion: true,
        child: const SizedBox.square(
          dimension: AppSizes.minimumTouchTarget,
          child: Center(
            child: SizedBox.square(
              dimension: AppSizes.buttonProgressIndicator,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ),
      );
    }
    return IconButton.outlined(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: const Icon(Icons.ios_share_outlined),
      style: IconButton.styleFrom(
        minimumSize: const Size.square(AppSizes.minimumTouchTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.control),
        ),
      ),
    );
  }
}
