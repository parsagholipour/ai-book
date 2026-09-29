part of 'studio_screen.dart';

/// The text a writing-assistant tool was opened on: which segment of which
/// chapter, where the selection or cursor was, and the text around it.
class _AiTarget {
  const _AiTarget({
    required this.document,
    required this.entry,
    required this.window,
    required this.textAtRequest,
  });

  factory _AiTarget.capture(StudioDocument document, StudioTextEntry entry) {
    final texts = document.textEntries.toList();
    final index = texts.indexOf(entry);
    final value = entry.controller.value;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    return _AiTarget(
      document: document,
      entry: entry,
      textAtRequest: value.text,
      window: assistWindowFor(
        text: value.text,
        selection: selection,
        textBefore: [for (final text in texts.take(index)) text.text],
        textAfter: [for (final text in texts.skip(index + 1)) text.text],
      ),
    );
  }

  final StudioDocument document;
  final StudioTextEntry entry;
  final AssistWindow window;
  final String textAtRequest;

  /// Still the open chapter's text: nothing swapped it out meanwhile (a
  /// chapter switch, a version restored, a conflict settled).
  bool isLive(StudioSession session) =>
      identical(session.document, document) && document.contains(entry);
}

/// The quick tools and pictures: the selection menu, the keyboard's ✨, the
/// suggestion sheet's result going into the text, and pictures being drawn.
extension _StudioScreenAi on _StudioScreenState {
  void _rememberFocusedText() {
    final entry = _session.focusedText.value;
    if (entry != null) _lastText = entry;
  }

  /// The ✨ in the keyboard's toolbar: the tools for the selection or the
  /// cursor in [entry].
  Future<void> _openAiTools(StudioTextEntry entry) async {
    final document = _session.document;
    if (document == null) return;
    final target = _AiTarget.capture(document, entry);
    final tool = await showStudioAiToolsSheet(
      context,
      hasSelection: target.window.hasSelection,
      selectionLength: target.window.selection?.length ?? 0,
    );
    if (tool == null || !mounted) return;
    await _runTool(target, tool);
  }

  Future<void> _runTool(_AiTarget target, StudioAiTool tool) async {
    switch (tool) {
      case StudioQuickTool(:final kind, :final preset, :final instruction):
        await _runQuick(target, kind, preset: preset, instruction: instruction);
      case StudioIllustrateTool():
        await _illustrateText(target);
      case StudioBookToolsTool():
        await _openBookTools();
    }
  }

  /// A tool from the selection menu.
  Future<void> _runSelectionToolFor(
    StudioTextEntry entry,
    StudioSelectionTool tool,
  ) async {
    final document = _session.document;
    if (document == null) return;
    final target = _AiTarget.capture(document, entry);
    final selection = target.window.selection;
    if (selection == null) return;
    final tooLong = selection.length > assistSelectionChars;
    if (tooLong &&
        tool != StudioSelectionTool.rewrite &&
        tool != StudioSelectionTool.more) {
      showStudioMessage(
        'That’s a lot of text. Select a shorter passage — up to about a '
        'thousand words — and try again.',
      );
      return;
    }
    switch (tool) {
      case StudioSelectionTool.rewrite || StudioSelectionTool.more:
        // A rewrite needs a direction, so it opens on the tools sheet.
        final picked = await showStudioAiToolsSheet(
          context,
          hasSelection: true,
          selectionLength: selection.length,
        );
        if (picked != null && mounted) await _runTool(target, picked);
      case StudioSelectionTool.fix:
        await _runQuick(target, QuickAssistKind.proofread);
      case StudioSelectionTool.illustrate:
        await _illustrateText(target);
      case StudioSelectionTool.ask:
        await _runQuick(target, QuickAssistKind.ask);
    }
  }

  Future<void> _runQuick(
    _AiTarget target,
    QuickAssistKind kind, {
    RewritePreset? preset,
    String? instruction,
  }) async {
    final chapterId = _session.chapterId;
    if (chapterId == null) return;
    if (kind.needsSelection && !target.window.hasSelection) return;
    final acceptance = await showStudioQuickAssistSheet(
      context,
      projectId: widget.projectId,
      request: StudioQuickRequest(
        kind: kind,
        chapterId: chapterId,
        window: target.window,
        preset: preset,
        instruction: instruction,
      ),
    );
    if (acceptance == null || !mounted) return;
    await _accept(target, acceptance);
  }

