/// Location for starting a brand-new book creation chat.
///
/// Every call mints a fresh `r` nonce so two consecutive "New book" taps
/// never resolve to the exact same GoRouter location. Without it,
/// `context.go` is a no-op whenever the target location equals the current
/// one (`GoRouterDelegate.setNewRoutePath` skips `notifyListeners()` on an
/// unchanged `RouteMatchList`) — and the app stays on `/books/new?fresh=true`
/// for the whole conversation that follows, so a second tap while already
/// there would otherwise do nothing but close the drawer. See
/// `CreationChatScreen.resetToken`, which pairs with this so the screen
/// itself doesn't shortcut the reset either.
String newBookChatLocation() =>
    '/books/new?fresh=true&r=${DateTime.now().microsecondsSinceEpoch}';
