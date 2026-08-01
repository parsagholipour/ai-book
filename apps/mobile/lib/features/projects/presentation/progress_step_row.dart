import 'package:flutter/material.dart';

import '../domain/project_models.dart';

/// One milestone in a live pipeline — planning, writing, narrating.
///
/// The active step carries a spinner rather than a static icon: it is the one
/// piece of the list that has to read as "happening right now" from across the
/// room. Shared by the creation chat and the /handoff screen so the two never
/// describe the same book differently.
class ProgressStepRow extends StatelessWidget {
  const ProgressStepRow({
    required this.step,
    this.dense = true,
    this.showDetail = false,
    super.key,
  });

  final MobileProjectStatusStep step;

  /// Compact chat-bubble sizing. Non-dense is the roomier card layout.
  final bool dense;

  /// Renders [MobileProjectStatusStep.detail] as a second line.
  final bool showDetail;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final detail = showDetail ? step.detail : null;
    final stateLabel = step.isDone
        ? 'Done'
        : step.isFailed
        ? 'Needs attention'
        : step.isActive
        ? 'In progress'
        : 'Waiting';
    final icon = step.isDone
        ? Icons.check_circle
        : step.isFailed
        ? Icons.error
        : Icons.radio_button_unchecked;
    final color = step.isDone || step.isActive
        ? colors.primary
        : step.isFailed
        ? colors.error
        : colors.outline;
    // Two label shapes, both pinned by widget tests: the chat rows end in a
    // period, the card rows join their detail line with one.
    final semanticLabel = dense
        ? '${step.label}. $stateLabel.'
        : [step.label, stateLabel, ?detail].join('. ');
    final iconSize = dense ? 18.0 : 20.0;

    return Semantics(
      container: true,
      label: semanticLabel,
      child: ExcludeSemantics(
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: dense ? 3 : 5),
          child: Row(
            crossAxisAlignment: detail == null
                ? CrossAxisAlignment.center
                : CrossAxisAlignment.start,
            children: [
              SizedBox.square(
                dimension: iconSize,
                child: step.isActive
                    ? Center(
                        child: SizedBox.square(
                          dimension: iconSize - 3,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: color,
                          ),
                        ),
                      )
                    : Icon(icon, size: iconSize, color: color),
              ),
              SizedBox(width: dense ? 9 : 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      step.label,
                      style: dense
                          ? Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: step.isActive
                                  ? colors.onSurface
                                  : colors.onSurfaceVariant,
                              fontWeight: step.isActive
                                  ? FontWeight.w700
                                  : null,
                            )
                          : Theme.of(context).textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                    ),
                    if (detail != null)
                      Text(
                        detail,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
