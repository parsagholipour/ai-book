part of 'studio_screen.dart';

/// The chapter and book tools — draft, feedback, consistency, outline — and
/// what their results do: the AI inbox, the draft preview, the notes panel,
/// the outline becoming chapters.
extension _StudioScreenAiBook on _StudioScreenState {
  Future<void> _openBookTools() async {
    final document = _session.document;
    if (document == null) return;
    final tool = await showStudioBookToolsSheet(
      context,
      projectId: widget.projectId,
      chapterChars: document.markdown.length,
      pictureBook: document.isPictureLayout,
      blankBook: _session.isBlankStudioBook,
    );
    if (tool == null || !mounted) return;
    switch (tool) {
      case StudioBookTool.draft:
        await _draftChapter();
      case StudioBookTool.feedback:
        await _chapterFeedback();
      case StudioBookTool.consistency:
        await _checkConsistency();
      case StudioBookTool.outline:
        await _planChapters();
      case StudioBookTool.illustrateAll:
        await _illustrateEveryPage();
    }
  }

  /// Starts a background tool. What is on screen is saved first: the tool
  /// reads the chapter from the server.
  Future<ManuscriptAssist> _startLong(LongAssistRequest request) async {
    await _session.flush();
    final assist = await ref
        .read(studioRepositoryProvider)
        .startAssist(widget.projectId, request);
    ref.invalidate(billingProvider);
    // Followed from the moment it is paid for, even if its sheet is swiped
    // away before it can say so: the result still reaches the inbox.
    if (mounted) _ai.track(assist);
    return assist;
  }

  /// After a paid start: wait with the author (or let them go back to
  /// writing), then show the result.
  Future<void> _followAssist(ManuscriptAssist assist) async {
    _ai.track(assist);
    final ready = await showStudioAssistWaitSheet(
      context,
      controller: _ai,
      assistId: assist.id,
      kind: assist.kind,
    );
    if (ready != null && mounted) await _useAssist(ready);
  }

  Future<void> _draftChapter() async {
    final chapterId = _session.chapterId;
    if (chapterId == null) return;
    final base = newStudioRequestId('studio-draft');
    final assist = await showStudioDraftSheet(
      context,
      projectId: widget.projectId,
      chapterTitle: _chapterLabel(chapterId) ?? '',
      notes: _session.notes,
      editNotes: () async {
        final notes = await showChapterNotesSheet(
          context,
          notes: _session.notes,
        );
        if (notes != null) {
          _session.setNotes(notes);
          await _session.saveNow();
        }
        return _session.notes;
      },
      start: (words, notes) => _startLong(
        LongAssistRequest(
          kind: LongAssistKind.draftChapter,
          requestId: '$base-$words-${notes.hashCode}',
          chapterId: chapterId,
          notes: notes,
          targetWords: words,
        ),
      ),
    );
    if (assist != null && mounted) await _followAssist(assist);
  }

  Future<void> _chapterFeedback() async {
    final chapterId = _session.chapterId;
    final document = _session.document;
    if (chapterId == null || document == null) return;
    final chars = document.markdown.length;
    if (document.words == 0) {
      showStudioMessage(
        'Write some of this chapter first — feedback reads what’s there.',
      );
      return;
    }
    final requestId = newStudioRequestId('studio-feedback');
    final assist = await showStudioPaidToolSheet(
      context,
      projectId: widget.projectId,
      title: 'Chapter feedback',
      icon: Icons.rate_review_outlined,
      description:
          'Notes on pacing, clarity, continuity and dialogue in '
          '“${_chapterLabel(chapterId) ?? 'this chapter'}”, each pinned to '
          'the lines it’s about.',
      actionLabel: 'Get feedback',
      reason: 'Feedback on this chapter.',
      price: (ref) => watchStudioAssistPrice(
        ref,
        widget.projectId,
        LongAssistKind.chapterFeedback,
        chapterChars: chars,
      ),
      start: () => _startLong(
        LongAssistRequest(
          kind: LongAssistKind.chapterFeedback,
          requestId: requestId,
          chapterId: chapterId,
        ),
      ),
    );
    if (assist != null && mounted) await _followAssist(assist);
  }

