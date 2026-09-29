import 'package:flutter/material.dart';

/// The small, deliberate spacing scale used by application chrome.
///
/// Feature-specific geometry (for example PDF overlays or cover artwork) does
/// not need to fit this scale. Screen structure, cards, controls, and action
/// groups should.
abstract final class AppSpacing {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}

/// Shared corner radii for compact surfaces, controls, cards, and overlays.
abstract final class AppRadii {
  static const double compact = 10;
  static const double control = 14;
  static const double card = 18;
  static const double sheet = 28;
  static const double pill = 999;
}

/// Sizes whose consistency carries accessibility or state meaning.
abstract final class AppSizes {
  static const double minimumTouchTarget = 48;
  static const double controlHeight = 52;
  static const double buttonProgressIndicator = 18;
}

/// Canonical screen padding for ordinary, vertically scrolling routes.
abstract final class AppInsets {
  static const EdgeInsets screen = EdgeInsets.fromLTRB(18, 8, 18, 32);
}

/// Shadows for surfaces a feature paints itself (a `DecoratedBox`, not a
/// `Card`, which already takes its lift from the theme).
///
/// Light surfaces get a soft, teal-tinted lift; dark surfaces get none, because
/// a shadow cannot show on a dark page and a dark surface climbs by tone
/// instead (`surfaceContainerLowest` -> `Highest`).
abstract final class AppElevation {
  /// A card at rest: barely off the page.
  static List<BoxShadow> resting(ColorScheme scheme) =>
      scheme.brightness == Brightness.dark
      ? const []
      : const [
          BoxShadow(
            color: Color(0x140F3D34),
            blurRadius: 3,
            offset: Offset(0, 1),
          ),
          BoxShadow(
            color: Color(0x0F0F3D34),
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ];

  /// Something floating over the page: a cover, a pinned bar, a toast.
  static List<BoxShadow> raised(ColorScheme scheme) =>
      scheme.brightness == Brightness.dark
      ? const []
      : const [
          BoxShadow(
            color: Color(0x1A0F3D34),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
          BoxShadow(
            color: Color(0x1F0F3D34),
            blurRadius: 24,
            offset: Offset(0, 10),
          ),
        ];
}
