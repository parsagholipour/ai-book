import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import '../../shared/ui/design_system/app_tokens.dart';
import '../../shared/ui/motion.dart';

/// Component themes for [ThemeData], split from `app_theme.dart` so that file
/// stays about *colour* and this one about how each control uses it.
///
/// Every function takes the finished [ColorScheme] and [TextTheme] and reads
/// only from them, so light and dark differ by palette alone.

/// The text-field look: a 1px outline strong enough to find the field
/// (3:1 against every surface it sits on), a 2px brand ring while it has
/// focus, and a label that follows the field's state.
InputDecorationTheme appInputDecorationTheme(
  ColorScheme scheme,
  TextTheme text,
) {
  OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(AppRadii.control),
    borderSide: BorderSide(color: color, width: width),
  );

  Color stateColor(Set<WidgetState> states, {Color? rest}) {
    if (states.contains(WidgetState.disabled)) {
      return scheme.onSurface.withValues(alpha: 0.38);
    }
    if (states.contains(WidgetState.error)) return scheme.error;
    if (states.contains(WidgetState.focused)) return scheme.primary;
    return rest ?? scheme.onSurfaceVariant;
  }

  return InputDecorationTheme(
    filled: true,
    fillColor: WidgetStateColor.resolveWith(
      (states) => states.contains(WidgetState.disabled)
          ? scheme.surfaceContainerLow
          : scheme.surfaceContainerLowest,
    ),
    hoverColor: Colors.transparent,
    border: border(scheme.outline, 1),
    enabledBorder: border(scheme.outline, 1),
    focusedBorder: border(scheme.primary, 2),
    errorBorder: border(scheme.error, 1.4),
    focusedErrorBorder: border(scheme.error, 2),
    disabledBorder: border(scheme.outlineVariant, 1),
    labelStyle: WidgetStateTextStyle.resolveWith(
      (states) => text.bodyMedium!.copyWith(color: stateColor(states)),
    ),
    floatingLabelStyle: WidgetStateTextStyle.resolveWith(
      (states) => text.bodyMedium!.copyWith(
        color: stateColor(states),
        fontWeight: FontWeight.w700,
      ),
    ),
    // Hints are text, so they hold the same 4.5:1 as the rest of the copy;
    // they read as hints by being lighter in weight than what is typed.
    hintStyle: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
    helperStyle: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
    errorStyle: text.bodySmall?.copyWith(
      color: scheme.error,
      fontWeight: FontWeight.w600,
    ),
    prefixIconColor: WidgetStateColor.resolveWith(stateColor),
    suffixIconColor: WidgetStateColor.resolveWith(stateColor),
    contentPadding: const EdgeInsets.symmetric(
      horizontal: AppSpacing.md,
      vertical: AppSpacing.md,
    ),
    errorMaxLines: 3,
    helperMaxLines: 3,
  );
}

ChipThemeData appChipTheme(
  ChipThemeData base,
  ColorScheme scheme,
  TextTheme text,
) {
  return base.copyWith(
    shape: const StadiumBorder(),
    side: WidgetStateBorderSide.resolveWith((states) {
      if (states.contains(WidgetState.disabled)) {
        return BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6));
      }
      if (states.contains(WidgetState.selected)) {
        return BorderSide(color: scheme.primary.withValues(alpha: 0.5));
      }
      return BorderSide(color: scheme.outlineVariant);
    }),
    backgroundColor: scheme.surfaceContainerLowest,
    selectedColor: scheme.primaryContainer,
    disabledColor: scheme.surfaceContainerLow,
    elevation: 0,
    pressElevation: 0,
    labelStyle: text.labelLarge?.copyWith(color: scheme.onSurface),
    secondaryLabelStyle: text.labelLarge?.copyWith(
      color: scheme.onPrimaryContainer,
    ),
    checkmarkColor: scheme.onPrimaryContainer,
    iconTheme: IconThemeData(size: 18, color: scheme.onSurfaceVariant),
  );
}

