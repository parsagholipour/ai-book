import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../data/play_purchase_processor.dart';

/// The app-wide half of Google Play purchases: while someone is signed in,
/// [PlayPurchaseProcessor] listens to Play whether or not a paywall is open,
/// and asks Play for anything unfinished on sign-in, on a restored session,
/// and on every return to the foreground (at most once a minute).
///
/// A paywall's controller used to be the only listener, so a purchase that
/// landed after it closed — a slow card clearing, a checkout the process died
/// under — was never verified, and Play refunded it three days later.
class BillingPurchaseWatcher extends ConsumerStatefulWidget {
  const BillingPurchaseWatcher({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<BillingPurchaseWatcher> createState() =>
      _BillingPurchaseWatcherState();
}

class _BillingPurchaseWatcherState
    extends ConsumerState<BillingPurchaseWatcher> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onResume: () =>
          unawaited(ref.read(playPurchaseProcessorProvider).resumed()),
    );
    // Fired at once too: a restored session is already signed in by the time
    // this mounts, or signs in while the splash screen is up.
    ref.listenManual(
      authControllerProvider.select((auth) => auth.asData?.value?.user.id),
      (previous, next) {
        if (previous == next && next == null) return;
        // Out of the notifier's update: what the processor reports redraws
        // whichever purchase surfaces are open.
        Future.microtask(() {
          if (!mounted) return;
          final purchases = ref.read(playPurchaseProcessorProvider);
          if (next == null) {
            purchases.signedOut();
          } else {
            unawaited(purchases.signedIn(next));
          }
        });
      },
      fireImmediately: true,
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