  Future<void> _checkConsistency() async {
    final requestId = newStudioRequestId('studio-consistency');
    final assist = await showStudioPaidToolSheet(
      context,
      projectId: widget.projectId,
      title: 'Check consistency',
      icon: Icons.fact_check_outlined,
      description:
          'Reads every chapter for names, ages, places and dates that '
          'disagree, and shows you where.',
      actionLabel: 'Check the book',
      reason: 'A consistency check of your whole book.',
      price: (ref) => watchStudioAssistPrice(
        ref,
        widget.projectId,
        LongAssistKind.consistency,
      ),
      start: () => _startLong(
        LongAssistRequest(
          kind: LongAssistKind.consistency,
          requestId: requestId,
        ),
      ),
    );
    if (assist != null && mounted) await _followAssist(assist);
  }

  Future<void> _planChapters() async {
    final base = newStudioRequestId('studio-outline');
    final assist = await showStudioOutlineSheet(
      context,
      projectId: widget.projectId,
      pictureBook: _session.manuscript?.isPictureBook ?? false,
      start: (premise) => _startLong(
        LongAssistRequest(
          kind: LongAssistKind.outline,
          requestId: '$base-${premise.hashCode}',
          notes: premise,
        ),
      ),
    );
    if (assist != null && mounted) await _followAssist(assist);
  }

  // ---------------------------------------------------------------------------
  // Results

  Future<void> _openInbox() async {
    final assist = await showStudioAiInboxSheet(
      context,
      controller: _ai,
      chapterLabel: _chapterLabel,
    );
    if (assist != null && mounted) await _useAssist(assist);
  }

  /// Uses a finished assist, from the wait sheet, the inbox or a snack bar.
  Future<void> _useAssist(ManuscriptAssist assist) async {
    switch (assist.result) {
      case final AssistImageResult result:
        await _insertReadyPicture(assist, result);
      case final AssistDraftResult result:
        await _previewDraft(assist, result);
      case final AssistNotesResult result:
        await _showNotes(assist, result);
      case final AssistOutlineResult result:
        await _previewOutline(assist, result);
      case null:
        break;
    }
  }

  /// "Chapter 3 · The Harbour" (a picture book's parts go by title alone).
  String? _chapterLabel(String? chapterId) {
    final manuscript = _session.manuscript;
    if (chapterId == null || manuscript == null) return null;
    final chapter = manuscript.chapterById(chapterId);
    if (chapter == null) return null;
    return manuscript.isPictureBook
        ? chapter.displayTitle
        : 'Chapter ${chapter.position} · ${chapter.displayTitle}';
  }

  Future<void> _previewDraft(
    ManuscriptAssist assist,
    AssistDraftResult result,
  ) async {
    final chapterId = assist.chapterId;
    if (chapterId != null && chapterId != _session.chapterId) {
      await _session.switchChapter(chapterId);
      if (!mounted || _session.chapterId != chapterId) return;
    }
    final document = _session.document;
    if (document == null) return;
    final choice = await showStudioDraftPreviewSheet(
      context,
      markdown: result.markdown,
      chapterTitle: _chapterLabel(_session.chapterId) ?? '',
      chapterHasText: document.markdown.trim().isNotEmpty,
    );
    if (choice == null || !mounted) return;
    if (choice == StudioDraftChoice.discard) {
      await _ai.dismiss(assist.id);
      return;
    }
    if (!identical(document, _session.document)) return;
    if (!await _session.checkpointBeforeAi()) return;
    if (!mounted || !identical(document, _session.document)) return;
    final draft = result.markdown.trim();
    if (choice == StudioDraftChoice.replaceChapter) {
      document.replaceContent(title: document.title.text, markdown: draft);
    } else {
      _appendDraft(document, draft);
    }
    await _ai.markApplied(assist.id);
    showStudioMessage(
      choice == StudioDraftChoice.replaceChapter
          ? 'The draft is your chapter now. Your earlier text is in Version '
                'history.'
          : 'The draft is at the end of your chapter.',
    );
  }

