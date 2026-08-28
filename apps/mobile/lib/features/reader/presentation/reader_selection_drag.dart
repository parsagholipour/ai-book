import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/ui/haptics.dart';
import '../domain/reader_text_hit.dart';

/// How long a finger has to rest on a word before the drag takes over.
///
/// Deliberately shorter than [kLongPressTimeout]. pdfrx has a long press of its
/// own on the page underneath — the one that selects a single word and then
/// leaves you to the handles — and two recognizers that reach the same deadline
/// in the same millisecond are separated only by the order their timers happened
/// to be created in. Winning on the clock makes it a property of this widget
/// rather than of the hit-test order, and 400ms still reads as a press rather
/// than as a tap.
const readerSelectionLongPressDuration = Duration(milliseconds: 400);

/// How close to the top or bottom of the viewer a finger has to be before the
/// book starts sliding under it.
const readerSelectionAutoScrollBand = 72.0;

/// The fastest the book slides under a finger held at the very edge, in logical
/// pixels a second.
const readerSelectionAutoScrollSpeed = 720.0;

/// How fast the book should slide for a finger [localY] down a viewer [height]
/// tall, in logical pixels a second.
///
/// Negative goes back through the book, positive goes on. Zero across nearly
/// all of the screen: this exists only so that a passage longer than one screen
/// can be taken in one movement, which on a page of a book is most of them.
///
/// The ramp is quadratic so that a finger that has merely strayed into the band
/// creeps, and only one pushed to the edge moves at speed — a linear ramp makes
/// the last line before the fold impossible to stop on. Nothing happens at all
/// on a viewer too short to hold both bands and some page between them.
double readerSelectionAutoScroll(double localY, double height) {
  if (height < readerSelectionAutoScrollBand * 3) {
    return 0;
  }
  double ramp(double depth) {
    final fraction = (depth / readerSelectionAutoScrollBand).clamp(0.0, 1.0);
    return readerSelectionAutoScrollSpeed * fraction * fraction;
  }

  if (localY < readerSelectionAutoScrollBand) {
    return -ramp(readerSelectionAutoScrollBand - localY);
  }
  final bottom = height - readerSelectionAutoScrollBand;
  if (localY > bottom) {
    return ramp(localY - bottom);
  }
  return 0;
}

/// Long-press a word and keep dragging to take more of the passage.
///
/// pdfrx cannot do this on touch. It turns its free drag-to-select off whenever
/// the selection handles are on (which is always, on a phone), so a long press
/// selects one word, ends there, and the only way to take a sentence is to let
/// go and find the two handles. Every other piece of text on the device extends
/// as you keep dragging, so the reader's did not read as "a PDF" so much as
/// broken.
///
/// So the gesture is driven from here instead, through the viewer's public
/// [PdfTextSelectionDelegate]: pdfrx picks the first word (which is also what
/// leaves the viewer in the state its own context menu is built from — see
/// `_buildSelectionMenu`), and every move after that sets the range directly.
/// Nothing here reaches inside the viewer; a drag it refuses to follow simply
/// leaves the last good selection standing.
///
/// **Positions are taken globally and resolved through the viewer every time.**
/// A pointer route keeps the transform it was given at touch-down, so a local
/// position is only true of the frame it was captured in — the slide at the
/// edges below, or a second finger panning the page, is enough to make one
/// wrong.
class ReaderSelectionDrag {
  ReaderSelectionDrag({required this.controller, required this.onChanged});

  final PdfViewerController controller;

  /// Called when a press is claimed and when it is let go of — the two moments
  /// the reader's own chrome has to reconsider itself.
  final VoidCallback onChanged;

  /// One [PdfPageText] per page, because extracting it is a full character walk
  /// through PDFium and this runs on every move. The viewer keeps a cache of
  /// its own but will not share it, so the anchor page's copy is taken from the
  /// selection pdfrx just made and the rest are loaded here.
  final _textByPage = <int, PdfPageText>{};
  final _loading = <int, Future<void>>{};

  /// How many pages' text to keep.
  ///
  /// A page's worth is a rectangle per character — six figures of them in a
  /// book — so keeping every page ever selected on is the one thing in the
  /// reader that would grow with how much of the book had been read. A drag
  /// only ever reaches across a handful of pages, and the anchor page's copy
  /// costs nothing anyway.
  static const _maxCachedPages = 8;

