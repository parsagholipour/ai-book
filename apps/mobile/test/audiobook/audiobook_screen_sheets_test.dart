import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';

import 'audiobook_fakes.dart';

/// The tools row, the chapter list, the stale notice and the accessibility of
/// the transport controls — everything the listening screen adds around the
/// play button.
void main() {
  late Directory tempDir;
  late FakeAudiobookPlayer player;
  late FakeAudiobookRepository repository;
  late FakeAudiobookCache cache;
  late FakeAudiobookProgressStore progress;
  ProviderContainer? activeContainer;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-audiobook-sheets');
    player = FakeAudiobookPlayer();
    repository = FakeAudiobookRepository(
      audiobook: audiobookWith(chapters: fullyNarratedChapters()),
    );
    cache = FakeAudiobookCache(tempDir)
      ..timelinesByChapter[1] = timelineFixture()
      ..timelinesByChapter[2] = const AudiobookChapterTimeline(
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
    progress = FakeAudiobookProgressStore();
  });

  tearDown(() {
    activeContainer?.dispose();
    activeContainer = null;
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

  testWidgets(
    'names the chapter being heard and how far through the book it is',
    (tester) async {
      await pumpScreen(tester);

      expect(find.textContaining('Low Tide', findRichText: true), findsWidgets);
      expect(find.textContaining('1 of 2', findRichText: true), findsOneWidget);
    },
  );

  testWidgets('the chapter list marks the current chapter and jumps on tap', (
    tester,
  ) async {
    await pumpScreen(tester);

    await tester.tap(find.text('Chapters'));
    await settle(tester);

    expect(find.text('2 chapters · 18 sec'), findsOneWidget);
    expect(find.text('High Tide'), findsOneWidget);
    // Nine seconds each: a length beside every chapter.
    expect(find.text('9 sec'), findsNWidgets(2));
    expect(
      tester.getSemantics(find.text('Low Tide').last),
      matchesSemantics(
        label: 'Chapter 1, Low Tide, playing now, 9 sec',
        isSelected: true,
        isButton: true,
        isEnabled: true,
        hasEnabledState: true,
        hasSelectedState: true,
        hasTapAction: true,
      ),
    );

    await tester.tap(find.text('High Tide'));
    await settle(tester);

    // Choosing a chapter reads it, rather than parking at its start.
    expect(player.seeks.last.index, 1);
    expect(player.playing, isTrue);
    // And the sheet is out of the way.
    expect(find.text('Chapters'), findsOneWidget);
  });

  testWidgets(
    'a chapter still being narrated is listed but cannot be jumped to',
    (tester) async {
      repository.audiobook = audiobookWith(
        status: AudiobookStatus.generating,
        chapters: halfNarratedChapters(),
      );
      final container = await pumpScreen(tester);

      await tester.tap(find.text('Chapters'));
      await settle(tester);

      expect(find.text('Narrating…'), findsOneWidget);
      await tester.tap(find.text('High Tide'));
      await settle(tester);
      expect(player.seeks, isEmpty);
      container.dispose();
      activeContainer = null;
    },
  );

  testWidgets('the speed sheet marks the current speed and applies a new one', (
    tester,
  ) async {
    await pumpScreen(tester);

    await tester.tap(find.text('Speed'));
    await settle(tester);
    expect(find.text('Playback speed'), findsOneWidget);

    await tester.tap(find.text('1.25x'));
    await settle(tester);

    expect(player.speeds.last, 1.25);
    // The sheet closes itself on a choice.
    expect(find.text('Playback speed'), findsNothing);
    expect(find.text('1.25x'), findsOneWidget);
  });

  testWidgets('the sleep timer says how long is left and can be turned off', (
    tester,
  ) async {
    final container = await pumpScreen(tester);

    await tester.tap(find.text('Sleep'));
    await settle(tester);
    await tester.tap(find.text('30 minutes'));
    await settle(tester);

    expect(find.text('30 min'), findsOneWidget);
    expect(
      container.read(audiobookControllerProvider('project-1')).sleepTimerEnd,
      isNotNull,
    );

    await tester.tap(find.text('30 min'));
    await settle(tester);
    await tester.tap(find.text('Turn off the timer'));
    await settle(tester);

    expect(find.text('Sleep'), findsOneWidget);
    expect(
      container.read(audiobookControllerProvider('project-1')).sleepTimerEnd,
      isNull,
    );
  });

  testWidgets('a book edited after narrating offers to narrate it again', (
    tester,
  ) async {
    repository.audiobook = MobileAudiobook(
      id: 'audiobook-1',
      projectId: 'project-1',
      status: AudiobookStatus.complete,
      voice: 'Zephyr',
      narratorName: 'Zephyr',
      isStale: true,
      totalDurationMs: 9000,
      totalEstimatedDurationMs: 9000,
      failureMessage: null,
      progress: null,
      chapters: audiobookWith().chapters,
    );
    await pumpScreen(tester);

    expect(
      find.text('You have edited this book since it was narrated.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Re-narrate'));
    await settle(tester);

    // It opens the picker as a replacement, with the current narrator marked.
    expect(find.text('Choose a new narrator'), findsOneWidget);
    expect(find.text('Current'), findsOneWidget);
  });

  testWidgets('an unedited book carries no stale notice', (tester) async {
    await pumpScreen(tester);

    expect(find.text('Re-narrate'), findsNothing);
  });

  testWidgets('the transport controls say what they do', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpScreen(tester);

    expect(find.bySemanticsLabel('Play'), findsOneWidget);
    expect(find.bySemanticsLabel('Skip back 15 seconds'), findsOneWidget);
    expect(find.bySemanticsLabel('Skip forward 15 seconds'), findsOneWidget);
    expect(find.bySemanticsLabel('Playback speed, 1x'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    expect(find.bySemanticsLabel('Pause'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('the picker offers no price it was not told', (tester) async {
    repository.audiobook = null;
    await pumpScreen(tester);

    await tester.tap(find.text('Choose a narrator'));
    await settle(tester);

    // The billing fixture ships no audiobook prices, so none are invented.
    expect(find.text('Narrating this book costs'), findsNothing);
    expect(find.bySemanticsLabel('Play Zephyr preview'), findsOneWidget);
    expect(find.text('Pick a voice to continue'), findsOneWidget);

    await tester.tap(find.text('Zephyr'));
    await settle(tester);
    expect(find.text('Narrated by Zephyr'), findsOneWidget);
  });
}
