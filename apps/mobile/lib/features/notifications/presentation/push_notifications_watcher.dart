import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../auth/presentation/auth_controller.dart';
import '../data/push_device_repository.dart';
import '../data/push_messaging.dart';

/// The app-wide half of book notifications: keeps this install's token filed
/// under whoever is signed in, and opens the book a tapped notification is
/// about.
///
/// A tap can come before there is anyone to show the book to — a cold start
/// lands on the splash screen while the session restores — so the book waits
/// here until a session exists, then opens above home.
class PushNotificationsWatcher extends ConsumerStatefulWidget {
  const PushNotificationsWatcher({
    required this.router,
    required this.child,
    super.key,
  });

  final GoRouter router;
  final Widget child;

  @override
  ConsumerState<PushNotificationsWatcher> createState() =>
      _PushNotificationsWatcherState();
}

class _PushNotificationsWatcherState
    extends ConsumerState<PushNotificationsWatcher> {
  AppLifecycleListener? _lifecycle;
  final _subscriptions = <StreamSubscription<String>>[];
  String? _pendingBook;

  @override
  void initState() {
    super.initState();
    final messaging = ref.read(pushMessagingProvider);
    if (messaging == null) return;
    _lifecycle = AppLifecycleListener(
      onResume: () {
        // The reader may be back from the settings page.
        ref.invalidate(pushPermissionProvider);
        _sync();
      },
    );
    _subscriptions
      ..add(messaging.openedBooks.listen(_openBook))
      ..add(messaging.tokenRefreshes.listen((_) => _sync()));
    Future.microtask(() async {
      final launched = await messaging.takeLaunchBook();
      if (launched != null) _openBook(launched);
      _sync();
    });
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _lifecycle?.dispose();
    super.dispose();
  }

  String? get _userId =>
      ref.read(authControllerProvider).asData?.value?.user.id;

  void _sync() {
    if (!mounted) return;
    unawaited(ref.read(pushRegistrarProvider)?.sync(userId: _userId));
  }

  void _openBook(String projectId) {
    if (!mounted) return;
    _pendingBook = projectId;
    _openPendingBook();
  }

  void _openPendingBook() {
    final projectId = _pendingBook;
    if (projectId == null || _userId == null) return;
    // The router may still be redirecting from the splash screen to home;
    // opening the book in the same frame would be undone by that redirect.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _pendingBook != projectId || _userId == null) return;
      _pendingBook = null;
      final path = '/projects/$projectId';
      // The top page, not `currentConfiguration.uri`: a pushed page leaves
      // that on the page it was pushed over.
      final matches = widget.router.routerDelegate.currentConfiguration;
      if (matches.isNotEmpty && matches.last.matchedLocation == path) return;
      widget.router.push(path);
    });
    // A post-frame callback waits for a frame, and an idle app — which is
    // what a tap on a notification usually finds — has none coming.
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  Widget build(BuildContext context) {
    if (ref.read(pushMessagingProvider) != null) {
      ref.listen(
        authControllerProvider.select((auth) => auth.asData?.value?.user.id),
        (previous, next) {
          if (previous == next) return;
          _sync();
          _openPendingBook();
        },
      );
    }
    return widget.child;
  }
}