  /// Set for as long as a press is held, whether or not it found any text.
  ///
  /// The reader reads this to know that a finger on the page is busy, so that
  /// letting go of a long press does not also count as the tap that hides the
  /// bars.
  bool _claimed = false;

  /// Identifies the press in flight.
  ///
  /// Picking the first word is two awaits long, and a reader who lifts and
  /// presses again inside that window has [_claimed] set back to true — so the
  /// first press's continuation would otherwise land its anchor on top of the
  /// second's.
  int _gesture = 0;

  ReaderTextHit? _anchorStart;
  ReaderTextHit? _anchorEnd;
  ({ReaderTextHit start, ReaderTextHit end})? _applied;

  /// Where the finger is, so the book can keep sliding under one that has
  /// stopped moving because it has run out of screen.
  Offset? _finger;
  Timer? _autoScroll;
  double _autoScrollSpeed = 0;

  /// The last place the finger reached before the anchor was ready.
  ///
  /// Picking the first word is asynchronous, and a quick reader is already
  /// dragging by the time it lands. Without this those first moves are simply
  /// lost and the selection starts a few words late.
  Offset? _pending;

  bool get active => _claimed;

  PdfTextSelectionDelegate? get _delegate =>
      controller.isReady ? controller.textSelectionDelegate : null;

  /// Forgets every page's text.
  ///
  /// Called when a new document is opened: a [PdfTextSelectionPoint] carries the
  /// page text its index is measured against, and handing the viewer one from
  /// the book it used to be showing indexes into the wrong character list.
  void reset() {
    _stopAutoScroll();
    _gesture++;
    _textByPage.clear();
    _loading.clear();
    _claimed = false;
    _anchorStart = _anchorEnd = null;
    _applied = null;
    _pending = null;
    _finger = null;
  }

  static const _autoScrollTick = Duration(milliseconds: 16);

  /// Takes the word under the finger and holds on to it as the anchor.
  Future<void> begin(Offset globalPosition) async {
    _claimed = true;
    final gesture = ++_gesture;
    _anchorStart = _anchorEnd = null;
    _applied = null;
    _pending = null;
    // Tells the reader to put its action bar away: a passage still being chosen
    // is not one there is anything to do with yet.
    onChanged();

    // Read before anything is asked of the controller: every one of its
    // accessors goes through a state it does not have until the document is
    // open, and reaching one before then throws out of a gesture callback.
    final delegate = _delegate;
    if (delegate == null) {
      return;
    }
    final point = controller.globalToDocument(globalPosition);
    if (point == null) {
      return;
    }
    // A fling still settling writes the matrix every frame, and would pull the
    // word out from under the finger that just chose it. Putting a finger down
    // does not stop one on its own: the viewer's own pan only takes over once
    // the finger moves, which is exactly what this press has not done.
    controller.stopInteractiveViewerAnimation();
    // Cleared first so a press that lands in a gap between words anchors to
    // nothing rather than silently adopting whatever was selected before.
    await delegate.clearTextSelection();
    await delegate.selectWord(point);
    var range = delegate.textSelectionPointRange;
    if (range == null && _gesture == gesture) {
      // pdfrx only takes a word whose box the point is genuinely inside, and a
      // finger is wider than the space between two lines of type. A press that
      // lands just under a line, or just past the last word on one, is looked up
      // again within `readerCharIndexAt`'s margin rather than being treated as a
      // press on nothing. The margin and nothing more: this deliberately does
      // not take `readerDragCharIndexAt`'s reach for a whole line, because a
      // press is the one gesture that still has to be able to come back with
      // nothing. Every numbered sheet prints its own "Page n" footer, so a
      // reach that never declines would turn a long press on a picture into a
      // selection of the page number underneath it.
      await _anchorNear(delegate, point);
      range = delegate.textSelectionPointRange;
    }
    if (range == null || _gesture != gesture || !_claimed) {
      return;
    }
    final text = range.start.text;
    _rememberText(text);
    // A run of spaces is a word to pdfrx, and a passage of nothing but
    // whitespace is one the reader drops on the floor — it collapses to an
    // empty string and no action bar opens at all. So a press that took one
    // moves to the word beside it and the viewer is told.
    final word = readerAnchorWordAt(text, range.start.index);
    if (word == null) {
      return;
    }
    _anchorStart = ReaderTextHit(text.pageNumber, word.start);
    _anchorEnd = ReaderTextHit(text.pageNumber, word.end);
    // What the viewer is already showing, so a finger that has not left the
    // word it pressed does not set the same range again — and, more to the
    // point, does not tick a second time on top of the press.
    _applied = (start: _anchorStart!, end: _anchorEnd!);
    AppHaptics.longPress();
    if (word.start != range.start.index || word.end != range.end.index) {
      await delegate.setTextSelectionPointRange(
        PdfTextSelectionRange.fromPoints(
          PdfTextSelectionPoint(text, word.start),
          PdfTextSelectionPoint(text, word.end),
        ),
      );
    }

    final pending = _pending;
    _pending = null;
    if (pending != null && _gesture == gesture) {
      await extendTo(pending);
    }
  }