  /// Adds [draft] after the chapter's last words. Plain prose goes through
  /// the last text field's own controller, so its Undo takes it back; a
  /// draft with pictures or pages is laid out again as blocks.
  void _appendDraft(StudioDocument document, String draft) {
    final plain = parseManuscriptBlocks(draft).every((b) => b is TextBlock);
    if (plain) {
      final last = document.lastText;
      final text = last.text.trimRight();
      final joined = text.isEmpty ? draft : '$text\n\n$draft';
      last.controller.value = TextEditingValue(
        text: joined,
        selection: TextSelection.collapsed(offset: joined.length),
      );
      return;
    }
    final current = document.markdown.trim();
    document.replaceContent(
      title: document.title.text,
      markdown: current.isEmpty ? draft : '$current\n\n$draft',
    );
  }

  Future<void> _showNotes(
    ManuscriptAssist assist,
    AssistNotesResult result,
  ) async {
    final chapterId = assist.chapterId;
    if (assist.kind == LongAssistKind.chapterFeedback &&
        chapterId != null &&
        chapterId != _session.chapterId) {
      await _session.switchChapter(chapterId);
      if (!mounted) return;
    }
    _ai.showNotes(
      StudioNotesView(
        assistId: assist.id,
        kind: assist.kind,
        notes: result.notes,
        chapterId: chapterId,
      ),
    );
  }

  /// A note's quote, found and selected in the text — in another chapter,
  /// that chapter opens first.
  Future<void> _selectNote(AssistNote note) async {
    final quote = note.quote?.trim();
    if (quote == null || quote.isEmpty) return;
    final view = _ai.notes;
    final target =
        note.chapterId ??
        (view?.kind == LongAssistKind.chapterFeedback ? view?.chapterId : null);
    var switched = false;
    if (target != null && target != _session.chapterId) {
      await _session.switchChapter(target);
      if (!mounted) return;
      switched = true;
    }
    void select() {
      final document = _session.document;
      if (!mounted || document == null) return;
      if (!_selectQuote(document, quote)) {
        showStudioMessage('That passage isn’t in the chapter any more.');
      }
    }

    if (switched) {
      // The chapter's fields exist from the next frame.
      WidgetsBinding.instance.addPostFrameCallback((_) => select());
      WidgetsBinding.instance.scheduleFrame();
    } else {
      select();
    }
  }

  /// Selects [quote] in the first text field holding it — exactly, or with
  /// its spacing and line breaks loosened.
  bool _selectQuote(StudioDocument document, String quote) {
    final words = quote.split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    final loose = RegExp(words.map(RegExp.escape).join(r'\s+'));
    for (final entry in document.textEntries) {
      final text = entry.text;
      var start = text.indexOf(quote);
      var end = start + quote.length;
      if (start < 0) {
        final match = loose.firstMatch(text);
        if (match == null) continue;
        start = match.start;
        end = match.end;
      }
      entry.controller.selection = TextSelection(
        baseOffset: start,
        extentOffset: end,
      );
      entry.focusNode.requestFocus();
      return true;
    }
    return false;
  }

  Future<void> _previewOutline(
    ManuscriptAssist assist,
    AssistOutlineResult result,
  ) async {
    final chapters = [
      for (final chapter in result.chapters)
        if (chapter.title.trim().isNotEmpty)
          (title: chapter.title.trim(), notes: chapter.notes.trim()),
    ];
    if (chapters.isEmpty) {
      showStudioMessage('The outline came back empty. Try planning again.');
      await _ai.dismiss(assist.id);
      return;
    }
    final choice = await showStudioOutlinePreviewSheet(
      context,
      chapters: [
        for (final chapter in chapters)
          AssistOutlineChapter(title: chapter.title, notes: chapter.notes),
      ],
      apply: (progress) => _session.createChaptersFromOutline(
        assist.id,
        chapters,
        onProgress: progress,
      ),
    );
    if (!mounted) return;
    switch (choice) {
      case StudioOutlineChoice.used:
        await _ai.markApplied(assist.id);
        _refreshBookSurfaces();
        showStudioMessage(
          chapters.length == 1
              ? 'Your plan is in the chapter notes.'
              : 'Your outline is in: ${chapters.length} chapters, each with '
                    'its notes.',
        );
      case StudioOutlineChoice.discarded:
        await _ai.dismiss(assist.id);
      case null:
        break;
    }
  }
}