  /// Puts an accepted suggestion into the text: a version checkpoint first,
  /// so version history keeps the text as it was; then the change goes
  /// through the field's own controller, so the field's Undo takes it back.
  Future<void> _accept(_AiTarget target, StudioAiAcceptance acceptance) async {
    const changed =
        'Your text changed while the assistant was working, so nothing was '
        'changed. Try again.';
    if (!target.isLive(_session)) {
      showStudioMessage(changed);
      return;
    }
    if (!await _session.checkpointBeforeAi()) {
      if (mounted && _session.conflict != null) {
        showStudioMessage(
          'Choose which version of this chapter to keep first, then try '
          'again.',
        );
      }
      return;
    }
    if (!mounted || !target.isLive(_session)) return;
    final entry = target.entry;
    final value = entry.controller.value;
    final window = target.window;
    final next = switch (acceptance) {
      StudioAiReplacement(:final text) => replaceSelection(
        value,
        start: window.start,
        expected: window.selection ?? '',
        replacement: text,
      ),
      StudioAiInsertion(:final text) => insertContinuation(
        value,
        offset: window.end,
        textAtRequest: target.textAtRequest,
        insertion: text,
      ),
      StudioAiCorrections(:final corrections) => applyCorrections(
        value,
        start: window.start,
        expected: window.selection ?? '',
        corrections: corrections,
      ),
    };
    if (next == null) {
      showStudioMessage(changed);
      return;
    }
    entry.controller.value = next;
    entry.focusNode.requestFocus();
  }

  // ---------------------------------------------------------------------------
  // Pictures

  /// Illustrate the selection, or the paragraph at the cursor. The picture's
  /// placeholder goes after that paragraph.
  Future<void> _illustrateText(_AiTarget target) async {
    final window = target.window;
    final source =
        window.selection ?? paragraphAt(target.textAtRequest, window.start);
    final started = await _showIllustrate(source);
    if (started == null || !mounted) return;
    final (:assist, :prompt) = started;
    if (!target.isLive(_session)) {
      _ai.track(assist);
      showStudioMessage(
        'Your picture is being drawn. It will wait in the AI inbox.',
      );
      return;
    }
    final text = target.entry.text;
    final card = target.document.insertAiPicture(
      target.entry,
      paragraphEndAt(text, window.end.clamp(0, text.length)),
      assistId: assist.id,
      prompt: prompt,
      passage: illustratePassageFrom(source),
    );
    _ai.track(assist, picture: card);
    unawaited(_session.checkpointBeforeAi());
  }

  /// Illustrate page [pageIndex] of a picture book, into its picture slot.
  Future<void> _illustratePage(int pageIndex) async {
    final document = _session.document;
    if (document == null || pageIndex >= document.pages.length) return;
    final text = document.pages[pageIndex].text;
    final started = await _showIllustrate(text);
    if (started == null || !mounted) return;
    final (:assist, :prompt) = started;
    final stillEmpty =
        identical(_session.document, document) &&
        pageIndex < document.pages.length &&
        document.pages[pageIndex].picture == null;
    if (!stillEmpty) {
      _ai.track(assist);
      showStudioMessage(
        'Your picture is being drawn. It will wait in the AI inbox.',
      );
      return;
    }
    final card = document.insertPageAiPicture(
      pageIndex,
      assistId: assist.id,
      prompt: prompt,
      passage: illustratePassageFrom(text),
    );
    _ai.track(assist, picture: card);
    unawaited(_session.checkpointBeforeAi());
  }

  /// The illustrate sheet over [source]; resolves with the started request
  /// and the description the author confirmed.
  Future<({ManuscriptAssist assist, String prompt})?> _showIllustrate(
    String source,
  ) async {
    final chapterId = _session.chapterId;
    final passage = illustratePassageFrom(source);
    final base = newStudioRequestId('studio-illustrate');
    String? used;
    final assist = await showStudioIllustrateSheet(
      context,
      projectId: widget.projectId,
      prompt: illustratePromptFrom(source),
      artStyle: _session.manuscript?.artStyle,
      onChangeStyle: _changeArtStyle,
      start: (prompt) async {
        used = prompt;
        // The same words asked twice (a lost answer, a retry after a
        // top-up) are the same request, so the server never draws twice.
        final assist = await ref
            .read(studioRepositoryProvider)
            .startAssist(
              widget.projectId,
              LongAssistRequest(
                kind: LongAssistKind.illustrate,
                requestId: '$base-${prompt.hashCode}',
                chapterId: chapterId,
                prompt: prompt,
                passage: passage.isEmpty ? null : passage,
              ),
            );
        ref.invalidate(billingProvider);
        if (mounted) _ai.track(assist);
        return assist;
      },
    );
    if (assist == null) return null;
    return (assist: assist, prompt: used ?? '');
  }

