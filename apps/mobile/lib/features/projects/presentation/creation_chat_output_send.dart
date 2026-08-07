part of 'creation_chat_screen.dart';

// Talking to a book that already exists: the send path for the output stage of
// this screen, where the conversation is about a finished book rather than the
// plan for one.
//
// A mixin rather than plain helpers because these need `setState`, `ref` and
// `mounted`, and because the in-flight state below belongs with them — the
// screen's own class body has no room left for fields it never reads.

/// The output-stage chat's send path, and everything it has in flight.
mixin _OutputChatSend on ConsumerState<CreationChatScreen> {
  bool _projectChatSending = false;
  String? _editingProjectMessageId;
  String? _pendingProjectRequestId;
  String? _pendingProjectRequestText;
  String? _pendingProjectEditMessageId;
  String? _pendingProjectReplyToId;

  /// The message the user just sent, echoed until the refreshed transcript
  /// carries it — or until it fails and offers itself back to retry.
  ///
  /// A turn about a finished book takes the server a model call or two, and
  /// without this the composer simply emptied: the message vanished and the
  /// only sign anything was happening was a disabled button.
  PendingEcho? _pendingProjectEcho;

  // Provided by the screen this mixin is applied to.
  TextEditingController get _composerController;
  // Declared without the screen's optional `refreshStatus`: everything here
  // wants the status stream re-armed, which is that parameter's default.
  void _refreshOutput(String projectId);
  void _startPlanPoll();
  void _resumeStickToBottom();
  Future<void> _openReplanCopy(String projectId);

  Future<MobileProjectChatSendResult?> _sendProjectMessage({
    required String projectId,
    required String message,
    ChatReplyTarget? replyTo,
  }) async {
    final trimmed = message.trim();
    if (trimmed.isEmpty || _projectChatSending) return null;
    final editingMessageId = _editingProjectMessageId;
    // The quoted message is part of what makes a request distinct: the same
    // words replying to a different turn are a different ask, so reusing the
    // idempotency key would replay the first one instead of sending this.
    final samePendingRequest =
        _pendingProjectRequestText == trimmed &&
        _pendingProjectEditMessageId == editingMessageId &&
        _pendingProjectReplyToId == replyTo?.messageId;
    if (!samePendingRequest) {
      _pendingProjectRequestText = trimmed;
      _pendingProjectEditMessageId = editingMessageId;
      _pendingProjectReplyToId = replyTo?.messageId;
      _pendingProjectRequestId =
          'project-chat-${DateTime.now().microsecondsSinceEpoch}';
    }
    final requestId = _pendingProjectRequestId!;
    final shouldRestoreComposer = _composerController.text.trim() == trimmed;
    if (shouldRestoreComposer) {
      _composerController.clear();
    }
    setState(() {
      _projectChatSending = true;
      _pendingProjectEcho = PendingEcho(text: trimmed);
    });
    _resumeStickToBottom();
    try {
      final repository = ref.read(projectsRepositoryProvider);
      final result = editingMessageId != null
          ? await repository.editProjectChatMessage(
              projectId: projectId,
              messageId: editingMessageId,
              message: trimmed,
              requestId: requestId,
            )
          : await repository.sendProjectChatMessage(
              projectId: projectId,
              message: trimmed,
              requestId: requestId,
              replyToMessageId: replyTo?.messageId,
            );
      _pendingProjectRequestId = null;
      _pendingProjectRequestText = null;
      _pendingProjectEditMessageId = null;
      _pendingProjectReplyToId = null;
      _refreshOutput(projectId);
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      if (!mounted) return result;
      setState(() {
        _projectChatSending = false;
        _pendingProjectEcho = null;
        _editingProjectMessageId = null;
      });
      if (result.operation != null) {
        _startPlanPoll();
        // Plan revision already surfaces in the transcript and plan footer;
        // a toast would just duplicate that.
        if (!result.operation!.isPlanRevision) {
          ScaffoldMessenger.of(context).showAppSnackBar(
            SnackBar(content: Text(result.operation!.displayAction)),
          );
        }
      }
      return result;
    } catch (error) {
      if (!mounted) return null;
      // The message stays on screen with its own Retry rather than being
      // pushed back into the composer, so a failure never loses the text and
      // never fights with anything typed while the request was in flight.
      setState(() {
        _projectChatSending = false;
        _pendingProjectEcho = PendingEcho(
          text: trimmed,
          failed: true,
          error: userFacingError(error),
        );
      });
      return null;
    }
  }

  /// Sends the failed message again under its original request ID, so the
  /// server replays that turn instead of charging for a second one.
  Future<void> _retryPendingProjectEcho(String projectId) async {
    final echo = _pendingProjectEcho;
    if (echo == null || !echo.failed || _projectChatSending) return;
    setState(() => _pendingProjectEcho = null);
    await _sendProjectMessage(projectId: projectId, message: echo.text);
  }

  /// Drops the failed message, handing the text back to an empty composer so
  /// it can be reworded rather than retyped.
  void _dismissPendingProjectEcho() {
    final echo = _pendingProjectEcho;
    if (echo == null || _projectChatSending) return;
    setState(() {
      _pendingProjectEcho = null;
      _pendingProjectRequestId = null;
      _pendingProjectRequestText = null;
      _pendingProjectEditMessageId = null;
      if (_composerController.text.trim().isEmpty) {
        _composerController.text = echo.text;
        _composerController.selection = TextSelection.collapsed(
          offset: _composerController.text.length,
        );
      }
    });
  }

  Future<void> _applyProjectEditProposal({
    required String projectId,
    required String proposalId,
  }) async {
    if (_projectChatSending) return;
    if (proposalId.isEmpty) {
      await _sendProjectMessage(projectId: projectId, message: 'apply it');
      return;
    }
    final requestId =
        'project-proposal-apply-${DateTime.now().microsecondsSinceEpoch}';
    setState(() => _projectChatSending = true);
    // Move to where the progress will appear before the request even returns.
    _resumeStickToBottom();
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .applyEditProposal(
            projectId: projectId,
            proposalId: proposalId,
            requestId: requestId,
          );
      _refreshOutput(projectId);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      setState(() => _projectChatSending = false);
      if (result.operation != null) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          SnackBar(content: Text(result.operation!.displayAction)),
        );
      }
      // A replan builds the rebuilt book as a separate output and leaves this
      // one untouched, so staying put shows the unchanged book.
      final replanCopyId = result.reply.replanCopyTargetProjectId;
      if (replanCopyId != null && replanCopyId != projectId) {
        // `_openReplanCopy` arms the poll itself, against the copy. Doing it
        // here instead would arm it against *this* project — which is finished
        // — and the settled-project check cancels the timer during the await
        // below, before the copy is ever selected.
        await _openReplanCopy(replanCopyId);
      } else if (result.operation != null) {
        _startPlanPoll();
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _projectChatSending = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _cancelProjectEditProposal({
    required String projectId,
    required String proposalId,
  }) async {
    if (_projectChatSending) return;
    if (proposalId.isEmpty) {
      await _sendProjectMessage(projectId: projectId, message: 'cancel');
      return;
    }
    final requestId =
        'project-proposal-cancel-${DateTime.now().microsecondsSinceEpoch}';
    setState(() => _projectChatSending = true);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .cancelEditProposal(
            projectId: projectId,
            proposalId: proposalId,
            requestId: requestId,
          );
      _refreshOutput(projectId);
      if (!mounted) return;
      setState(() => _projectChatSending = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _projectChatSending = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _undoProjectEdit({required String projectId}) async {
    if (_projectChatSending) return;
    final requestId = 'project-undo-${DateTime.now().microsecondsSinceEpoch}';
    setState(() => _projectChatSending = true);
    _resumeStickToBottom();
    try {
      await ref
          .read(projectsRepositoryProvider)
          .undoLastBookEdit(projectId: projectId, requestId: requestId);
      _refreshOutput(projectId);
      if (!mounted) return;
      setState(() => _projectChatSending = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _projectChatSending = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}
