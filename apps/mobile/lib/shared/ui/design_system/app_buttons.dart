import 'package:flutter/material.dart';

import '../haptics.dart';
import '../motion.dart';
import 'app_tokens.dart';

enum _AppButtonVariant { primary, tonal, outlined, text, destructive }

/// The shared contract for ordinary, labelled application actions.
///
/// This widget deliberately owns presentation state only. Feature code still
/// owns async work, errors, navigation, and the value of [loading]; haptics are
/// opt-in through [haptic], because most call sites already fire their own and
/// two impacts inside one tap read as a stutter.
///
/// It gives every variant the same feedback: a small press-in scale, and a
/// width that eases (rather than jumps) when [loading] swaps a spinner in.
class AppButton extends StatelessWidget {
  const AppButton.primary({
    required this.label,
    required this.onPressed,
    this.leading,
    this.loading = false,
    this.loadingLabel,
    this.expanded = false,
    this.alignStart = false,
    this.maxLines,
    this.overflow,
    this.haptic = false,
    super.key,
  }) : _variant = _AppButtonVariant.primary;

  const AppButton.tonal({
    required this.label,
    required this.onPressed,
    this.leading,
    this.loading = false,
    this.loadingLabel,
    this.expanded = false,
    this.alignStart = false,
    this.maxLines,
    this.overflow,
    this.haptic = false,
    super.key,
  }) : _variant = _AppButtonVariant.tonal;

  const AppButton.outlined({
    required this.label,
    required this.onPressed,
    this.leading,
    this.loading = false,
    this.loadingLabel,
    this.expanded = false,
    this.alignStart = false,
    this.maxLines,
    this.overflow,
    this.haptic = false,
    super.key,
  }) : _variant = _AppButtonVariant.outlined;

  const AppButton.text({
    required this.label,
    required this.onPressed,
    this.leading,
    this.loading = false,
    this.loadingLabel,
    this.expanded = false,
    this.alignStart = false,
    this.maxLines,
    this.overflow,
    this.haptic = false,
    super.key,
  }) : _variant = _AppButtonVariant.text;

  const AppButton.destructive({
    required this.label,
    required this.onPressed,
    this.leading,
    this.loading = false,
    this.loadingLabel,
    this.expanded = false,
    this.alignStart = false,
    this.maxLines,
    this.overflow,
    this.haptic = false,
    super.key,
  }) : _variant = _AppButtonVariant.destructive;

  final String label;
  final VoidCallback? onPressed;
  final Widget? leading;
  final bool loading;
  final String? loadingLabel;
  final bool expanded;
  final bool alignStart;
  final int? maxLines;
  final TextOverflow? overflow;

  /// Fires [AppHaptics.tap] as the press is accepted. Off by default.
  final bool haptic;
  final _AppButtonVariant _variant;

