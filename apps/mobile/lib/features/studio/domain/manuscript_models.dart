/// The Writing Studio's wire models — Dart mirrors of the DTOs in
/// `.scratch/writing-studio/spec.md`. The server is the authority on every
/// field; nothing here derives a value the server already sends.
library;

import 'assist_models.dart';

/// How a book is laid out: continuous chapters, or explicit picture-book pages.
enum ManuscriptLayout {
  flow,
  picture;

  static ManuscriptLayout fromWire(String? value) =>
      value == 'picture' ? ManuscriptLayout.picture : ManuscriptLayout.flow;

  String get wire => name;
}

/// What kind of book the author said they are writing. Drives defaults only.
enum ManuscriptKind {
  story('story', 'Story or novel'),
  nonfiction('nonfiction', 'Non-fiction'),
  picture('picture', 'Picture book'),
  other('other', 'Something else');

  const ManuscriptKind(this.wire, this.label);

  final String wire;
  final String label;

  static ManuscriptKind fromWire(String? value) => ManuscriptKind.values
      .firstWhere((kind) => kind.wire == value, orElse: () => story);

  ManuscriptLayout get defaultLayout => this == ManuscriptKind.picture
      ? ManuscriptLayout.picture
      : ManuscriptLayout.flow;
}

/// The author's own progress marker for a chapter.
enum ManuscriptChapterStatus {
  idea('idea', 'Idea'),
  drafting('drafting', 'Drafting'),
  revised('revised', 'Revised'),
  finalDraft('final', 'Final');

  const ManuscriptChapterStatus(this.wire, this.label);

  final String wire;
  final String label;

  static ManuscriptChapterStatus fromWire(String? value) =>
      ManuscriptChapterStatus.values.firstWhere(
        (status) => status.wire == value,
        orElse: () => drafting,
      );
}

/// Why publishing is not possible right now; null means it is.
enum ManuscriptPublishBlock {
  busy,
  audiobook,
  importing;

  static ManuscriptPublishBlock? fromWire(String? value) => switch (value) {
    'busy' => busy,
    'audiobook' => audiobook,
    'importing' => importing,
    _ => null,
  };

  String get message => switch (this) {
    busy => 'Your book is being updated. You can publish when it finishes.',
    audiobook =>
      'Your audiobook is being made. You can publish when it finishes.',
    importing => 'Your manuscript is still being imported.',
  };
}

/// One chapter as the outline lists it — no text.
class ManuscriptChapterSummary {
  const ManuscriptChapterSummary({
    required this.id,
    required this.position,
    required this.title,
    required this.status,
    required this.wordCount,
    required this.revision,
    required this.excerpt,
    required this.hasUnpublishedChanges,
    required this.hasConflict,
    required this.updatedAt,
    this.bookChapterId,
  });

  final String id;

  /// The book's `Chapter` row this chapter published as, or null before its
  /// first publish. The reader only knows book chapter ids, so the Studio
  /// resolves a `?chapter=` link against this too.
  final String? bookChapterId;
  final int position;
  final String title;
  final ManuscriptChapterStatus status;
  final int wordCount;
  final int revision;
  final String excerpt;
  final bool hasUnpublishedChanges;
  final bool hasConflict;
  final DateTime updatedAt;

  factory ManuscriptChapterSummary.fromJson(Map<String, dynamic> json) {
    return ManuscriptChapterSummary(
      id: json['id'] as String,
      position: json['position'] as int,
      title: json['title'] as String? ?? '',
      status: ManuscriptChapterStatus.fromWire(json['status'] as String?),
      wordCount: json['wordCount'] as int? ?? 0,
      revision: json['revision'] as int,
      excerpt: json['excerpt'] as String? ?? '',
      hasUnpublishedChanges: json['hasUnpublishedChanges'] as bool? ?? false,
      hasConflict: json['hasConflict'] as bool? ?? false,
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      bookChapterId: json['bookChapterId'] as String?,
    );
  }

  /// The title to show, never blank.
  String get displayTitle =>
      title.trim().isEmpty ? 'Untitled chapter' : title.trim();
}

