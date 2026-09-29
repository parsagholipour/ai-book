/// The Writing Studio's AI wire models (Phase 2/3) — Dart mirrors of the
/// assist DTOs in `.scratch/writing-studio/spec.md`. Every AI result is a
/// suggestion: nothing here writes the author's text.
library;

/// The tools that answer inline, in one request.
enum QuickAssistKind {
  rewrite('rewrite', 'Rewrite'),
  proofread('proofread', 'Fix spelling & grammar'),
  continueWriting('continue', 'Continue writing'),
  describe('describe', 'Describe more vividly'),
  brainstorm('brainstorm', 'What happens next?'),
  ask('ask', 'Ask about this');

  const QuickAssistKind(this.wire, this.label);

  final String wire;
  final String label;

  static QuickAssistKind fromWire(String? value) => QuickAssistKind.values
      .firstWhere((kind) => kind.wire == value, orElse: () => rewrite);

  /// Whether this tool works on selected text rather than at the cursor.
  bool get needsSelection =>
      this == rewrite || this == proofread || this == describe;
}

/// The quick directions a rewrite can take; a custom instruction is the other.
enum RewritePreset {
  clearer('clearer', 'Clearer'),
  vivid('vivid', 'More vivid'),
  shorter('shorter', 'Shorter'),
  longer('longer', 'Longer'),
  simpler('simpler', 'Simpler'),
  formal('formal', 'More formal'),
  casual('casual', 'More casual');

  const RewritePreset(this.wire, this.label);

  final String wire;
  final String label;
}

class QuickAssistRequest {
  const QuickAssistRequest({
    required this.kind,
    required this.chapterId,
    required this.requestId,
    this.selection,
    this.before,
    this.after,
    this.preset,
    this.instruction,
  });

  final QuickAssistKind kind;
  final String chapterId;
  final String requestId;

  /// ≤ 6000 characters. Required for rewrite, proofread, describe.
  final String? selection;

  /// ≤ 4000 characters of text before the selection or cursor.
  final String? before;

  /// ≤ 1500 characters after it.
  final String? after;
  final RewritePreset? preset;

  /// ≤ 500 characters: a custom rewrite direction, a question, or a focus.
  final String? instruction;

  Map<String, Object?> toJson() => {
    'kind': kind.wire,
    'chapterId': chapterId,
    'requestId': requestId,
    'selection': ?selection,
    'before': ?before,
    'after': ?after,
    'preset': ?preset?.wire,
    'instruction': ?instruction,
  };
}

/// One spelling or grammar fix: [find] occurs exactly once in the selection.
class AssistCorrection {
  const AssistCorrection({
    required this.find,
    required this.replace,
    required this.reason,
  });

  final String find;
  final String replace;
  final String reason;

  factory AssistCorrection.fromJson(Map<String, dynamic> json) {
    return AssistCorrection(
      find: json['find'] as String? ?? '',
      replace: json['replace'] as String? ?? '',
      reason: json['reason'] as String? ?? '',
    );
  }
}

class AssistIdea {
  const AssistIdea({required this.title, required this.text});

  final String title;
  final String text;

  factory AssistIdea.fromJson(Map<String, dynamic> json) {
    return AssistIdea(
      title: json['title'] as String? ?? '',
      text: json['text'] as String? ?? '',
    );
  }
}

/// What a quick tool suggested. Only the fields its kind fills are non-empty.
///
/// Insertion rules the server guarantees: a `continue` suggestion carries its
/// own leading space or paragraph break, and a rewrite or description keeps
/// the selection's own surrounding whitespace — so the client inserts or
/// replaces verbatim and never adds a separator of its own.
class QuickAssistResult {
  const QuickAssistResult({
    required this.kind,
    required this.suggestions,
    required this.corrections,
    required this.ideas,
    this.answer,
  });

  final QuickAssistKind kind;
  final List<String> suggestions;
  final List<AssistCorrection> corrections;
  final List<AssistIdea> ideas;
  final String? answer;

  factory QuickAssistResult.fromJson(Map<String, dynamic> json) {
    List<dynamic> list(String key) => json[key] as List<dynamic>? ?? const [];
    return QuickAssistResult(
      kind: QuickAssistKind.fromWire(json['kind'] as String?),
      suggestions: list('suggestions')
          .map(
            (item) => (item as Map<String, dynamic>)['text'] as String? ?? '',
          )
          .where((text) => text.isNotEmpty)
          .toList(growable: false),
      corrections: list('corrections')
          .map(
            (item) => AssistCorrection.fromJson(item as Map<String, dynamic>),
          )
          .toList(growable: false),
      ideas: list('ideas')
          .map((item) => AssistIdea.fromJson(item as Map<String, dynamic>))
          .toList(growable: false),
      answer: json['answer'] as String?,
    );
  }
}

/// The tools that run in the background and are priced in credits.
enum LongAssistKind {
  illustrate('illustrate', 'Illustration'),
  draftChapter('draft_chapter', 'Chapter draft'),
  chapterFeedback('chapter_feedback', 'Chapter feedback'),
  consistency('consistency', 'Consistency check'),
  outline('outline', 'Book outline');

  const LongAssistKind(this.wire, this.label);

  final String wire;
  final String label;

  static LongAssistKind fromWire(String? value) => LongAssistKind.values
      .firstWhere((kind) => kind.wire == value, orElse: () => illustrate);
}

class LongAssistRequest {
  const LongAssistRequest({
    required this.kind,
    required this.requestId,
    this.chapterId,
    this.prompt,
    this.passage,
    this.notes,
    this.targetWords,
  });

  final LongAssistKind kind;
  final String requestId;
  final String? chapterId;

