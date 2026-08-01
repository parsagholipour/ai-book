import 'dart:convert';

/// What the server says about a book's narration.
enum AudiobookStatus { generating, complete, failed }

enum AudiobookChapterStatus { pending, ready, failed }

class MobileAudiobook {
  const MobileAudiobook({
    required this.id,
    required this.projectId,
    required this.status,
    required this.voice,
    required this.narratorName,
    required this.isStale,
    required this.totalDurationMs,
    required this.totalEstimatedDurationMs,
    required this.failureMessage,
    required this.progress,
    required this.chapters,
  });

  final String id;
  final String projectId;
  final AudiobookStatus status;
  final String voice;
  final String narratorName;

  /// True when the book was edited after this narration was made.
  final bool isStale;
  final int? totalDurationMs;
  final int? totalEstimatedDurationMs;
  final String? failureMessage;
  final AudiobookProgress? progress;
  final List<MobileAudiobookChapter> chapters;

  bool get isGenerating => status == AudiobookStatus.generating;
  bool get hasFailed => status == AudiobookStatus.failed;

  /// True as soon as anything is listenable, which is the point of narrating
  /// chapter by chapter — the first one lands long before the last.
  bool get hasPlayableAudio => chapters.any((chapter) => chapter.isReady);

  List<MobileAudiobookChapter> get readyChapters =>
      chapters.where((chapter) => chapter.isReady).toList(growable: false);

  factory MobileAudiobook.fromJson(Map<String, dynamic> json) {
    return MobileAudiobook(
      id: json['id'] as String? ?? '',
      projectId: json['projectId'] as String? ?? '',
      status: _statusFrom(json['status'] as String?),
      voice: json['voice'] as String? ?? '',
      narratorName: json['narratorName'] as String? ?? '',
      isStale: json['isStale'] as bool? ?? false,
      totalDurationMs: (json['totalDurationMs'] as num?)?.round(),
      totalEstimatedDurationMs: (json['totalEstimatedDurationMs'] as num?)
          ?.round(),
      failureMessage: json['failureMessage'] as String?,
      progress: json['progress'] == null
          ? null
          : AudiobookProgress.fromJson(
              json['progress'] as Map<String, dynamic>,
            ),
      chapters:
          (json['chapters'] as List<dynamic>? ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(MobileAudiobookChapter.fromJson)
              .toList(growable: false),
    );
  }

  static AudiobookStatus _statusFrom(String? value) => switch (value) {
    'complete' => AudiobookStatus.complete,
    'failed' => AudiobookStatus.failed,
    _ => AudiobookStatus.generating,
  };
}

class MobileAudiobookChapter {
  const MobileAudiobookChapter({
    required this.index,
    required this.title,
    required this.status,
    required this.durationMs,
    required this.estimatedDurationMs,
    required this.byteSize,
    required this.segmentCount,
    required this.audioUrl,
    required this.timelineUrl,
  });

  final int index;
  final String title;
  final AudiobookChapterStatus status;
  final int? durationMs;
  final int? estimatedDurationMs;
  final int? byteSize;
  final int? segmentCount;
  final String? audioUrl;
  final String? timelineUrl;

  bool get isReady => status == AudiobookChapterStatus.ready;

  /// The measured length when it exists, the prediction until then. The player
  /// needs a number for every chapter to draw one continuous timeline.
  int get effectiveDurationMs => durationMs ?? estimatedDurationMs ?? 0;

  factory MobileAudiobookChapter.fromJson(Map<String, dynamic> json) {
    return MobileAudiobookChapter(
      index: (json['index'] as num?)?.round() ?? 0,
      title: json['title'] as String? ?? '',
      status: switch (json['status'] as String?) {
        'ready' => AudiobookChapterStatus.ready,
        'failed' => AudiobookChapterStatus.failed,
        _ => AudiobookChapterStatus.pending,
      },
      durationMs: (json['durationMs'] as num?)?.round(),
      estimatedDurationMs: (json['estimatedDurationMs'] as num?)?.round(),
      byteSize: (json['byteSize'] as num?)?.round(),
      segmentCount: (json['segmentCount'] as num?)?.round(),
      audioUrl: json['audioUrl'] as String?,
      timelineUrl: json['timelineUrl'] as String?,
    );
  }
}

class AudiobookProgress {
  const AudiobookProgress({
    required this.percent,
    required this.currentAction,
    required this.chaptersReady,
    required this.chapterCount,
  });

  final int percent;
  final String currentAction;
  final int chaptersReady;
  final int chapterCount;

  factory AudiobookProgress.fromJson(Map<String, dynamic> json) {
    return AudiobookProgress(
      percent: (json['percent'] as num?)?.round() ?? 0,
      currentAction: json['currentAction'] as String? ?? '',
      chaptersReady: (json['chaptersReady'] as num?)?.round() ?? 0,
      chapterCount: (json['chapterCount'] as num?)?.round() ?? 0,
    );
  }
}

class NarratorVoice {
  const NarratorVoice({
    required this.voice,
    required this.name,
    required this.blurb,
    required this.sampleUrl,
  });

  final String voice;
  final String name;
  final String blurb;
  final String sampleUrl;

  factory NarratorVoice.fromJson(Map<String, dynamic> json) {
    return NarratorVoice(
      voice: json['voice'] as String? ?? '',
      name: json['name'] as String? ?? '',
      blurb: json['blurb'] as String? ?? '',
      sampleUrl: json['sampleUrl'] as String? ?? '',
    );
  }
}

/// One chapter's sentence timings, as written by the worker.
class AudiobookChapterTimeline {
  const AudiobookChapterTimeline({
    required this.chapterIndex,
    required this.title,
    required this.isRightToLeft,
    required this.durationMs,
    required this.segments,
  });

  final int chapterIndex;
  final String title;
  final bool isRightToLeft;
  final int durationMs;
  final List<AudiobookSegment> segments;

  static AudiobookChapterTimeline parse(String raw) {
    final json = jsonDecode(raw) as Map<String, dynamic>;
    return AudiobookChapterTimeline(
      chapterIndex: (json['chapterIndex'] as num?)?.round() ?? 0,
      title: json['title'] as String? ?? '',
      isRightToLeft: json['direction'] == 'rtl',
      durationMs: (json['durationMs'] as num?)?.round() ?? 0,
      segments:
          (json['segments'] as List<dynamic>? ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(AudiobookSegment.fromJson)
              .toList(growable: false),
    );
  }
}

class AudiobookSegment {
  const AudiobookSegment({
    required this.index,
    required this.isTitle,
    required this.paragraph,
    required this.pageIndex,
    required this.startMs,
    required this.endMs,
    required this.text,
  });

  final int index;
  final bool isTitle;
  final int paragraph;
  final int pageIndex;
  final int startMs;
  final int endMs;
  final String text;

  factory AudiobookSegment.fromJson(Map<String, dynamic> json) {
    return AudiobookSegment(
      index: (json['i'] as num?)?.round() ?? 0,
      isTitle: json['kind'] == 'title',
      paragraph: (json['paragraph'] as num?)?.round() ?? 0,
      pageIndex: (json['pageIndex'] as num?)?.round() ?? 0,
      startMs: (json['startMs'] as num?)?.round() ?? 0,
      endMs: (json['endMs'] as num?)?.round() ?? 0,
      text: json['text'] as String? ?? '',
    );
  }
}