  /// Takes the selection out to the word under the finger.
  Future<void> extendTo(Offset globalPosition) async {
    if (!_claimed) {
      return;
    }
    _finger = globalPosition;
    final anchorStart = _anchorStart;
    final anchorEnd = _anchorEnd;
    if (anchorStart == null || anchorEnd == null) {
      // Either the press is still picking its word, or it landed somewhere with
      // no words at all. Nothing to extend, and nothing worth moving the book
      // for: a press on an illustration must not turn into a scroll.
      _pending = globalPosition;
      return;
    }
    // Before the hit test rather than after it: a finger parked below the last
    // line on screen resolves to nothing, and that is exactly the finger the
    // book has to start moving under.
    _syncAutoScroll(globalPosition);
    final delegate = _delegate;
    if (delegate == null) {
      return;
    }
    final point = controller.globalToDocument(globalPosition);
    if (point == null) {
      return;
    }
    final hit = _hitAt(point);
    // A page whose text has not been read yet; a page carrying no text at all,
    // which is the cover — one image, and `@page pdf-cover` prints no footer
    // under it; a point on no sheet at all, which `readerDocumentPointIsOnPage`
    // names as the gap between two pages, the paper clearing the bars at either
    // end, and the side gutter of a mixed-size book; or a finger too far from
    // every line to be reaching for one — the middle of a full-page
    // illustration, where the only text on the sheet is the footer a couple of
    // hundred points below. Standing still is the right answer to all four: the
    // selection keeps whatever it last reached rather than snapping somewhere
    // arbitrary. It is kept rather than dropped because the first case answers
    // itself a moment later, and a reader who crossed onto a new page and
    // stopped there would otherwise be left holding half a passage.
    if (hit == null) {
      _pending = globalPosition;
      return;
    }
    final text = _textByPage[hit.pageNumber];
    final word = text == null ? null : readerWordAt(text, hit.index);
    if (word == null) {
      return;
    }
    final selection = readerDragSelection(
      anchorStart: anchorStart,
      anchorEnd: anchorEnd,
      movingStart: ReaderTextHit(hit.pageNumber, word.start),
      movingEnd: ReaderTextHit(hit.pageNumber, word.end),
    );
    if (selection == _applied) {
      return;
    }
    final start = _selectionPoint(selection.start);
    final end = _selectionPoint(selection.end);
    // The viewer indexes straight into the page's character list without
    // checking, and it does it during its own build — so an index that has gone
    // out of range takes the whole reader down rather than this gesture.
    if (start == null || end == null || !start.isValid || !end.isValid) {
      return;
    }
    _applied = selection;
    // One tick per word taken, the way every other text selection on the device
    // reports the same thing.
    AppHaptics.selection();
    await delegate.setTextSelectionPointRange(
      PdfTextSelectionRange.fromPoints(start, end),
    );
  }

  /// Where the finger dragging a selection *handle* has reached.
  ///
  /// Seeded from the handle's own position in [onHandlePanStart] and moved
  /// only by [onHandlePanUpdate]'s deltas — never from pdfrx's own
  /// resolution of where the handle landed, which is what lets this keep up
  /// once that resolution gets stuck.
  Offset? _handlePanPoint;