ListTileThemeData appListTileTheme(
  ColorScheme scheme,
  TextTheme text,
  ShapeBorder shape,
) {
  return ListTileThemeData(
    shape: shape,
    iconColor: scheme.onSurfaceVariant,
    selectedColor: scheme.primary,
    // No `selectedTileColor` on purpose. ListTile asserts (debug builds) when a
    // theme gives it a non-transparent background and it sits under any
    // ColoredBox: a PopupMenuButton with `initialValue` wraps the matching item
    // in one, so a themed tile colour broke every CheckedPopupMenuItem menu.
    titleTextStyle: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
    subtitleTextStyle: text.bodyMedium?.copyWith(
      color: scheme.onSurfaceVariant,
    ),
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
    minVerticalPadding: AppSpacing.xs,
    horizontalTitleGap: AppSpacing.sm + 2,
  );
}

SwitchThemeData appSwitchTheme(ColorScheme scheme) {
  return SwitchThemeData(
    thumbColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.disabled)) {
        return states.contains(WidgetState.selected)
            ? scheme.surface
            : scheme.onSurface.withValues(alpha: 0.38);
      }
      return states.contains(WidgetState.selected)
          ? scheme.onPrimary
          : scheme.outline;
    }),
    trackColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.disabled)) {
        return states.contains(WidgetState.selected)
            ? scheme.onSurface.withValues(alpha: 0.12)
            : scheme.surfaceContainerHighest.withValues(alpha: 0.6);
      }
      return states.contains(WidgetState.selected)
          ? scheme.primary
          : scheme.surfaceContainerHighest;
    }),
    trackOutlineColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.selected)) return Colors.transparent;
      return states.contains(WidgetState.disabled)
          ? scheme.onSurface.withValues(alpha: 0.12)
          : scheme.outline;
    }),
    // A tick on the "on" thumb: state must not ride on colour alone.
    thumbIcon: WidgetStateProperty.resolveWith((states) {
      if (!states.contains(WidgetState.selected)) return null;
      return Icon(
        Icons.check,
        size: 16,
        color: states.contains(WidgetState.disabled)
            ? scheme.onSurface.withValues(alpha: 0.38)
            : scheme.primary,
      );
    }),
  );
}

CheckboxThemeData appCheckboxTheme(ColorScheme scheme) {
  return CheckboxThemeData(
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    side: WidgetStateBorderSide.resolveWith((states) {
      if (states.contains(WidgetState.selected)) return BorderSide.none;
      return BorderSide(
        color: states.contains(WidgetState.disabled)
            ? scheme.onSurface.withValues(alpha: 0.38)
            : scheme.outline,
        width: 2,
      );
    }),
    fillColor: WidgetStateProperty.resolveWith((states) {
      if (!states.contains(WidgetState.selected)) return Colors.transparent;
      return states.contains(WidgetState.disabled)
          ? scheme.onSurface.withValues(alpha: 0.38)
          : scheme.primary;
    }),
    checkColor: WidgetStatePropertyAll(scheme.onPrimary),
  );
}

RadioThemeData appRadioTheme(ColorScheme scheme) {
  return RadioThemeData(
    fillColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.disabled)) {
        return scheme.onSurface.withValues(alpha: 0.38);
      }
      return states.contains(WidgetState.selected)
          ? scheme.primary
          : scheme.outline;
    }),
  );
}

SegmentedButtonThemeData appSegmentedButtonTheme(
  ColorScheme scheme,
  TextTheme text,
) {
  return SegmentedButtonThemeData(
    style: ButtonStyle(
      minimumSize: const WidgetStatePropertyAll(
        Size(48, AppSizes.minimumTouchTarget),
      ),
      textStyle: WidgetStatePropertyAll(
        text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
      ),
      side: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) {
          return BorderSide(color: scheme.primary.withValues(alpha: 0.5));
        }
        return BorderSide(color: scheme.outline);
      }),
      backgroundColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? scheme.primaryContainer
            : Colors.transparent,
      ),
      foregroundColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.disabled)) {
          return scheme.onSurface.withValues(alpha: 0.38);
        }
        return states.contains(WidgetState.selected)
            ? scheme.onPrimaryContainer
            : scheme.onSurface;
      }),
    ),
  );
}

