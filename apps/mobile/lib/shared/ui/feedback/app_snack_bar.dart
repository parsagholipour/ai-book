import 'package:flutter/material.dart';

/// Show a snack bar that a tap gets rid of.
///
/// A [SnackBar] on its own closes on its timer, on a swipe, or on its own
/// action — and any snack bar carrying an action drops the timer
/// ([SnackBar.persist]), so an unwanted message can sit on top of the content
/// until it is swiped just right. Tapping it is what people try first, so that
/// is what every message in this app answers to.
///
/// Use this everywhere instead of `showSnackBar`.
extension AppSnackBarMessenger on ScaffoldMessengerState {
  ScaffoldFeatureController<SnackBar, SnackBarClosedReason> showAppSnackBar(
    SnackBar snackBar,
  ) => showSnackBar(tapToDismissSnackBar(snackBar));
}

/// Rebuilds [snackBar] with its message wrapped in a tap target.
///
/// The target is the whole bar wherever possible, which is why this also takes
/// over [SnackBar.padding]: Flutter applies that padding *outside* the content,
/// so nothing built from within the content can reach the strip it occupies,
/// and a bar whose edges swallow taps is worse than one that never invited
/// them. A bar with an action, a close icon, or padding of its own keeps
/// Flutter's layout — the same padding sets the action's margins there — and
/// settles for the message as the target.
SnackBar tapToDismissSnackBar(SnackBar snackBar) {
  final ownPadding =
      snackBar.padding == null &&
      snackBar.action == null &&
      snackBar.showCloseIcon != true;
  return SnackBar(
    key: snackBar.key,
    content: _TapToDismiss(
      behavior: snackBar.behavior,
      padded: ownPadding,
      child: snackBar.content,
    ),
    backgroundColor: snackBar.backgroundColor,
    elevation: snackBar.elevation,
    margin: snackBar.margin,
    padding: ownPadding ? EdgeInsets.zero : snackBar.padding,
    width: snackBar.width,
    shape: snackBar.shape,
    hitTestBehavior: snackBar.hitTestBehavior,
    behavior: snackBar.behavior,
    action: snackBar.action,
    actionOverflowThreshold: snackBar.actionOverflowThreshold,
    showCloseIcon: snackBar.showCloseIcon,
    closeIconColor: snackBar.closeIconColor,
    duration: snackBar.duration,
    persist: snackBar.persist,
    animation: snackBar.animation,
    onVisible: snackBar.onVisible,
    dismissDirection: snackBar.dismissDirection,
    clipBehavior: snackBar.clipBehavior,
  );
}

class _TapToDismiss extends StatelessWidget {
  const _TapToDismiss({
    required this.behavior,
    required this.padded,
    required this.child,
  });

  final SnackBarBehavior? behavior;

  /// Whether this widget owns the padding the snack bar would have applied.
  final bool padded;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    var content = child;
    if (padded) {
      // Mirrors SnackBar's own defaults, which it cannot apply for us here.
      final resolved =
          behavior ??
          Theme.of(context).snackBarTheme.behavior ??
          SnackBarBehavior.fixed;
      content = Padding(
        padding: EdgeInsets.symmetric(
          horizontal: resolved == SnackBarBehavior.floating ? 16 : 24,
          vertical: 14,
        ),
        child: content,
      );
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      // SnackBar already publishes a dismiss action to assistive technology;
      // a second tappable node over the message would only be noise.
      excludeFromSemantics: true,
      onTap: () => ScaffoldMessenger.of(
        context,
      ).hideCurrentSnackBar(reason: SnackBarClosedReason.dismiss),
      child: content,
    );
  }
}
