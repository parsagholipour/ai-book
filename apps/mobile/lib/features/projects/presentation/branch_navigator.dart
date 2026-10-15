import 'package:flutter/material.dart';

import '../../../shared/ui/touch_target.dart';
import '../domain/project_models.dart';

/// Chevron arrows with an `index/total` label shown under a message that has
/// sibling branches (created by editing a sent message), used to switch the
/// visible conversation thread between them.
class BranchNavigator extends StatelessWidget {
  const BranchNavigator({
    super.key,
    required this.branch,
    required this.foreground,
    required this.switching,
    required this.onPrevious,
    required this.onNext,
  });

  final MobileProjectChatBranch branch;
  final Color foreground;
  final bool switching;
  final VoidCallback onPrevious;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    // The arrows keep their small box in the layout but answer a 48dp touch
    // (see [TouchTarget]); the bubble around them is the region that hands a
    // near miss to them.
    final color = foreground.withValues(alpha: 0.85);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        TouchTarget(
          child: IconButton(
            tooltip: 'Previous branch',
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            padding: EdgeInsets.zero,
            onPressed: switching || !branch.canGoPrevious ? null : onPrevious,
            icon: Icon(Icons.chevron_left, color: color, size: 20),
          ),
        ),
        Text(
          '${branch.index}/${branch.total}',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
          ),
        ),
        TouchTarget(
          child: IconButton(
            tooltip: 'Next branch',
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            padding: EdgeInsets.zero,
            onPressed: switching || !branch.canGoNext ? null : onNext,
            icon: Icon(Icons.chevron_right, color: color, size: 20),
          ),
        ),
      ],
    );
  }
}
