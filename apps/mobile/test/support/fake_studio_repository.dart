import 'dart:async';

import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// An in-memory Writing Studio server for widget tests.
///
/// It keeps chapters, revisions and versions the way the real routes do, so a
/// test can drive the editor through saves, conflicts, reorders and publishes
/// without a network. Every call is recorded in [calls].
class FakeStudioRepository implements StudioRepository {
  FakeStudioRepository({
    this.projectId = 'p1',
    this.layout = ManuscriptLayout.flow,
    this.kind = ManuscriptKind.story,
    this.source = 'written',
    this.title = 'My book',
    List<FakeStudioChapter>? chapters,
    this.published = false,
  }) : chapters =
           chapters ??
           [FakeStudioChapter(id: 'c1', title: 'Chapter 1', markdown: '')];

  final String projectId;
  ManuscriptLayout layout;
  ManuscriptKind kind;
  final String source;
  String title;
  String? subtitle;
  String? authorName;
  String? dedication;
  String? artStyle;
  int? goalWords;
  bool published;
  int revision = 1;
  final List<FakeStudioChapter> chapters;
  final List<FakeStudioChapter> deleted = [];
  final List<String> calls = [];
  final List<ManuscriptUploadedImage> uploads = [];

  /// Set to make the next save of this chapter answer CHAPTER_CONFLICT.
  String? conflictNextSaveOf;

  /// Set to make [publish] (and the checklist) fail with this code.
  String? publishErrorCode;

  /// Set to make the next [publish] alone fail with this error — a refusal
  /// carrying details, say. The checklist still loads.
  Object? publishError;

  /// Items the dry-run checklist reports.
  List<PublishChecklistItem> checklistItems = const [];

  /// Every chapter save, with what it sent.
  final List<FakeStudioSave> saves = [];

  /// Makes the next [failSaves] saves fail as if the network were down.
  int failSaves = 0;

  /// Makes the next save fail with this error instead.
  Object? nextSaveError;

  /// Makes image uploads fail with this error.
  Object? uploadError;

  /// Every settings change, as the repository was handed it.
  final List<ManuscriptSettingsUpdate> settingsUpdates = [];

  /// The arguments of every [createBook] call.
  final List<({ManuscriptKind kind, String? title, String requestId})>
  createRequests = [];

  /// Set to make [createBook] fail with this error.
  Object? createError;

  /// Set to hold [publish] until the test completes it, so the progress state
  /// can be looked at.
  Completer<void>? publishGate;

  /// The book's cast (library character ids).
  List<String> castCharacterIds = const [];
  ManuscriptCover cover = ManuscriptCover.designed;

  /// Every quick assist asked for, in order.
  final List<QuickAssistRequest> quickAssistRequests = [];

  /// What the next quick assist answers; by default a deterministic echo of
  /// the request (see [defaultQuickAssistResult]).
  QuickAssistResult? nextQuickAssistResult;

  /// Makes the next quick assist fail with this error.
  Object? quickAssistError;

  /// Holds quick assists open until completed, to test waiting states.
  Completer<void>? quickAssistGate;

  /// Background tools, newest last.
  final List<ManuscriptAssist> assists = [];
  final List<LongAssistRequest> longAssistRequests = [];

  /// Makes the next background tool request fail with this error.
  Object? startAssistError;

  /// Refuses the background tool request numbered [refuseStartAt] (0-based,
  /// counting every request) with [startAssistError]'s kind of error — for a
  /// run of requests where one in the middle is refused.
  int? refuseStartAt;
  Object? refuseStartWith;

  /// Every plan-to-manuscript conversion asked for.
  final List<String> conversions = [];

  /// Makes the next cover request (upload, generate or designed) fail with
  /// this error.
  Object? coverError;

  /// Holds cover uploads open until completed, to look at their progress.
  Completer<void>? coverGate;

  /// The request id of every [generateCover] call, in order.
  final List<String> coverRequestIds = [];

