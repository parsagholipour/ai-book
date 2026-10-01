import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../data/appearance_store.dart';
import '../domain/appearance_prefs.dart';

Future<void> showAppearanceSheet(BuildContext context) {
  return showAppBottomSheet<void>(
    context,
    builder: (_) => const AppearanceSheet(),
  );
}

// The real palettes, read once: the tiles are drawn from the same colours the
// app will switch to, so what a tile shows is what the choice does.
final ColorScheme _lightScheme = buildTomezaLightTheme().colorScheme;
final ColorScheme _darkScheme = buildTomezaDarkTheme().colorScheme;

/// Light, dark, or whatever the phone says — each drawn as a miniature of the
/// app in that palette, so the choice is seen rather than described.
class AppearanceSheet extends ConsumerWidget {
  const AppearanceSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected =
        ref.watch(appearanceModeProvider).value ?? AppearanceMode.system;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.sm,
          AppSpacing.lg,
          AppSpacing.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              header: true,
              child: Text(
                'Appearance',
                style: text.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xxs),
            Text(
              'System follows your phone.',
              style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.md),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final mode in AppearanceMode.values) ...[
                  if (mode != AppearanceMode.system)
                    const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: _ModeTile(
                      mode: mode,
                      selected: selected == mode,
                      onTap: () async {
                        AppHaptics.selection();
                        await ref
                            .read(appearanceModeProvider.notifier)
                            .setMode(mode);
                        if (context.mounted) {
                          Navigator.of(context).pop();
                        }
                      },
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ModeTile extends StatelessWidget {
  const _ModeTile({
    required this.mode,
    required this.selected,
    required this.onTap,
  });

  final AppearanceMode mode;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final radius = BorderRadius.circular(AppRadii.control);
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.fast;

    return Semantics(
      container: true,
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: mode.label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: radius,
          onTap: onTap,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AspectRatio(
                aspectRatio: 0.78,
                child: AnimatedContainer(
                  duration: duration,
                  decoration: BoxDecoration(
                    borderRadius: radius,
                    border: Border.all(
                      color: selected ? colors.primary : colors.outlineVariant,
                      width: selected ? 2.4 : 1,
                    ),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadii.control - 1),
                    child: switch (mode) {
                      AppearanceMode.light => _MiniApp(scheme: _lightScheme),
                      AppearanceMode.dark => _MiniApp(scheme: _darkScheme),
                      AppearanceMode.system => Stack(
                        fit: StackFit.expand,
                        children: [
                          _MiniApp(scheme: _lightScheme),
                          ClipRect(
                            clipper: _EndHalfClipper(
                              rtl:
                                  Directionality.of(context) ==
                                  TextDirection.rtl,
                            ),
                            child: _MiniApp(scheme: _darkScheme),
                          ),
                        ],
                      ),
                    },
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_unchecked,
                    size: 18,
                    color: selected ? colors.primary : colors.outline,
                  ),
                  const SizedBox(width: AppSpacing.xxs),
                  Flexible(
                    child: Text(
                      mode.label,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: selected
                            ? FontWeight.w800
                            : FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.xxs),
            ],
          ),
        ),
      ),
    );
  }
}

/// The far half of the box in reading direction: the second palette on a
/// split "System" tile, mirrored for right-to-left.
class _EndHalfClipper extends CustomClipper<Rect> {
  const _EndHalfClipper({required this.rtl});

  final bool rtl;

  @override
  Rect getClip(Size size) => rtl
      ? Rect.fromLTWH(0, 0, size.width / 2, size.height)
      : Rect.fromLTWH(size.width / 2, 0, size.width / 2, size.height);

  @override
  bool shouldReclip(_EndHalfClipper oldClipper) => oldClipper.rtl != rtl;
}

/// A screen in miniature, painted from [scheme]: a title row, a card with two
/// lines of text, and the primary button.
class _MiniApp extends StatelessWidget {
  const _MiniApp({required this.scheme});

  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    Widget line(double factor, {Color? color, double height = 5}) =>
        FractionallySizedBox(
          widthFactor: factor,
          alignment: AlignmentDirectional.centerStart,
          child: Container(
            height: height,
            decoration: BoxDecoration(
              color: color ?? scheme.onSurface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(3),
            ),
          ),
        );

    return ExcludeSemantics(
      child: ColoredBox(
        color: scheme.surface,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xs),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 14,
                    height: 14,
                    decoration: BoxDecoration(
                      color: scheme.primaryContainer,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 5),
                  Expanded(child: line(0.6, height: 6)),
                ],
              ),
              const SizedBox(height: AppSpacing.xs),
              Expanded(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerLowest,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        line(0.85),
                        const SizedBox(height: 4),
                        line(
                          0.6,
                          color: scheme.onSurfaceVariant.withValues(alpha: 0.5),
                        ),
                        const Spacer(),
                        Container(
                          height: 14,
                          decoration: BoxDecoration(
                            color: scheme.primary,
                            borderRadius: BorderRadius.circular(5),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
