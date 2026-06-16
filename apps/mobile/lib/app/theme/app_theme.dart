import 'package:flutter/material.dart';

ThemeData buildTomezaLightTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xFF176B5D),
        brightness: Brightness.light,
      ).copyWith(
        primary: const Color(0xFF176B5D),
        secondary: const Color(0xFF8A5A1F),
        tertiary: const Color(0xFF365B8C),
        surface: const Color(0xFFFCFCF8),
      );

  return _themeFromScheme(scheme);
}

ThemeData buildTomezaDarkTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xFF3FB49F),
        brightness: Brightness.dark,
      ).copyWith(
        primary: const Color(0xFF7ED8C8),
        secondary: const Color(0xFFE0B15D),
        tertiary: const Color(0xFFA8C7FA),
      );

  return _themeFromScheme(scheme);
}

ThemeData _themeFromScheme(ColorScheme scheme) {
  const radius = 8.0;
  final roundedShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(radius),
  );
  final baseTheme = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: scheme.brightness,
  );

  return baseTheme.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: scheme.surface,
    visualDensity: VisualDensity.standard,
    textTheme: baseTheme.textTheme.apply(
      bodyColor: scheme.onSurface,
      displayColor: scheme.onSurface,
    ),
    appBarTheme: AppBarTheme(
      centerTitle: false,
      elevation: 0,
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: EdgeInsets.zero,
      color: scheme.surfaceContainerLowest,
      shape: roundedShape.copyWith(
        side: BorderSide(color: scheme.outlineVariant),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(radius)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: scheme.primary, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: scheme.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: scheme.error, width: 1.5),
      ),
      filled: true,
      fillColor: scheme.surfaceContainerLowest,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: roundedShape,
        minimumSize: const Size(64, 48),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: roundedShape,
        minimumSize: const Size(64, 48),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        shape: roundedShape,
        minimumSize: const Size(48, 48),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        minimumSize: const Size.square(48),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
    ),
    chipTheme: baseTheme.chipTheme.copyWith(
      shape: roundedShape,
      side: BorderSide(color: scheme.outlineVariant),
      labelStyle: baseTheme.textTheme.labelLarge?.copyWith(
        color: scheme.onSurface,
      ),
      secondaryLabelStyle: baseTheme.textTheme.labelLarge?.copyWith(
        color: scheme.onPrimaryContainer,
      ),
      selectedColor: scheme.primaryContainer,
      checkmarkColor: scheme.onPrimaryContainer,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: scheme.primary,
      linearTrackColor: scheme.surfaceContainerHighest,
      circularTrackColor: scheme.surfaceContainerHighest,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: baseTheme.textTheme.bodyMedium?.copyWith(
        color: scheme.onInverseSurface,
      ),
      shape: roundedShape,
    ),
  );
}
