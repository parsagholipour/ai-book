part of 'project_chat_screen.dart';

// The transcript itself: what the list shows above the composer, in order —
// the welcome for a fresh chat, earlier-message loading, every message with the
// operation cards that hang under it, and then whatever is in flight.
//
// A mixin because this reads a dozen of the screen's own fields and callbacks;
// pulling it into a widget would mean threading all of them back through a
// constructor.

/// The list children for the book chat's transcript.
mixin _ProjectChatTranscriptView
    on ConsumerState<ProjectChatScreen>, _ProjectChatEditActions {
  // Provided by the screen this mixin is applied to.
  TextEditingController get _editController;
  ChatMessageAnchorController get _messageAnchors;
  bool get _switchingBranch;
  bool get _loadingEarlier;
  String? get _editingMessageId;
  PendingEcho? get _pendingEcho;
  String get _streamingReply;
  String? get _creditsReadyProposalId;
  bool _canLoadEarlier(MobileProjectChat chat);
  String? _replanCopyTargetProjectId(MobileProjectChatMessage message);
  void _startEdit(MobileProjectChatMessage message);
  void _startReply(MobileProjectChatMessage message);
  void _cancelEdit();
  Future<void> _submitEdit();
  Future<void> _switchBranch(
    MobileProjectChatMessage message,
    String direction,
  );
  Future<void> _loadEarlier(MobileProjectChat chat);
  Future<void> _openPaywall(
    MobileProjectDetail? project, {
    int? credits,
    String? resumeProposalId,
    bool plans,
  });
  Future<void> _retryPendingEcho();
  void _dismissPendingEcho();
  void _proceedWithCreditsReadyEdit();
  void _fillComposer(ChatSuggestion suggestion);

  List<Widget> _transcriptChildren({
    required MobileProjectChat chat,
    required MobileProjectDetail? project,
    required MobileProjectStatus? liveStatus,
    required TranscriptOperations operations,
    required UndoRedoRebuildView rebuild,
  }) {
    final messages = _visibleMessages(chat);
    final fresh = messages.isEmpty && _pendingEcho == null;
    // A free change's reply ends with the book it rebuilt (`chat_book_update.dart`).
    final status = ref
        .watch(projectStatusProvider(widget.projectId))
        .asData
        ?.value;
    final updateMessage = chatBookUpdateMessage(messages);
    final updateState = updateMessage == null
        ? null
        : chatBookUpdateState(
            revision: updateMessage.bookUpdateRevision!,
            status: status,
          );
    final updatingInReply =
        updateState == ChatBookUpdateState.updating && !operations.hasRunning;
    final finished = project?.status == 'complete';
    return [
      // A finished book gets an invitation with things to tap, once, while
      // the chat is empty. Any other stage keeps its one-line limit in view,
      // because there it is something the reader has to remember, not a hint.
      if (!finished)
        ProjectChatStageNotice(project: project)
      else if (fresh)
        ProjectChatWelcome(project: project, onSuggestion: _fillComposer),
      if (!finished || fresh) const SizedBox(height: AppSpacing.md),
      if (_canLoadEarlier(chat)) ...[
        Center(
          child: TextButton.icon(
            onPressed: _loadingEarlier ? null : () => _loadEarlier(chat),
            icon: _loadingEarlier
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.history),
            label: const Text('Load earlier messages'),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
      ],
      for (final message in messages) ...[
        ProjectMessageBubble(
          key: _messageAnchors.keyFor(message.id),
          message: message,
          editController: _editController,
          editing: _editingMessageId == message.id,
          submittingEdit: _editing && _editingMessageId == message.id,
          switchingBranch: _switchingBranch,
          // Only a proposal the server would still accept shows Apply/Cancel.
          // Applying or cancelling one settles it there, so a card left asking
          // after that invites a tap the API can only replay. A proposal this
          // screen has already settled stays closed while the transcript
          // refetch is on its way.
          showProposalActions:
              message.editProposal != null &&
              message.editProposal!.id == chat.openProposalId &&
              !_proposalOutcomes.containsKey(message.editProposal!.id),
          applyingProposal:
              message.editProposal != null &&
              message.editProposal!.id == _applyingProposalId,
          proposalOutcome: message.editProposal == null
              ? null
              : _proposalOutcomes[message.editProposal!.id],
          // A live job closes the proposal card's Apply for the same reason it
          // closes the composer: it would queue a second edit the API has to
          // refuse.
          sending: _sending || _editing || liveStatus != null,
          // While the edit runs it has no card yet, so the reply itself
          // carries the charge; once the card appears it owns the number.
          showCreditCost: operations.anchoredTo(message.id).isEmpty,
          onStartEdit: message.isUser && liveStatus == null
              ? () => _startEdit(message)
              : null,
          onReply: () => _startReply(message),
          onReport: message.isAssistant
              ? () => reportAiContent(
                  context: context,
                  title: 'Report this AI reply',
                  submit: (reason, comment) => ref
                      .read(aiContentReportsApiProvider)
                      .reportChatReply(
                        projectId: message.projectId,
                        messageId: message.id,
                        reason: reason,
                        comment: comment,
                      ),
                )
              : null,
          onCancelEdit: _cancelEdit,
          onSubmitEdit: _submitEdit,
          onSwitchBranch: (direction) => _switchBranch(message, direction),
          onOpenPaywall: message.hasInsufficientCredits
              ? () => _openPaywall(
                  project,
                  credits: message.insufficientCreditsRequired,
                  resumeProposalId: message.editProposal?.id,
                  plans: message.asksForPlan,
                )
              : null,
          onOpenReplanCopy: _replanCopyTargetProjectId(message) == null
              ? null
              : () => context.push(
                  '/projects/${_replanCopyTargetProjectId(message)}/chat',
                ),
          onApplyProposal: message.editProposal == null
              ? null
              : () => unawaited(_applyProposal(message.editProposal!.id)),
          onCancelProposal: message.editProposal == null
              ? null
              : () => unawaited(_cancelProposal(message.editProposal!.id)),
          bookUpdate: message.id != updateMessage?.id || updateState == null
              ? null
              : ChatBookUpdateRow(
                  state: updateState,
                  status: status,
                  foreground: Theme.of(context).colorScheme.onSurface,
                  onOpen: () =>
                      context.push('/projects/${message.projectId}/read'),
                ),
        ),
        const SizedBox(height: 12),
        for (final operation in operations.anchoredTo(message.id)) ...[
          _operationBubble(
            operation,
            liveStatus,
            rebuilding: rebuild.isRebuilding(operation.id),
          ),
          const SizedBox(height: 12),
        ],
      ],
      if (_pendingEcho != null) ...[
        PendingEchoBubble(
          echo: _pendingEcho!,
          onRetry: _retryPendingEcho,
          onDismiss: _dismissPendingEcho,
        ),
        const SizedBox(height: 12),
      ],
      if (_creditsReadyProposalId != null) ...[
        CreditsReadyBubble(
          onProceed: _sending || _editing || liveStatus != null
              ? null
              : _proceedWithCreditsReadyEdit,
          onDismiss: _dismissCreditsReady,
        ),
        const SizedBox(height: 12),
      ],
      // Reading the message and working out what it asks for takes a model
      // call or two, and until this the wait was silent. Suppressed once the
      // work is live: the progress card below says the same thing with real
      // numbers, and two busy indicators read as two things happening.
      if (_showThinking(liveStatus)) ...[
        ChatThinkingBubble(
          stages: bookChatThinkingStages,
          text: (_sending || _editing) ? _streamingReply : '',
        ),
        const SizedBox(height: 12),
      ],
      for (final operation in operations.unanchored)
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.xs),
          child: _operationBubble(
            operation,
            liveStatus,
            rebuilding: rebuild.isRebuilding(operation.id),
          ),
        ),
      if (liveStatus != null &&
          !(rebuild.inFlight && !operations.hasRunning) &&
          !updatingInReply) ...[
        const SizedBox(height: AppSpacing.xxs),
        ChatOperationProgressCard(status: liveStatus),
        const SizedBox(height: AppSpacing.xs),
      ],
    ];
  }

  void _dismissCreditsReady() => setState(_clearCreditsReadyPrompt);
}