  Future<String?> _changeArtStyle() async {
    final manuscript = _session.manuscript;
    if (manuscript == null) return null;
    final updated = await showManuscriptSettingsSheet(
      context,
      projectId: widget.projectId,
      manuscript: manuscript,
    );
    if (updated != null) _session.updateManuscript(updated);
    return (updated ?? manuscript).artStyle;
  }

  /// Another try at a picture that could not be drawn: a new request,
  /// priced on the card's button.
  Future<void> _retryAiPictureFor(StudioAiPictureEntry card) async {
    final document = _session.document;
    if (document == null || !document.contains(card)) return;
    bool live() =>
        mounted &&
        identical(_session.document, document) &&
        document.contains(card);
    final previous = card.state.value;
    card.state.value = const StudioAiPictureState.starting();
    try {
      final assist = await ref
          .read(studioRepositoryProvider)
          .startAssist(
            widget.projectId,
            LongAssistRequest(
              kind: LongAssistKind.illustrate,
              requestId: newStudioRequestId('studio-illustrate-retry'),
              chapterId: _session.chapterId,
              prompt: card.prompt,
              passage: card.passage.isEmpty ? null : card.passage,
            ),
          );
      ref.invalidate(billingProvider);
      if (!live()) {
        if (mounted) _ai.track(assist);
        return;
      }
      _ai.forget(card.assistId);
      card.assistId = assist.id;
      card.state.value = const StudioAiPictureState.drawing();
      _ai.track(assist, picture: card);
    } catch (error) {
      if (!mounted) return;
      final recovery = await answerStudioBillingRefusal(
        context,
        ref,
        error,
        projectId: widget.projectId,
        reason: 'Drawing a picture for your book.',
      );
      if (!live()) return;
      card.state.value = switch (recovery) {
        StudioAiRecovery.ready => const StudioAiPictureState.failed(
          'You’re all set. Try again.',
        ),
        StudioAiRecovery.blocked => previous,
        StudioAiRecovery.none => StudioAiPictureState.failed(
          studioAiErrorMessage(error),
        ),
      };
    }
  }

  void _removeAiPictureFor(StudioAiPictureEntry card) {
    final document = _session.document;
    if (document == null) return;
    final assist = _ai.assist(card.assistId);
    document.removeAiPicture(card);
    if (assist != null && assist.status.isWorking) {
      unawaited(_ai.dismiss(assist.id));
    } else {
      _ai.forget(card.assistId);
    }
  }

  /// A background request stopped working: a picture lands in its
  /// placeholder (or the placeholder says why not); anything else started
  /// here, with no sheet waiting on it, says it is ready.
  void _onAssistSettled(ManuscriptAssist assist) {
    if (!mounted) return;
    final card = _ai.pictureFor(assist.id);
    final document = _session.document;
    if (card != null) {
      final placed = document != null && document.contains(card);
      final result = assist.result;
      if (!placed) {
        _ai.releasePicture(assist.id);
      } else if (assist.status == ManuscriptAssistStatus.ready &&
          result is AssistImageResult) {
        document.landAiPicture(card, url: result.url, alt: result.alt);
        unawaited(_ai.markApplied(assist.id));
        return;
      } else if (assist.status == ManuscriptAssistStatus.failed) {
        card.state.value = StudioAiPictureState.failed(
          assist.error ?? 'This picture couldn’t be drawn.',
        );
        return;
      }
    }
    if (_ai.isWatched(assist.id) || !_ai.startedHere(assist.id)) return;
    if (assist.status == ManuscriptAssistStatus.ready) {
      showStudioMessage(
        '${assist.kind.label} is ready.',
        actionLabel: studioAssistUseLabel(assist),
        onAction: () => unawaited(_useAssist(assist)),
      );
    } else if (assist.status == ManuscriptAssistStatus.failed) {
      showStudioMessage(
        assist.error ?? '${assist.kind.label} couldn’t be finished.',
      );
    }
  }

