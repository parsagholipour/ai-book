import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/assist_models.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_widgets.dart';
import 'studio_document.dart';

/// What a picture being drawn says while it is drawn, in order.
const studioPictureStages = [
  'Starting your picture…',
  'Sketching the scene…',
  'Adding colour…',
  'Finishing touches…',
  'Still drawing…',
];

/// A picture the AI is drawing, where it will sit: the stage it is at and a
/// bar that only climbs; or, when it could not be drawn, why — with another
/// try (priced) and a way to take the placeholder out.
class StudioAiPictureCard extends ConsumerWidget {
  const StudioAiPictureCard({
    required this.entry,
    required this.projectId,
    required this.onRetry,
    required this.onRemove,
    this.slot = false,
    super.key,
  });

  final StudioAiPictureEntry entry;
  final String projectId;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  /// A picture book's picture slot, which keeps the page's 4:3 shape.
  final bool slot;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return ValueListenableBuilder<StudioAiPictureState>(
      valueListenable: entry.state,
      builder: (context, state, _) {
        final Widget body;
        if (state.failed) {
          final price = watchStudioAssistPrice(
            ref,
            projectId,
            LongAssistKind.illustrate,
          );
          body = Column(
            key: const ValueKey('studio-ai-picture-failed'),
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.image_not_supported_outlined, color: colors.outline),
              const SizedBox(height: AppSpacing.xs),
              Text(
                state.failure!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.sm),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: AppSpacing.xs,
                runSpacing: AppSpacing.xs,
                children: [
                  AppButton.outlined(
                    key: const ValueKey('studio-ai-picture-retry'),
                    label: price == null
                        ? 'Try again'
                        : 'Try again · ${studioCredits(price)}',
                    onPressed: price == null ? null : onRetry,
                  ),
                  AppButton.text(
                    key: const ValueKey('studio-ai-picture-remove'),
                    label: 'Remove',
                    onPressed: onRemove,
                  ),
                ],
              ),
            ],
          );
        } else {
          body = Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              StudioAiWaiting(
                key: ValueKey('studio-ai-picture-${entry.assistId}'),
                stages: state.starting
                    ? const ['Starting again…']
                    : studioPictureStages,
                tau: const Duration(seconds: 28),
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              ),
              if (entry.prompt.trim().isNotEmpty)
                Text(
                  entry.prompt.trim(),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontStyle: FontStyle.italic,
                  ),
                ),
            ],
          );
        }
        final card = DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Center(child: body),
          ),
        );
        // A picture book's slot keeps the page's 4:3 shape unless the words
        // need more room (large text); a flow picture is at least as tall as
        // an upload's placeholder.
        return Semantics(
          container: true,
          label: state.failed ? 'Picture not drawn' : 'Picture being drawn',
          child: LayoutBuilder(
            builder: (context, constraints) => ConstrainedBox(
              constraints: BoxConstraints(
                minWidth: constraints.maxWidth,
                minHeight: slot && constraints.maxWidth.isFinite
                    ? constraints.maxWidth * 3 / 4
                    : 220,
              ),
              child: card,
            ),
          ),
        );
      },
    );
  }
}
