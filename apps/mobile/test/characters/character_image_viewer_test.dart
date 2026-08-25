import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/presentation/character_image_viewer.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'character_test_support.dart';

/// The fullscreen picture viewer: a pager of pictures, each of which zooms.
///
/// Three gestures share one surface — swipe, pinch and swipe-down-to-dismiss —
/// and the viewer decides between them itself rather than letting three
/// recognizers race. These are the cases that race went wrong on, so they are
/// driven finger by finger: a `tester.drag` lands its whole travel in one event
/// and would never reproduce a second finger arriving mid-gesture.
void main() {
  Future<void> pumpViewer(
    WidgetTester tester, {
    int count = 3,
    TextDirection direction = TextDirection.ltr,
  }) async {
    final images = [for (var i = 0; i < count; i++) testImage(id: 'img-$i')];
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiAuthHeadersProvider.overrideWith(
            (ref) async => const <String, String>{},
          ),
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository(testCharacter(), images: images),
          ),
        ],
        child: MaterialApp(
          builder: (context, child) =>
              Directionality(textDirection: direction, child: child!),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showCharacterImageViewer(
                  context: context,
                  images: images,
                  initialIndex: 0,
                  characterName: 'Mina Park',
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// The matrix the picture on screen is drawn with.
  Matrix4 shownMatrix(WidgetTester tester) {
    return tester
        .widgetList<Transform>(
          find.descendant(
            of: find.byType(InteractiveViewer).first,
            matching: find.byType(Transform),
          ),
        )
        .first
        .transform;
  }

  double shownScale(WidgetTester tester) =>
      shownMatrix(tester).getMaxScaleOnAxis();

  Offset shownTranslation(WidgetTester tester) {
    final translation = shownMatrix(tester).getTranslation();
    return Offset(translation.x, translation.y);
  }

  double shownPage(WidgetTester tester) =>
      tester.widget<PageView>(find.byType(PageView)).controller!.page!;

  Offset centre(WidgetTester tester) => tester.getCenter(find.byType(PageView));

  /// A finger travels this far between two pointer events.
  ///
  /// Real ones move in small steps, and the size of the step decides which
  /// recognizer claims the gesture: one that jumps a whole swipe in a single
  /// event clears every slop at once and hands it to whichever recognizer is
  /// deepest, which is not what a device does at all.
  const step = 6.0;

  List<Offset> stepsOf(Offset by) {
    if (by == Offset.zero) return List<Offset>.filled(8, Offset.zero);
    final count = (by.distance / step).ceil();
    return List<Offset>.filled(count, by / count.toDouble());
  }

  /// Moves [gesture] along [by], one pointer event per [interval], carrying on
  /// from [from] on the clock and answering with where it got to.
  ///
  /// Stamping the events is the point. Every `moveBy` defaults to
  /// `Duration.zero`, so a gesture built without timestamps reaches the
  /// velocity tracker as infinitely fast movement that it reports as no speed
  /// at all — and a swipe that flings on a device settles in the harness.
  Future<Duration> travel(
    WidgetTester tester,
    TestGesture gesture,
    Offset by, {
    Duration from = Duration.zero,
    Duration interval = const Duration(milliseconds: 16),
  }) async {
    var at = from;
    for (final delta in stepsOf(by)) {
      at += interval;
      await gesture.moveBy(delta, timeStamp: at);
      await tester.pump(interval);
    }
    return at;
  }

  /// One finger, moved a pointer event at a time. [stillFirst] lets the finger
  /// come to rest before it lifts, which is how a reader takes a swipe back.
  Future<void> swipe(
    WidgetTester tester,
    Offset by, {
    Duration interval = const Duration(milliseconds: 16),
    bool stillFirst = false,
  }) async {
    final gesture = await tester.startGesture(centre(tester));
    await tester.pump();
    var at = await travel(tester, gesture, by, interval: interval);
    if (stillFirst) {
      at = await travel(
        tester,
        gesture,
        Offset.zero,
        from: at,
        interval: interval,
      );
    }
    await gesture.up(timeStamp: at + interval);
    await tester.pumpAndSettle();
  }

  /// Two fingers spreading apart along [axis]. [drift] is how far the first
  /// finger travels before the second one lands — the thing that used to turn
  /// a pinch into a page swipe for the rest of the gesture.
  Future<void> pinchApart(
    WidgetTester tester, {
    required Offset axis,
    Offset drift = Offset.zero,
  }) async {
    const interval = Duration(milliseconds: 16);
    final from = centre(tester);
    var at = Duration.zero;
    final first = await tester.startGesture(from - axis);
    await tester.pump(interval);
    if (drift != Offset.zero) {
      at = await travel(tester, first, drift);
    }
    final second = await tester.startGesture(from + axis);
    await tester.pump(interval);
    for (final delta in stepsOf(axis * 3)) {
      at += interval;
      await first.moveBy(-delta, timeStamp: at);
      await second.moveBy(delta, timeStamp: at);
      await tester.pump(interval);
    }
    await first.up(timeStamp: at + interval);
    await second.up(timeStamp: at + interval);
    await tester.pumpAndSettle();
  }

  Future<void> doubleTapCentre(WidgetTester tester) async {
    await tester.tapAt(centre(tester));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tapAt(centre(tester));
    await tester.pumpAndSettle();
  }

  group('zooming', () {
    for (final (name, axis) in const [
      ('horizontally', Offset(40, 0)),
      ('vertically', Offset(0, 40)),
      ('diagonally', Offset(28, 28)),
    ]) {
      testWidgets('pinching apart $name zooms the picture in', (tester) async {
        await pumpViewer(tester);
        await pinchApart(tester, axis: axis);

        expect(shownScale(tester), greaterThan(1.2));
        expect(shownPage(tester), 0);
      });

      testWidgets('pinching apart $name zooms after the first finger drifts', (
        tester,
      ) async {
        await pumpViewer(tester);
        // Well past kTouchSlop, which is all it used to take: the page swipe
        // had already claimed the gesture before the second finger landed.
        await pinchApart(tester, axis: axis, drift: const Offset(24, 0));

        expect(shownScale(tester), greaterThan(1.2));
        expect(
          shownPage(tester),
          0,
          reason: 'the half-swiped page is handed back, not flung',
        );
      });
    }

    testWidgets('double tapping zooms in and back out', (tester) async {
      await pumpViewer(tester);

      await doubleTapCentre(tester);
      expect(shownScale(tester), greaterThan(1.2));

      await doubleTapCentre(tester);
      expect(shownScale(tester), 1);
    });
  });

  group('a zoomed picture', () {
    Future<void> pumpZoomed(WidgetTester tester) async {
      await pumpViewer(tester);
      await doubleTapCentre(tester);
      expect(shownScale(tester), greaterThan(1.2));
    }

    testWidgets('pans sideways instead of changing page', (tester) async {
      await pumpZoomed(tester);
      final before = shownTranslation(tester);

      await swipe(tester, const Offset(-120, 0));

      expect(shownPage(tester), 0);
      expect(shownTranslation(tester).dx, lessThan(before.dx - 20));
    });

    testWidgets('pans downwards instead of dismissing', (tester) async {
      await pumpZoomed(tester);
      final before = shownTranslation(tester);

      await swipe(tester, const Offset(0, 200));

      expect(find.byType(CharacterImageViewer), findsOneWidget);
      expect(shownTranslation(tester).dy, greaterThan(before.dy + 20));
    });
  });

  group('paging', () {
    testWidgets('a sideways swipe moves to the next picture', (tester) async {
      await pumpViewer(tester);
      expect(find.text('1 of 3'), findsOneWidget);

      await swipe(tester, const Offset(-500, 0));

      expect(shownPage(tester), 1);
      expect(find.text('2 of 3'), findsOneWidget);
    });

    testWidgets('a short swipe settles back on the same picture', (
      tester,
    ) async {
      await pumpViewer(tester);

      await swipe(tester, const Offset(-40, 0), stillFirst: true);

      expect(shownPage(tester), 0);
      expect(find.text('1 of 3'), findsOneWidget);
    });

    testWidgets('a quick flick carries on to the next picture', (tester) async {
      await pumpViewer(tester);

      // Barely an eighth of the way across, but fast: it is the speed that
      // decides, so this is the path the hand-built DragEndDetails is on.
      await swipe(
        tester,
        const Offset(-100, 0),
        interval: const Duration(milliseconds: 8),
      );

      expect(shownPage(tester), 1);
      expect(find.text('2 of 3'), findsOneWidget);
    });

    testWidgets('a snap already running is caught by a finger', (tester) async {
      await pumpViewer(tester);
      final position = tester
          .widget<PageView>(find.byType(PageView))
          .controller!
          .position;

      // Flick towards the next picture, then let the snap get under way.
      final flick = await tester.startGesture(centre(tester));
      await tester.pump();
      final at = await travel(
        tester,
        flick,
        const Offset(-100, 0),
        interval: const Duration(milliseconds: 8),
      );
      await flick.up(timeStamp: at + const Duration(milliseconds: 8));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        position.pixels,
        inExclusiveRange(0, 400),
        reason: 'on its way to the next picture, not there yet',
      );

      // A finger landing on it stops it dead, before it has claimed anything.
      final caught = await tester.startGesture(centre(tester));
      await tester.pump(const Duration(milliseconds: 16));
      final held = position.pixels;
      await tester.pump(const Duration(milliseconds: 300));
      expect(position.pixels, held, reason: 'the finger stopped the snap');

      // And it is the reader's again: the picture follows the finger.
      var back = await travel(tester, caught, const Offset(-60, 0));
      expect(
        position.pixels,
        greaterThan(held + 20),
        reason: 'the caught picture moves with the finger',
      );

      back = await travel(tester, caught, const Offset(180, 0), from: back);
      back = await travel(tester, caught, Offset.zero, from: back);
      await caught.up(timeStamp: back + const Duration(milliseconds: 16));
      await tester.pumpAndSettle();

      expect(shownPage(tester), 0);
      expect(find.text('1 of 3'), findsOneWidget);
    });

    testWidgets('a moving picture can be pinched', (tester) async {
      // Same reason the caught snap has to move: a finger that lands while the
      // pager is animating is hit-tested against a viewport that is ignoring
      // pointers, so anything inside the pager never hears the gesture at all.
      await pumpViewer(tester);
      final position = tester
          .widget<PageView>(find.byType(PageView))
          .controller!
          .position;

      final flick = await tester.startGesture(centre(tester));
      await tester.pump();
      final at = await travel(
        tester,
        flick,
        const Offset(-100, 0),
        interval: const Duration(milliseconds: 8),
      );
      await flick.up(timeStamp: at + const Duration(milliseconds: 8));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(position.pixels, inExclusiveRange(0, 400));

      await pinchApart(tester, axis: const Offset(40, 0));

      expect(shownScale(tester), greaterThan(1.2));
    });

    testWidgets('a tap on a moving picture settles it where it is', (
      tester,
    ) async {
      await pumpViewer(tester);
      final position = tester
          .widget<PageView>(find.byType(PageView))
          .controller!
          .position;

      final flick = await tester.startGesture(centre(tester));
      await tester.pump();
      final at = await travel(
        tester,
        flick,
        const Offset(-100, 0),
        interval: const Duration(milliseconds: 8),
      );
      await flick.up(timeStamp: at + const Duration(milliseconds: 8));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(position.pixels, inExclusiveRange(0, 400));

      await tester.tapAt(centre(tester));
      await tester.pumpAndSettle();

      // Caught before halfway, so it settles back rather than carrying on.
      // (The tap itself hides the chrome, so the counter is not the witness.)
      expect(position.pixels, 0);
      expect(shownPage(tester), 0);
    });

    testWidgets('a right-to-left reader swipes the other way', (tester) async {
      // The pager is driven by hand now, so the direction it reads a finger in
      // is this viewer's to get right rather than the framework's.
      await pumpViewer(tester, direction: TextDirection.rtl);

      await swipe(tester, const Offset(500, 0));

      expect(shownPage(tester), 1);
      expect(find.text('2 of 3'), findsOneWidget);
    });

    testWidgets('the first picture cannot be swiped backwards past', (
      tester,
    ) async {
      await pumpViewer(tester);

      await swipe(tester, const Offset(500, 0));

      expect(shownPage(tester), 0);
    });
  });

  group('dismissing', () {
    testWidgets('a long drag down closes the viewer', (tester) async {
      await pumpViewer(tester);

      await swipe(tester, const Offset(0, 260));

      expect(find.byType(CharacterImageViewer), findsNothing);
    });

    testWidgets('a short drag down does not', (tester) async {
      await pumpViewer(tester);
      final before = centre(tester);

      await swipe(tester, const Offset(0, 60), stillFirst: true);

      expect(find.byType(CharacterImageViewer), findsOneWidget);
      expect(centre(tester), before, reason: 'snapped back, not left hanging');
    });

    testWidgets('a second finger unwinds a drag that had started', (
      tester,
    ) async {
      await pumpViewer(tester);
      final gesture = await tester.startGesture(centre(tester));
      await tester.pump();
      var at = await travel(tester, gesture, const Offset(0, 160));
      final second = await tester.startGesture(
        centre(tester) + const Offset(60, 0),
      );
      await tester.pump(const Duration(milliseconds: 16));
      for (final delta in stepsOf(const Offset(60, 0))) {
        at += const Duration(milliseconds: 16);
        await gesture.moveBy(-delta, timeStamp: at);
        await second.moveBy(delta, timeStamp: at);
        await tester.pump(const Duration(milliseconds: 16));
      }
      await gesture.up(timeStamp: at);
      await second.up(timeStamp: at);
      await tester.pumpAndSettle();

      expect(find.byType(CharacterImageViewer), findsOneWidget);
    });
  });

  testWidgets('a single tap hides the chrome and shows it again', (
    tester,
  ) async {
    await pumpViewer(tester);
    expect(find.text('1 of 3'), findsOneWidget);

    // A lone tap waits out the double-tap window before it counts.
    await tester.tapAt(centre(tester));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(find.text('1 of 3'), findsNothing);

    await tester.tapAt(centre(tester));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(find.text('1 of 3'), findsOneWidget);
  });
}