  /// A finished picture from the inbox: into the first empty picture slot of
  /// a picture book, otherwise after the paragraph the cursor was last in.
  Future<void> _insertReadyPicture(
    ManuscriptAssist assist,
    AssistImageResult result,
  ) async {
    final document = _session.document;
    if (document == null) return;
    if (!await _session.checkpointBeforeAi()) return;
    if (!mounted || !identical(_session.document, document)) return;
    final slot = document.isPictureLayout
        ? document.firstEmptyPictureSlot
        : null;
    final StudioAiPictureEntry card;
    if (slot != null) {
      card = document.insertPageAiPicture(
        slot,
        assistId: assist.id,
        prompt: result.alt,
        passage: '',
      );
    } else {
      final last = _lastText;
      final entry = last != null && document.contains(last)
          ? last
          : document.lastText;
      final selection = entry.controller.selection;
      final text = entry.text;
      card = document.insertAiPicture(
        entry,
        paragraphEndAt(
          text,
          selection.isValid ? selection.end.clamp(0, text.length) : text.length,
        ),
        assistId: assist.id,
        prompt: result.alt,
        passage: '',
      );
    }
    document.landAiPicture(card, url: result.url, alt: result.alt);
    await _ai.markApplied(assist.id);
    showStudioMessage(
      slot != null ? 'Picture added to page ${slot + 1}.' : 'Picture added.',
    );
  }

  // ---------------------------------------------------------------------------
  // Picture books

  /// Illustrate every page that has words and no picture: one request per
  /// page, each with its own placeholder in the page's slot.
  Future<void> _illustrateEveryPage() async {
    final document = _session.document;
    if (document == null) return;
    final pages = document.pages;
    final targets = [
      for (final page in pages)
        if (page.picture == null && page.text.trim().isNotEmpty) page.index,
    ];
    final skipped = pages
        .where((page) => page.picture == null && page.text.trim().isEmpty)
        .length;
    if (targets.isEmpty) {
      showStudioMessage(
        skipped > 0
            ? 'Write some words on a page first — its picture is drawn from '
                  'them.'
            : 'Every page already has a picture.',
      );
      return;
    }
    final confirmed = await showStudioIllustrateAllSheet(
      context,
      projectId: widget.projectId,
      pages: targets.length,
      skipped: skipped,
    );
    if (!confirmed || !mounted) return;
    await _startPagePictures(document, targets);
  }

  Future<void> _startPagePictures(
    StudioDocument document,
    List<int> pageIndexes,
  ) async {
    final repository = ref.read(studioRepositoryProvider);
    final key = newStudioRequestId('studio-illustrate-page');
    var started = 0;
    for (var i = 0; i < pageIndexes.length; i++) {
      if (!mounted || !identical(_session.document, document)) break;
      final pageIndex = pageIndexes[i];
      final pages = document.pages;
      if (pageIndex >= pages.length || pages[pageIndex].picture != null) {
        continue;
      }
      final text = pages[pageIndex].text;
      final prompt = illustratePromptFrom(text);
      final passage = illustratePassageFrom(text);
      try {
        final assist = await repository.startAssist(
          widget.projectId,
          LongAssistRequest(
            kind: LongAssistKind.illustrate,
            requestId: '$key-$pageIndex',
            chapterId: _session.chapterId,
            prompt: prompt,
            passage: passage,
          ),
        );
        if (!mounted) return;
        if (!identical(_session.document, document)) {
          _ai.track(assist);
          continue;
        }
        final card = document.insertPageAiPicture(
          pageIndex,
          assistId: assist.id,
          prompt: prompt,
          passage: passage,
        );
        _ai.track(assist, picture: card);
        started++;
      } catch (error) {
        if (!mounted) return;
        ref.invalidate(billingProvider);
        final remaining = pageIndexes.sublist(i);
        final recovery = await answerStudioBillingRefusal(
          context,
          ref,
          error,
          projectId: widget.projectId,
          reason: 'Drawing pictures for your pages.',
        );
        if (!mounted) return;
        if (recovery == StudioAiRecovery.ready) {
          // The purchase was for these pages: offer the rest, priced again.
          final again = await showStudioIllustrateAllSheet(
            context,
            projectId: widget.projectId,
            pages: remaining.length,
            skipped: 0,
          );
          if (again && mounted) await _startPagePictures(document, remaining);
        } else if (recovery == StudioAiRecovery.none) {
          final left = remaining.length;
          showStudioMessage(
            started == 0
                ? studioAiErrorMessage(error)
                : '${studioAiErrorMessage(error)} '
                      '${left == 1 ? '1 page wasn’t' : '$left pages weren’t'} '
                      'started.',
          );
        }
        break;
      }
    }
    ref.invalidate(billingProvider);
    if (started > 0) unawaited(_session.checkpointBeforeAi());
  }
}