  /// Makes the next plan conversion fail with this error.
  Object? convertError;

  int _nextId = 100;
  final DateTime _now = DateTime.utc(2026, 9, 29, 12);

  FakeStudioChapter _chapter(String chapterId) =>
      chapters.firstWhere((chapter) => chapter.id == chapterId);

  Manuscript snapshot() {
    final live = [...chapters];
    return Manuscript(
      projectId: projectId,
      revision: revision,
      source: source,
      layout: layout,
      kind: kind,
      title: title,
      subtitle: subtitle,
      authorName: authorName,
      dedication: dedication,
      artStyle: artStyle,
      goalWords: goalWords,
      language: 'en',
      wordCount: live.fold(0, (sum, chapter) => sum + chapter.wordCount),
      published: published,
      hasUnpublishedChanges: live.any((chapter) => chapter.unpublished),
      chapters: [
        for (var i = 0; i < live.length; i++) live[i].summary(i + 1, _now),
      ],
      updatedAt: _now,
      castCharacterIds: castCharacterIds,
      cover: cover,
    );
  }

  @override
  Future<StudioBookCreated> createBook({
    required ManuscriptKind kind,
    required String requestId,
    String? title,
    String? language,
  }) async {
    calls.add('createBook');
    createRequests.add((kind: kind, title: title, requestId: requestId));
    if (createError case final error?) throw error;
    this.kind = kind;
    layout = kind.defaultLayout;
    if (title != null && title.trim().isNotEmpty) this.title = title.trim();
    return StudioBookCreated(
      projectId: projectId,
      manuscript: snapshot(),
      chapter: chapters.first.full(1, _now),
    );
  }

  @override
  Future<Manuscript> getManuscript(String projectId) async {
    calls.add('getManuscript');
    return snapshot();
  }

  @override
  Future<ManuscriptChapter> getChapter(
    String projectId,
    String chapterId,
  ) async {
    calls.add('getChapter:$chapterId');
    final index = chapters.indexWhere((chapter) => chapter.id == chapterId);
    if (index < 0) {
      throw const ApiException(
        code: 'CHAPTER_NOT_FOUND',
        message: 'Chapter not found.',
        statusCode: 404,
      );
    }
    return chapters[index].full(index + 1, _now);
  }

  @override
  Future<ManuscriptChapterSaveResult> saveChapter({
    required String projectId,
    required String chapterId,
    required String title,
    required String markdown,
    required int baseRevision,
    String? notes,
    ManuscriptChapterStatus? status,
    ManuscriptSaveCheckpoint? checkpoint,
    ManuscriptConflictResolution? resolveConflict,
  }) async {
    calls.add('saveChapter:$chapterId');
    saves.add(
      FakeStudioSave(
        chapterId: chapterId,
        title: title,
        markdown: markdown,
        baseRevision: baseRevision,
        notes: notes,
        status: status,
        checkpoint: checkpoint,
        resolveConflict: resolveConflict,
      ),
    );
    final error = nextSaveError;
    if (error != null) {
      nextSaveError = null;
      throw error;
    }
    if (failSaves > 0) {
      failSaves--;
      throw const ApiException(
        code: 'NETWORK_ERROR',
        message: 'No connection.',
      );
    }
    final chapter = _chapter(chapterId);
    final position = chapters.indexOf(chapter) + 1;
    if (conflictNextSaveOf == chapterId || baseRevision != chapter.revision) {
      conflictNextSaveOf = null;
      throw ManuscriptChapterConflictException(chapter.full(position, _now));
    }
    if (checkpoint != null) {
      chapter.versions.insert(
        0,
        ManuscriptVersion(
          id: 'v${_nextId++}',
          reason: checkpoint == ManuscriptSaveCheckpoint.beforeAi
              ? ManuscriptVersionReason.beforeAi
              : ManuscriptVersionReason.restore,
          title: chapter.title,
          wordCount: chapter.wordCount,
          createdAt: _now,
          markdown: chapter.markdown,
        ),
      );
    }
    if (resolveConflict == ManuscriptConflictResolution.book &&
        chapter.conflict != null) {
      chapter
        ..title = chapter.conflict!.title
        ..markdown = chapter.conflict!.markdown;
    } else {
      chapter
        ..title = title
        ..markdown = markdown;
    }
    if (resolveConflict != null) chapter.conflict = null;
    if (notes != null) chapter.notes = notes;
    if (status != null) chapter.status = status;
    chapter
      ..revision += 1
      ..unpublished = true;
    revision += 1;
    return ManuscriptChapterSaveResult(
      chapter: chapter.summary(position, _now),
      manuscriptRevision: revision,
      savedAt: _now,
    );
  }

