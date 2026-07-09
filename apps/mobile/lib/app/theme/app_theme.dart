import 'package:flutter/material.dart';

/// Shared corner radii so every surface in the app lands on the same scale.
abstract final class TomezaRadii {
  static const double control = 14;
  static const double card = 18;
  static const double sheet = 28;
  static const double chip = 999;
}

ThemeData buildTomezaLightTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xFF0F6B5C),
        brightness: Brightness.light,
      ).copyWith(
        primary: const Color(0xFF0F6B5C),
        onPrimary: Colors.white,
        primaryContainer: const Color(0xFFD5EEE5),
        onPrimaryContainer: const Color(0xFF0A3F35),
        secondary: const Color(0xFF8A5A1F),
        secondaryContainer: const Color(0xFFF7E7CB),
        onSecondaryContainer: const Color(0xFF4E3005),
        tertiary: const Color(0xFF365B8C),
        tertiaryContainer: const Color(0xFFDCE7F8),
        onTertiaryContainer: const Color(0xFF16324F),
        surface: const Color(0xFFFAFAF6),
        onSurface: const Color(0xFF171D1B),
        onSurfaceVariant: const Color(0xFF55605B),
        surfaceContainerLowest: Colors.white,
        surfaceContainerLow: const Color(0xFFF3F4EF),
        surfaceContainer: const Color(0xFFEEF0EA),
        surfaceContainerHigh: const Color(0xFFE8EBE4),
        surfaceContainerHighest: const Color(0xFFE1E5DE),
        outline: const Color(0xFF6F7A75),
        outlineVariant: const Color(0xFFE1E5DF),
      );

  return _themeFromScheme(scheme);
}

ThemeData buildTomezaDarkTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xFF3FB49F),
        brightness: Brightness.dark,
      ).copyWith(
        primary: const Color(0xFF74D6C2),
        onPrimary: const Color(0xFF00382E),
        primaryContainer: const Color(0xFF1B5348),
        onPrimaryContainer: const Color(0xFFB5EEDF),
        secondary: const Color(0xFFE5C186),
        secondaryContainer: const Color(0xFF5A4423),
        onSecondaryContainer: const Color(0xFFF7E3C2),
        tertiary: const Color(0xFFA9C6F4),
        tertiaryContainer: const Color(0xFF2E4867),
        onTertiaryContainer: const Color(0xFFD6E4FB),
        surface: const Color(0xFF101513),
        onSurface: const Color(0xFFE3E8E4),
        onSurfaceVariant: const Color(0xFFA5B0AA),
        // Used as the card color: kept slightly lighter than the scaffold so
        // cards read as raised surfaces in dark mode.
        surfaceContainerLowest: const Color(0xFF181E1B),
        surfaceContainerLow: const Color(0xFF1B211E),
        surfaceContainer: const Color(0xFF1F2622),
        surfaceContainerHigh: const Color(0xFF242C28),
        surfaceContainerHighest: const Color(0xFF2B342F),
        outline: const Color(0xFF7E8983),
        outlineVariant: const Color(0xFF2E3733),
      );

  return _themeFromScheme(scheme);
}