  /// Illustration: what the picture shows (≤ 1200).
  final String? prompt;

  /// Illustration: the text it illustrates (≤ 4000).
  final String? passage;

  /// Chapter draft: what the chapter should hold (≤ 6000); defaults to the
  /// chapter's own notes on the server.
  final String? notes;
  final int? targetWords;

  Map<String, Object?> toJson() => {
    'kind': kind.wire,
    'requestId': requestId,
    'chapterId': ?chapterId,
    'prompt': ?prompt,
    'passage': ?passage,
    'notes': ?notes,
    'targetWords': ?targetWords,
  };
}

enum ManuscriptAssistStatus {
  queued,
  running,
  ready,
  failed,
  dismissed,
  applied;

  static ManuscriptAssistStatus fromWire(String? value) =>
      ManuscriptAssistStatus.values.firstWhere(
        (status) => status.name == value,
        orElse: () => queued,
      );

  bool get isWorking => this == queued || this == running;
}

/// One editorial note: what it is about (a verbatim quote, or null for the
/// whole chapter) and what to consider.
class AssistNote {
  const AssistNote({
    required this.note,
    required this.isIssue,
    this.quote,
    this.chapterId,
  });

  final String? quote;
  final String note;

  /// "issue" rather than "suggestion".
  final bool isIssue;

  /// The working-copy chapter the quote was found in (consistency checks).
  final String? chapterId;

  factory AssistNote.fromJson(Map<String, dynamic> json) {
    return AssistNote(
      quote: json['quote'] as String?,
      note: json['note'] as String? ?? '',
      isIssue: json['severity'] == 'issue',
      chapterId: json['chapterId'] as String?,
    );
  }
}

class AssistOutlineChapter {
  const AssistOutlineChapter({required this.title, required this.notes});

  final String title;
  final String notes;
}

/// What a background tool produced.
sealed class AssistResult {
  const AssistResult();

  static AssistResult? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    switch (json['type']) {
      case 'image':
        return AssistImageResult(
          url: json['url'] as String? ?? '',
          alt: json['alt'] as String? ?? '',
        );
      case 'draft':
        return AssistDraftResult(markdown: json['markdown'] as String? ?? '');
      case 'notes':
        return AssistNotesResult(
          notes: (json['notes'] as List<dynamic>? ?? const [])
              .map((item) => AssistNote.fromJson(item as Map<String, dynamic>))
              .toList(growable: false),
        );
      case 'outline':
        return AssistOutlineResult(
          chapters: (json['chapters'] as List<dynamic>? ?? const [])
              .map((item) {
                final map = item as Map<String, dynamic>;
                return AssistOutlineChapter(
                  title: map['title'] as String? ?? '',
                  notes: map['notes'] as String? ?? '',
                );
              })
              .toList(growable: false),
        );
    }
    return null;
  }
}

class AssistImageResult extends AssistResult {
  const AssistImageResult({required this.url, required this.alt});

  /// `/assets/images/<projectId>/studio-image-<id>.<ext>`.
  final String url;
  final String alt;
}

class AssistDraftResult extends AssistResult {
  const AssistDraftResult({required this.markdown});

  final String markdown;
}

class AssistNotesResult extends AssistResult {
  const AssistNotesResult({required this.notes});

  final List<AssistNote> notes;
}

class AssistOutlineResult extends AssistResult {
  const AssistOutlineResult({required this.chapters});

  final List<AssistOutlineChapter> chapters;
}

/// One background AI request and, once it lands, its result.
class ManuscriptAssist {
  const ManuscriptAssist({
    required this.id,
    required this.kind,
    required this.status,
    required this.creditsCharged,
    required this.createdAt,
    this.chapterId,
    this.error,
    this.result,
  });

  final String id;
  final LongAssistKind kind;
  final ManuscriptAssistStatus status;
  final String? chapterId;
  final int creditsCharged;
  final DateTime createdAt;

  /// A reader-facing sentence when [status] is failed.
  final String? error;
  final AssistResult? result;

  factory ManuscriptAssist.fromJson(Map<String, dynamic> json) {
    return ManuscriptAssist(
      id: json['id'] as String,
      kind: LongAssistKind.fromWire(json['kind'] as String?),
      status: ManuscriptAssistStatus.fromWire(json['status'] as String?),
      chapterId: json['chapterId'] as String?,
      creditsCharged: json['creditsCharged'] as int? ?? 0,
      createdAt: DateTime.parse(json['createdAt'] as String),
      error: json['error'] as String?,
      result: AssistResult.fromJson(json['result']),
    );
  }
}

/// Where the book's cover comes from.
enum ManuscriptCoverSource {
  design,
  upload,
  ai;

  static ManuscriptCoverSource fromWire(String? value) => ManuscriptCoverSource
      .values
      .firstWhere((source) => source.name == value, orElse: () => design);
}

class ManuscriptCover {
  const ManuscriptCover({
    required this.source,
    required this.pending,
    this.imageUrl,
  });

  static const designed = ManuscriptCover(
    source: ManuscriptCoverSource.design,
    pending: false,
  );

  final ManuscriptCoverSource source;

  /// The current cover picture, or null before the first one exists.
  final String? imageUrl;

  /// A cover is being made right now.
  final bool pending;

  static ManuscriptCover fromJsonOrDefault(Object? json) {
    if (json is! Map<String, dynamic>) return designed;
    return ManuscriptCover(
      source: ManuscriptCoverSource.fromWire(json['source'] as String?),
      imageUrl: json['imageUrl'] as String?,
      pending: json['pending'] as bool? ?? false,
    );
  }
}