  @override
  Future<({ManuscriptChapter chapter, Manuscript manuscript})> addChapter({
    required String projectId,
    required String requestId,
    String? afterChapterId,
    String? title,
  }) async {
    calls.add('addChapter');
    // As the API reads it: a null is "before the first chapter", not "at the
    // end" — an add meant for the end has to name the last chapter.
    final after = afterChapterId == null
        ? -1
        : chapters.indexWhere((item) => item.id == afterChapterId);
    final chapter = FakeStudioChapter(
      id: 'c${_nextId++}',
      // Named by the place it lands in, as the API names it.
      title: title ?? 'Chapter ${after + 2}',
      markdown: '',
    )..unpublished = true;
    chapters.insert(after + 1, chapter);
    revision += 1;
    return (chapter: chapter.full(after + 2, _now), manuscript: snapshot());
  }

  @override
  Future<Manuscript> deleteChapter(String projectId, String chapterId) async {
    calls.add('deleteChapter:$chapterId');
    if (chapters.length == 1) {
      throw const ApiException(
        code: 'LAST_CHAPTER',
        message: 'A book needs at least one chapter.',
        statusCode: 409,
      );
    }
    final chapter = _chapter(chapterId);
    chapter.deletedAt = chapters.indexOf(chapter);
    chapters.remove(chapter);
    deleted.add(chapter);
    revision += 1;
    return snapshot();
  }

  @override
  Future<Manuscript> restoreChapter(String projectId, String chapterId) async {
    calls.add('restoreChapter:$chapterId');
    final chapter = deleted.firstWhere((item) => item.id == chapterId);
    deleted.remove(chapter);
    chapters.insert(
      (chapter.deletedAt ?? chapters.length).clamp(0, chapters.length),
      chapter,
    );
    chapter.deletedAt = null;
    revision += 1;
    return snapshot();
  }

  @override
  Future<Manuscript> reorderChapters(
    String projectId,
    List<String> chapterIds,
  ) async {
    calls.add('reorderChapters');
    final byId = {for (final chapter in chapters) chapter.id: chapter};
    chapters
      ..clear()
      ..addAll(chapterIds.map((id) => byId[id]!));
    revision += 1;
    return snapshot();
  }

  @override
  Future<Manuscript> updateSettings(
    String projectId,
    ManuscriptSettingsUpdate update,
  ) async {
    calls.add('updateSettings');
    settingsUpdates.add(update);
    if (update.title != null) title = update.title!;
    subtitle = update.clear.contains('subtitle')
        ? null
        : update.subtitle ?? subtitle;
    authorName = update.clear.contains('authorName')
        ? null
        : update.authorName ?? authorName;
    dedication = update.clear.contains('dedication')
        ? null
        : update.dedication ?? dedication;
    artStyle = update.clear.contains('artStyle')
        ? null
        : update.artStyle ?? artStyle;
    goalWords = update.clear.contains('goalWords')
        ? null
        : update.goalWords ?? goalWords;
    if (update.layout != null) layout = update.layout!;
    if (update.castCharacterIds != null) {
      castCharacterIds = List.of(update.castCharacterIds!);
    }
    revision += 1;
    return snapshot();
  }

