import 'package:flutter/material.dart';

enum AppTone { neutral, info, success, warning, error }

/// Semantic colours that Material's [ColorScheme] does not name directly.
///
/// Brand, billing-tier, reader-page, diff, and generated-cover palettes remain
/// feature owned. These colours are only for application feedback and status.
@immutable
class AppSemanticColors extends ThemeExtension<AppSemanticColors> {
  const AppSemanticColors({
    required this.info,
    required this.onInfo,
    required this.infoContainer,
    required this.onInfoContainer,
    required this.success,
    required this.onSuccess,
    required this.successContainer,
    required this.onSuccessContainer,
    required this.warning,
    required this.onWarning,
    required this.warningContainer,
    required this.onWarningContainer,
  });

  factory AppSemanticColors.fromScheme(ColorScheme scheme) {
    final warning = scheme.brightness == Brightness.light
        ? const (
            color: Color(0xFF7A4C08),
            onColor: Colors.white,
            container: Color(0xFFF7E7CB),
            onContainer: Color(0xFF4E3005),
          )
        : const (
            color: Color(0xFFE5C186),
            onColor: Color(0xFF3F2C08),
            container: Color(0xFF5A4423),
            onContainer: Color(0xFFF7E3C2),
          );

    return AppSemanticColors(
      info: scheme.tertiary,
      onInfo: scheme.onTertiary,
      infoContainer: scheme.tertiaryContainer,
      onInfoContainer: scheme.onTertiaryContainer,
      success: scheme.primary,
      onSuccess: scheme.onPrimary,
      successContainer: scheme.primaryContainer,
      onSuccessContainer: scheme.onPrimaryContainer,
      warning: warning.color,
      onWarning: warning.onColor,
      warningContainer: warning.container,
      onWarningContainer: warning.onContainer,
    );
  }

  final Color info;
  final Color onInfo;
  final Color infoContainer;
  final Color onInfoContainer;
  final Color success;
  final Color onSuccess;
  final Color successContainer;
  final Color onSuccessContainer;
  final Color warning;
  final Color onWarning;
  final Color warningContainer;
  final Color onWarningContainer;

  static AppSemanticColors of(BuildContext context) {
    final theme = Theme.of(context);
    return theme.extension<AppSemanticColors>() ??
        AppSemanticColors.fromScheme(theme.colorScheme);
  }

  @override
  AppSemanticColors copyWith({
    Color? info,
    Color? onInfo,
    Color? infoContainer,
    Color? onInfoContainer,
    Color? success,
    Color? onSuccess,
    Color? successContainer,
    Color? onSuccessContainer,
    Color? warning,
    Color? onWarning,
    Color? warningContainer,
    Color? onWarningContainer,
  }) {
    return AppSemanticColors(
      info: info ?? this.info,
      onInfo: onInfo ?? this.onInfo,
      infoContainer: infoContainer ?? this.infoContainer,
      onInfoContainer: onInfoContainer ?? this.onInfoContainer,
      success: success ?? this.success,
      onSuccess: onSuccess ?? this.onSuccess,
      successContainer: successContainer ?? this.successContainer,
      onSuccessContainer: onSuccessContainer ?? this.onSuccessContainer,
      warning: warning ?? this.warning,
      onWarning: onWarning ?? this.onWarning,
      warningContainer: warningContainer ?? this.warningContainer,
      onWarningContainer: onWarningContainer ?? this.onWarningContainer,
    );
  }

  @override
  AppSemanticColors lerp(
    covariant ThemeExtension<AppSemanticColors>? other,
    double t,
  ) {
    if (other is! AppSemanticColors) return this;
    return AppSemanticColors(
      info: Color.lerp(info, other.info, t)!,
      onInfo: Color.lerp(onInfo, other.onInfo, t)!,
      infoContainer: Color.lerp(infoContainer, other.infoContainer, t)!,
      onInfoContainer: Color.lerp(onInfoContainer, other.onInfoContainer, t)!,
      success: Color.lerp(success, other.success, t)!,
      onSuccess: Color.lerp(onSuccess, other.onSuccess, t)!,
      successContainer: Color.lerp(
        successContainer,
        other.successContainer,
        t,
      )!,
      onSuccessContainer: Color.lerp(
        onSuccessContainer,
        other.onSuccessContainer,
        t,
      )!,
      warning: Color.lerp(warning, other.warning, t)!,
      onWarning: Color.lerp(onWarning, other.onWarning, t)!,
      warningContainer: Color.lerp(
        warningContainer,
        other.warningContainer,
        t,
      )!,
      onWarningContainer: Color.lerp(
        onWarningContainer,
        other.onWarningContainer,
        t,
      )!,
    );
  }
}

typedef AppToneColors = ({Color background, Color foreground, Color accent});

AppToneColors appToneColors(BuildContext context, AppTone tone) {
  final colors = Theme.of(context).colorScheme;
  final semantic = AppSemanticColors.of(context);
  return switch (tone) {
    AppTone.neutral => (
      background: colors.surfaceContainerHigh,
      foreground: colors.onSurfaceVariant,
      accent: colors.onSurfaceVariant,
    ),
    AppTone.info => (
      background: semantic.infoContainer,
      foreground: semantic.onInfoContainer,
      accent: semantic.info,
    ),
    AppTone.success => (
      background: semantic.successContainer,
      foreground: semantic.onSuccessContainer,
      accent: semantic.success,
    ),
    AppTone.warning => (
      background: semantic.warningContainer,
      foreground: semantic.onWarningContainer,
      accent: semantic.warning,
    ),
    AppTone.error => (
      background: colors.errorContainer,
      foreground: colors.onErrorContainer,
      accent: colors.error,
    ),
  };
}
