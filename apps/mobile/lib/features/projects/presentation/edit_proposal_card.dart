import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'credit_cost_badge.dart';
import 'edit_diff_view.dart';
import 'edit_kind_presentation.dart';
import 'plan_build_progress.dart';

/// What became of a proposal, when this screen saw it happen.
///
/// The transcript stores no outcome on a spent card, so only a proposal settled
/// in this session can say which way it went. After a restart the card reads as
/// closed, which is true of both.
enum EditProposalOutcome { applied, cancelled }

/// Priced book-edit confirmation card. Apply / Cancel call dedicated proposal
/// endpoints (not chat-text confirmations).
///
/// This is the last screen before a charge, so it is built to be read at a
/// glance: what sort of change, what it covers, what it costs (or that it is
/// free), what will read differently when the server can show it, and one
/// dominant action. A card that is no longer open collapses to a quiet history
/// row instead of repeating the whole ask with its buttons removed.
class EditProposalCard extends StatelessWidget {
  const EditProposalCard({
    required this.proposal,
    required this.enabled,
    this.onApply,
    this.onCancel,
    this.applying = false,
    this.outcome,
    super.key,
  });

  final MobileEditProposal proposal;
  final bool enabled;
  final VoidCallback? onApply;
  final VoidCallback? onCancel;

  /// This card's own Apply request is in flight. The buttons give way to
  /// progress so a tap is never met with a silently greyed-out card.
  final bool applying;

  /// How this proposal was settled in this session, if it was.
  final EditProposalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final open = onApply != null || onCancel != null;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xs),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: SizedBox(
          width: double.infinity,
          child: open
              ? _OpenProposal(
                  proposal: proposal,
                  enabled: enabled,
                  onApply: onApply,
                  onCancel: onCancel,
                  applying: applying,
                )
              : _SettledProposal(proposal: proposal, outcome: outcome),
        ),
      ),
    );
  }
}

class _OpenProposal extends StatelessWidget {
  const _OpenProposal({
    required this.proposal,
    required this.enabled,
    required this.onApply,
    required this.onCancel,
    required this.applying,
  });

  final MobileEditProposal proposal;
  final bool enabled;
  final VoidCallback? onApply;
  final VoidCallback? onCancel;
  final bool applying;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = proposalKindStyle(proposal);
    final preview = proposal.preview;
    final fact = _structuralFact(proposal);
    return Semantics(
      container: true,
      label: 'Proposed edit',
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: colors.surfaceContainerLowest,
          borderRadius: BorderRadius.circular(AppRadii.card),
          border: Border.all(
            color: colors.primary.withValues(alpha: 0.5),
            width: 1.4,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                _KindTile(icon: style.icon),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Proposed edit',
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: colors.onSurfaceVariant,
                          letterSpacing: 0.3,
                        ),
                      ),
                      Text(
                        style.label,
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            _ProposalSummary(summary: proposal.summary),
            const SizedBox(height: AppSpacing.sm),
            _ScopeAndCost(proposal: proposal),
            if (preview != null) ...[
              const SizedBox(height: AppSpacing.sm),
              _ExactPreview(preview: preview),
            ],
            if (fact != null) ...[
              const SizedBox(height: AppSpacing.sm),
              _FactRow(icon: Icons.menu_book_outlined, text: fact),
            ],
            const SizedBox(height: AppSpacing.md),
            if (applying)
              const _ApplyingStrip()
            else
              _ProposalActions(
                enabled: enabled,
                onApply: onApply,
                onCancel: onCancel,
              ),
          ],
        ),
      ),
    );
  }
}

/// How a page-structure edit changes the length of the book, in a sentence.
///
/// A move rewrites nothing and changes no length, so it has none. `totalPages`
/// is the length once the edit is applied.
String? _structuralFact(MobileEditProposal proposal) {
  final change = proposal.structural;
  if (change == null || change.totalPages <= 0 || change.pageCount <= 0) {
    return null;
  }
  return switch (change.action) {
    'insert' =>
      'Your book goes from ${change.totalPages - change.pageCount} to '
          '${change.totalPages} pages.',
    'delete' =>
      'Your book goes from ${change.totalPages + change.pageCount} to '
          '${change.totalPages} pages.',
    _ => null,
  };
}

class _KindTile extends StatelessWidget {
  const _KindTile({required this.icon, this.size = 40, this.muted = false});

  final IconData icon;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: muted
              ? colors.surfaceContainerHighest
              : colors.primaryContainer,
          borderRadius: BorderRadius.circular(AppRadii.compact + 2),
        ),
        child: Icon(
          icon,
          size: size * 0.55,
          color: muted ? colors.onSurfaceVariant : colors.onPrimaryContainer,
        ),
      ),
    );
  }
}

