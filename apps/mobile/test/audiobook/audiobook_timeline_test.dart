import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_timeline.dart';

MobileAudiobookChapter chapter({
  required int index,
  int? durationMs,
  int? estimatedDurationMs,
  AudiobookChapterStatus status = AudiobookChapterStatus.ready,
}) {
  return MobileAudiobookChapter(
    index: index,
    title: 'Chapter $index',
    status: status,
    durationMs: durationMs,
    estimatedDurationMs: estimatedDurationMs,
    byteSize: null,
    segmentCount: null,
    audioUrl: status == AudiobookChapterStatus.ready ? '/audio/$index' : null,
    timelineUrl: status == AudiobookChapterStatus.ready ? '/timeline/$index' : null,
  );
}

void main() {
  group('AudiobookGlobalTimeline', () {
    test('measures the whole book, mixing finished and predicted chapters', () {
      final timeline = AudiobookGlobalTimeline([
        chapter(index: 1, durationMs: 60000),
        chapter(
          index: 2,
          estimatedDurationMs: 90000,
          status: AudiobookChapterStatus.pending,
        ),
      ]);

      // The listener sees the book's full length from the first minute.
      expect(timeline.totalDurationMs, 150000);
      // But only the narrated part can actually be played.
      expect(timeline.playableUntilMs, 60000);
      expect(timeline.isFullyPlayable, isFalse);
    });

    test('maps a book position onto the chapter playing there', () {
      final timeline = AudiobookGlobalTimeline([
        chapter(index: 1, durationMs: 60000),
        chapter(index: 2, durationMs: 60000),
        chapter(index: 3, durationMs: 60000),
      ]);

      expect(timeline.resolve(0).chapterIndex, 1);
      expect(timeline.resolve(59999).chapterIndex, 1);
      // A boundary belongs to the chapter that starts there.
      expect(timeline.resolve(60000).chapterIndex, 2);
      expect(timeline.resolve(125000).chapterIndex, 3);
      expect(timeline.resolve(125000).chapterPosition, 5000);
      expect(timeline.resolve(125000).listPosition, 2);
    });

    test('clamps a position past the end of the book instead of overrunning', () {
      final timeline = AudiobookGlobalTimeline([chapter(index: 1, durationMs: 60000)]);
      expect(timeline.resolve(999999).chapterIndex, 1);
      expect(timeline.resolve(999999).chapterPosition, 60000);
      expect(timeline.resolve(-500).chapterPosition, 0);
    });

    test('round-trips between book time and chapter time', () {
      final timeline = AudiobookGlobalTimeline([
        chapter(index: 1, durationMs: 60000),
        chapter(index: 2, durationMs: 60000),
      ]);

      final resolved = timeline.resolve(75000);
      expect(
        timeline.toGlobal(
          chapterIndex: resolved.chapterIndex,
          chapterPositionMs: resolved.chapterPosition,
        ),
        75000,
      );
    });

    test('stops the playable extent at the first gap rather than jumping it', () {
      // Chapter 2 failed but chapter 3 finished; the book is only listenable
      // up to the gap, not through it.
      final timeline = AudiobookGlobalTimeline([
        chapter(index: 1, durationMs: 60000),
        chapter(index: 2, estimatedDurationMs: 60000, status: AudiobookChapterStatus.failed),
        chapter(index: 3, durationMs: 60000),
      ]);

      expect(timeline.playableUntilMs, 60000);
      expect(timeline.totalDurationMs, 180000);
    });

    test('handles a book with no chapters at all', () {
      final timeline = AudiobookGlobalTimeline([]);
      expect(timeline.totalDurationMs, 0);
      expect(timeline.playableUntilMs, 0);
      expect(timeline.isFullyPlayable, isFalse);
      expect(timeline.resolve(1000).chapterIndex, 0);
    });

    test('knows a fully narrated book is fully playable', () {
      final timeline = AudiobookGlobalTimeline([
        chapter(index: 1, durationMs: 1000),
        chapter(index: 2, durationMs: 1000),
      ]);
      expect(timeline.isFullyPlayable, isTrue);
      expect(timeline.playableUntilMs, timeline.totalDurationMs);
    });
  });

  group('segmentAt', () {
    final timeline = AudiobookChapterTimeline.parse(
      jsonEncode({
        'version': 1,
        'chapterIndex': 1,
        'title': 'Low Tide',
        'language': 'en',
        'direction': 'ltr',
        'durationMs': 9000,
        'segments': [
          {'i': 0, 'kind': 'title', 'paragraph': 0, 'pageIndex': 1, 'startMs': 0, 'endMs': 2000, 'text': 'Chapter 1. Low Tide'},
          {'i': 1, 'kind': 'sentence', 'paragraph': 1, 'pageIndex': 1, 'startMs': 3000, 'endMs': 5000, 'text': 'She waited.'},
          {'i': 2, 'kind': 'sentence', 'paragraph': 1, 'pageIndex': 1, 'startMs': 5000, 'endMs': 7000, 'text': 'He did not come.'},
        ],
      }),
    );

    test('finds the line being spoken', () {
      expect(segmentAt(timeline, 0)?.text, 'Chapter 1. Low Tide');
      expect(segmentAt(timeline, 4000)?.text, 'She waited.');
      expect(segmentAt(timeline, 5000)?.text, 'He did not come.');
    });

    test('holds the last line through the pause after it', () {
      // Nothing is being read at 2.5s, but blanking the highlight there would
      // make the transcript flicker between every sentence.
      expect(segmentAt(timeline, 2500)?.text, 'Chapter 1. Low Tide');
      expect(segmentAt(timeline, 8000)?.text, 'He did not come.');
    });

    test('has nothing to highlight before the first word', () {
      final empty = AudiobookChapterTimeline.parse(
        jsonEncode({
          'version': 1,
          'chapterIndex': 1,
          'title': '',
          'language': 'en',
          'direction': 'ltr',
          'durationMs': 0,
          'segments': <dynamic>[],
        }),
      );
      expect(segmentAt(empty, 10), isNull);
    });

    test('reads the direction so right-to-left books lay out correctly', () {
      final rtl = AudiobookChapterTimeline.parse(
        jsonEncode({
          'version': 1,
          'chapterIndex': 1,
          'title': 'فصل',
          'language': 'fa',
          'direction': 'rtl',
          'durationMs': 1000,
          'segments': <dynamic>[],
        }),
      );
      expect(rtl.isRightToLeft, isTrue);
      expect(timeline.isRightToLeft, isFalse);
    });
  });

  group('paragraphsOf', () {
    test('groups sentences back into the paragraphs they were read from', () {
      final timeline = AudiobookChapterTimeline.parse(
        jsonEncode({
          'version': 1,
          'chapterIndex': 1,
          'title': '',
          'language': 'en',
          'direction': 'ltr',
          'durationMs': 4000,
          'segments': [
            {'i': 0, 'kind': 'sentence', 'paragraph': 0, 'pageIndex': 1, 'startMs': 0, 'endMs': 1000, 'text': 'One.'},
            {'i': 1, 'kind': 'sentence', 'paragraph': 0, 'pageIndex': 1, 'startMs': 1000, 'endMs': 2000, 'text': 'Two.'},
            {'i': 2, 'kind': 'sentence', 'paragraph': 1, 'pageIndex': 1, 'startMs': 2000, 'endMs': 3000, 'text': 'Three.'},
          ],
        }),
      );

      final paragraphs = paragraphsOf(timeline);
      expect(paragraphs, hasLength(2));
      expect(paragraphs[0].map((s) => s.text), ['One.', 'Two.']);
      expect(paragraphs[1].map((s) => s.text), ['Three.']);
    });
  });

  group('formatAudiobookDuration', () {
    test('reads as a clock, dropping the hour when there is not one', () {
      expect(formatAudiobookDuration(0), '0:00');
      expect(formatAudiobookDuration(9000), '0:09');
      expect(formatAudiobookDuration(65000), '1:05');
      expect(formatAudiobookDuration(3600000), '1:00:00');
      expect(formatAudiobookDuration(7325000), '2:02:05');
    });
  });

  group('MobileAudiobook parsing', () {
    test('knows a book is listenable as soon as one chapter is ready', () {
      final audiobook = MobileAudiobook.fromJson({
        'id': 'a1',
        'projectId': 'p1',
        'status': 'generating',
        'voice': 'Zephyr',
        'narratorName': 'Zephyr',
        'isStale': false,
        'totalDurationMs': null,
        'totalEstimatedDurationMs': 120000,
        'progress': {'percent': 50, 'currentAction': 'Narrated 1 of 2 chapters', 'chaptersReady': 1, 'chapterCount': 2},
        'chapters': [
          {'index': 1, 'title': 'One', 'status': 'ready', 'durationMs': 60000, 'audioUrl': '/a/1'},
          {'index': 2, 'title': 'Two', 'status': 'pending', 'estimatedDurationMs': 60000},
        ],
      });

      expect(audiobook.isGenerating, isTrue);
      expect(audiobook.hasPlayableAudio, isTrue);
      expect(audiobook.readyChapters, hasLength(1));
      expect(audiobook.progress?.chaptersReady, 1);
    });

    test('uses the prediction until a chapter has been measured', () {
      final pending = MobileAudiobookChapter.fromJson({
        'index': 1,
        'title': 'One',
        'status': 'pending',
        'estimatedDurationMs': 45000,
      });
      expect(pending.effectiveDurationMs, 45000);

      final ready = MobileAudiobookChapter.fromJson({
        'index': 1,
        'title': 'One',
        'status': 'ready',
        'durationMs': 47000,
        'estimatedDurationMs': 45000,
      });
      expect(ready.effectiveDurationMs, 47000);
    });
  });
}
