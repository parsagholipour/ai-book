part of 'creation_chat_screen.dart';

// What the composer is currently attached to.
//
// This screen's one text field serves three modes — a new message, an edit that
// forks a branch, and a reply that quotes an earlier turn — and they are
// mutually exclusive. Keeping the four entry points together is what makes that
// legible: each one clears the other two.

/// The composer's current attachment: an edit, a reply, or neither.
///
/// Chained on [_OutputChatSend] rather than on the state directly so it can see
/// the output-stage edit id it has to clear — the three modes share one field
/// each and every entry point below drops the other two.
mixin _CreationComposerContext on _OutputChatSend {
  String? _editingCreationMessageId;
  final _messageAnchors = ChatMessageAnchorController(
    debugLabel: 'creation-chat',
  );

  // Provided by the screen this mixin is applied to.
  ScrollController get _scrollController;
  FocusNode get _composerFocusNode;
  void _stopFollowingTranscript();

  /// The message the composer is quoting, for either stage of this screen.
  ChatReplyTarget? _replyTarget;

  void _scrollToReplyTarget() {
    final target = _replyTarget;
    if (target == null || !_scrollController.hasClients) return;
    _stopFollowingTranscript();
    _messageAnchors.reveal(target: target, scrollController: _scrollController);
  }

  void _startCreationMessageEdit(MobileCreationMessage message) {
    final state = ref.read(creationChatControllerProvider);
    if (message.id == null || state.isBusy || state.switchingBranch) return;
    setState(() {
      // Only one edit at a time: starting a brainstorm edit replaces any
      // in-progress project chat edit, and vice versa.
      _editingProjectMessageId = null;
      _editingCreationMessageId = message.id;
      _replyTarget = null;
      _messageAnchors.forget();
      _composerController.text = message.content;
      _composerController.selection = TextSelection.collapsed(
        offset: _composerController.text.length,
      );
    });
    _focusComposerForEdit();
  }

  void _cancelCreationMessageEdit() {
    setState(() {
      _editingCreationMessageId = null;
      _composerController.clear();
    });
  }

  /// Quotes a message in the composer. Replying and editing are mutually
  /// exclusive, so starting one drops the other — an edit also drops whatever
  /// was typed, which is why the reply path leaves the text alone.
  void _startReply(ChatReplyTarget? target) {
    if (target == null) return;
    _messageAnchors.remember(target);
    setState(() {
      _editingProjectMessageId = null;
      _editingCreationMessageId = null;
      _replyTarget = target;
    });
  }

  void _cancelReply() {
    setState(() {
      _replyTarget = null;
      _messageAnchors.forget();
    });
  }

  void _startProjectMessageEdit(MobileProjectChatMessage message) {
    if (_projectChatSending) return;
    setState(() {
      _editingCreationMessageId = null;
      _editingProjectMessageId = message.id;
      _replyTarget = null;
      _messageAnchors.forget();
      _composerController.text = message.content;
      _composerController.selection = TextSelection.collapsed(
        offset: _composerController.text.length,
      );
    });
    _focusComposerForEdit();
  }

  void _focusComposerForEdit() {
    // Entering edit mode can swap the pre-build footer for the output-stage
    // footer. Wait until that rebuild has attached the shared focus node to
    // the visible field before opening the keyboard.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _composerFocusNode.requestFocus();
    });
  }

  void _cancelProjectMessageEdit() {
    setState(() {
      _editingProjectMessageId = null;
      _composerController.clear();
    });
  }
}
