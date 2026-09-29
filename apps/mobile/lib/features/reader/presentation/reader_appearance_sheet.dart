import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/reader_settings.dart';
import 'reader_sheet_parts.dart';

/// How the page looks and how long the screen stays on.
///
/// A compiled PDF has fixed type, so the usual reader controls — font, size,
/// margins — are not on offer. What is left is light: the colour of the paper
/// and how much of it reaches the eye. Both are live: every change shows on the
/// page behind the sheet as it is made, because choosing a reading light by
/// closing a dialogue and looking is not choosing.
///
/// The sheet covers most of that page, though, so it carries a small one of its
/// own at the top: a few lines of a book, in the paper and the dimming the
/// reader has chosen, with a highlight on it, because that is the other thing
/// a page colour has to get along with.
class ReaderAppearanceSheet extends StatelessWidget {
  const ReaderAppearanceSheet({
    required this.settings,
    required this.onChanged,
    super.key,
  });

  final ReaderSettings settings;
  final void Function(ReaderSettings settings) onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const ReaderSheetHeader(title: 'Appearance'),
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.lg - 4,
                AppSpacing.xxs,
                AppSpacing.lg - 4,
                AppSpacing.lg,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _PagePreview(
                    tint: settings.tint,
                    dimLevel: settings.dimLevel,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  Text('Page', style: theme.textTheme.labelLarge),
                  const SizedBox(height: AppSpacing.xs),
                  _tints(context),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    settings.tint.description,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _brightness(context),
                  const SizedBox(height: AppSpacing.xs),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: settings.keepAwake,
                    title: const Text('Keep the screen on'),
                    subtitle: const Text(
                      'While you are reading, so a slow page does not go dark.',
                    ),
                    onChanged: (value) {
                      AppHaptics.selection();
                      onChanged(settings.copyWith(keepAwake: value));
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tints(BuildContext context) {
    return Row(
      children: [
        for (final tint in ReaderPageTint.values)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: _TintChip(
                tint: tint,
                selected: settings.tint == tint,
                onTap: () {
                  AppHaptics.selection();
                  onChanged(settings.copyWith(tint: tint));
                },
              ),
            ),
          ),
      ],
    );
  }

  Widget _brightness(BuildContext context) {
    final theme = Theme.of(context);
    final dim = settings.dimLevel.clamp(0.0, ReaderSettings.maxDimLevel);
    final percent = (dim / ReaderSettings.maxDimLevel * 100).round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text('Brightness', style: theme.textTheme.labelLarge),
            ),
            Text(
              percent == 0 ? 'Off' : 'Dimmed $percent%',
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        Row(
          children: [
            const Icon(Icons.brightness_high, size: 18),
            Expanded(
              child: Slider(
                // Dimming runs the other way round from brightness: the low
                // end of the slider is the page as it is, so the icons are
                // ordered the way the thumb moves — bright at rest, dim at the
                // far end.
                value: dim,
                max: ReaderSettings.maxDimLevel,
                label: 'Dim',
                semanticFormatterCallback: (value) => value == 0
                    ? 'Dimming off'
                    : 'Dimmed ${(value / ReaderSettings.maxDimLevel * 100).round()} percent',
                onChanged: (value) =>
                    onChanged(settings.copyWith(dimLevel: value)),
              ),
            ),
            const Icon(Icons.brightness_low, size: 18),
          ],
        ),
        Text(
          // Says plainly what it does, because a slider labelled
          // "brightness" that cannot go brighter than the phone is a
          // slider that feels broken.
          'Dims the page below your screen’s own minimum, for reading in '
          'the dark.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// The paper each tint puts on the page, as the swatches and the preview draw
/// it. Kept here rather than derived from the painter's blend modes: this is
/// what the paper *looks like*, the painter is how the viewer gets there.
Color _paperFor(ReaderPageTint tint) => switch (tint) {
  ReaderPageTint.none => const Color(0xFFFFFFFF),
  ReaderPageTint.sepia => const Color(0xFFF4E7CE),
  ReaderPageTint.gray => const Color(0xFFE3E1DC),
  ReaderPageTint.night => const Color(0xFF1A1D21),
};

Color _inkFor(ReaderPageTint tint) => tint == ReaderPageTint.night
    ? const Color(0xFFCBD5DC)
    : const Color(0xFF20262C);

/// Three lines of a book on the chosen paper, under the chosen dimming.
class _PagePreview extends StatelessWidget {
  const _PagePreview({required this.tint, required this.dimLevel});

  final ReaderPageTint tint;
  final double dimLevel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    final ink = _inkFor(tint);
    final onDark = tint == ReaderPageTint.night;
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.control),
        child: Stack(
          children: [
            AnimatedContainer(
              duration: reduced ? Duration.zero : AppMotion.fast,
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: _paperFor(tint),
                border: Border.all(color: colors.outlineVariant),
                borderRadius: BorderRadius.circular(AppRadii.control),
              ),
              child: Text.rich(
                TextSpan(
                  style: TextStyle(
                    color: ink,
                    fontSize: 14,
                    height: 1.5,
                    fontWeight: FontWeight.w500,
                  ),
                  children: [
                    const TextSpan(
                      text: 'The rabbit stretched in the long grass and ',
                    ),
                    TextSpan(
                      text: 'considered the morning',
                      style: TextStyle(
                        // The same wash a highlight is drawn with on this page.
                        backgroundColor: onDark
                            ? const Color(0x6664B5F6)
                            : const Color(0x99FFD54F),
                      ),
                    ),
                    const TextSpan(
                      text:
                          '. Somewhere beyond the hedge the '
                          'river was already busy.',
                    ),
                  ],
                ),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (dimLevel > 0)
              Positioned.fill(
                child: IgnorePointer(
                  child: ColoredBox(
                    color: Colors.black.withValues(
                      alpha: dimLevel.clamp(0.0, 0.9),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TintChip extends StatelessWidget {
  const _TintChip({
    required this.tint,
    required this.selected,
    required this.onTap,
  });

  final ReaderPageTint tint;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      label: '${tint.label}. ${tint.description}',
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.control),
        child: Container(
          constraints: const BoxConstraints(
            minHeight: AppSizes.minimumTouchTarget + 24,
          ),
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
          decoration: BoxDecoration(
            color: selected
                ? colors.primaryContainer.withValues(alpha: 0.5)
                : null,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(
              color: selected ? colors.primary : colors.outlineVariant,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    width: 44,
                    height: 30,
                    decoration: BoxDecoration(
                      color: _paperFor(tint),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: colors.outlineVariant),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      'Aa',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: _inkFor(tint),
                      ),
                    ),
                  ),
                  // The chosen one is ticked as well as outlined, so it does
                  // not depend on telling two outlines apart.
                  if (selected)
                    PositionedDirectional(
                      end: -7,
                      top: -7,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.primary,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          Icons.check,
                          size: 13,
                          color: colors.onPrimary,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                tint.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelMedium?.copyWith(
                  fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
