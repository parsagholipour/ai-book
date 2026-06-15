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

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: scheme.surface,
    visualDensity: VisualDensity.standard,
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
      filled: true,
      fillColor: scheme.surfaceContainerLowest,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: roundedShape,
        minimumSize: const Size(64, 48),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: roundedShape,
        minimumSize: const Size(64, 44),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(shape: roundedShape),
    ),
  );
}