  @override
  Future<List<ManuscriptVersionSummary>> listVersions(
    String projectId,
    String chapterId,
  ) async {
    calls.add('listVersions:$chapterId');
    return List.of(_chapter(chapterId).versions);
  }

  @override
  Future<ManuscriptVersion> getVersion(
    String projectId,
    String chapterId,
    String versionId,
  ) async {
    calls.add('getVersion:$versionId');
    return _chapter(
      chapterId,
    ).versions.firstWhere((version) => version.id == versionId);
  }

  @override
  Future<ManuscriptUploadedImage> uploadImage({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) async {
    calls.add('uploadImage:$filename');
    final error = uploadError;
    if (error != null) throw error;
    onProgress?.call(bytes.length, bytes.length);
    final image = ManuscriptUploadedImage(
      url: '/assets/images/$projectId/upload-${_nextId++}.jpg',
      width: 1200,
      height: 900,
    );
    uploads.add(image);
    return image;
  }

  @override
  Future<PublishChecklist> publishChecklist(
    String projectId, {
    required String requestId,
  }) async {
    calls.add('publishChecklist');
    _throwPublishError();
    return PublishChecklist(
      firstPublish: !published,
      words: snapshot().wordCount,
      estimatedPages: chapters.length * 3,
      changedChapters: chapters.where((chapter) => chapter.unpublished).length,
      items: checklistItems,
    );
  }

  @override
  Future<Manuscript> publish(
    String projectId, {
    required String requestId,
  }) async {
    calls.add('publish');
    if (publishGate case final gate?) await gate.future;
    _throwPublishError();
    if (publishError case final error?) {
      publishError = null;
      throw error;
    }
    published = true;
    for (final chapter in chapters) {
      chapter.unpublished = false;
    }
    revision += 1;
    return snapshot();
  }

  @override
  Future<QuickAssistResult> runQuickAssist(
    String projectId,
    QuickAssistRequest request,
  ) async {
    calls.add('runQuickAssist:${request.kind.wire}');
    quickAssistRequests.add(request);
    await quickAssistGate?.future;
    final error = quickAssistError;
    if (error != null) {
      quickAssistError = null;
      throw error;
    }
    final scripted = nextQuickAssistResult;
    nextQuickAssistResult = null;
    return scripted ?? defaultQuickAssistResult(request);
  }

  /// A deterministic answer per kind, shaped like the server's.
  static QuickAssistResult defaultQuickAssistResult(
    QuickAssistRequest request,
  ) {
    final selection = request.selection ?? '';
    return switch (request.kind) {
      QuickAssistKind.rewrite || QuickAssistKind.describe => QuickAssistResult(
        kind: request.kind,
        suggestions: ['$selection (revised)'],
        corrections: const [],
        ideas: const [],
      ),
      QuickAssistKind.continueWriting => QuickAssistResult(
        kind: request.kind,
        suggestions: const [' The wind rose over the harbour.'],
        corrections: const [],
        ideas: const [],
      ),
      QuickAssistKind.proofread => QuickAssistResult(
        kind: request.kind,
        suggestions: const [],
        corrections: selection.contains('teh')
            ? const [
                AssistCorrection(
                  find: 'teh',
                  replace: 'the',
                  reason: 'Spelling',
                ),
              ]
            : const [],
        ideas: const [],
      ),
      QuickAssistKind.brainstorm => QuickAssistResult(
        kind: request.kind,
        suggestions: const [],
        corrections: const [],
        ideas: const [
          AssistIdea(title: 'A letter arrives', text: 'Someone writes back.'),
          AssistIdea(title: 'The storm', text: 'The weather turns.'),
          AssistIdea(title: 'A stranger', text: 'Someone new walks in.'),
        ],
      ),
      QuickAssistKind.ask => QuickAssistResult(
        kind: request.kind,
        suggestions: const [],
        corrections: const [],
        ideas: const [],
        answer: 'It reads clearly.',
      ),
    };
  }

  @override
  Future<ManuscriptAssist> startAssist(
    String projectId,
    LongAssistRequest request,
  ) async {
    calls.add('startAssist:${request.kind.wire}');
    longAssistRequests.add(request);
    final error = startAssistError;
    if (error != null) {
      startAssistError = null;
      throw error;
    }
    final refusal = refuseStartWith;
    if (refusal != null && longAssistRequests.length - 1 == refuseStartAt) {
      throw refusal;
    }
    final assist = ManuscriptAssist(
      id: 'a${_nextId++}',
      kind: request.kind,
      status: ManuscriptAssistStatus.queued,
      chapterId: request.chapterId,
      creditsCharged: request.kind == LongAssistKind.illustrate ? 45 : 80,
      createdAt: _now,
    );
    assists.add(assist);
    return assist;
  }

  /// Lands a background tool's result, as the worker would.
  void completeAssist(String assistId, AssistResult result) {
    _replaceAssist(assistId, ManuscriptAssistStatus.ready, result: result);
  }

  /// Fails a background tool with a reader-facing sentence.
  void failAssist(String assistId, String error) {
    _replaceAssist(assistId, ManuscriptAssistStatus.failed, error: error);
  }

  ManuscriptAssist _replaceAssist(
    String assistId,
    ManuscriptAssistStatus status, {
    AssistResult? result,
    String? error,
  }) {
    final index = assists.indexWhere((assist) => assist.id == assistId);
    final old = assists[index];
    final next = ManuscriptAssist(
      id: old.id,
      kind: old.kind,
      status: status,
      chapterId: old.chapterId,
      creditsCharged: old.creditsCharged,
      createdAt: old.createdAt,
      error: error ?? old.error,
      result: result ?? old.result,
    );
    assists[index] = next;
    return next;
  }

  @override
  Future<List<ManuscriptAssist>> listOpenAssists(
    String projectId, {
    String? chapterId,
  }) async {
    calls.add('listOpenAssists');
    return assists
        .where(
          (assist) =>
              (assist.status.isWorking ||
                  assist.status == ManuscriptAssistStatus.ready) &&
              (chapterId == null || assist.chapterId == chapterId),
        )
        .toList(growable: false);
  }

  @override
  Future<ManuscriptAssist> getAssist(String projectId, String assistId) async {
    calls.add('getAssist:$assistId');
    return assists.firstWhere((assist) => assist.id == assistId);
  }

  @override
  Future<ManuscriptAssist> dismissAssist(
    String projectId,
    String assistId,
  ) async {
    calls.add('dismissAssist:$assistId');
    return _replaceAssist(assistId, ManuscriptAssistStatus.dismissed);
  }

  @override
  Future<ManuscriptAssist> markAssistApplied(
    String projectId,
    String assistId,
  ) async {
    calls.add('markAssistApplied:$assistId');
    return _replaceAssist(assistId, ManuscriptAssistStatus.applied);
  }

  @override
  Future<Manuscript> uploadCover({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) async {
    calls.add('uploadCover:$filename');
    onProgress?.call(bytes.length ~/ 2, bytes.length);
    if (coverGate case final gate?) await gate.future;
    _throwCoverError();
    onProgress?.call(bytes.length, bytes.length);
    cover = ManuscriptCover(
      source: ManuscriptCoverSource.upload,
      pending: false,
      imageUrl: '/assets/images/$projectId/cover-upload-${_nextId++}.jpg',
    );
    return snapshot();
  }

  @override
  Future<Manuscript> generateCover(
    String projectId, {
    required String requestId,
  }) async {
    calls.add('generateCover');
    coverRequestIds.add(requestId);
    _throwCoverError();
    cover = ManuscriptCover(
      source: ManuscriptCoverSource.ai,
      pending: true,
      imageUrl: cover.imageUrl,
    );
    return snapshot();
  }

  @override
  Future<Manuscript> useDesignedCover(String projectId) async {
    calls.add('useDesignedCover');
    _throwCoverError();
    cover = ManuscriptCover(
      source: ManuscriptCoverSource.design,
      pending: true,
      imageUrl: cover.imageUrl,
    );
    return snapshot();
  }

  @override
  Future<Manuscript> convertPlanToManuscript(
    String projectId, {
    required String requestId,
  }) async {
    calls.add('convertPlanToManuscript');
    conversions.add(projectId);
    final error = convertError;
    if (error != null) {
      convertError = null;
      throw error;
    }
    return snapshot();
  }

  /// Every [takeOverBook] call, by project id.
  final List<String> takeovers = [];

  /// Set to make the next [takeOverBook] fail with this error.
  Object? takeoverError;

  /// Set to hold [takeOverBook] until the test completes it.
  Completer<void>? takeoverGate;

  @override
  Future<Manuscript> takeOverBook(
    String projectId, {
    required String requestId,
  }) async {
    calls.add('takeOverBook');
    takeovers.add(projectId);
    final gate = takeoverGate;
    if (gate != null) await gate.future;
    final error = takeoverError;
    if (error != null) {
      takeoverError = null;
      throw error;
    }
    published = true;
    return snapshot();
  }

  void _throwCoverError() {
    final error = coverError;
    if (error == null) return;
    coverError = null;
    throw error;
  }

  void _throwPublishError() {
    final code = publishErrorCode;
    if (code == null) return;
    throw ApiException(
      code: code,
      message: 'Publishing failed ($code).',
      statusCode: 409,
    );
  }
}

/// What one `saveChapter` call sent.
class FakeStudioSave {
  const FakeStudioSave({
    required this.chapterId,
    required this.title,
    required this.markdown,
    required this.baseRevision,
    this.notes,
    this.status,
    this.checkpoint,
    this.resolveConflict,
  });

  final String chapterId;
  final String title;
  final String markdown;
  final int baseRevision;
  final String? notes;
  final ManuscriptChapterStatus? status;
  final ManuscriptSaveCheckpoint? checkpoint;
  final ManuscriptConflictResolution? resolveConflict;
}

/// One chapter of a [FakeStudioRepository].
class FakeStudioChapter {
  FakeStudioChapter({
    required this.id,
    required this.title,
    required this.markdown,
    this.notes = '',
    this.status = ManuscriptChapterStatus.drafting,
    this.revision = 1,
    this.unpublished = false,
    this.conflict,
    this.updatedAt,
    this.bookChapterId,
  });

  /// The book `Chapter` row this chapter published as.
  String? bookChapterId;

  final String id;

  /// When this chapter was last written in; the repository's clock if unset.
  DateTime? updatedAt;
  String title;
  String markdown;
  String notes;
  ManuscriptChapterStatus status;
  int revision;
  bool unpublished;
  ManuscriptChapterConflict? conflict;
  int? deletedAt;
  final List<ManuscriptVersion> versions = [];

  int get wordCount => markdown
      .split(RegExp(r'\s+'))
      .where((word) => RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(word))
      .length;

  ManuscriptChapterSummary summary(int position, DateTime now) {
    return ManuscriptChapterSummary(
      id: id,
      position: position,
      title: title,
      status: status,
      wordCount: wordCount,
      revision: revision,
      excerpt: markdown.length > 160 ? markdown.substring(0, 160) : markdown,
      hasUnpublishedChanges: unpublished,
      hasConflict: conflict != null,
      updatedAt: updatedAt ?? now,
      bookChapterId: bookChapterId,
    );
  }

  ManuscriptChapter full(int position, DateTime now) {
    final head = summary(position, now);
    return ManuscriptChapter(
      id: head.id,
      position: head.position,
      title: head.title,
      status: head.status,
      wordCount: head.wordCount,
      revision: head.revision,
      excerpt: head.excerpt,
      hasUnpublishedChanges: head.hasUnpublishedChanges,
      hasConflict: head.hasConflict,
      updatedAt: head.updatedAt,
      bookChapterId: head.bookChapterId,
      markdown: markdown,
      notes: notes,
      conflict: conflict,
    );
  }
}
