import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/reader_link.dart';

/// The hand-off to the browser, behind a provider so widget tests can stand in
/// for it.
///
/// There is no url_launcher plugin under `flutter test`: the channel call never
/// answers, so a test that let this run would hang rather than fail. Same
/// reasoning as `playSubscriptionsLauncherProvider`.
final readerLinkLauncherProvider = Provider<Future<bool> Function(Uri url)>((
  ref,
) {
  return (url) => launchUrl(url, mode: LaunchMode.externalApplication);
});

/// The book's links, page by page, for as long as one document is open.
///
/// The viewer would happily do this itself — `PdfViewerParams.linkHandlerParams`
/// exists — but it cannot be used here. `ReaderTapLayer` is a raw `Listener`
/// covering the whole page, so it fires on the pointer going up rather than
/// competing in the gesture arena, and it is deliberately built that way: it
/// must never lose a tap to a scroll or a pinch. pdfrx classifies its own taps
/// separately and dispatches them through its overlay hit-tester, so the two
/// would both fire and a tapped chapter link would jump *and* hide the bars.
/// One owner answers "what is under this point" instead — markup, then a link,
/// then the book itself.
///
/// Reading a page's links is a round trip to the render isolate, so the answer
/// is memoized and the page being looked at is resolved before it is tapped.
class ReaderLinkIndex {
  PdfDocument? _document;
  final Map<int, List<ReaderPageLink>> _resolved = {};
  final Map<int, Future<List<ReaderPageLink>>> _loading = {};

  /// Binds the index to a document, forgetting anything read from an older one.
  ///
  /// A recompiled book is a different document with the same pages, so keeping
  /// the old answers would point the Contents at last revision's chapters.
  void attach(PdfDocument document) {
    if (identical(_document, document)) {
      return;
    }
    _document = document;
    _resolved.clear();
    _loading.clear();
  }

  /// The links already read for [pageNumber], or null when the page has not
  /// been read yet. Lets a tap on a page the reader is already looking at be
  /// answered without an asynchronous gap.
  List<ReaderPageLink>? resolved(int pageNumber) => _resolved[pageNumber];

  /// Reads [pageNumber]'s links, at most once per page.
  Future<List<ReaderPageLink>> forPage(int pageNumber) {
    final ready = _resolved[pageNumber];
    if (ready != null) {
      return Future.value(ready);
    }
    final pending = _loading[pageNumber];
    if (pending != null) {
      return pending;
    }
    final load = _read(pageNumber);
    _loading[pageNumber] = load;
    // Cleared through `whenComplete` rather than a `finally` inside [_read]:
    // the guard paths there return without suspending, so a `finally` would
    // run before this assignment and leave the entry behind for good.
    unawaited(load.whenComplete(() => _loading.remove(pageNumber)));
    return load;
  }

  Future<List<ReaderPageLink>> _read(int pageNumber) async {
    final document = _document;
    if (document == null ||
        pageNumber < 1 ||
        pageNumber > document.pages.length) {
      return const [];
    }
    final page = document.pages[pageNumber - 1];
    // An unloaded page answers with an empty list rather than waiting for
    // itself, so caching that would pin "no links here" for the life of the
    // document.
    if (!page.isLoaded) {
      return const [];
    }
    try {
      final links = readerPageLinks(
        // Bare URLs printed in the prose are tappable too, the way they are in
        // every other viewer. PDFium finds them itself, so this costs a native
        // pass over text the page has already laid out. It reaches further into
        // the manuscript than the annotations do — a book's text is whatever
        // the model wrote or an import brought in — which is why the result
        // still goes through [readerLinkUrl] and not to the browser. PDFium
        // also reads an email address as a `mailto:` link; those are refused
        // there and stay inert.
        await page.loadLinks(compact: true, enableAutoLinkDetection: true),
        page,
      );
      // The document can have been swapped out from under the read.
      if (identical(_document, document)) {
        _resolved[pageNumber] = links;
      }
      return links;
    } catch (_) {
      // A link index that cannot be read must not take the tap down with it.
      return const [];
    }
  }
}

/// Follows a tapped [link], answering whether it consumed the tap.
///
/// False means the reader should treat this as an ordinary tap on the page.
/// That matters as much as the true case: a link this reader will not follow
/// has to leave the tap alone, or it becomes a dead spot where the bars refuse
/// to get out of the way and nothing explains why.
Future<bool> followReaderLink({
  required BuildContext context,
  required WidgetRef ref,
  required PdfViewerController controller,
  required ReaderPageLink link,
}) async {
  final dest = link.dest;
  if (dest != null) {
    return _goToDestination(controller, dest);
  }
  final url = link.url;
  if (url == null) {
    return false;
  }
  AppHaptics.tap();
  // Read before the hand-off: opening a browser is an asynchronous gap the
  // reader can be disposed across.
  final messenger = ScaffoldMessenger.of(context);
  var opened = false;
  try {
    opened = await ref.read(readerLinkLauncherProvider)(url);
  } catch (_) {
    // A device with nothing able to open a web page throws rather than
    // answering false.
    opened = false;
  }
  if (!opened) {
    messenger.showAppSnackBar(
      const SnackBar(content: Text('Could not open that link.')),
    );
  }
  return true;
}

/// The same, for a link handed straight over by the viewer.
///
/// Only for a surface where the viewer owns link taps because nothing else
/// does — the pre-signup sample book, which carries none of the reader's own
/// page layers. Anywhere those layers exist, [ReaderLinkIndex] is the owner.
Future<bool> followPdfLink({
  required BuildContext context,
  required WidgetRef ref,
  required PdfViewerController controller,
  required PdfLink link,
}) {
  return followReaderLink(
    context: context,
    ref: ref,
    controller: controller,
    link: ReaderPageLink(
      rects: const [],
      url: readerLinkUrl(link.url),
      dest: link.dest,
    ),
  );
}

/// Jumps to a place in this same book — a chapter from the Contents page.
///
/// The matrix is worked out before anything is committed to, because a
/// destination pdfrx cannot resolve is one the reader should be allowed to tap
/// past: better the bars move than a tap that buzzes and does nothing.
Future<bool> _goToDestination(
  PdfViewerController controller,
  PdfDest dest,
) async {
  if (!controller.isReady ||
      !readerLinkDestIsReachable(dest, controller.pageCount) ||
      controller.calcMatrixForDest(dest) == null) {
    return false;
  }
  AppHaptics.tap();
  await controller.goToDest(dest);
  return true;
}