  /// pdfrx drives its own selection handles entirely — see the class doc
  /// above for why this file cannot reach inside that — but
  /// [PdfTextSelectionParams] hands back a notification on every frame of a
  /// handle drag regardless of whether pdfrx's own hit test actually moved
  /// the handle. That hit test is the same tight, unwidened margin
  /// [readerCharIndexAt] used to stop at before its own fix: a short line, or
  /// the ordinary gap between two lines, leaves a dragged handle stuck
  /// exactly the way the long-press drag used to. These three methods are
  /// the other half of that fix reaching it — tracking the finger's own path
  /// independently of pdfrx's resolution and correcting the selection on top
  /// of whatever pdfrx already applied, through the same
  /// [PdfTextSelectionDelegate] the long-press drag uses. The two agree
  /// whenever pdfrx's own resolution already succeeded, so this only ever
  /// changes anything in the case that used to freeze.
  void onHandlePanStart(PdfTextSelectionAnchor anchor) {
    _handlePanPoint = anchor.rect.center;
    // The starting page's text is what pdfrx just handed over — free to
    // remember rather than reload the moment a move reaches past its edge.
    _rememberText(anchor.page);
  }

  void onHandlePanUpdate(PdfTextSelectionAnchor anchor, Offset delta) {
    if (!controller.isReady) {
      return;
    }
    final zoom = controller.currentZoom;
    if (zoom == 0) {
      return;
    }
    final point = (_handlePanPoint ?? anchor.rect.center) + delta / zoom;
    _handlePanPoint = point;
    unawaited(_correctHandle(anchor, point));
  }

  void onHandlePanEnd(PdfTextSelectionAnchor anchor) {
    _handlePanPoint = null;
  }

  /// Resolves [documentPoint] the same way a long-press drag would and, when
  /// that lands somewhere other than where pdfrx's own hit test already put
  /// [anchor], moves the selection there instead — keeping the other end of
  /// the range exactly where it was.
  Future<void> _correctHandle(
    PdfTextSelectionAnchor anchor,
    Offset documentPoint,
  ) async {
    final delegate = _delegate;
    if (delegate == null) {
      return;
    }
    final hit = _hitAt(documentPoint);
    if (hit == null ||
        (hit.pageNumber == anchor.page.pageNumber &&
            hit.index == anchor.index)) {
      // Nowhere to resolve to, or pdfrx's own hit test already reached the
      // same character: nothing to correct.
      return;
    }
    final moving = _selectionPoint(hit);
    if (moving == null || !moving.isValid) {
      return;
    }
    final range = delegate.textSelectionPointRange;
    if (range == null) {
      return;
    }
    // Whichever end of the current range already matches this anchor is the
    // one being dragged; [PdfTextSelectionRange.fromPoints] sorts the pair
    // back into start/end, so which is passed as which here does not matter.
    final draggingStart =
        range.start.text.pageNumber == anchor.page.pageNumber &&
        range.start.index == anchor.index;
    final other = draggingStart ? range.end : range.start;
    AppHaptics.selection();
    await delegate.setTextSelectionPointRange(
      PdfTextSelectionRange.fromPoints(moving, other),
    );
  }

  /// Lets go. The selection stays; only the gesture ends.
  void end() {
    _stopAutoScroll();
    if (!_claimed) {
      return;
    }
    _claimed = false;
    _anchorStart = _anchorEnd = null;
    _applied = null;
    _pending = null;
    _finger = null;
    onChanged();
    // The action bar is built from the viewer's own context-menu slot, which is
    // suppressed for as long as the finger is down. Nothing rebuilt the viewer
    // when that stopped being true, so ask for the frame that finally shows it.
    if (controller.isReady) {
      controller.invalidate();
    }
  }

  /// Starts, retunes or stops the slide, from where the finger is now.
  void _syncAutoScroll(Offset globalPosition) {
    final local = controller.isReady
        ? controller.globalToLocal(globalPosition)
        : null;
    _autoScrollSpeed = local == null
        ? 0
        : readerSelectionAutoScroll(local.dy, controller.viewSize.height);
    if (_autoScrollSpeed == 0) {
      _stopAutoScroll();
      return;
    }
    if (_autoScroll != null) {
      return;
    }
    // A fling still settling writes the same matrix every frame and would
    // simply undo each nudge.
    controller.stopInteractiveViewerAnimation();
    _autoScroll = Timer.periodic(_autoScrollTick, (_) => _autoScrollStep());
  }

  void _stopAutoScroll() {
    _autoScroll?.cancel();
    _autoScroll = null;
    _autoScrollSpeed = 0;
  }

