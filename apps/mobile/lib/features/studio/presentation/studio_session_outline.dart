part of 'studio_session.dart';

/// The outline half of the session: the book's chapters as a list — adding,
/// deleting and restoring, reordering, renaming and setting the status of
/// chapters other than the open one — and the outline copy that a save keeps
/// current. The open chapter's text, its saves and its conflicts are the
/// other half, in `studio_session.dart`.
extension StudioSessionOutline on StudioSession {
  /// Adds an empty chapter after [afterChapterId] — at the end of the book
  /// when that is null — and opens it with its title selected, so the first
  /// thing typed names it. Answers whether it was added; a second tap while
  /// one is on its way adds nothing.
  Future<bool> addChapter({String? afterChapterId}) async {
    if (_addingChapter) return false;
    _addingChapter = true;
    _notify();
    try {
      await flush();
      final chapters = _manuscript?.chapters ?? const [];
      final added = await _repository.addChapter(
        projectId: projectId,
        requestId: newStudioRequestId('studio-chapter'),
        // Always an id: the API reads a null as "before the first chapter".
        afterChapterId:
            afterChapterId ?? (chapters.isEmpty ? chapterId : chapters.last.id),
      );
      if (_disposed) return false;
      _manuscript = added.manuscript;
      _install(added.chapter);
      _nameAfterFrame(_document!);
      return true;
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
      return false;
    } finally {
      _addingChapter = false;
      _notify();
    }
  }

  /// A picture book's chapters are its parts.
  String get chapterNoun =>
      (_manuscript?.isPictureBook ?? false) ? 'part' : 'chapter';

  /// "Add chapter 4": says which chapter an add at the end makes, so the
  /// button never leaves the author guessing where it went.
  String get addChapterLabel => 'Add $chapterNoun ${chapterCount + 1}';

  /// Puts the cursor in a new chapter's title with its "Chapter 4" selected,
  /// once the editor has built the field.
  void _nameAfterFrame(StudioDocument document) {
    SchedulerBinding.instance
      ..addPostFrameCallback((_) {
        if (_disposed || _document != document) return;
        final title = document.title;
        title.selection = TextSelection(
          baseOffset: 0,
          extentOffset: title.text.length,
        );
        document.titleFocus.requestFocus();
      })
      ..scheduleFrame();
  }

  /// Deletes a chapter; the server keeps it for [restoreChapter]. Answers
  /// null when it went, or the sentence saying why it could not — for the
  /// caller to show where the author is looking (over a sheet, a snack bar on
  /// the page beneath would go unseen).
  Future<String?> deleteChapter(String id) async {
    final wasOpen = id == chapterId;
    if (wasOpen) await flush();
    final position = (_manuscript?.chapters ?? const []).indexWhere(
      (chapter) => chapter.id == id,
    );
    try {
      final manuscript = await _repository.deleteChapter(projectId, id);
      if (_disposed) return null;
      _manuscript = manuscript;
    } on ApiException catch (error) {
      return error.code == 'LAST_CHAPTER'
          ? 'A book needs at least one chapter, so this one stays.'
          : userFacingError(error);
    } catch (error) {
      return userFacingError(error);
    }
    if (wasOpen) {
      await _deleteBuffer(id);
      final chapters = _manuscript!.chapters;
      if (chapters.isNotEmpty) {
        final next = chapters[position.clamp(0, chapters.length - 1)];
        try {
          await _open(next.id);
        } catch (error) {
          delegate?.showStudioMessage(userFacingError(error));
        }
      }
    }
    _notify();
    return null;
  }

  Future<void> restoreChapter(String id) async {
    try {
      final manuscript = await _repository.restoreChapter(projectId, id);
      if (_disposed) return;
      _manuscript = manuscript;
      _notify();
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
    }
  }

  /// Moves a chapter; the outline changes at once and goes back if the
  /// server refuses.
  Future<void> reorderChapters(List<String> ids) async {
    final before = _manuscript;
    if (before == null) return;
    final byId = {for (final chapter in before.chapters) chapter.id: chapter};
    _manuscript = _withChapters(before, [
      for (var i = 0; i < ids.length; i++)
        if (byId[ids[i]] != null) _summaryAt(byId[ids[i]]!, i + 1),
    ]);
    _notify();
    try {
      final manuscript = await _repository.reorderChapters(projectId, ids);
      if (_disposed) return;
      _manuscript = manuscript;
    } catch (error) {
      _manuscript = before;
      delegate?.showStudioMessage(userFacingError(error));
    }
    _notify();
  }

  Future<void> renameChapter(String id, String title) async {
    if (id == chapterId) {
      _document?.title.text = title;
      await saveNow();
      return;
    }
    await _editOtherChapter(id, (chapter) => (title: title, status: null));
  }

  Future<void> setChapterStatus(
    String id,
    ManuscriptChapterStatus status,
  ) async {
    if (id == chapterId) {
      setStatus(status);
      return;
    }
    await _editOtherChapter(
      id,
      (chapter) => (title: chapter.title, status: status),
    );
  }

  Future<void> _editOtherChapter(
    String id,
    ({String title, ManuscriptChapterStatus? status}) Function(
      ManuscriptChapter chapter,
    )
    change,
  ) async {
    try {
      final chapter = await _repository.getChapter(projectId, id);
      final edit = change(chapter);
      final result = await _repository.saveChapter(
        projectId: projectId,
        chapterId: id,
        title: edit.title,
        markdown: chapter.markdown,
        notes: chapter.notes,
        status: edit.status ?? chapter.status,
        baseRevision: chapter.revision,
      );
      if (_disposed) return;
      _updateOutline(result.chapter);
      _notify();
    } catch (error) {
      delegate?.showStudioMessage(userFacingError(error));
    }
  }