/// The instruction the reader is approving, in full.
///
/// The server puts the whole execution contract here — up to a couple of
/// paragraphs of requirements — and clipping it silently once hid requirements
/// the worker would still carry out. A long one folds behind an explicit
/// "Show all" rather than being cut.
class _ProposalSummary extends StatefulWidget {
  const _ProposalSummary({required this.summary});

  final String summary;

  static const _foldAt = 240;

  @override
  State<_ProposalSummary> createState() => _ProposalSummaryState();
}

class _ProposalSummaryState extends State<_ProposalSummary> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final foldable = widget.summary.length > _ProposalSummary._foldAt;
    final folded = foldable && !_expanded;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AnimatedSize(
          duration: AppMotion.reducedMotion(context)
              ? Duration.zero
              : AppMotion.medium,
          curve: AppMotion.standard,
          alignment: Alignment.topCenter,
          child: Text(
            widget.summary,
            maxLines: folded ? 5 : null,
            overflow: folded ? TextOverflow.ellipsis : null,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w700,
              height: 1.35,
            ),
          ),
        ),
        if (foldable)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: _expanded ? 'Show less' : 'Show all',
              onPressed: () => setState(() => _expanded = !_expanded),
            ),
          ),
      ],
    );
  }
}

/// Where the edit lands and what it costs, side by side.
///
/// A free edit says so. Silence next to a paid one reads as "free" and next to
/// a free one reads as "unknown", so both are stated.
class _ScopeAndCost extends StatelessWidget {
  const _ScopeAndCost({required this.proposal});

  final MobileEditProposal proposal;

  IconData _scopeIcon() {
    final structural = proposal.structural;
    if (structural != null) {
      return proposalKindStyle(proposal).icon;
    }
    if (proposal.scope == 'all_pages') return Icons.auto_stories_outlined;
    if (proposal.affectedChapterIndex != null) return Icons.bookmark_outline;
    return Icons.description_outlined;
  }

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        AppMetricChip(label: proposal.pageLabel, icon: _scopeIcon()),
        if (proposal.credits > 0)
          CreditCostBadge(
            credits: proposal.credits,
            kind: CreditCostKind.quoted,
          )
        else
          const AppStatusBadge(
            label: 'Free',
            icon: Icons.check_circle_outline,
            tone: AppTone.success,
          ),
      ],
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icon, size: 18, color: colors.onSurfaceVariant),
        ),
        const SizedBox(width: AppSpacing.xs),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

/// The exact before/after lines a deterministic edit will produce.
///
/// Only shown for literal find/replace edits, where the server computed the
/// result without a model: what is drawn here is the change itself, not a
/// description of one, which is what makes approving it safe. The words that
/// differ are marked in both lines so the eye lands on them.
class _ExactPreview extends StatelessWidget {
  const _ExactPreview({required this.preview});

  final MobileEditPreview preview;

  /// More than this and the card stops being a confirmation and becomes a list.
  static const _maxSamples = 4;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final samples = preview.samples.take(_maxSamples).toList();
    final more = preview.samples.length - samples.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'What will change',
          style: theme.textTheme.labelMedium?.copyWith(
            color: colors.onSurfaceVariant,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Container(
          padding: const EdgeInsets.all(AppSpacing.sm),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.compact + 2),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (index, sample) in samples.indexed) ...[
                if (index > 0) ...[
                  const SizedBox(height: AppSpacing.xs),
                  Divider(height: 1, color: colors.outlineVariant),
                  const SizedBox(height: AppSpacing.xs),
                ],
                _SamplePair(sample: sample),
              ],
              if (more > 0) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '+$more more like this',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _SamplePair extends StatelessWidget {
  const _SamplePair({required this.sample});

  final MobileEditPreviewSample sample;

  @override
  Widget build(BuildContext context) {
    final runs = diffWords(sample.before, sample.after);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _PreviewLine(
          removed: true,
          runs: [
            for (final run in runs)
              if (run.type != MobileEditDiffRunType.insert) run,
          ],
        ),
        const SizedBox(height: 6),
        _PreviewLine(
          removed: false,
          runs: [
            for (final run in runs)
              if (run.type != MobileEditDiffRunType.delete) run,
          ],
        ),
      ],
    );
  }
}

class _PreviewLine extends StatelessWidget {
  const _PreviewLine({required this.removed, required this.runs});

