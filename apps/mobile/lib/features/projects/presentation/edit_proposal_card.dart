import 'package:flutter/material.dart';

import '../domain/project_models.dart';
import 'credit_cost_badge.dart';

/// Priced book-edit confirmation card. Apply / Cancel call dedicated proposal
/// endpoints (not chat-text confirmations).
class EditProposalCard extends StatelessWidget {
  const EditProposalCard({
    required this.proposal,
    required this.enabled,
    this.onApply,
    this.onCancel,
    super.key,
  });

  final MobileEditProposal proposal;
  final bool enabled;
  final VoidCallback? onApply;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.86,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  proposal.summary,
                  style: textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (proposal.credits > 0) ...[
                const SizedBox(width: 8),
                CreditCostBadge(
                  credits: proposal.credits,
                  kind: CreditCostKind.quoted,
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text(
            proposal.pageLabel,
            style: textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          if (proposal.preview != null) ...[
            const SizedBox(height: 10),
            _EditPreview(preview: proposal.preview!),
          ],
          if (onApply != null || onCancel != null) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                if (onApply != null)
                  FilledButton(
                    onPressed: enabled ? onApply : null,
                    child: const Text('Apply'),
                  ),
                if (onApply != null && onCancel != null)
                  const SizedBox(width: 8),
                if (onCancel != null)
                  TextButton(
                    onPressed: enabled ? onCancel : null,
                    child: const Text('Cancel'),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// The exact before/after lines a deterministic edit will produce.
///
/// Only shown for literal find/replace edits, where the server computed the
/// result without a model: what is drawn here is the change itself, not a
/// description of one, which is what makes approving it safe.
class _EditPreview extends StatelessWidget {
  const _EditPreview({required this.preview});

  final MobileEditPreview preview;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final lineStyle = textTheme.bodySmall?.copyWith(height: 1.35);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (index, sample) in preview.samples.indexed) ...[
            if (index > 0) const SizedBox(height: 8),
            _PreviewLine(
              marker: '-',
              text: sample.before,
              color: colors.error,
              style: lineStyle,
            ),
            const SizedBox(height: 2),
            _PreviewLine(
              marker: '+',
              text: sample.after,
              color: colors.primary,
              style: lineStyle,
            ),
          ],
        ],
      ),
    );
  }
}

class _PreviewLine extends StatelessWidget {
  const _PreviewLine({
    required this.marker,
    required this.text,
    required this.color,
    required this.style,
  });

  final String marker;
  final String text;
  final Color color;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          marker,
          style: style?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: style?.copyWith(color: color))),
      ],
    );
  }
}
