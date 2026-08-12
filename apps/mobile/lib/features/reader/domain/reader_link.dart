import 'dart:ui';

import 'package:pdfrx/pdfrx.dart';

import 'reader_annotation.dart';
import 'reader_annotation_geometry.dart';

/// A link on a page of the book, in the reader's own coordinates.
///
/// The compiled book carries two kinds and both are ordinary PDF annotations:
/// the Contents page links to a named destination per chapter, and the Sources
/// list links out to each publisher. Chrome writes them at print time, so
/// nothing about them is particular to this app — a book opened in any other
/// viewer has the same links.
class ReaderPageLink {
  const ReaderPageLink({required this.rects, this.url, this.dest});

  /// Where the link sits on the page, as fractions of the page box, the way
  /// [NormPoint] and markup are. One rectangle per line: a citation that wraps
  /// is still one link.
  final List<NormRect> rects;

  /// The address to open, already through [readerLinkUrl] — so a link that
  /// survives into here is one this reader is willing to follow.
  final Uri? url;

  /// A place in this same document.
  final PdfDest? dest;

  /// Whether a tap should be spent on this link at all.
  ///
  /// A link with neither is not merely useless, it is harmful: it would sit on
  /// the page swallowing taps that the reader means as taps on the book.
  bool get isFollowable => dest != null || url != null;

  /// Whether [point] lands on this link.
  ///
  /// Grown by the same slop as markup, and for the same reason: a citation is
  /// one line of type tall, which is a far smaller target than a fingertip.
  bool hitTest(
    NormPoint point, {
    double slop = ReaderAnnotation.defaultTouchSlop,
  }) {
    return rects.any((rect) => rect.inflate(slop).contains(point));
  }
}

/// The link under [point], or null when the tap missed every one.
///
/// Later links win, which is the rule `ReaderAnnotationController.annotationAt`
/// follows for markup and for the same reason: PDFium reports annotations in
/// document order, and the last one is the one on top.
ReaderPageLink? readerLinkAt(List<ReaderPageLink> links, NormPoint point) {
  for (var i = links.length - 1; i >= 0; i--) {
    if (links[i].hitTest(point)) {
      return links[i];
    }
  }
  return null;
}

/// Reads [page]'s links into the reader's coordinates, dropping the ones it
/// would refuse to follow.
///
/// Dropping them here rather than at the tap is what keeps a refused link from
/// becoming a dead spot on the page: it is not in the index, so the tap falls
/// through to the page and the bars get out of the way as they would anywhere
/// else.
///
/// PDF geometry is y-up from the bottom-left corner and may carry a page
/// rotation; a [NormPoint] is a fraction of the page box measured from its
/// top-left. Turning one into the other is left to pdfrx's own `toRect`, which
/// applies the page rotation, so a link lands exactly where the viewer paints
/// it — including for a rotation this pipeline never produces.
///
/// What `toRect` answers in is the page's *displayed* frame, which spans
/// `page.width` by `page.height` — pdfrx reports those already rotated. That is
/// the same box `ReaderTapLayer` measures its [NormPoint] against, so it is the
/// divisor. Building the box as a [PdfRect] instead would be wrong: `toRect`
/// would rotate it a second time, and on a quarter-turned page it comes back
/// transposed, which puts a link off the edge of the page entirely.
List<ReaderPageLink> readerPageLinks(List<PdfLink> links, PdfPage page) {
  final pageBox = Rect.fromLTWH(0, 0, page.width, page.height);
  if (pageBox.width <= 0 || pageBox.height <= 0) {
    return const [];
  }
  final resolved = <ReaderPageLink>[];
  for (final link in links) {
    final url = readerLinkUrl(link.url);
    final dest = link.dest;
    if (url == null && dest == null) {
      continue;
    }
    final rects = <NormRect>[
      for (final rect in link.rects)
        NormRect.fromRect(rect.toRect(page: page), pageBox),
    ];
    if (rects.isEmpty) {
      continue;
    }
    resolved.add(ReaderPageLink(rects: rects, url: url, dest: dest));
  }
  return resolved;
}

/// The address a tapped link may open, or null when it may not be opened.
///
/// A manuscript is untrusted text — the model writes the prose, an import
/// arrives as whatever the reader had, and an exact-replacement edit writes
/// literal text into a page — and every one of those routes reaches a link
/// annotation in the compiled PDF. `launchUrl` will fire whatever scheme it is
/// handed, and on Android that includes `intent:`, which names an arbitrary
/// component of another app. So the reader opens the web and nothing else.
///
/// This is deliberately the same rule as `MobileCreationResearchSource.uri`,
/// which is what the creation chat opens its research links through: the two
/// surfaces show the reader the same citations and must agree about which of
/// them are safe.
///
/// The `userInfo` check is the one that is not about schemes:
/// `https://en.wikipedia.org@evil.example` is a link to `evil.example` that
/// reads as a link to Wikipedia, and the printed page shows only the title.
Uri? readerLinkUrl(Uri? url) {
  if (url == null) {
    return null;
  }
  if (url.scheme != 'https' && url.scheme != 'http') {
    return null;
  }
  if (url.host.isEmpty || url.userInfo.isNotEmpty) {
    return null;
  }
  return url;
}

/// Whether [dest] names a page this document actually has.
///
/// pdfrx indexes `pages[dest.pageNumber - 1]` without checking, and PDFium
/// answers −1 for a destination it cannot resolve, so a link to a chapter that
/// a later recompile removed would throw a `RangeError` out of the tap handler
/// rather than doing nothing.
bool readerLinkDestIsReachable(PdfDest dest, int pageCount) {
  return dest.pageNumber >= 1 && dest.pageNumber <= pageCount;
}
