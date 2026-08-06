part of 'project_chat_screen.dart';

// Acting on an edit that already exists: retrying a failed operation, applying
// or cancelling a priced proposal, and undoing the last edit.
//
// A mixin rather than plain helpers because these need `setState`, `ref`,
// `context` and `mounted`, and because the two in-flight flags below are read
// nowhere except here and the widgets that show them spinning.

/// The book chat's operation and proposal actions.
mixin _ProjectChatEditActions on ConsumerState<ProjectChatScreen> {
  /// The operation whose retry is in flight, if any.
  String? _retryingOperationId;
  bool _undoing = false;

  // Provided by the screen this mixin is applied to.
  TextEditingController get _controller;
  bool get _sending;
  set _sending(bool value);
  bool get _bookIsBusy;
  String _newRequestId(String prefix);
  void _refresh();
  // Both are declared without the screen's optional parameters: nothing here
  // wants anything but their defaults (an animated scroll, an unquoted send).
  void _scrollToBottomSoon();
  void _armFallingEdge(MobileBookEditOperation? operation);
  Future<void> _sendMessage(String message);

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
    setState(() => _retryingOperationId = operation.id);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: widget.projectId,
            operationId: operation.id,
            requestId: createPlanRevisionRetryRequestId(operation.id),
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
    setState(() => _sending = true);
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
    setState(() => _sending = true);
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
    if (_undoing || _sending) return;
    final requestId = _newRequestId('undo');
    setState(() => _undoing = true);
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .undoLastBookEdit(projectId: widget.projectId, requestId: requestId);
      if (!mounted) return;
      _armFallingEdge(result.operation);
      setState(() => _undoing = false);
      _refresh();
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() => _undoing = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}