  bool get enabled => onPressed != null && !loading;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final announcedLabel = loading ? loadingLabel ?? label : label;
    final labelWidget = Text(
      announcedLabel,
      maxLines: maxLines,
      overflow: overflow,
    );
    final icon = loading
        ? SizedBox.square(
            dimension: AppSizes.buttonProgressIndicator,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: _foreground(colors),
            ),
          )
        : leading;
    final callback = !enabled
        ? null
        : haptic
        ? () {
            AppHaptics.tap();
            onPressed!();
          }
        : onPressed;
    final style = _style(colors);
    final child = switch (_variant) {
      _AppButtonVariant.primary =>
        icon == null
            ? FilledButton(
                onPressed: callback,
                style: style,
                child: labelWidget,
              )
            : FilledButton.icon(
                onPressed: callback,
                style: style,
                icon: icon,
                label: labelWidget,
              ),
      _AppButtonVariant.tonal =>
        icon == null
            ? FilledButton.tonal(
                onPressed: callback,
                style: style,
                child: labelWidget,
              )
            : FilledButton.tonalIcon(
                onPressed: callback,
                style: style,
                icon: icon,
                label: labelWidget,
              ),
      _AppButtonVariant.outlined =>
        icon == null
            ? OutlinedButton(
                onPressed: callback,
                style: style,
                child: labelWidget,
              )
            : OutlinedButton.icon(
                onPressed: callback,
                style: style,
                icon: icon,
                label: labelWidget,
              ),
      _AppButtonVariant.text =>
        icon == null
            ? TextButton(onPressed: callback, style: style, child: labelWidget)
            : TextButton.icon(
                onPressed: callback,
                style: style,
                icon: icon,
                label: labelWidget,
              ),
      _AppButtonVariant.destructive =>
        icon == null
            ? FilledButton(
                onPressed: callback,
                style: style,
                child: labelWidget,
              )
            : FilledButton.icon(
                onPressed: callback,
                style: style,
                icon: icon,
                label: labelWidget,
              ),
    };

    final result = Semantics(
      button: true,
      enabled: enabled,
      liveRegion: loading,
      label: announcedLabel,
      child: ExcludeSemantics(
        child: AppPressScale(
          enabled: enabled,
          // A spinner slides in beside (or in place of) the label; easing the
          // size keeps the neighbours from jumping when a request starts.
          child: AnimatedSize(
            duration: AppMotion.adapt(context, AppMotion.fast),
            curve: AppMotion.standard,
            child: child,
          ),
        ),
      ),
    );
    return expanded ? SizedBox(width: double.infinity, child: result) : result;
  }

  Color _foreground(ColorScheme colors) => switch (_variant) {
    _AppButtonVariant.primary => colors.onPrimary,
    _AppButtonVariant.tonal => colors.onSecondaryContainer,
    _AppButtonVariant.outlined => colors.onSurface,
    _AppButtonVariant.text => colors.primary,
    _AppButtonVariant.destructive => colors.onError,
  };

  ButtonStyle? _style(ColorScheme colors) {
    // Directional, so a right-to-left label starts at the right edge.
    final alignment = alignStart ? AlignmentDirectional.centerStart : null;
    if (_variant == _AppButtonVariant.destructive) {
      return _destructiveStyle(
        colors,
        preserveDisabled: loading,
        alignment: alignment,
      );
    }
    if (!loading && alignment == null) return null;
    return switch (_variant) {
      _AppButtonVariant.primary => FilledButton.styleFrom(
        alignment: alignment,
        disabledBackgroundColor: loading ? colors.primary : null,
        disabledForegroundColor: loading ? colors.onPrimary : null,
      ),
      _AppButtonVariant.tonal => FilledButton.styleFrom(
        alignment: alignment,
        disabledBackgroundColor: loading ? colors.secondaryContainer : null,
        disabledForegroundColor: loading ? colors.onSecondaryContainer : null,
      ),
      _AppButtonVariant.outlined => OutlinedButton.styleFrom(
        alignment: alignment,
        disabledForegroundColor: loading ? colors.onSurface : null,
      ),
      _AppButtonVariant.text => TextButton.styleFrom(
        alignment: alignment,
        disabledForegroundColor: loading ? colors.primary : null,
      ),
      _AppButtonVariant.destructive => null,
    };
  }

  ButtonStyle _destructiveStyle(
    ColorScheme colors, {
    required bool preserveDisabled,
    AlignmentGeometry? alignment,
  }) => FilledButton.styleFrom(
    alignment: alignment,
    backgroundColor: colors.error,
    foregroundColor: colors.onError,
    disabledBackgroundColor: preserveDisabled ? colors.error : null,
    disabledForegroundColor: preserveDisabled ? colors.onError : null,
  );
}

/// Lays out related actions without letting large text squeeze the primary CTA.
class AppActionGroup extends StatelessWidget {
  const AppActionGroup({
    required this.primary,
    this.secondary = const [],
    this.spacing = AppSpacing.sm,
    super.key,
  });

  final Widget primary;
  final List<Widget> secondary;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        final stacked = constraints.maxWidth < 360 || textScale >= 1.35;
        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final action in secondary) ...[
                SizedBox(width: double.infinity, child: action),
                SizedBox(height: spacing),
              ],
              SizedBox(width: double.infinity, child: primary),
            ],
          );
        }

        return Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (secondary.isNotEmpty)
              Expanded(
                child: Wrap(
                  spacing: AppSpacing.xs,
                  runSpacing: AppSpacing.xs,
                  children: secondary,
                ),
              ),
            if (secondary.isNotEmpty) SizedBox(width: spacing),
            Flexible(child: primary),
          ],
        );
      },
    );
  }
}
