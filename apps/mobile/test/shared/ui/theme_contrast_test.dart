import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/shared/ui/design_system/app_tones.dart';

/// WCAG 2.x contrast ratio of [foreground] over [background]. A translucent
/// foreground is composited onto the background first, since that is the
/// colour that actually reaches the screen.
double contrastRatio(Color foreground, Color background) {
  final flat = Color.alphaBlend(foreground, background);
  final a = flat.computeLuminance();
  final b = background.computeLuminance();
  final lighter = a > b ? a : b;
  final darker = a > b ? b : a;
  return (lighter + 0.05) / (darker + 0.05);
}

typedef _Pair = (String, Color, Color);

void main() {
  for (final entry in {
    'light': buildTomezaLightTheme(),
    'dark': buildTomezaDarkTheme(),
  }.entries) {
    final name = entry.key;
    final scheme = entry.value.colorScheme;
    final semantic = entry.value.extension<AppSemanticColors>()!;
    final bubble = userChatBubbleColors(scheme);
    final surfaces = <String, Color>{
      'surface': scheme.surface,
      'lowest': scheme.surfaceContainerLowest,
      'low': scheme.surfaceContainerLow,
      'container': scheme.surfaceContainer,
      'high': scheme.surfaceContainerHigh,
      'highest': scheme.surfaceContainerHighest,
    };

    group('$name theme contrast', () {
      test('body text pairs reach 4.5:1', () {
        final pairs = <_Pair>[
          ('onPrimary/primary', scheme.onPrimary, scheme.primary),
          (
            'onPrimaryContainer/primaryContainer',
            scheme.onPrimaryContainer,
            scheme.primaryContainer,
          ),
          ('onSecondary/secondary', scheme.onSecondary, scheme.secondary),
          (
            'onSecondaryContainer/secondaryContainer',
            scheme.onSecondaryContainer,
            scheme.secondaryContainer,
          ),
          ('onError/error', scheme.onError, scheme.error),
          (
            'onErrorContainer/errorContainer',
            scheme.onErrorContainer,
            scheme.errorContainer,
          ),
          (
            'onTertiaryContainer/tertiaryContainer',
            scheme.onTertiaryContainer,
            scheme.tertiaryContainer,
          ),
          (
            'onInverseSurface/inverseSurface',
            scheme.onInverseSurface,
            scheme.inverseSurface,
          ),
          ('onWarning/warning', semantic.onWarning, semantic.warning),
          (
            'onWarningContainer/warningContainer',
            semantic.onWarningContainer,
            semantic.warningContainer,
          ),
          ('onInfo/info', semantic.onInfo, semantic.info),
          ('user bubble', bubble.foreground, bubble.background),
          for (final surface in surfaces.entries) ...[
            ('onSurface on ${surface.key}', scheme.onSurface, surface.value),
            (
              'onSurfaceVariant on ${surface.key}',
              scheme.onSurfaceVariant,
              surface.value,
            ),
            ('primary on ${surface.key}', scheme.primary, surface.value),
            ('error on ${surface.key}', scheme.error, surface.value),
          ],
          (
            'primary link on primaryContainer',
            scheme.onPrimaryContainer,
            scheme.primaryContainer,
          ),
        ];
        final failures = [
          for (final (label, fg, bg) in pairs)
            if (contrastRatio(fg, bg) < 4.5)
              '$label = ${contrastRatio(fg, bg).toStringAsFixed(2)}',
        ];
        expect(failures, isEmpty);
      });

      testWidgets('every AppTone reads at 4.5:1 and its accent at 3:1', (
        tester,
      ) async {
        late BuildContext context;
        await tester.pumpWidget(
          MaterialApp(
            theme: entry.value,
            home: Builder(
              builder: (c) {
                context = c;
                return const SizedBox.shrink();
              },
            ),
          ),
        );
        final failures = <String>[];
        for (final tone in AppTone.values) {
          final colors = appToneColors(context, tone);
          final text = contrastRatio(colors.foreground, colors.background);
          if (text < 4.5) failures.add('${tone.name} text $text');
          // A tone's accent (icon, leading stripe) has to be visible against
          // both the page and its own fill.
          for (final surface in [scheme.surface, colors.background]) {
            final accent = contrastRatio(colors.accent, surface);
            if (accent < 3) failures.add('${tone.name} accent $accent');
          }
        }
        expect(failures, isEmpty);
      });

      test('input borders and control outlines reach 3:1', () {
        final failures = <String>[];
        for (final surface in [
          scheme.surface,
          scheme.surfaceContainerLowest,
          scheme.surfaceContainerLow,
        ]) {
          final outline = contrastRatio(scheme.outline, surface);
          if (outline < 3) failures.add('outline on $surface $outline');
          final focus = contrastRatio(scheme.primary, surface);
          if (focus < 3) failures.add('focus ring on $surface $focus');
          final error = contrastRatio(scheme.error, surface);
          if (error < 3) failures.add('error border on $surface $error');
        }
        expect(failures, isEmpty);
      });

      test('the borders the theme actually draws use those outlines', () {
        final theme = entry.value;
        final failures = <String>[];
        void check(String label, Color? color, Color surface) {
          if (color == null) {
            failures.add('$label has no colour');
          } else if (contrastRatio(color, surface) < 3) {
            failures.add('$label = ${contrastRatio(color, surface)}');
          }
        }

        final input = theme.inputDecorationTheme;
        check(
          'text field border',
          (input.enabledBorder as OutlineInputBorder?)?.borderSide.color,
          scheme.surfaceContainerLowest,
        );
        check(
          'focused text field border',
          (input.focusedBorder as OutlineInputBorder?)?.borderSide.color,
          scheme.surfaceContainerLowest,
        );
        check(
          'outlined button border',
          theme.outlinedButtonTheme.style?.side?.resolve({})?.color,
          scheme.surface,
        );
        check(
          'checkbox border',
          WidgetStateProperty.resolveAs<BorderSide?>(
            theme.checkboxTheme.side,
            <WidgetState>{},
          )?.color,
          scheme.surface,
        );
        check(
          'unselected switch outline',
          theme.switchTheme.trackOutlineColor?.resolve({}),
          // The outline is the switch's edge against what it sits on (a card
          // or the page), not against its own track.
          scheme.surfaceContainerLowest,
        );
        expect(failures, isEmpty);
      });

      test('ordinary text pairs never fall under 4.5:1 for hint text', () {
        // Hints and placeholders are text too. The theme draws them in
        // onSurfaceVariant, which is held to 4.5:1 above.
        final decoration = entry.value.inputDecorationTheme;
        final hint = decoration.hintStyle?.color;
        expect(hint, isNotNull);
        expect(
          contrastRatio(hint!, decoration.fillColor ?? scheme.surface),
          greaterThanOrEqualTo(4.5),
        );
      });
    });
  }
}
