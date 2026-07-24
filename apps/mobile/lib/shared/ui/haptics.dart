import 'package:flutter/services.dart';

/// Semantic haptics for the app.
///
/// Call sites name the *meaning* of the moment rather than a platform impact
/// strength, so the feel of the whole app can be retuned in one place. Every
/// call is fire-and-forget: haptics are a garnish and must never block or throw
/// into a UI callback, so platform failures (unsupported device, missing
/// vibrator permission) are swallowed.
abstract final class AppHaptics {
  /// Set to false to mute every haptic, e.g. from a future accessibility
  /// setting or from a test that asserts on platform channel calls.
  static bool enabled = true;

  static void _run(Future<void> Function() effect) {
    if (!enabled) {
      return;
    }
    // Ignore platform errors: a missing vibrator must never break a tap.
    effect().catchError((_) {});
  }

  /// A light tick for a discrete choice: selecting a chip, toggling an option,
  /// moving through a list of options.
  static void selection() => _run(HapticFeedback.selectionClick);

  /// A committed, meaningful tap: sending a message, opening a book, confirming
  /// a sheet. The workhorse for primary buttons.
  static void tap() => _run(HapticFeedback.lightImpact);

  /// A weightier action that changes state in a way the user should feel:
  /// approving a plan, starting generation, buying credits.
  static void commit() => _run(HapticFeedback.mediumImpact);

  /// The payoff moment: a book finished, an export unlocked, a purchase
  /// completed. Two beats so it reads as celebratory rather than as an alert.
  static void success() {
    if (!enabled) {
      return;
    }
    _run(HapticFeedback.mediumImpact);
    Future<void>.delayed(
      const Duration(milliseconds: 90),
      () => _run(HapticFeedback.lightImpact),
    );
  }

  /// Something needs attention but is recoverable: validation, a soft block.
  static void warning() => _run(HapticFeedback.mediumImpact);

  /// Something failed: a send error, a failed generation, a declined purchase.
  static void error() => _run(HapticFeedback.heavyImpact);

  /// Long-press affordance opened (context menu, reorder handle).
  static void longPress() => _run(HapticFeedback.mediumImpact);
}
