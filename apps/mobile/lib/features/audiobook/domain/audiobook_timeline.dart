import 'audiobook_models.dart';

/// The arithmetic that makes a pile of chapter files behave like one audiobook.
///
/// A listener is shown a single scrubber for the whole book, even while the
/// back half is still being narrated. That works because every chapter has a
/// length from the moment it is planned — measured once it exists, predicted
/// before then — so the book's shape is known in advance and only gets more
/// accurate. All of this is pure, which is what makes it testable without a
/// player.
class AudiobookGlobalTimeline {
  AudiobookGlobalTimeline(this.chapters)
    : _starts = _prefixSums(chapters),
      totalDurationMs = chapters.fold(
        0,
        (total, chapter) => total + chapter.effectiveDurationMs,
      );

  final List<MobileAudiobookChapter> chapters;
  final List<int> _starts;

  /// Length of the whole book, mixing measured and predicted chapters.
  final int totalDurationMs;

  /// Where the narrated part ends: everything past this is still being made.
  ///
  /// Ready chapters only count from the start of the book, so a gap (a failed
  /// chapter three with a ready chapter four) stops the bar rather than
  /// pretending the middle is playable.
  int get playableUntilMs {
    var playable = 0;
    for (final chapter in chapters) {
      if (!chapter.isReady) {
        break;
      }
      playable += chapter.effectiveDurationMs;
    }
    return playable;
  }

  bool get isFullyPlayable =>
      chapters.isNotEmpty && chapters.every((chapter) => chapter.isReady);

  int startOfChapter(int chapterIndex) {
    final position = chapters.indexWhere(
      (chapter) => chapter.index == chapterIndex,
    );
    return position < 0 ? 0 : _starts[position];
  }

  /// Book position → the chapter playing there and how far into it.
  AudiobookPosition resolve(int positionMs) {
    if (chapters.isEmpty) {
      return const AudiobookPosition(
        chapterIndex: 0,
        chapterPosition: 0,
        listPosition: 0,
      );
    }
    final clamped = positionMs.clamp(0, totalDurationMs);

    var low = 0;
    var high = chapters.length - 1;
    var found = 0;
    while (low <= high) {
      final mid = (low + high) >> 1;
      if (_starts[mid] <= clamped) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return AudiobookPosition(
      chapterIndex: chapters[found].index,
      chapterPosition: clamped - _starts[found],
      listPosition: found,
    );
  }

  /// Chapter-local position → position in the book.
  int toGlobal({required int chapterIndex, required int chapterPositionMs}) {
    return startOfChapter(chapterIndex) + chapterPositionMs;
  }

  static List<int> _prefixSums(List<MobileAudiobookChapter> chapters) {
    final starts = <int>[];
    var running = 0;
    for (final chapter in chapters) {
      starts.add(running);
      running += chapter.effectiveDurationMs;
    }
    return starts;
  }
}

class AudiobookPosition {
  const AudiobookPosition({
    required this.chapterIndex,
    required this.chapterPosition,
    required this.listPosition,
  });

  final int chapterIndex;
  final int chapterPosition;

  /// Ordinal within the chapter list, which is what the player's queue uses.
  final int listPosition;
}

/// The sentence being spoken at a chapter-local position, found by binary
/// search because this runs on every position tick.
AudiobookSegment? segmentAt(AudiobookChapterTimeline timeline, int positionMs) {
  final segments = timeline.segments;
  if (segments.isEmpty) {
    return null;
  }

  var low = 0;
  var high = segments.length - 1;
  AudiobookSegment? candidate;
  while (low <= high) {
    final mid = (low + high) >> 1;
    final segment = segments[mid];
    if (segment.startMs <= positionMs) {
      candidate = segment;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return candidate;
}

/// Segments grouped into the paragraphs they were read from, so the transcript
/// can lay out prose rather than a list of disconnected sentences.
List<List<AudiobookSegment>> paragraphsOf(AudiobookChapterTimeline timeline) {
  final paragraphs = <List<AudiobookSegment>>[];
  int? currentParagraph;
  for (final segment in timeline.segments) {
    if (segment.paragraph != currentParagraph) {
      paragraphs.add(<AudiobookSegment>[]);
      currentParagraph = segment.paragraph;
    }
    paragraphs.last.add(segment);
  }
  return paragraphs;
}

String formatAudiobookDuration(int milliseconds) {
  final totalSeconds = (milliseconds / 1000).round().clamp(0, 359999);
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  final seconds = totalSeconds % 60;
  final paddedSeconds = seconds.toString().padLeft(2, '0');
  if (hours == 0) {
    return '$minutes:$paddedSeconds';
  }
  return '$hours:${minutes.toString().padLeft(2, '0')}:$paddedSeconds';
}