ThemeData _themeFromScheme(ColorScheme scheme) {
  final isLight = scheme.brightness == Brightness.light;
  final controlShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(TomezaRadii.control),
  );
  final cardShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(TomezaRadii.card),
  );
  final baseTheme = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: scheme.brightness,
    fontFamily: 'Manrope',
  );

  final textTheme = _buildTextTheme(baseTheme.textTheme, scheme);

  return baseTheme.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: scheme.surface,
    visualDensity: VisualDensity.standard,
    splashFactory: InkSparkle.splashFactory,
    textTheme: textTheme,
    appBarTheme: AppBarTheme(
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      titleTextStyle: textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.4,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: EdgeInsets.zero,
      color: scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      shape: cardShape.copyWith(side: BorderSide(color: scheme.outlineVariant)),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant,
      thickness: 1,
      space: 1,
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        borderSide: BorderSide(color: scheme.primary, width: 1.6),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        borderSide: BorderSide(color: scheme.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        borderSide: BorderSide(color: scheme.error, width: 1.6),
      ),
      filled: true,
      fillColor: scheme.surfaceContainerLowest,
      hoverColor: Colors.transparent,
      labelStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
      hintStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant.withValues(alpha: 0.75),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: controlShape,
        minimumSize: const Size(64, 52),
        elevation: 0,
        textStyle: textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w700,
          letterSpacing: 0.1,
        ),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        shape: controlShape,
        minimumSize: const Size(64, 52),
        elevation: 0,
        textStyle: textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w700,
          letterSpacing: 0.1,
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: controlShape,
        minimumSize: const Size(64, 52),
        side: BorderSide(
          color: isLight
              ? scheme.outlineVariant
              : scheme.outline.withValues(alpha: 0.55),
        ),
        foregroundColor: scheme.onSurface,
        textStyle: textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w700,
          letterSpacing: 0.1,
        ),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        shape: controlShape,
        minimumSize: const Size(48, 48),
        textStyle: textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w700,
          letterSpacing: 0.1,
        ),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        minimumSize: const Size.square(48),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
    ),
    chipTheme: baseTheme.chipTheme.copyWith(
      shape: const StadiumBorder(),
      side: BorderSide(color: scheme.outlineVariant),
      backgroundColor: scheme.surfaceContainerLowest,
      labelStyle: textTheme.labelLarge?.copyWith(color: scheme.onSurface),
      secondaryLabelStyle: textTheme.labelLarge?.copyWith(
        color: scheme.onPrimaryContainer,
      ),
      selectedColor: scheme.primaryContainer,
      checkmarkColor: scheme.onPrimaryContainer,
    ),
    listTileTheme: ListTileThemeData(
      shape: controlShape,
      iconColor: scheme.onSurfaceVariant,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: scheme.primary,
      linearTrackColor: scheme.surfaceContainerHighest,
      circularTrackColor: scheme.surfaceContainerHighest,
      linearMinHeight: 6,
      borderRadius: BorderRadius.circular(999),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.sheet - 4),
      ),
      titleTextStyle: textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.3,
        color: scheme.onSurface,
      ),
      contentTextStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurfaceVariant,
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: scheme.outlineVariant,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(TomezaRadii.sheet),
        ),
      ),
    ),
    drawerTheme: DrawerThemeData(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.horizontal(
          right: Radius.circular(TomezaRadii.sheet),
        ),
      ),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      elevation: 4,
      shadowColor: Colors.black.withValues(alpha: isLight ? 0.16 : 0.5),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      textStyle: textTheme.bodyMedium,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onInverseSurface,
      ),
      shape: controlShape,
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: scheme.inverseSurface,
        borderRadius: BorderRadius.circular(10),
      ),
      textStyle: textTheme.bodySmall?.copyWith(color: scheme.onInverseSurface),
    ),
  );
}

TextTheme _buildTextTheme(TextTheme base, ColorScheme scheme) {
  final themed = base.apply(
    bodyColor: scheme.onSurface,
    displayColor: scheme.onSurface,
    fontFamily: 'Manrope',
  );

  return themed.copyWith(
    displayLarge: themed.displayLarge?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -1.2,
      height: 1.08,
    ),
    displayMedium: themed.displayMedium?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -1,
      height: 1.1,
    ),
    displaySmall: themed.displaySmall?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.8,
      height: 1.12,
    ),
    headlineLarge: themed.headlineLarge?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.6,
      height: 1.15,
    ),
    headlineMedium: themed.headlineMedium?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.5,
      height: 1.18,
    ),
    headlineSmall: themed.headlineSmall?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.4,
      height: 1.2,
    ),
    titleLarge: themed.titleLarge?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.3,
    ),
    titleMedium: themed.titleMedium?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.2,
    ),
    titleSmall: themed.titleSmall?.copyWith(
      fontWeight: FontWeight.w700,
      letterSpacing: -0.1,
    ),
    bodyLarge: themed.bodyLarge?.copyWith(height: 1.5, letterSpacing: 0),
    bodyMedium: themed.bodyMedium?.copyWith(height: 1.5, letterSpacing: 0),
    bodySmall: themed.bodySmall?.copyWith(height: 1.45, letterSpacing: 0),
    labelLarge: themed.labelLarge?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.1,
    ),
    labelMedium: themed.labelMedium?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.1,
    ),
    labelSmall: themed.labelSmall?.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.2,
    ),
  );
}
