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
