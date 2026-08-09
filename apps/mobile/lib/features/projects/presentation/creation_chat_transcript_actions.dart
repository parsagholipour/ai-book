part of 'creation_chat_screen.dart';

// Transcript movement and submit behavior share the same follow-the-latest
// contract. Keeping them together makes it clear which user actions re-enable
// automatic scrolling and which ones deliberately stop it.
extension _CreationChatTranscriptActions on _CreationChatScreenState {
  void _syncStickToBottomFromUserScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    _stickToBottom = position.maxScrollExtent - position.pixels <= 80;
  }

  void _stopFollowingTranscriptImpl() {
    _stickToBottom = false;
    _stickScrollTimer?.cancel();
    _stickScrollTimer = null;
  }

  /// Re-engages follow-the-conversation scrolling. Submitting the composer is
  /// an explicit signal to watch the reply, even after scrolling up (which is
  /// how every message edit starts).
  void _resumeStickToBottomImpl() {
    _stickToBottom = true;
    _scheduleStickyScroll(delay: const Duration(milliseconds: 16));
  }

  bool _onTranscriptScrollNotification(Notification notification) {
    if (notification is UserScrollNotification) {
      if (notification.metrics.axis != Axis.vertical) return false;
      _syncStickToBottomFromUserScroll();
      return false;
    }
    if (notification is ScrollMetricsNotification && _stickToBottom) {
      if (notification.metrics.axis != Axis.vertical) return false;
      // Content grew after the initial scroll (export card, images, etc.).
      _scheduleStickyScroll(delay: const Duration(milliseconds: 48));
    }
    return false;
  }

  void _maybeScrollToBottom(Object trigger) {
    final contentChanged = trigger != _lastScrollTrigger;
    if (contentChanged) {
      _lastScrollTrigger = trigger;
    }
    if (!contentChanged || !_stickToBottom) return;
    // Wait a beat so the new bubble can finish its first layout pass.
    _scheduleStickyScroll(delay: const Duration(milliseconds: 16));
  }

  void _scheduleStickyScroll({required Duration delay}) {
    _stickScrollTimer?.cancel();
    _stickScrollTimer = Timer(delay, () {
      _stickScrollTimer = null;
      if (!mounted || !_stickToBottom || !_scrollController.hasClients) return;
      final target = _scrollController.position.maxScrollExtent;
      final distance = (target - _scrollController.position.pixels).abs();
      if (distance <= 1) return;
      // Short glide for small growth (export expand); longer for new messages.
      final durationMs = distance < 120 ? 180 : 260;
      _scrollController.animateTo(
        target,
        duration: Duration(milliseconds: durationMs),
        curve: Curves.easeOutCubic,
      );
    });
  }

  /// A question-skip tap: sends the localized skip text as a normal chat
  /// message, flagged so the server keeps it out of the composed book prompt.
  Future<void> _sendQuestionSkip(String text) async {
    AppHaptics.tap();
    _resumeStickToBottom();
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .sendMessage(text, skippedQuestion: true);
    } catch (_) {}
  }

  Future<void> _send(String text) async {
    final trimmed = text.trim();
    final state = ref.read(creationChatControllerProvider);
    AppHaptics.tap();
    // Taken before the guards below so a send that bails leaves the banner up.
    final replyTo = _replyTarget;
    final activeProjectId = _activeProjectId(state);
    if (activeProjectId != null) {
      if (trimmed.isEmpty) return;
      await _sendOutputMessage(activeProjectId, trimmed);
      return;
    }
    // Attachment-only sends are allowed, like handing a file to a person.
    if (trimmed.isEmpty && !state.hasReadyAttachments) return;
    final editingCreationMessageId = _editingCreationMessageId;
    if (editingCreationMessageId != null) {
      await _sendCreationEdit(trimmed, editingCreationMessageId);
      return;
    }
    _composerController.clear();
    if (replyTo != null) {
      _updateState(() {
        _replyTarget = null;
        _messageAnchors.forget();
      });
    }
    _resumeStickToBottom();
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .sendMessage(trimmed, replyTo: replyTo);
    } catch (_) {}
  }

  /// Routes an output-stage composer submit: an in-progress brainstorm edit
  /// goes to the creation chat (forking a branch there); everything else is
  /// a normal project chat message.
  Future<void> _sendOutputMessage(String projectId, String message) async {
    final projectStatus = ref
        .read(projectDetailProvider(projectId))
        .asData
        ?.value
        .status;
    final liveStatus = ref.read(projectStatusProvider(projectId)).asData?.value;
    // The field is already disabled while this is non-null. Repeat the guard
    // at the callback boundary so a tap from the frame just before a live
    // status update cannot sneak a message into an active generation.
    if (_outputMessagingLockLabel(
          projectStatus: projectStatus,
          liveStatus: liveStatus,
        ) !=
        null) {
      return;
    }
    final editingCreationMessageId = _editingCreationMessageId;
    if (editingCreationMessageId != null) {
      await _sendCreationEdit(message, editingCreationMessageId);
      return;
    }
    final replyTo = _replyTarget;
    if (replyTo != null) {
      _updateState(() {
        _replyTarget = null;
        _messageAnchors.forget();
      });
    }
    await _sendProjectMessage(
      projectId: projectId,
      message: message,
      replyTo: replyTo,
    );
  }

  Future<void> _sendCreationEdit(String message, String editMessageId) async {
    _updateState(() {
      _editingCreationMessageId = null;
      _messageAnchors.forget();
    });
    _composerController.clear();
    _resumeStickToBottom();
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .sendMessage(message, editMessageId: editMessageId);
    } catch (_) {}
  }

  Future<void> _switchProjectBranch(
    MobileProjectChatMessage message,
    String direction,
  ) async {
    if (_projectChatBranchSwitching) return;
    _updateState(() => _projectChatBranchSwitching = true);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .switchProjectChatBranch(
            projectId: message.projectId,
            messageId: message.id,
            direction: direction,
          );
      _refreshOutput(message.projectId, refreshStatus: false);
      if (!mounted) return;
      _updateState(() => _projectChatBranchSwitching = false);
    } catch (error) {
      if (!mounted) return;
      _updateState(() => _projectChatBranchSwitching = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}
