import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../../projects/presentation/plan_build_progress.dart';
import 'studio_document.dart';

/// What the picture menu can do.
enum StudioImageAction { replace, moveUp, moveDown, remove }

/// A picture in the chapter: the image itself, a menu over its corner, and
/// the caption beneath it (markdown's alt text), edited in place.
class StudioImageBlock extends StatelessWidget {
  const StudioImageBlock({
    required this.entry,
    required this.onAction,
    this.canMoveUp = true,
    this.canMoveDown = true,
    this.showMoves = true,
    super.key,
  });

  final StudioImageEntry entry;
  final ValueChanged<StudioImageAction> onAction;
  final bool canMoveUp;
  final bool canMoveDown;

  /// The picture book's picture slot does not move within its page.
  final bool showMoves;

  Future<void> _openMenu(BuildContext context) async {
    final action = await showAppActionSheet<StudioImageAction>(
      context,
      title: 'Picture',
      builder: (sheetContext) {
        final colors = Theme.of(sheetContext).colorScheme;
        void pick(StudioImageAction action) =>
            Navigator.of(sheetContext).pop(action);
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Replace picture'),
              onTap: () => pick(StudioImageAction.replace),
            ),
            if (showMoves) ...[
              ListTile(
                enabled: canMoveUp,
                leading: const Icon(Icons.arrow_upward_rounded),
                title: const Text('Move up'),
                onTap: () => pick(StudioImageAction.moveUp),
              ),
              ListTile(
                enabled: canMoveDown,
                leading: const Icon(Icons.arrow_downward_rounded),
                title: const Text('Move down'),
                onTap: () => pick(StudioImageAction.moveDown),
              ),
            ],
            ListTile(
              leading: Icon(Icons.delete_outline, color: colors.error),
              title: Text(
                'Remove picture',
                style: TextStyle(color: colors.error),
              ),
              onTap: () => pick(StudioImageAction.remove),
            ),
          ],
        );
      },
    );
    if (action != null) onAction(action);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      label: 'Picture',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.control),
            child: ColoredBox(
              color: colors.surfaceContainerLow,
              child: Stack(
                children: [
                  // The picture at its own shape, as wide as the text; a tall
                  // one stops at 440 and is letterboxed on the card's tint.
                  ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: 120,
                      maxHeight: 440,
                    ),
                    child: SizedBox(
                      width: double.infinity,
                      child: LayoutBuilder(
                        builder: (context, constraints) => AuthedNetworkImage(
                          key: ValueKey(entry.url),
                          url: entry.url,
                          cacheBuster: null,
                          fit: BoxFit.contain,
                          width: constraints.maxWidth,
                          logicalDecodeWidth: math.min(
                            constraints.maxWidth,
                            900,
                          ),
                          semanticLabel: entry.caption.text.trim().isEmpty
                              ? 'Picture'
                              : entry.caption.text.trim(),
                          transitionDuration: AppMotion.adapt(
                            context,
                            AppMotion.medium,
                          ),
                          loadingPlaceholder: const AppSkeletonGroup(
                            label: 'Loading picture',
                            child: AppSkeleton.box(height: 220, radius: 0),
                          ),
                          errorPlaceholder: const _PictureUnavailable(),
                        ),
                      ),
                    ),
                  ),
                  PositionedDirectional(
                    top: AppSpacing.xs,
                    end: AppSpacing.xs,
                    child: _CornerButton(
                      tooltip: 'Picture options',
                      icon: Icons.more_horiz,
                      onPressed: () => _openMenu(context),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          TextField(
            controller: entry.caption,
            focusNode: entry.captionFocus,
            textAlign: TextAlign.center,
            maxLines: null,
            textCapitalization: TextCapitalization.sentences,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.onSurfaceVariant,
              fontStyle: FontStyle.italic,
            ),
            decoration: studioBareDecoration(
              context,
              hint: 'Add a caption',
              hintStyle: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant.withValues(alpha: 0.7),
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A picture on its way up: the chosen photo, dimmed, with the upload's
/// progress running across it.
class StudioUploadingBlock extends StatelessWidget {
  const StudioUploadingBlock({required this.entry, super.key});

  final StudioUploadEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadii.control),
      child: SizedBox(
        height: 220,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.memory(
              entry.bytes,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              errorBuilder: (_, _, _) =>
                  ColoredBox(color: colors.surfaceContainerHigh),
            ),
            ColoredBox(color: colors.surface.withValues(alpha: 0.72)),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: ValueListenableBuilder<double?>(
                valueListenable: entry.progress,
                builder: (context, progress, _) {
                  final percent = progress == null
                      ? null
                      : (progress * 100).clamp(0, 100).round();
                  return Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      PlanBuildSparkle(color: colors.primary, size: 28),
                      const SizedBox(height: AppSpacing.sm),
                      Text(
                        percent == null
                            ? 'Adding your picture…'
                            : 'Adding your picture… $percent%',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 240),
                        child: PlanBuildProgressBar(
                          value: progress,
                          height: 6,
                          semanticLabel: 'Uploading picture',
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A chart. Charts are drawn by the book, not typed, so the Studio shows
/// what it is and leaves the block alone.
class StudioFigureCard extends StatelessWidget {
  const StudioFigureCard({required this.entry, super.key});

  final StudioFigureEntry entry;

  static String _describe(String raw) {
    final lines = raw.split('\n');
    final body = lines.length > 2
        ? lines.sublist(1, lines.length - 1).join('\n')
        : '';
    try {
      final json = jsonDecode(body);
      if (json is Map<String, dynamic>) {
        final kind = switch (json['kind']) {
          'bar' => 'Bar chart',
          'line' => 'Line chart',
          'pie' => 'Pie chart',
          'flow' => 'Diagram',
          _ => 'Chart',
        };
        final title = json['title'];
        return title is String && title.trim().isNotEmpty
            ? '$kind · ${title.trim()}'
            : kind;
      }
    } catch (_) {}
    return 'Chart';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            Icon(Icons.bar_chart_rounded, color: colors.primary),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _describe(entry.figure.raw),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Drawn as a chart in your book.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A picture book page with no picture yet.
class StudioPictureSlot extends StatelessWidget {
  const StudioPictureSlot({required this.onTap, super.key});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final radius = BorderRadius.circular(AppRadii.control);
    return Semantics(
      button: true,
      label: 'Add a picture',
      child: ExcludeSemantics(
        child: Material(
          color: colors.surfaceContainerLow,
          borderRadius: radius,
          child: InkWell(
            borderRadius: radius,
            onTap: onTap,
            child: CustomPaint(
              painter: _DashedBorderPainter(
                color: colors.outline.withValues(alpha: 0.55),
                radius: AppRadii.control,
              ),
              child: AspectRatio(
                aspectRatio: 4 / 3,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.primaryContainer.withValues(alpha: 0.7),
                        shape: BoxShape.circle,
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        child: Icon(
                          Icons.add_photo_alternate_outlined,
                          color: colors.primary,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      'Add a picture',
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A borderless field: the Studio's text sits on the page, not in a box.
///
/// The app's input theme fills and outlines every field; each border is
/// switched off here explicitly, because an unset one falls back to that
/// theme.
InputDecoration studioBareDecoration(
  BuildContext context, {
  String? hint,
  TextStyle? hintStyle,
}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: hintStyle,
    isCollapsed: true,
    filled: false,
    contentPadding: EdgeInsets.zero,
    border: InputBorder.none,
    enabledBorder: InputBorder.none,
    focusedBorder: InputBorder.none,
    disabledBorder: InputBorder.none,
    errorBorder: InputBorder.none,
    focusedErrorBorder: InputBorder.none,
  );
}

class _PictureUnavailable extends StatelessWidget {
  const _PictureUnavailable();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return SizedBox(
      height: 180,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.image_not_supported_outlined, color: colors.outline),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'This picture can’t be shown right now.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CornerButton extends StatelessWidget {
  const _CornerButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface.withValues(alpha: 0.88),
      shape: const CircleBorder(),
      elevation: 0,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: 20),
        color: colors.onSurface,
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

class _DashedBorderPainter extends CustomPainter {
  const _DashedBorderPainter({required this.color, required this.radius});

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Offset.zero & size,
          Radius.circular(radius),
        ).deflate(0.7),
      );
    const dash = 7.0;
    const gap = 5.0;
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        canvas.drawPath(metric.extractPath(distance, distance + dash), paint);
        distance += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBorderPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.radius != radius;
}