  void _autoScrollStep() {
    final finger = _finger;
    if (!_claimed ||
        finger == null ||
        _autoScrollSpeed == 0 ||
        !controller.isReady) {
      _stopAutoScroll();
      return;
    }
    final pixels = _autoScrollSpeed * _autoScrollTick.inMilliseconds / 1000;
    final before = controller.value.clone();
    // The book moves in document units and the band was measured in screen
    // ones, so the nudge is divided by the zoom — a page held close still slides
    // past the finger at the same speed it appears to.
    controller.value = controller.value.clone()
      ..translateByDouble(0, -pixels / controller.currentZoom, 0, 1);
    if (controller.value == before) {
      // The end of the book. The matrix clamped back to where it was, so there
      // is nothing left to reach and the ticker would spin for the rest of the
      // gesture.
      _stopAutoScroll();
      return;
    }
    // The finger has not moved; the words under it have.
    unawaited(extendTo(finger));
  }

  /// Asks the viewer for the word nearest [documentPoint] rather than the one
  /// under it.
  ///
  /// Goes back through [PdfTextSelectionDelegate.selectWord] with a point that
  /// is certainly inside a word, so the anchor is picked the same way and by the
  /// same code as every other press — the alternative is a second notion of
  /// what a word is, disagreeing with pdfrx's on exactly the presses that were
  /// already awkward.
  Future<void> _anchorNear(
    PdfTextSelectionDelegate delegate,
    Offset documentPoint,
  ) async {
    final pages = controller.pages;
    final layouts = controller.layout.pageLayouts;
    for (var i = 0; i < pages.length && i < layouts.length; i++) {
      final rect = layouts[i];
      if (!rect.contains(documentPoint)) {
        continue;
      }
      final page = pages[i];
      final text = await _loadedText(page);
      if (text == null || !_claimed) {
        return;
      }
      final index = readerCharIndexAt(
        text,
        (documentPoint - rect.topLeft).toPdfPoint(
          page: page,
          scaledPageSize: rect.size,
        ),
      );
      if (index == null) {
        return;
      }
      await delegate.selectWord(
        text.charRects[index].center.toOffsetInDocument(
          page: page,
          pageRect: rect,
        ),
      );
      return;
    }
  }

  ReaderTextHit? _hitAt(Offset documentPoint) {
    final pages = controller.pages;
    final layouts = controller.layout.pageLayouts;
    for (var i = 0; i < pages.length && i < layouts.length; i++) {
      final rect = layouts[i];
      if (!rect.contains(documentPoint)) {
        continue;
      }
      final page = pages[i];
      final text = _textFor(page);
      if (text == null) {
        return null;
      }
      // The drag's own lookup, not the press's: a finger that has run off the
      // end of a short line is still asking for that line, and a press in the
      // same place is asking for nothing.
      final index = readerDragCharIndexAt(
        text,
        (documentPoint - rect.topLeft).toPdfPoint(
          page: page,
          scaledPageSize: rect.size,
        ),
      );
      return index == null ? null : ReaderTextHit(page.pageNumber, index);
    }
    return null;
  }

  PdfTextSelectionPoint? _selectionPoint(ReaderTextHit hit) {
    final text = _textByPage[hit.pageNumber];
    return text == null ? null : PdfTextSelectionPoint(text, hit.index);
  }

  /// This page's text if it has been read, and a request for it if not.
  ///
  /// Reading it crosses to PDFium and takes a beat, so the move that asked for
  /// it goes unanswered and the next one — a frame or two later, still mid-drag
  /// — has it. That is the same deal the viewer gives its own paint pass.
  PdfPageText? _textFor(PdfPage page) {
    final cached = _textByPage[page.pageNumber];
    if (cached != null) {
      return cached;
    }
    unawaited(_loadText(page));
    return null;
  }

  /// This page's text, waiting for it if it is not read yet.
  Future<PdfPageText?> _loadedText(PdfPage page) async {
    await _loadText(page);
    return _textByPage[page.pageNumber];
  }

  /// One read per page, shared by everyone who asks while it is in flight —
  /// otherwise a press and the move that follows it each start their own walk
  /// through the same few thousand characters.
  Future<void> _loadText(PdfPage page) {
    return _loading[page.pageNumber] ??= _readText(page);
  }

