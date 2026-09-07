part of 'project_chat_screen.dart';

// Acting on an edit that already exists: retrying a failed operation, applying
// or cancelling a priced proposal, and undoing or redoing the last edit.
//
// A mixin rather than plain helpers because these need `setState`, `ref`,
// `context` and `mounted`, and because the two in-flight flags below are read
// nowhere except here and the widgets that show them spinning.

/// The book chat's operation and proposal actions.
mixin _ProjectChatEditActions on ConsumerState<ProjectChatScreen> {
  /// The operation whose retry is in flight, if any.
  String? _retryingOperationId;
  bool _undoing = false;
  bool _redoing = false;
  final _rebuildHandoff = UndoRedoRebuildHandoff();

  bool get _hasPendingOperationAction =>
      _undoing || _redoing || _retryingOperationId != null;

  /// Status held before a `projectStatusProvider` invalidate. Capture it then:
  /// invalidate parses a new COMPLETE for the same row, and `identical` misses
  /// that.
  MobileProjectStatus? _currentProjectStatus() =>
      ref.read(projectStatusProvider(widget.projectId)).asData?.value;

  /// Replaces the local Undo/Redo handoff with streamed progress (or removes it
  /// if a very fast rebuild already settled before the first status tick).
  /// Loading / missing `asData` is not a tick — reconnect `.value` can still
  /// be the COMPLETE from before Undo. The snapshot captured at arm is that
  /// same COMPLETE, so it must not clear the rebuild either — nor a later
  /// parse of the same row (`updatedAt` unchanged).
  void _didReceiveProjectStatus(MobileProjectStatus status) {
    if (!_rebuildHandoff.shouldSettle(status)) return;
    setState(_rebuildHandoff.clear);
  }

  String? _composerLockLabel(MobileProjectStatus? liveStatus) {
    if (_rebuildHandoff.awaiting) return 'Regenerating your book…';
    if (liveStatus == null) return null;
    return switch (liveStatus.status) {
      'planning' => 'Revising your plan…',
      'generating' => 'Generating your book…',
      _ => 'Regenerating your book…',
    };
  }

  bool _showThinking(MobileProjectStatus? liveStatus) {
    if (liveStatus != null) return false;
    return _sending || _editing || _hasPendingOperationAction;
  }

  // Provided by the screen this mixin is applied to.
  TextEditingController get _controller;
  bool get _sending;
  set _sending(bool value);
  bool get _editing;
  bool get _bookIsBusy;
  String _newRequestId(String prefix);
  void _refresh();
  // Both are declared without the screen's optional parameters: nothing here
  // wants anything but their defaults (an animated scroll, an unquoted send).
  void _scrollToBottomSoon();
  void _armFallingEdge(MobileBookEditOperation? operation);
  Future<void> _sendMessage(String message);
  List<MobileProjectChatMessage> _visibleMessages(MobileProjectChat chat);

  /// Drops the "You now have enough credits" follow-up: settling any proposal
  /// makes it stale, and its proposal card remains the way to run that edit.
  void _clearCreditsReadyPrompt();

  Future<void> _retryOperation(MobileBookEditOperation operation) async {
    if (operation.isAutomaticRetryPending || _retryingOperationId != null) {
      return;
    }
    if (!operation.retryAvailable) {
      final submittedText = operation.submittedText?.trim();
      if (submittedText != null && submittedText.isNotEmpty) {
        setState(() {
          _controller.text = submittedText;
          _controller.selection = TextSelection.collapsed(
            offset: submittedText.length,
          );
        });
      }
      ScaffoldMessenger.of(context).showAppSnackBar(
        SnackBar(
          content: Text(
            submittedText == null || submittedText.isEmpty
                ? 'Edit your request below, then send it again.'
                : 'The original request is ready to edit and send again.',
          ),
        ),
      );
      return;
    }
    final quote = operation.recoveryQuote;
    if (quote == null) return;
    final confirmed = await confirmPaidGenerationRetry(
      context,
      ref,
      projectId: operation.projectId,
      quote: quote,
    );
    if (confirmed == null || !mounted) return;
    setState(() => _retryingOperationId = operation.id);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: widget.projectId,
            operationId: operation.id,
            requestId: createPlanRevisionRetryRequestId(operation.id),
            retryToken: confirmed.retryToken,
          );
      if (!mounted) return;
      setState(() => _retryingOperationId = null);
      _refresh();
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() => _retryingOperationId = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _applyProposal(String proposalId) async {
    if (_sending || _bookIsBusy) return;
    if (proposalId.isEmpty) {
      await _sendMessage('apply it');
      return;
    }
    final requestId = _newRequestId('proposal-apply');
    setState(() {
      _sending = true;
      _clearCreditsReadyPrompt();
    });
    // Move to where the progress will appear before the request even returns.
    _scrollToBottomSoon();
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .applyEditProposal(
            projectId: widget.projectId,
            proposalId: proposalId,
            requestId: requestId,
          );
      if (!mounted) return;
      _armFallingEdge(result.operation);
      setState(() => _sending = false);
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(billingProvider);
      _scrollToBottomSoon();
      // A replan builds the rebuilt book somewhere else and leaves this one
      // untouched. Staying here shows the unchanged book, which reads as the
      // edit having done nothing at all.
      final replanCopyId = result.reply.replanCopyTargetProjectId;
      if (replanCopyId != null && replanCopyId != widget.projectId) {
        context.push('/projects/$replanCopyId/chat');
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _sending = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _cancelProposal(String proposalId) async {
    if (_sending) return;
    if (proposalId.isEmpty) {
      await _sendMessage('cancel');
      return;
    }
    final requestId = _newRequestId('proposal-cancel');
    setState(() {
      _sending = true;
      _clearCreditsReadyPrompt();
    });
    try {
      await ref
          .read(projectsRepositoryProvider)
          .cancelEditProposal(
            projectId: widget.projectId,
            proposalId: proposalId,
            requestId: requestId,
          );
      if (!mounted) return;
      setState(() => _sending = false);
      ref.invalidate(projectChatProvider(widget.projectId));
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() => _sending = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _undoLastEdit() async {
    // After Undo B, card B can offer Redo while an older card A still offers
    // Undo. Both fire unawaited; starting A while B's Redo is in flight races
    // two manuscript writes.
    if (_redoing || _undoing || _sending || _rebuildHandoff.inFlight) {
      return;
    }
    final requestId = _newRequestId('undo');
    setState(() => _undoing = true);
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .undoLastBookEdit(projectId: widget.projectId, requestId: requestId);
      if (!mounted) return;
      _armFallingEdge(result.operation);
      final statusBefore = _currentProjectStatus();
      setState(() {
        _undoing = false;
        _rebuildHandoff.arm(result, currentStatus: statusBefore);
      });
      _refresh();
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _undoing = false;
        _rebuildHandoff.clear();
      });
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _redoLastEdit() async {
    if (_redoing || _undoing || _sending || _rebuildHandoff.inFlight) {
      return;
    }
    final requestId = _newRequestId('redo');
    setState(() => _redoing = true);
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .redoLastBookEdit(projectId: widget.projectId, requestId: requestId);
      if (!mounted) return;
      _armFallingEdge(result.operation);
      final statusBefore = _currentProjectStatus();
      setState(() {
        _redoing = false;
        _rebuildHandoff.arm(result, currentStatus: statusBefore);
      });
      _refresh();
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _redoing = false;
        _rebuildHandoff.clear();
      });
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Widget _operationBubble(
    MobileBookEditOperation operation,
    MobileProjectStatus? liveStatus, {
    required bool rebuilding,
  }) {
    return ProjectChatOperationBubble(
      projectId: widget.projectId,
      operation: operation,
      retrying: _retryingOperationId == operation.id,
      undoing: _undoing,
      redoing: _redoing,
      liveStatus: liveStatus,
      rebuilding: rebuilding,
      onRetry: () => _retryOperation(operation),
      onUndo: () => unawaited(_undoLastEdit()),
      onRedo: () => unawaited(_redoLastEdit()),
    );
  }

  TranscriptOperations _transcriptOperations(MobileProjectChat chat) {
    return splitTranscriptOperations(
      operations: chat.operations,
      messages: _visibleMessages(chat),
    );
  }
}