/// "Chapter 3" on the third chapter: the name a chapter is given before its
/// author names it, which says nothing the label does not. A new chapter is
/// named by count, not place, so "Chapter 4" inserted second is not one.
bool isPlaceholderChapterTitle(String title, int position) => RegExp(
  '^chapter\\s+$position\$',
  caseSensitive: false,
).hasMatch(title.trim());

/// The book's version of a chapter, captured when the book changed underneath
/// (an edit made in the book chat) while this chapter held unpublished edits.
class ManuscriptChapterConflict {
  const ManuscriptChapterConflict({
    required this.title,
    required this.markdown,
    required this.detectedAt,
  });

  final String title;
  final String markdown;
  final DateTime detectedAt;

  factory ManuscriptChapterConflict.fromJson(Map<String, dynamic> json) {
    return ManuscriptChapterConflict(
      title: json['title'] as String? ?? '',
      markdown: json['markdown'] as String? ?? '',
      detectedAt: DateTime.parse(json['detectedAt'] as String),
    );
  }
}

/// One chapter with its text, as the editor opens it.
class ManuscriptChapter extends ManuscriptChapterSummary {
  const ManuscriptChapter({
    required super.id,
    required super.position,
    required super.title,
    required super.status,
    required super.wordCount,
    required super.revision,
    required super.excerpt,
    required super.hasUnpublishedChanges,
    required super.hasConflict,
    required super.updatedAt,
    super.bookChapterId,
    required this.markdown,
    required this.notes,
    this.conflict,
  });

  final String markdown;
  final String notes;
  final ManuscriptChapterConflict? conflict;

  factory ManuscriptChapter.fromJson(Map<String, dynamic> json) {
    final summary = ManuscriptChapterSummary.fromJson(json);
    final conflict = json['conflict'];
    return ManuscriptChapter(
      id: summary.id,
      position: summary.position,
      title: summary.title,
      status: summary.status,
      wordCount: summary.wordCount,
      revision: summary.revision,
      excerpt: summary.excerpt,
      hasUnpublishedChanges: summary.hasUnpublishedChanges,
      hasConflict: summary.hasConflict,
      updatedAt: summary.updatedAt,
      bookChapterId: summary.bookChapterId,
      markdown: json['markdown'] as String? ?? '',
      notes: json['notes'] as String? ?? '',
      conflict: conflict is Map<String, dynamic>
          ? ManuscriptChapterConflict.fromJson(conflict)
          : null,
    );
  }
}

/// The whole working copy's metadata: settings and the chapter outline.
class Manuscript {
  const Manuscript({
    required this.projectId,
    required this.revision,
    required this.source,
    required this.layout,
    required this.kind,
    required this.title,
    required this.language,
    required this.wordCount,
    required this.published,
    required this.hasUnpublishedChanges,
    required this.chapters,
    required this.updatedAt,
    this.subtitle,
    this.authorName,
    this.dedication,
    this.artStyle,
    this.goalWords,
    this.publishBlock,
    this.castCharacterIds = const [],
    this.cover = ManuscriptCover.designed,
  });

  final String projectId;
  final int revision;

  /// The book's cast: library character ids whose looks every illustration
  /// follows and whose names the AI tools know.
  final List<String> castCharacterIds;
  final ManuscriptCover cover;

  /// 'written' for a book begun in the Studio, 'imported' for an uploaded
  /// manuscript.
  final String source;
  final ManuscriptLayout layout;
  final ManuscriptKind kind;
  final String title;
  final String? subtitle;
  final String? authorName;
  final String? dedication;
  final String? artStyle;
  final int? goalWords;
  final String language;
  final int wordCount;

  /// Whether the book has ever been published (always true for an import).
  final bool published;
  final bool hasUnpublishedChanges;
  final ManuscriptPublishBlock? publishBlock;
  final List<ManuscriptChapterSummary> chapters;
  final DateTime updatedAt;

  bool get isPictureBook => layout == ManuscriptLayout.picture;

  bool get hasConflicts => chapters.any((chapter) => chapter.hasConflict);

  /// Progress toward the author's goal, 0..1, or null without a goal.
  double? get goalProgress {
    final goal = goalWords;
    if (goal == null || goal <= 0) return null;
    return (wordCount / goal).clamp(0, 1).toDouble();
  }