  /// Keeps [text], evicting the page read longest ago once there are too many.
  ///
  /// A plain map is insertion-ordered, so re-remembering a page has to take it
  /// out first or the page being dragged over right now could be the one thrown
  /// away.
  void _rememberText(PdfPageText text) {
    _textByPage.remove(text.pageNumber);
    _textByPage[text.pageNumber] = text;
    while (_textByPage.length > _maxCachedPages) {
      _textByPage.remove(_textByPage.keys.first);
    }
  }

  Future<void> _readText(PdfPage page) async {
    try {
      _rememberText(await page.loadStructuredText());
    } catch (_) {
      // A page whose text cannot be extracted simply cannot be selected on.
      // Nothing is failed for it: the drag stops at the last page that could.
    } finally {
      _loading.remove(page.pageNumber);
    }
    // The move that asked for this page went unanswered. Answer it now rather
    // than wait for a finger that may well have stopped where it is.
    final pending = _pending;
    if (pending != null && _claimed) {
      _pending = null;
      unawaited(extendTo(pending));
    }
  }
}

/// Puts [ReaderSelectionDrag] over the viewer.
///
/// Built by `viewerOverlayBuilder`, which lays this out as a sibling of the
/// viewer's own scrolling body rather than inside it. That placement is the
/// whole reason the gesture can be taken at all: a `Stack` hit-tests its
/// children top down, so a recognizer here joins the arena before pdfrx's own
/// long press and before the pan, and winning at the deadline rejects both. It
/// still sits *below* the selection handles, which pdfrx stacks last, so
/// dragging one of those is unaffected.
///
/// Deliberately not a page overlay, which is where the reader's other page
/// layers live. Page overlays are built only for the pages inside the viewer's
/// cache extent and are dropped from the tree the moment a page leaves it —
/// which auto-scroll makes happen mid-gesture. A [LongPressGestureRecognizer]
/// disposed after it has been accepted reports *nothing*: not an end, not a
/// cancel, because `resolve(rejected)` takes the `_longPressAccepted` branch
/// and only resets. The press would stay claimed for the rest of the session,
/// with the book still sliding.
class ReaderSelectionDragLayer extends StatefulWidget {
  const ReaderSelectionDragLayer({
    required this.drag,
    required this.size,
    super.key,
  });

  final ReaderSelectionDrag drag;

  /// The viewer's own size, which is the box this has to cover.
  final Size size;

  @override
  State<ReaderSelectionDragLayer> createState() =>
      _ReaderSelectionDragLayerState();
}

class _ReaderSelectionDragLayerState extends State<ReaderSelectionDragLayer> {
  @override
  void dispose() {
    // The other half of the same problem: leaving the reader, or picking up a
    // pen, takes this layer away mid-press and the recognizer says nothing on
    // its way out.
    widget.drag.end();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RawGestureDetector(
      // Translucent, over a box that reports no hit of its own — the shape
      // pdfrx documents for a gesture detector in this slot. The layer has to
      // *join* the hit test rather than win it: a `Stack` stops at the first
      // child that claims a hit, so an opaque layer here would take the viewer's
      // whole subtree out of the path and with it panning, pinch zoom, link taps
      // and the ink layer.
      behavior: HitTestBehavior.translucent,
      gestures: {
        LongPressGestureRecognizer:
            GestureRecognizerFactoryWithHandlers<LongPressGestureRecognizer>(
              () => LongPressGestureRecognizer(
                duration: readerSelectionLongPressDuration,
                // A mouse keeps pdfrx's own click-and-drag selection, which is
                // already the native gesture there.
                supportedDevices: const {
                  PointerDeviceKind.touch,
                  PointerDeviceKind.stylus,
                },
              ),
              (recognizer) {
                final drag = widget.drag;
                recognizer.onLongPressStart = (details) {
                  unawaited(drag.begin(details.globalPosition));
                };
                recognizer.onLongPressMoveUpdate = (details) {
                  unawaited(drag.extendTo(details.globalPosition));
                };
                recognizer.onLongPressEnd = (_) => drag.end();
                // Fires instead of `onLongPressEnd` when the pointer is
                // cancelled, and before anything started when the press lost to
                // a pan. Ending twice is a no-op, so both go to the same place.
                recognizer.onLongPressCancel = drag.end;
              },
            ),
      },
      child: IgnorePointer(child: SizedBox.fromSize(size: widget.size)),
    );
  }
}