NavigationBarThemeData appNavigationBarTheme(
  ColorScheme scheme,
  TextTheme text,
) {
  return NavigationBarThemeData(
    backgroundColor: scheme.surfaceContainer,
    surfaceTintColor: Colors.transparent,
    elevation: 0,
    height: 68,
    indicatorColor: scheme.primaryContainer,
    indicatorShape: const StadiumBorder(),
    iconTheme: WidgetStateProperty.resolveWith(
      (states) => IconThemeData(
        size: 24,
        color: states.contains(WidgetState.selected)
            ? scheme.onPrimaryContainer
            : scheme.onSurfaceVariant,
      ),
    ),
    labelTextStyle: WidgetStateProperty.resolveWith(
      (states) => text.labelMedium?.copyWith(
        fontWeight: states.contains(WidgetState.selected)
            ? FontWeight.w800
            : FontWeight.w600,
        color: states.contains(WidgetState.selected)
            ? scheme.onSurface
            : scheme.onSurfaceVariant,
      ),
    ),
  );
}

TabBarThemeData appTabBarTheme(ColorScheme scheme, TextTheme text) {
  return TabBarThemeData(
    labelColor: scheme.primary,
    unselectedLabelColor: scheme.onSurfaceVariant,
    labelStyle: text.labelLarge?.copyWith(fontWeight: FontWeight.w800),
    unselectedLabelStyle: text.labelLarge?.copyWith(
      fontWeight: FontWeight.w600,
    ),
    indicatorSize: TabBarIndicatorSize.label,
    indicator: UnderlineTabIndicator(
      borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
      borderSide: BorderSide(color: scheme.primary, width: 3),
    ),
    dividerColor: scheme.outlineVariant,
    dividerHeight: 1,
    overlayColor: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.pressed)
          ? scheme.primary.withValues(alpha: 0.10)
          : states.contains(WidgetState.hovered) ||
                states.contains(WidgetState.focused)
          ? scheme.primary.withValues(alpha: 0.06)
          : null,
    ),
  );
}

SliderThemeData appSliderTheme(SliderThemeData base, ColorScheme scheme) {
  return base.copyWith(
    trackHeight: AppSpacing.xxs,
    activeTrackColor: scheme.primary,
    inactiveTrackColor: scheme.primary.withValues(alpha: 0.22),
    thumbColor: scheme.primary,
    overlayColor: scheme.primary.withValues(alpha: 0.12),
    disabledActiveTrackColor: scheme.onSurface.withValues(alpha: 0.38),
    disabledInactiveTrackColor: scheme.onSurface.withValues(alpha: 0.12),
    disabledThumbColor: scheme.onSurface.withValues(alpha: 0.38),
    valueIndicatorColor: scheme.inverseSurface,
    valueIndicatorTextStyle: TextStyle(color: scheme.onInverseSurface),
  );
}

ExpansionTileThemeData appExpansionTileTheme(ColorScheme scheme) {
  // Material draws a rule above and below an open tile; inside a card that
  // reads as two stray lines, so the tile is left borderless.
  const border = Border();
  return ExpansionTileThemeData(
    shape: border,
    collapsedShape: border,
    iconColor: scheme.onSurfaceVariant,
    collapsedIconColor: scheme.onSurfaceVariant,
    textColor: scheme.onSurface,
    collapsedTextColor: scheme.onSurface,
    tilePadding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
    childrenPadding: const EdgeInsets.fromLTRB(
      AppSpacing.md,
      0,
      AppSpacing.md,
      AppSpacing.md,
    ),
  );
}

