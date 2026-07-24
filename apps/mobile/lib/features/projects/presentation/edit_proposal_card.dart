import 'package:flutter/material.dart';

import '../domain/project_models.dart';

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
          Text(
            proposal.summary,
            style: textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            '${proposal.pageLabel} · ${proposal.credits} credits',
            style: textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
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