  /// The "before" line (true) or the "after" line (false).
  final bool removed;
  final List<MobileEditDiffRun> runs;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final palette = EditDiffPalette.of(context);
    final accent = removed
        ? palette.deleteForeground
        : palette.insertForeground;
    final mark = removed ? palette.deleteBackground : palette.insertBackground;
    final base = theme.textTheme.bodySmall?.copyWith(
      height: 1.4,
      color: colors.onSurface,
    );
    final label = removed ? 'Before' : 'After';
    return Semantics(
      container: true,
      label: label,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(
            child: SizedBox(
              width: 46,
              child: Text(
                label,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: accent,
                  fontWeight: FontWeight.w800,
                  height: 1.6,
                ),
              ),
            ),
          ),
          Expanded(
            child: Container(
              padding: const EdgeInsetsDirectional.only(start: AppSpacing.xs),
              decoration: BoxDecoration(
                border: BorderDirectional(
                  start: BorderSide(color: accent, width: 2),
                ),
              ),
              child: Text.rich(
                TextSpan(
                  children: [
                    for (final run in runs)
                      TextSpan(
                        text: run.text,
                        style: run.type == MobileEditDiffRunType.equal
                            ? null
                            : TextStyle(
                                backgroundColor: mark,
                                color: accent,
                                fontWeight: FontWeight.w700,
                              ),
                      ),
                  ],
                ),
                style: base,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Apply (dominant) and Cancel.
///
/// Side by side while the card is wide enough to keep both on one line at the
/// reader's text size; stacked with Apply first when it is not, so the primary
/// action is never squeezed and is the first thing the thumb finds.
class _ProposalActions extends StatelessWidget {
  const _ProposalActions({
    required this.enabled,
    required this.onApply,
    required this.onCancel,
  });

  final bool enabled;
  final VoidCallback? onApply;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final apply = onApply == null
        ? null
        : AppButton.primary(
            key: const ValueKey('edit-proposal-apply'),
            onPressed: enabled ? onApply : null,
            leading: const Icon(Icons.check),
            label: 'Apply',
            expanded: true,
          );
    final cancel = onCancel == null
        ? null
        : AppButton.text(
            key: const ValueKey('edit-proposal-cancel'),
            onPressed: enabled ? onCancel : null,
            label: 'Cancel',
            expanded: true,
          );
    if (apply == null || cancel == null) {
      return apply ?? cancel ?? const SizedBox.shrink();
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        final stacked = constraints.maxWidth < 300 || textScale >= 1.3;
        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              apply,
              const SizedBox(height: AppSpacing.xs),
              cancel,
            ],
          );
        }
        return Row(
          children: [
            Expanded(flex: 2, child: cancel),
            const SizedBox(width: AppSpacing.sm),
            Expanded(flex: 3, child: apply),
          ],
        );
      },
    );
  }
}

/// What the card shows between the tap and the server taking the work.
///
/// The request itself is short, but it reserves credits and queues the edit, so
/// a plain greyed-out button reads as a frozen screen. The real progress card
/// takes over the moment the worker reports.
class _ApplyingStrip extends StatelessWidget {
  const _ApplyingStrip();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Starting your edit',
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.sm),
          decoration: BoxDecoration(
            color: colors.primaryContainer.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  PlanBuildSparkle(color: colors.onPrimaryContainer, size: 22),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: RisingStatusText(
                      text: 'Starting your edit…',
                      style: theme.textTheme.labelLarge?.copyWith(
                        color: colors.onPrimaryContainer,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.xs),
              PlanBuildProgressBar(
                value: null,
                height: 6,
                trackColor: colors.surface.withValues(alpha: 0.6),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A proposal that is no longer waiting on the reader.
///
/// Kept in the transcript as history, but quiet: the same summary and scope, a
/// small badge for how it ended, and none of the weight of a decision.
class _SettledProposal extends StatelessWidget {
  const _SettledProposal({required this.proposal, required this.outcome});

  final MobileEditProposal proposal;
  final EditProposalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = proposalKindStyle(proposal);
    final badge = switch (outcome) {
      EditProposalOutcome.applied => const AppStatusBadge(
        label: 'Applied',
        icon: Icons.check,
        tone: AppTone.success,
      ),
      EditProposalOutcome.cancelled => const AppStatusBadge(
        label: 'Cancelled',
        icon: Icons.close,
      ),
      null => const AppStatusBadge(label: 'Closed'),
    };
    return Semantics(
      container: true,
      label: 'Edit proposal, closed',
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.sm),
        decoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          borderRadius: BorderRadius.circular(AppRadii.control),
          border: Border.all(color: colors.outlineVariant),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _KindTile(icon: style.icon, size: 32, muted: true),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    proposal.summary,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    proposal.pageLabel,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  badge,
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