  void _updateOutline(ManuscriptChapterSummary saved) {
    final manuscript = _manuscript;
    if (manuscript == null) return;
    _manuscript = _withChapters(manuscript, [
      for (final chapter in manuscript.chapters)
        chapter.id == saved.id
            ? _summaryAt(
                saved,
                chapter.position,
                // A save answers with the working copy; the book chapter it
                // published as is the outline's to keep.
                bookChapterId: saved.bookChapterId ?? chapter.bookChapterId,
              )
            : chapter,
    ]);
  }

  void _updateOutlineFromChapter(ManuscriptChapter chapter) =>
      _updateOutline(chapter);

  ManuscriptChapterSummary _summaryAt(
    ManuscriptChapterSummary chapter,
    int position, {
    String? bookChapterId,
  }) => ManuscriptChapterSummary(
    bookChapterId: bookChapterId ?? chapter.bookChapterId,
    id: chapter.id,
    position: position,
    title: chapter.title,
    status: chapter.status,
    wordCount: chapter.wordCount,
    revision: chapter.revision,
    excerpt: chapter.excerpt,
    hasUnpublishedChanges: chapter.hasUnpublishedChanges,
    hasConflict: chapter.hasConflict,
    updatedAt: chapter.updatedAt,
  );

  Manuscript _withChapters(
    Manuscript manuscript,
    List<ManuscriptChapterSummary> chapters,
  ) => Manuscript(
    projectId: manuscript.projectId,
    revision: manuscript.revision,
    source: manuscript.source,
    layout: manuscript.layout,
    kind: manuscript.kind,
    title: manuscript.title,
    language: manuscript.language,
    wordCount: chapters.fold(0, (sum, chapter) => sum + chapter.wordCount),
    published: manuscript.published,
    hasUnpublishedChanges:
        manuscript.hasUnpublishedChanges ||
        chapters.any((chapter) => chapter.hasUnpublishedChanges),
    chapters: chapters,
    updatedAt: manuscript.updatedAt,
    subtitle: manuscript.subtitle,
    authorName: manuscript.authorName,
    dedication: manuscript.dedication,
    artStyle: manuscript.artStyle,
    goalWords: manuscript.goalWords,
    publishBlock: manuscript.publishBlock,
    castCharacterIds: manuscript.castCharacterIds,
    cover: manuscript.cover,
  );

  /// Whether this is a book begun in the Studio with nothing written yet: a
  /// single chapter, empty. The one state "Plan my chapters with AI" offers
  /// itself in.
  bool get isBlankStudioBook {
    final manuscript = _manuscript;
    final document = _document;
    return manuscript != null &&
        document != null &&
        manuscript.source == 'written' &&
        manuscript.chapters.length == 1 &&
        document.markdown.trim().isEmpty;
  }

  /// Turns an AI outline into chapters. In a blank book the open chapter takes
  /// the first title and notes and the rest follow it in order; in a book
  /// with writing in it, every outline chapter is added after the last one,
  /// so nothing the author wrote is renamed. Each addition carries a request
  /// id derived from [key], so running this again after a failure replays the
  /// chapters already made instead of adding them twice. Answers null when
  /// every chapter is in, or the sentence saying why it stopped.
  Future<String?> createChaptersFromOutline(
    String key,
    List<({String title, String notes})> outline, {
    void Function(int done, int total)? onProgress,
  }) async {
    final document = _document;
    if (outline.isEmpty || document == null) return null;
    final total = outline.length;
    var first = 0;
    var after = chapterId;
    if (isBlankStudioBook ||
        (document.title.text == outline.first.title &&
            _notes == outline.first.notes)) {
      document.title.text = outline.first.title;
      setNotes(outline.first.notes);
      if (!await saveNow(force: true)) {
        return 'Your first chapter didn’t save. Check your connection and '
            'try again.';
      }
      first = 1;
      onProgress?.call(1, total);
    } else {
      final chapters = _manuscript?.chapters ?? const [];
      if (chapters.isNotEmpty) after = chapters.last.id;
    }
    try {
      for (var i = first; i < total; i++) {
        final item = outline[i];
        final added = await _repository.addChapter(
          projectId: projectId,
          requestId: 'studio-outline-$key-$i',
          afterChapterId: after,
          title: item.title,
        );
        final chapter = added.chapter;
        var manuscript = added.manuscript;
        if (item.notes.trim().isNotEmpty && chapter.notes != item.notes) {
          final saved = await _repository.saveChapter(
            projectId: projectId,
            chapterId: chapter.id,
            title: chapter.title,
            markdown: chapter.markdown,
            notes: item.notes,
            baseRevision: chapter.revision,
          );
          manuscript = _withChapters(manuscript, [
            for (final summary in manuscript.chapters)
              summary.id == saved.chapter.id
                  ? _summaryAt(saved.chapter, summary.position)
                  : summary,
          ]);
        }
        if (_disposed) return null;
        _manuscript = manuscript;
        after = chapter.id;
        onProgress?.call(i + 1, total);
        _notify();
      }
    } catch (error) {
      return userFacingError(error);
    }
    return null;
  }

  /// The book's words with the open chapter counted live.
  int get bookWords {
    final manuscript = _manuscript;
    if (manuscript == null) return chapterWords.value;
    var total = 0;
    for (final chapter in manuscript.chapters) {
      total += chapter.id == chapterId ? chapterWords.value : chapter.wordCount;
    }
    return total;
  }
}
