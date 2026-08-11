import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';

import 'audiobook_fakes.dart';

void main() {
  late Directory tempDir;
  late FakeAudiobookPlayer player;
  late FakeAudiobookRepository repository;
  late FakeAudiobookCache cache;
  late FakeAudiobookProgressStore progress;
  ProviderContainer? activeContainer;

  /// Disposes the container inside the test body. A narration that is still
  /// being made leaves a polling timer running, and the widget-test framework
  /// checks for pending timers before `addTearDown` callbacks run.
  void disposeActive() {
    activeContainer?.dispose();
    activeContainer = null;
  }

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-audiobook-test');
    player = FakeAudiobookPlayer();
    repository = FakeAudiobookRepository(audiobook: audiobookWith());
    cache = FakeAudiobookCache(tempDir)
      ..timelinesByChapter[1] = timelineFixture();
    progress = FakeAudiobookProgressStore();
  });

  tearDown(() {
    disposeActive();
    tempDir.deleteSync(recursive: true);
  });

  Future<ProviderContainer> pumpScreen(WidgetTester tester) async {
    final container = audiobookContainer(
      repository: repository,
      cache: cache,
      player: player,
      progress: progress,
    );
    activeContainer = container;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: AudiobookScreen(projectId: 'project-1')),
      ),
    );
    await settle(tester);
    return container;
  }

  testWidgets('offers to narrate a book that has none', (tester) async {
    repository.audiobook = null;
    await pumpScreen(tester);

    expect(find.text('Hear your book read aloud'), findsOneWidget);
    expect(find.text('Choose a narrator'), findsOneWidget);
  });

  testWidgets('a narration that cannot start says why', (tester) async {
    repository.audiobook = null;
    repository.startError = const ApiException(
      code: 'BOOK_NOT_READY',
      message: 'Finish the book before narrating it.',
      statusCode: 409,
    );
    await pumpScreen(tester);

    await tester.tap(find.text('Choose a narrator'));
    await settle(tester);
    await tester.tap(find.text('Zephyr').first);
    await settle(tester);
    await tester.tap(find.text('Start narrating'));
    await settle(tester);

    // The picker stays up with its button back on offer, and the reason is
    // said out loud — a silent return to "Start narrating" reads as the button
    // being broken.
    expect(find.text('Finish the book before narrating it.'), findsOneWidget);
    expect(find.text('Start narrating'), findsOneWidget);
  });

  testWidgets('a narration that cannot be loaded does not offer to sell one', (
    tester,
  ) async {
    repository.audiobook = null;
    repository.fetchError = const ApiException(
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      statusCode: 500,
    );
    await pumpScreen(tester);

    expect(find.text('Narration unavailable'), findsOneWidget);
    expect(find.text('Hear your book read aloud'), findsNothing);

    // And the error is not a dead end: once the server answers again the screen
    // finds its way back to the picker.
    repository.fetchError = null;
    await tester.tap(find.text('Try again'));
    await settle(tester);

    expect(find.text('Choose a narrator'), findsOneWidget);
  });

  testWidgets('a load that fails outside the API still lands on the error '
      'state instead of spinning forever', (tester) async {
    repository.audiobook = null;
    // The shape of a decode error: not an ApiException, and the only catch
    // used to be one.
    repository.fetchError = TypeError();
    await pumpScreen(tester);

    expect(find.text('Narration unavailable'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    repository.fetchError = null;
    await tester.tap(find.text('Try again'));
    await settle(tester);

    expect(find.text('Choose a narrator'), findsOneWidget);
  });

  testWidgets('a failed chapter download on a finished narration offers a '
      'retry rather than preparing forever', (tester) async {
    cache.audioError = Exception('disk full');
    await pumpScreen(tester);

    // The narration is settled, so nothing polls: without this error state the
    // screen would say "warming up" with no way to run the download again.
    expect(find.text('Zephyr is warming up'), findsNothing);
    expect(find.text('Download interrupted'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await settle(tester);

    expect(player.tracks, hasLength(1));
    expect(
      find.textContaining('She waited.', findRichText: true),
      findsOneWidget,
    );
  });

  testWidgets('downloads the finished chapter and shows its transcript', (
    tester,
  ) async {
    await pumpScreen(tester);

    expect(player.tracks, hasLength(1));
    expect(
      find.textContaining('She waited.', findRichText: true),
      findsOneWidget,
    );
    expect(find.text('Narrated by Zephyr'), findsOneWidget);
  });

  testWidgets('play and pause drive the player', (tester) async {
    await pumpScreen(tester);

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    expect(player.playing, isTrue);

    await tester.tap(find.byIcon(Icons.pause_rounded));
    await settle(tester);
    expect(player.playing, isFalse);
  });

  testWidgets('the button follows the sound back from the end of the queue', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    final container = await pumpScreen(tester);
    final controller = container.read(
      audiobookControllerProvider('project-1').notifier,
    );

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);

    // Seeking past what has been narrated lands on the last millisecond that
    // exists, so the queue runs out and playback stops.
    await controller.seekGlobal(15000);
    player.emitCompleted();
    await settle(tester);
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
    expect(find.text('waiting for the next chapter'), findsOneWidget);

    // Back into narrated audio the player resumes on its own — play was never
    // released — and the button has to notice.
    await controller.seekGlobal(2000);
    await settle(tester);
    expect(player.playing, isTrue);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
    disposeActive();
  });

  testWidgets('play carries on into a chapter that landed while waiting', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    final container = await pumpScreen(tester);
    final controller = container.read(
      audiobookControllerProvider('project-1').notifier,
    );

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    player.emitCompleted();
    await settle(tester);

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    cache.timelinesByChapter[2] = const AudiobookChapterTimeline(
      chapterIndex: 2,
      title: 'High Tide',
      isRightToLeft: false,
      durationMs: 9000,
      segments: [
        AudiobookSegment(
          index: 0,
          isTitle: true,
          paragraph: 0,
          pageIndex: 2,
          startMs: 0,
          endMs: 2000,
          text: 'Chapter 2. High Tide',
        ),
      ],
    );
    await controller.retry();
    await settle(tester);
    expect(player.tracks, hasLength(2));

    // Playing from where the queue stopped would be silence, so Play means the
    // chapter that has since arrived.
    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);

    expect(player.seeks.last.index, 1);
    expect(player.playing, isTrue);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
  });

  testWidgets('skipping back asks the player to move by fifteen seconds', (
    tester,
  ) async {
    await pumpScreen(tester);
    player.emitPosition(const Duration(seconds: 8), index: 0);
    await settle(tester);

    // Two skip buttons share the replay glyph; the first is "back".
    await tester.tap(find.byIcon(Icons.replay).first);
    await settle(tester);

    expect(player.seeks.last.position.inMilliseconds, lessThan(8000));
  });

  testWidgets('changing the speed reaches the player', (tester) async {
    await pumpScreen(tester);

    await tester.tap(find.text('1x'));
    await settle(tester);
    await tester.tap(find.text('1.5x').last);
    await settle(tester);

    expect(player.speeds.last, 1.5);
  });

  testWidgets('shows a preparing state until the first chapter lands', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      backupNarrationUsed: true,
      chapters: const [
        MobileAudiobookChapter(
          index: 1,
          title: 'Low Tide',
          status: AudiobookChapterStatus.pending,
          durationMs: null,
          estimatedDurationMs: 9000,
          byteSize: null,
          segmentCount: null,
          audioUrl: null,
          timelineUrl: null,
        ),
      ],
    );
    await pumpScreen(tester);

    expect(find.text('Zephyr is warming up'), findsOneWidget);
    expect(find.text('Generated with backup narration'), findsOneWidget);
    expect(player.tracks, isEmpty);
    disposeActive();
  });

  testWidgets('shows the backup narration note during playback', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(backupNarrationUsed: true);
    await pumpScreen(tester);

    expect(find.text('Generated with backup narration'), findsOneWidget);
  });

  testWidgets('a failed narration says the credits came back', (tester) async {
    repository.audiobook = MobileAudiobook(
      id: 'audiobook-1',
      projectId: 'project-1',
      status: AudiobookStatus.failed,
      voice: 'Zephyr',
      narratorName: 'Zephyr',
      isStale: false,
      totalDurationMs: null,
      totalEstimatedDurationMs: null,
      failureMessage:
          'Narration stopped before it finished. Your credits were refunded.',
      progress: null,
      chapters: const [],
    );
    await pumpScreen(tester);

    expect(find.textContaining('refunded'), findsOneWidget);
  });

  testWidgets('returns to the line being read after a jump across the book', (
    tester,
  ) async {
    cache.timelinesByChapter[1] = longTimelineFixture();
    await pumpScreen(tester);

    // Scrolling away by hand is what puts the button on screen: following only
    // stops when the reader takes over.
    await tester.drag(find.byType(ListView), const Offset(0, -240));
    await settle(tester);
    expect(find.byIcon(Icons.vertical_align_center), findsOneWidget);

    // Now the audio moves somewhere else entirely. The sentence being spoken is
    // thousands of pixels down a list that has never built that far, so it is
    // not in the tree at all.
    player.emitPosition(const Duration(milliseconds: 55400), index: 0);
    await settle(tester);
    expect(
      find.textContaining('Sentence 55.', findRichText: true),
      findsNothing,
    );

    await tester.tap(find.byIcon(Icons.vertical_align_center));
    await settle(tester);

    expect(
      find.textContaining('Sentence 55.', findRichText: true),
      findsOneWidget,
    );
  });

  testWidgets('the button works while the transcript is still flinging', (
    tester,
  ) async {
    cache.timelinesByChapter[1] = longTimelineFixture();
    await pumpScreen(tester);

    // Settle on the sentence being spoken, deep in the chapter.
    player.emitPosition(const Duration(milliseconds: 55400), index: 0);
    await settle(tester);
    expect(
      find.textContaining('Sentence 55.', findRichText: true),
      findsOneWidget,
    );

    // Then throw the transcript back towards the start and press the button one
    // frame later, while it is still coasting. A flung list has no finger on it,
    // and hands off from the drag without an end notification — so "the reader
    // is scrolling" has to stop being true when they let go, not when the list
    // stops, or the tap is refused and the momentum carries them further away.
    await tester.fling(find.byType(ListView), const Offset(0, 400), 2400);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.tap(find.byIcon(Icons.vertical_align_center));
    await settle(tester);

    expect(
      find.textContaining('Sentence 55.', findRichText: true),
      findsOneWidget,
    );
  });

  testWidgets('follows the voice into a paragraph it has not built yet', (
    tester,
  ) async {
    cache.timelinesByChapter[1] = longTimelineFixture();
    await pumpScreen(tester);

    // No hand-scrolling here: a seek alone leaves the transcript parked on the
    // old paragraph, and following is supposed to carry it across.
    player.emitPosition(const Duration(milliseconds: 48200), index: 0);
    await settle(tester);

    expect(
      find.textContaining('Sentence 48.', findRichText: true),
      findsOneWidget,
    );
    expect(find.textContaining('Sentence 0.', findRichText: true), findsNothing);
  });

  testWidgets('the transcript can be hidden', (tester) async {
    await pumpScreen(tester);
    expect(
      find.textContaining('She waited.', findRichText: true),
      findsOneWidget,
    );

    await tester.tap(find.byIcon(Icons.subtitles));
    await settle(tester);

    expect(
      find.textContaining('She waited.', findRichText: true),
      findsNothing,
    );
  });
}