  ManuscriptChapterSummary? chapterById(String id) {
    for (final chapter in chapters) {
      if (chapter.id == id) return chapter;
    }
    return null;
  }

  /// The chapter a `?chapter=` link names: a working-copy id, or the book
  /// chapter id the reader knows.
  ManuscriptChapterSummary? chapterForLink(String id) {
    final direct = chapterById(id);
    if (direct != null) return direct;
    for (final chapter in chapters) {
      if (chapter.bookChapterId == id) return chapter;
    }
    return null;
  }

  factory Manuscript.fromJson(Map<String, dynamic> json) {
    final chapters = (json['chapters'] as List<dynamic>? ?? const [])
        .map(
          (item) =>
              ManuscriptChapterSummary.fromJson(item as Map<String, dynamic>),
        )
        .toList(growable: false);
    return Manuscript(
      projectId: json['projectId'] as String,
      revision: json['revision'] as int,
      source: json['source'] as String? ?? 'written',
      layout: ManuscriptLayout.fromWire(json['layout'] as String?),
      kind: ManuscriptKind.fromWire(json['kind'] as String?),
      title: json['title'] as String? ?? '',
      subtitle: json['subtitle'] as String?,
      authorName: json['authorName'] as String?,
      dedication: json['dedication'] as String?,
      artStyle: json['artStyle'] as String?,
      goalWords: json['goalWords'] as int?,
      language: json['language'] as String? ?? 'en',
      wordCount: json['wordCount'] as int? ?? 0,
      published: json['published'] as bool? ?? false,
      hasUnpublishedChanges: json['hasUnpublishedChanges'] as bool? ?? false,
      publishBlock: ManuscriptPublishBlock.fromWire(
        json['publishBlockedReason'] as String?,
      ),
      chapters: chapters,
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      castCharacterIds: (json['castCharacterIds'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(growable: false),
      cover: ManuscriptCover.fromJsonOrDefault(json['cover']),
    );
  }
}

/// What the server answered a chapter save with.
class ManuscriptChapterSaveResult {
  const ManuscriptChapterSaveResult({
    required this.chapter,
    required this.manuscriptRevision,
    required this.savedAt,
  });

  final ManuscriptChapterSummary chapter;
  final int manuscriptRevision;
  final DateTime savedAt;

  factory ManuscriptChapterSaveResult.fromJson(Map<String, dynamic> json) {
    return ManuscriptChapterSaveResult(
      chapter: ManuscriptChapterSummary.fromJson(
        json['chapter'] as Map<String, dynamic>,
      ),
      manuscriptRevision: json['manuscriptRevision'] as int,
      savedAt: DateTime.parse(json['savedAt'] as String),
    );
  }
}

/// A chapter save the server refused because another device saved first. It
/// carries the server's copy so the author can choose.
class ManuscriptChapterConflictException implements Exception {
  const ManuscriptChapterConflictException(this.serverChapter);

  final ManuscriptChapter serverChapter;

  @override
  String toString() => 'This chapter was changed on another device.';
}

/// Why a version was kept.
enum ManuscriptVersionReason {
  auto('auto', 'Autosave'),
  beforeAi('before_ai', 'Before an AI change'),
  restore('restore', 'Before a restore'),
  publish('publish', 'Published'),
  conflict('conflict', 'Before resolving a conflict');

  const ManuscriptVersionReason(this.wire, this.label);

  final String wire;
  final String label;

  static ManuscriptVersionReason fromWire(String? value) =>
      ManuscriptVersionReason.values.firstWhere(
        (reason) => reason.wire == value,
        orElse: () => auto,
      );
}

class ManuscriptVersionSummary {
  const ManuscriptVersionSummary({
    required this.id,
    required this.reason,
    required this.title,
    required this.wordCount,
    required this.createdAt,
  });

  final String id;
  final ManuscriptVersionReason reason;
  final String title;
  final int wordCount;
  final DateTime createdAt;

  factory ManuscriptVersionSummary.fromJson(Map<String, dynamic> json) {
    return ManuscriptVersionSummary(
      id: json['id'] as String,
      reason: ManuscriptVersionReason.fromWire(json['reason'] as String?),
      title: json['title'] as String? ?? '',
      wordCount: json['wordCount'] as int? ?? 0,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

class ManuscriptVersion extends ManuscriptVersionSummary {
  const ManuscriptVersion({
    required super.id,
    required super.reason,
    required super.title,
    required super.wordCount,
    required super.createdAt,
    required this.markdown,
  });

  final String markdown;

  factory ManuscriptVersion.fromJson(Map<String, dynamic> json) {
    final summary = ManuscriptVersionSummary.fromJson(json);
    return ManuscriptVersion(
      id: summary.id,
      reason: summary.reason,
      title: summary.title,
      wordCount: summary.wordCount,
      createdAt: summary.createdAt,
      markdown: json['markdown'] as String? ?? '',
    );
  }
}

/// A picture the author uploaded into the book.
class ManuscriptUploadedImage {
  const ManuscriptUploadedImage({
    required this.url,
    required this.width,
    required this.height,
  });

  /// `/assets/images/<projectId>/upload-<id>.<ext>` — what the markdown image
  /// line points at.
  final String url;
  final int width;
  final int height;

  factory ManuscriptUploadedImage.fromJson(Map<String, dynamic> json) {
    return ManuscriptUploadedImage(
      url: json['url'] as String,
      width: json['width'] as int? ?? 0,
      height: json['height'] as int? ?? 0,
    );
  }
}

enum PublishChecklistKind {
  emptyChapter('empty_chapter'),
  untitledChapter('untitled_chapter'),
  placeholder('placeholder'),
  unclosedFence('unclosed_fence'),
  conflict('conflict'),
  emptyBook('empty_book'),

  /// Never in a checklist the server sends: a publish the content screen
  /// refused, shown as blocking items (see [ManuscriptContentRefusal]).
  contentRestricted('content_restricted'),
  other('other');

  const PublishChecklistKind(this.wire);

  final String wire;

  static PublishChecklistKind fromWire(String? value) => PublishChecklistKind
      .values
      .firstWhere((kind) => kind.wire == value, orElse: () => other);
}

class PublishChecklistItem {
  const PublishChecklistItem({
    required this.kind,
    required this.message,
    required this.blocking,
    this.chapterId,
  });

  final PublishChecklistKind kind;
  final String? chapterId;
  final String message;
  final bool blocking;

  factory PublishChecklistItem.fromJson(Map<String, dynamic> json) {
    return PublishChecklistItem(
      kind: PublishChecklistKind.fromWire(json['kind'] as String?),
      chapterId: json['chapterId'] as String?,
      message: json['message'] as String? ?? '',
      blocking: json['blocking'] as bool? ?? false,
    );
  }
}

/// What publishing would do, answered without doing it.
class PublishChecklist {
  const PublishChecklist({
    required this.firstPublish,
    required this.words,
    required this.estimatedPages,
    required this.changedChapters,
    required this.items,
  });

  final bool firstPublish;
  final int words;
  final int estimatedPages;
  final int changedChapters;
  final List<PublishChecklistItem> items;

  bool get canPublish => !items.any((item) => item.blocking);

  /// This checklist with a refused publish's items at the top, in place of any
  /// earlier refusal's.
  PublishChecklist withRefusal(ManuscriptContentRefusal refusal) =>
      PublishChecklist(
        firstPublish: firstPublish,
        words: words,
        estimatedPages: estimatedPages,
        changedChapters: changedChapters,
        items: [
          ...refusal.checklistItems,
          for (final item in items)
            if (item.kind != PublishChecklistKind.contentRestricted) item,
        ],
      );

  factory PublishChecklist.fromJson(Map<String, dynamic> json) {
    return PublishChecklist(
      firstPublish: json['firstPublish'] as bool? ?? false,
      words: json['words'] as int? ?? 0,
      estimatedPages: json['estimatedPages'] as int? ?? 0,
      changedChapters: json['changedChapters'] as int? ?? 0,
      items: (json['items'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                PublishChecklistItem.fromJson(item as Map<String, dynamic>),
          )
          .toList(growable: false),
    );
  }
}

/// A chapter the server's content screen refused at publish.
class ManuscriptRefusedChapter {
  const ManuscriptRefusedChapter({
    required this.chapterId,
    required this.title,
  });

  final String chapterId;
  final String title;

  factory ManuscriptRefusedChapter.fromJson(Map<String, dynamic> json) {
    return ManuscriptRefusedChapter(
      chapterId: json['chapterId'] as String? ?? '',
      title: json['title'] as String? ?? '',
    );
  }
}

/// A Studio write the server's content screen refused: a 422
/// `CONTENT_RESTRICTED` or `COPYRIGHT_RESTRICTED`, built from
/// `ApiException.details` (the server's `error` object). [message] is the
/// server's own sentence; a publish also names the [chapters] and the book's
/// own [fields] that hold the words, so the sheet can take the author there.
class ManuscriptContentRefusal {
  const ManuscriptContentRefusal({
    required this.message,
    this.chapters = const [],
    this.fields = const [],
  });

  static bool isRefusalCode(String code) =>
      code == 'CONTENT_RESTRICTED' || code == 'COPYRIGHT_RESTRICTED';

  final String message;
  final List<ManuscriptRefusedChapter> chapters;

  /// Wire names: `title`, `subtitle`, `authorName`, `dedication`, `artStyle`.
  final List<String> fields;

  factory ManuscriptContentRefusal.fromJson(Map<String, dynamic> json) {
    return ManuscriptContentRefusal(
      message: json['message'] as String? ?? '',
      chapters: (json['chapters'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(ManuscriptRefusedChapter.fromJson)
          .where((chapter) => chapter.chapterId.isNotEmpty)
          .toList(growable: false),
      fields: (json['fields'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(growable: false),
    );
  }

  /// One blocking item per refused chapter, each opening its chapter, and one
  /// for the book's own details (or for a refusal that named nothing).
  List<PublishChecklistItem> get checklistItems => [
    for (final chapter in chapters)
      PublishChecklistItem(
        kind: PublishChecklistKind.contentRestricted,
        chapterId: chapter.chapterId,
        message: chapter.title.trim().isEmpty
            ? 'In an untitled chapter: $message'
            : 'In “${chapter.title.trim()}”: $message',
        blocking: true,
      ),
    if (fields.isNotEmpty || chapters.isEmpty)
      PublishChecklistItem(
        kind: PublishChecklistKind.contentRestricted,
        message: fields.isEmpty
            ? message
            : 'In your book’s ${_fieldList(fields)}: $message '
                  'Change it in Book settings.',
        blocking: true,
      ),
  ];

  static String _fieldList(List<String> fields) {
    final labels = [
      for (final field in fields)
        switch (field) {
          'authorName' => 'author name',
          'artStyle' => 'art style',
          _ => field,
        },
    ];
    if (labels.length == 1) return labels.single;
    return '${labels.sublist(0, labels.length - 1).join(', ')} and '
        '${labels.last}';
  }
}

/// The `manuscript` block on a project summary: enough for the book page and
/// the library to show writing progress without loading the working copy.
class MobileManuscriptSummary {
  const MobileManuscriptSummary({
    required this.wordCount,
    required this.chapterCount,
    required this.published,
    required this.hasUnpublishedChanges,
    this.goalWords,
  });

  final int wordCount;
  final int chapterCount;
  final int? goalWords;
  final bool published;
  final bool hasUnpublishedChanges;

  double? get goalProgress {
    final goal = goalWords;
    if (goal == null || goal <= 0) return null;
    return (wordCount / goal).clamp(0, 1).toDouble();
  }

  static MobileManuscriptSummary? fromJsonOrNull(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    return MobileManuscriptSummary(
      wordCount: json['wordCount'] as int? ?? 0,
      chapterCount: json['chapterCount'] as int? ?? 0,
      goalWords: json['goalWords'] as int?,
      published: json['published'] as bool? ?? false,
      hasUnpublishedChanges: json['hasUnpublishedChanges'] as bool? ?? false,
    );
  }
}

/// A freshly created Studio book: the project, its working copy, and the
/// empty first chapter the editor opens on.
class StudioBookCreated {
  const StudioBookCreated({
    required this.projectId,
    required this.manuscript,
    required this.chapter,
  });

  final String projectId;
  final Manuscript manuscript;
  final ManuscriptChapter chapter;
}