DialogThemeData appDialogTheme(
  ColorScheme scheme,
  TextTheme text, {
  required bool isLight,
}) {
  return DialogThemeData(
    // Dark surfaces climb by tone, not shadow: a dialog is the highest layer,
    // so it takes a step above the cards beneath it.
    backgroundColor: isLight
        ? scheme.surfaceContainerLowest
        : scheme.surfaceContainerHigh,
    surfaceTintColor: Colors.transparent,
    elevation: isLight ? 6 : 0,
    shadowColor: Colors.black.withValues(alpha: 0.22),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadii.sheet - AppSpacing.xxs),
      side: isLight
          ? BorderSide.none
          : BorderSide(color: scheme.outlineVariant),
    ),
    titleTextStyle: text.titleLarge?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.3,
      color: scheme.onSurface,
    ),
    contentTextStyle: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
    actionsPadding: const EdgeInsets.fromLTRB(
      AppSpacing.md,
      0,
      AppSpacing.md,
      AppSpacing.md,
    ),
  );
}

BottomSheetThemeData appBottomSheetTheme(
  ColorScheme scheme, {
  required bool isLight,
}) {
  return BottomSheetThemeData(
    backgroundColor: isLight
        ? scheme.surfaceContainerLowest
        : scheme.surfaceContainer,
    surfaceTintColor: Colors.transparent,
    elevation: isLight ? 8 : 0,
    shadowColor: Colors.black.withValues(alpha: 0.24),
    modalElevation: isLight ? 8 : 0,
    modalBarrierColor: Colors.black.withValues(alpha: isLight ? 0.40 : 0.60),
    showDragHandle: true,
    // Visible against the sheet (3:1), unlike the hairline colour it used to
    // borrow: the handle is what tells a reader the sheet can be dragged.
    dragHandleColor: scheme.outline.withValues(alpha: isLight ? 0.55 : 0.75),
    dragHandleSize: const Size(36, 4),
    clipBehavior: Clip.antiAlias,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.sheet)),
    ),
  );
}

SnackBarThemeData appSnackBarTheme(ColorScheme scheme, TextTheme text) {
  return SnackBarThemeData(
    behavior: SnackBarBehavior.floating,
    // Lifted clear of the chat composer, which lives in the body where a
    // floating bar would otherwise sit right on top of the text field.
    insetPadding: const EdgeInsets.fromLTRB(
      AppSpacing.md,
      AppSpacing.md,
      AppSpacing.md,
      88,
    ),
    // Translucent on purpose: tapToDismissSnackBar backdrop-blurs the bar,
    // so this tint composites over frosted page content.
    backgroundColor: scheme.surfaceContainerHighest.withValues(alpha: 0.86),
    elevation: 0,
    contentTextStyle: text.bodyMedium?.copyWith(color: scheme.onSurface),
    // Material's default is `inversePrimary`, which is made for a dark bar and
    // sat at under 2:1 on this light one.
    actionTextColor: scheme.primary,
    disabledActionTextColor: scheme.onSurface.withValues(alpha: 0.38),
    closeIconColor: scheme.onSurfaceVariant,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadii.control),
      side: BorderSide(color: scheme.outline.withValues(alpha: 0.35)),
    ),
  );
}

/// Android keeps Material's predictive-back transition (the peek behind the
/// page while a back gesture is in flight) and only shortens the forward and
/// reverse animation, which Material sets at 450ms.
///
/// Other platforms keep their native builders. Screens routed through
/// `go_router`'s `CustomTransitionPage` do not read this theme at all; it is
/// for the `MaterialPageRoute`s pushed directly.
PageTransitionsTheme appPageTransitionsTheme(ColorScheme scheme) {
  return PageTransitionsTheme(
    builders: <TargetPlatform, PageTransitionsBuilder>{
      TargetPlatform.android: _AppPredictiveBackTransitions(
        fallbackColor: scheme.surface,
      ),
      TargetPlatform.iOS: const CupertinoPageTransitionsBuilder(),
      TargetPlatform.macOS: const CupertinoPageTransitionsBuilder(),
      TargetPlatform.windows: const ZoomPageTransitionsBuilder(),
      TargetPlatform.linux: const ZoomPageTransitionsBuilder(),
    },
  );
}

class _AppPredictiveBackTransitions
    extends PredictiveBackPageTransitionsBuilder {
  const _AppPredictiveBackTransitions({super.fallbackColor});

  @override
  Duration get transitionDuration => AppMotion.page;
}
