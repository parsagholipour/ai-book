import 'package:flutter/widgets.dart';

import '../../shared/ui/app_components.dart';

/// Asks before the back button closes the app.
///
/// Android exits because `didPopRoute` answers `false`: `handlePopRoute` walks
/// the binding's observers and calls `SystemNavigator.pop()` only once every one
/// of them has declined. So "this press is about to close the app" is precisely
/// "`super.didPopRoute()` reported that nothing was popped" — a `PopScope`, an
/// open dialog, a deeper page in the stack all consume the press in there first
/// and never reach the prompt.
///
/// The answer is awaited across the dialog, which is safe for the same reason:
/// `handlePopRoute` awaits each observer before falling through to the exit.
class ConfirmExitBackButtonDispatcher extends RootBackButtonDispatcher {
  ConfirmExitBackButtonDispatcher(this.navigatorKey);

  /// Root navigator, used to host the confirmation dialog.
  final GlobalKey<NavigatorState> navigatorKey;

  bool _asking = false;

  @override
  Future<bool> didPopRoute() async {
    if (await super.didPopRoute()) {
      return true;
    }

    // A press arriving while the prompt is up normally pops the dialog above,
    // so this only guards the case where it somehow raced past that.
    if (_asking) {
      return true;
    }

    // Read fresh from the key rather than captured before the await above, so a
    // navigator torn down in the meantime shows up as a missing context and the
    // press falls through to the exit.
    final context = navigatorKey.currentContext;
    if (context == null || !context.mounted) {
      return false;
    }

    _asking = true;
    try {
      final leaving = await showAppConfirmationDialog(
        context,
        title: 'Close Tomeza?',
        message:
            'Your books are saved. Anything still being generated keeps going '
            'and will be waiting when you come back.',
        confirmLabel: 'Close app',
        cancelLabel: 'Stay',
      );
      // Declining the exit means this press was handled; accepting it hands the
      // press back to the engine, which closes the app.
      return !leaving;
    } finally {
      _asking = false;
    }
  }
}
