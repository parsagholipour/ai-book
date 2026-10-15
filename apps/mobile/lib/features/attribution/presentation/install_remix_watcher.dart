import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/domain/auth_models.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../sharing/presentation/remix_location.dart';
import '../data/install_attribution_tracker.dart';

/// The location the offer waits for.
const _homeLocation = '/home';

/// Reads the install referrer once there is a session, reports where the
/// install came from, and — once per install — offers the remix of the shared
/// book the reader installed from.
///
/// A reader who tapped "Make a book like this" on a shared page without the
/// app went to Play instead, and the link they tapped is gone by the time the
/// app opens; Play kept the share's slug in the install referrer, and this is
/// where it comes back.
///
/// It lives beside the router rather than in a screen because it is about the
/// session, not a page: it used to be called by a home screen no route built,
/// so nothing was ever reported and no remix was ever offered. It acts once per
/// signed-in, online session, and only while home is the top page with nothing
/// over it — a page or sheet on top keeps the offer for the next time home is.
/// Sends nothing and shows nothing off Android, without a referrer, or when
/// anything fails.
class InstallRemixWatcher extends ConsumerStatefulWidget {
  const InstallRemixWatcher({
    required this.router,
    required this.child,
    super.key,
  });

  final GoRouter router;
  final Widget child;

  @override
  ConsumerState<InstallRemixWatcher> createState() =>
      _InstallRemixWatcherState();
}

class _InstallRemixWatcherState extends ConsumerState<InstallRemixWatcher> {
  /// The account this session's pass belongs to.
  String? _sessionUser;

  /// The offer was taken (a slug or none) for [_sessionUser]; nothing more is
  /// done until another account signs in.
  bool _settled = false;
  bool _running = false;
  bool _scheduled = false;

  @override
  void initState() {
    super.initState();
    widget.router.routerDelegate.addListener(_schedule);
    _schedule();
  }

  @override
  void didUpdateWidget(InstallRemixWatcher oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.router != widget.router) {
      oldWidget.router.routerDelegate.removeListener(_schedule);
      widget.router.routerDelegate.addListener(_schedule);
    }
  }

  @override
  void dispose() {
    widget.router.routerDelegate.removeListener(_schedule);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(authControllerProvider.select(_onlineUser), (previous, next) {
      if (previous != next) _schedule();
    });
    return widget.child;
  }

  /// The signed-in account, while the server has confirmed the session: an
  /// offline session can neither report nor open a remix.
  static String? _onlineUser(AsyncValue<AuthSession?> auth) {
    final session = auth.asData?.value;
    if (session == null || session.offline) return null;
    return session.user.id;
  }

  /// Checked a frame later, never inside the router's notification: a sheet
  /// pushed before the navigator has rebuilt its pages is dropped with the
  /// page it was pushed over.
  void _schedule() {
    if (_scheduled || !mounted) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      _check();
    });
    // A post-frame callback waits for a frame, and an idle app has none
    // coming.
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  /// Home is the top page, with no page, sheet or dialog over it.
  bool get _homeOnTop {
    final matches = widget.router.routerDelegate.currentConfiguration;
    // The top page, not `currentConfiguration.uri`: a pushed page leaves that
    // on the page it was pushed over.
    if (matches.isEmpty || matches.last.matchedLocation != _homeLocation) {
      return false;
    }
    final navigator = widget.router.routerDelegate.navigatorKey.currentState;
    return navigator != null && !navigator.canPop();
  }

  void _check() {
    if (!mounted || _running) return;
    final user = _onlineUser(ref.read(authControllerProvider));
    if (user == null) return;
    if (user != _sessionUser) {
      _sessionUser = user;
      _settled = false;
    }
    if (_settled || !_homeOnTop) return;
    unawaited(_run(user));
  }

  Future<void> _run(String user) async {
    _running = true;
    try {
      final tracker = ref.read(installAttributionProvider);
      await tracker.resolve();
      if (!mounted || user != _sessionUser) return;
      unawaited(_quietly(tracker.reportIfNeeded()));
      // Taken only while home is still on top; otherwise the next time it is.
      if (!_homeOnTop) return;
      _settled = true;
      final slug = await tracker.takeRemixOffer();
      if (slug == null || !mounted) return;
      final navigatorContext =
          widget.router.routerDelegate.navigatorKey.currentContext;
      if (navigatorContext == null || !navigatorContext.mounted) return;
      final accepted = await showAppBottomSheet<bool>(
        navigatorContext,
        builder: (_) => const InstallRemixOfferSheet(),
      );
      if (accepted == true && mounted) {
        unawaited(widget.router.push(remixLocation(slug)));
      }
    } on Object {
      // Attribution never fails the app; whatever went wrong is skipped.
    } finally {
      _running = false;
    }
  }

  static Future<void> _quietly(Future<void> work) async {
    try {
      await work;
    } on Object {
      // Reported on a later launch, or never; nothing worse.
    }
  }
}

class InstallRemixOfferSheet extends StatelessWidget {
  const InstallRemixOfferSheet({super.key});

  @override
  Widget build(BuildContext context) {
    return AppSheetScaffold(
      title: 'Make a book like the one you saw?',
      icon: Icons.auto_stories_outlined,
      onClose: () => Navigator.of(context).pop(false),
      footer: AppActionGroup(
        secondary: [
          AppButton.text(
            label: 'Not now',
            onPressed: () => Navigator.of(context).pop(false),
          ),
        ],
        primary: AppButton.primary(
          label: 'Make one like it',
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ),
      children: [
        Text(
          'You came to Tomeza from a shared book. Start a new book in the '
          'same style and length, with a story of your own.',
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ],
    );
  }
}
