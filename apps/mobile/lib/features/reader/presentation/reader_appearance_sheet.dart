import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../domain/reader_settings.dart';

/// How the page looks and how long the screen stays on.
///
/// A compiled PDF has fixed type, so the usual reader controls — font, size,
/// margins — are not on offer. What is left is light: the colour of the paper
/// and how much of it reaches the eye. Both are live: every change shows on the
/// page behind the sheet as it is made, because choosing a reading light by
/// closing a dialogue and looking is not choosing.
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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Appearance', style: theme.textTheme.titleMedium),
              const SizedBox(height: 16),
              Text('Page', style: theme.textTheme.labelLarge),
              const SizedBox(height: 8),
              _tints(context),
              const SizedBox(height: 20),
              Text('Brightness', style: theme.textTheme.labelLarge),
              Row(
                children: [
                  const Icon(Icons.brightness_low, size: 18),
                  Expanded(
                    child: Slider(
                      value: settings.dimLevel.clamp(
                        0,
                        ReaderSettings.maxDimLevel,
                      ),
                      max: ReaderSettings.maxDimLevel,
                      label: 'Dim',
                      onChanged: (value) =>
                          onChanged(settings.copyWith(dimLevel: value)),
                    ),
                  ),
                  const Icon(Icons.brightness_high, size: 18),
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
              const SizedBox(height: 8),
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
      ),
    );
  }

  Widget _tints(BuildContext context) {
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        for (final tint in ReaderPageTint.values)
          _TintChip(
            tint: tint,
            selected: settings.tint == tint,
            onTap: () {
              AppHaptics.selection();
              onChanged(settings.copyWith(tint: tint));
            },
          ),
      ],
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

  /// A swatch of what the paper will look like, so the choice is made by
  /// looking rather than by reading four labels.
  Color get _swatch => switch (tint) {
    ReaderPageTint.none => const Color(0xFFFFFFFF),
    ReaderPageTint.sepia => const Color(0xFFF4E7CE),
    ReaderPageTint.gray => const Color(0xFFE3E1DC),
    ReaderPageTint.night => const Color(0xFF1A1D21),
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: '${tint.label}. ${tint.description}',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 92,
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected
                  ? theme.colorScheme.primary
                  : theme.colorScheme.outlineVariant,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 44,
                height: 30,
                decoration: BoxDecoration(
                  color: _swatch,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
                ),
                alignment: Alignment.center,
                child: Text(
                  'Aa',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: tint == ReaderPageTint.night
                        ? const Color(0xFFCBD5DC)
                        : const Color(0xFF20262C),
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(tint.label, style: theme.textTheme.labelSmall),
            ],
          ),
        ),
      ),
    );
  }
}
