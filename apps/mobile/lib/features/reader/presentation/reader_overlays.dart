import 'package:flutter/material.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/motion.dart';
import 'reader_document_loader.dart';

/// Positions the selection action bar and animates it in and out.
///
/// The bar tracks a live selection, so it moves as well as appears: a plain
/// show/hide would make it blink from place to place while the reader drags a
/// handle. Sliding and fading keeps it legible as one object.
class ReaderSelectionOverlay extends StatelessWidget {
  const ReaderSelectionOverlay({
    required this.anchor,
    required this.visible,
    required this.child,
    super.key,
  });

  final Offset anchor;
  final bool visible;
  final Widget child;

  /// The widest the bar is allowed to get, and the widest it wants to be: the
  /// four book actions need room for "Edit page" without truncating it.
  static const maxMenuWidth = 340.0;

  /// Tall enough for the row of book actions. Only used to decide which side of
  /// the passage the bar sits on, so it is a reservation rather than a
  /// measurement — the busy notice occasionally makes it taller and that is
  /// worth less than keeping the bar off the paragraph the rest of the time.
  ///
  /// Markup moved to the top bar and the page footer went away, which is what
  /// let this shrink from 136: the bar now clears the paragraph it is about to
  /// act on instead of sitting over it.
  static const menuHeight = 66.0;

  /// The bar narrows on a small screen rather than running off it.
  static double menuWidthFor(double screenWidth) =>
      screenWidth - 16 < maxMenuWidth ? screenWidth - 16 : maxMenuWidth;

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final reduced = AppMotion.reducedMotion(context);
    final duration = reduced ? Duration.zero : AppMotion.fast;
    // Anchored above the selection where there is room, below it otherwise, so
    // the bar never covers the passage it acts on.
    final showAbove = anchor.dy > menuHeight + 40;
    final menuWidth = menuWidthFor(size.width);
    final left = (anchor.dx - menuWidth / 2).clamp(
      8.0,
      (size.width - menuWidth - 8).clamp(8.0, size.width),
    );
    final top = showAbove
        ? (anchor.dy - menuHeight).clamp(8.0, size.height)
        : (anchor.dy + 24).clamp(8.0, size.height);

    return AnimatedPositioned(
      duration: duration,
      curve: AppMotion.standard,
      left: left,
      top: top,
      child: IgnorePointer(
        ignoring: !visible,
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: duration,
          curve: visible ? AppMotion.enter : AppMotion.exit,
          child: AnimatedScale(
            scale: visible ? 1 : 0.92,
            duration: duration,
            curve: visible ? AppMotion.emphasized : AppMotion.exit,
            alignment: showAbove ? Alignment.bottomCenter : Alignment.topCenter,
            child: AnimatedSlide(
              offset: visible
                  ? Offset.zero
                  : Offset(0, showAbove ? 0.12 : -0.12),
              duration: duration,
              curve: visible ? AppMotion.enter : AppMotion.exit,
              // The bar is positioned, so it has no width of its own to take
              // from a parent; without this its row of equal columns has
              // nothing to divide.
              child: SizedBox(width: menuWidth, child: child),
            ),
          ),
        ),
      ),
    );
  }
}

/// Darkens the page below what the device's own brightness can reach.
class ReaderDimOverlay extends StatelessWidget {
  const ReaderDimOverlay({required this.level, super.key});

  /// 0 to 1. Nothing is drawn at 0, so reading at full brightness costs no
  /// extra layer.
  final double level;

  @override
  Widget build(BuildContext context) {
    if (level <= 0) {
      return const SizedBox.shrink();
    }
    return Positioned.fill(
      child: IgnorePointer(
        child: ColoredBox(
          color: Colors.black.withValues(alpha: level.clamp(0.0, 0.9)),
        ),
      ),
    );
  }
}

/// What stands in for the book while there is no document to render: the
/// download, or the reason it never arrived.
class ReaderDownloadState extends StatelessWidget {
  const ReaderDownloadState({
    required this.loader,
    required this.onRetry,
    required this.onOpenPaywall,
    super.key,
  });

  final ReaderDocumentLoader loader;
  final VoidCallback onRetry;
  final VoidCallback onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final error = loader.error;
    if (loader.stage != ReaderLoadStage.failed || error == null) {
      return ReaderDownloadProgress(progress: loader.progress);
    }
    // A download the balance could not pay for is not something retrying
    // fixes — the same call refuses again — so it offers the paywall instead.
    // The screen decided credits were enough before starting, so this is the
    // balance moving underneath the reader rather than a locked book.
    if (_isPaymentFailure(error)) {
      return AppErrorState(
        icon: Icons.lock_outline,
        title: 'Credits needed to open this book',
        message: userFacingError(error),
        actionLabel: 'Get credits',
        actionIcon: Icons.bolt_outlined,
        onRetry: onOpenPaywall,
      );
    }
    // The file is being rebuilt, not missing. This is reachable in the window
    // an edit opens — it deletes the compiled exports and queues the recompile
    // — and the download itself queues that compile if nothing else has, so
    // retrying is exactly the right move rather than a dead end.
    //
    // The copy deliberately does not promise a compile is running right now. A
    // rebuild that already failed is not retried until its five-minute window
    // rolls, so "your changes are being compiled" would be a claim this screen
    // cannot make. "Try again" always re-checks the file, and picks the book up
    // the moment one lands.
    if (_isRebuilding(error)) {
      return AppErrorState(
        icon: Icons.hourglass_empty,
        title: 'Still preparing this book',
        message:
            'This book is being rebuilt after your latest changes. It is usually ready within a few minutes.',
        actionLabel: 'Try again',
        onRetry: onRetry,
      );
    }
    return AppErrorState(
      title: 'Could not download this book',
      message: userFacingError(error),
      onRetry: onRetry,
    );
  }

  /// Whether [error] is the export refusing to unlock for want of credits.
  ///
  /// A download's error body arrives as a stream, so the 402 does not always
  /// survive as a parsed code — the status is checked as well.
  bool _isPaymentFailure(Object error) {
    return error is ApiException &&
        (error.code == 'INSUFFICIENT_CREDITS' || error.statusCode == 402);
  }

  /// Whether [error] is the export not being on disk yet.
  bool _isRebuilding(Object error) {
    return error is ApiException && error.code == 'EXPORT_NOT_READY';
  }
}

/// The download bar shown before the book can be opened.
class ReaderDownloadProgress extends StatelessWidget {
  const ReaderDownloadProgress({this.progress, super.key});

  final double? progress;

  @override
  Widget build(BuildContext context) {
    if (progress == null) {
      return const AppLoadingState(message: 'Opening your book');
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 48),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          LinearProgressIndicator(value: progress),
          const SizedBox(height: 14),
          Text(
            'Downloading your book — ${(progress! * 100).round()}%',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }
}
