import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../voice/presentation/character_cast_sheet.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'chat_reply_quote.dart';
import 'chat_thinking_bubble.dart';
import 'generation_retry_confirmation.dart';
import 'plan_revision_retry.dart';
import 'project_chat_bubbles.dart';
import 'project_chat_composer.dart';
import 'project_chat_operations.dart';
import 'project_route_error.dart';

part 'project_chat_edit_actions.dart';

/// What a screen wants the book chat to do when it opens.
///
/// Carried as the route's `extra`. The reader uses it so acting on a passage
/// lands in the chat immediately: sending first and navigating afterwards left
/// the user looking at the book for as long as the request took.
class ProjectChatLaunch {
  const ProjectChatLaunch({this.draft, this.send, this.readerContext});

  /// Text to prefill the composer with, left unsent.
  final String? draft;

  /// Text to send as soon as the chat is on screen.
  final String? send;

  /// Where in the book the reader composed [send]: the book page the locator
  /// resolved (`pageIndex`), and the physical PDF sheet they were looking at
  /// (`pdfPage`) with the digest of the file it is a sheet of. The server
  /// targets the edit by these rather than re-parsing the message text.
  final Map<String, Object>? readerContext;
}

class ProjectChatScreen extends ConsumerStatefulWidget {
  const ProjectChatScreen({
    required this.projectId,
    this.initialDraft,
    this.initialMessage,
    this.initialReaderContext,
    super.key,
  });

  final String projectId;

  /// Text the composer opens with, left unsent so the user can finish the
  /// thought. The reader uses it to carry a selected passage into the chat.
  final String? initialDraft;

  /// Text sent automatically once the screen is up, through the same optimistic
  /// path as typing it, so the pending bubble, retry and errors all behave
  /// exactly as they normally do.
  final String? initialMessage;

  /// The reader position [initialMessage] was composed from, sent alongside it.
  final Map<String, Object>? initialReaderContext;

  @override
  ConsumerState<ProjectChatScreen> createState() => _ProjectChatScreenState();
}

class _ProjectChatScreenState extends ConsumerState<ProjectChatScreen>
    with _ProjectChatEditActions {
  @override
  late final _controller = TextEditingController(
    text: widget.initialDraft ?? '',
  );
  final _editController = TextEditingController();
  final _scrollController = ScrollController();
  final _messageAnchors = ChatMessageAnchorController(
    debugLabel: 'project-chat',
  );
  @override
  bool _sending = false;
  bool _editing = false;
  bool _switchingBranch = false;
  bool _loadingEarlier = false;
  String? _editingMessageId;
  String? _pendingSendRequestId;
  String? _pendingSendMessage;

  /// The message the composer is quoting, and the one the in-flight send
  /// quoted — kept separately so a retry resends the same reply.
  ChatReplyTarget? _replyTarget;
  ChatReplyTarget? _pendingSendReplyTo;
  Map<String, Object>? _pendingSendReaderContext;

  /// A reader-composed message parked in the composer while the book was busy,
  /// with the position it was composed from. The context re-attaches only when
  /// the parked text is sent verbatim; an edited message drops it.
  Map<String, Object>? _parkedReaderContext;
  String? _parkedMessage;
  String? _pendingEditRequestId;
  String? _pendingEditMessage;
  String? _historyNextCursor;
  bool? _historyHasMore;
  int _requestSequence = 0;
  bool _initialScrollDone = false;
  ProviderSubscription<AsyncValue<MobileProjectStatus>>? _statusSubscription;
  bool _wasLive = false;
  PendingEcho? _pendingEcho;
  final List<MobileProjectChatMessage> _olderMessages = [];

  /// The resumable proposal behind a "You now have enough credits" bubble,
  /// set when a paywall opened from an insufficient-credits reply closed with
  /// a purchase that covers the blocked edit. Local by design: after a restart
  /// the reply's own proposal card is the way to proceed.
  String? _creditsReadyProposalId;

  @override
  void initState() {
    super.initState();
    // The project status stream is what makes a running edit visible: it
    // reports progress while the worker is busy and tells us the moment the
    // result is ready to pull into the transcript.
    _statusSubscription = ref.listenManual(
      projectStatusProvider(widget.projectId),
      (previous, next) => _onStatusChanged(next),
      fireImmediately: true,
    );
    final message = widget.initialMessage?.trim();
    if (message == null || message.isEmpty) {
      return;
    }
    // After the first frame so the transcript, and the optimistic bubble the
    // send adds to it, have somewhere to appear.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // The reader can hand a passage over while the book is mid-rebuild. The
      // composer is closed then, so park the text in it rather than send into
      // work that cannot take it — it is sendable the moment the job settles.
      if (_bookIsBusy) {
        setState(() {
          _controller.text = message;
          _controller.selection = TextSelection.collapsed(
            offset: message.length,
          );
          // The selection's position must survive the parking, or the send
          // that eventually happens is a typed message whose "page N" the
          // server has to re-parse — a mistarget on any book without a map.
          _parkedReaderContext = widget.initialReaderContext;
          _parkedMessage = message;
        });
        return;
      }
      unawaited(
        _sendMessage(message, readerContext: widget.initialReaderContext),
      );
    });
  }

  /// Whether the worker is currently rebuilding this book.
  ///
  /// Read rather than watched: the guards using it run from callbacks, where
  /// the composer's disabled state was already decided by the last build.
  @override
  bool get _bookIsBusy =>
      ref.read(projectStatusProvider(widget.projectId)).asData?.value.isLive ??
      false;

  /// The hint the composer shows while it is closed, or null while it is open.
  ///
  /// A book being rewritten cannot take a second request — the API refuses one
  /// until the current job settles — so the chat says so rather than accepting
  /// messages that would only be parked.
  String? _composerLockLabel(MobileProjectStatus? liveStatus) {
    if (liveStatus == null) return null;
    return switch (liveStatus.status) {
      'planning' => 'Revising your plan…',
      'generating' => 'Generating your book…',
      _ => 'Regenerating your book…',
    };
  }

  /// Whether to draw the assistant-side "thinking" bubble.
  ///
  /// Every one of these flags is a request the user is waiting on a reply to.
  /// Hidden once the work is live, because the progress card says the same
  /// thing with real numbers and two busy indicators read as two jobs.
  bool _showThinking(MobileProjectStatus? liveStatus) {
    if (liveStatus != null) return false;
    return _sending || _editing || _undoing || _retryingOperationId != null;
  }

  /// Remembers that work was handed to the worker.
  ///
  /// The falling edge below is what pulls a finished edit into the transcript,
  /// and it only fires if the client saw the work live first. A short edit can
  /// start and finish between two status ticks, which used to strand the
  /// result behind a manual pull-to-refresh. A queued operation in the response
  /// is proof the work exists, so arm the edge from that too.
  @override
  void _armFallingEdge(MobileBookEditOperation? operation) {
    if (operation != null && operation.isRunning) {
      _wasLive = true;
    }
  }

  /// Reacts to the book starting and finishing a piece of work.
  ///
  /// The transcript is only refetched on the falling edge, so the finished
  /// message arrives on its own instead of the user having to pull to refresh.
  void _onStatusChanged(AsyncValue<MobileProjectStatus> value) {
    final status = value.asData?.value;
    if (status == null) return;
    final live = status.isLive;
    if (live) {
      _wasLive = true;
      // Stay pinned to the progress card while it advances, unless the reader
      // has scrolled up to read something.
      _followBottom();
      return;
    }
    if (!_wasLive) return;
    _wasLive = false;
    ref.invalidate(projectChatProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
    ref.invalidate(projectsProvider);
    _scrollToBottomSoon();
  }

  @override
  void dispose() {
    _statusSubscription?.close();
    _controller.dispose();
    _editController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  /// Puts the transcript at the newest message the first time it renders.
  ///
  /// The list is in reading order, so without this the chat opens on the oldest
  /// message and the reader has to scroll to find what just happened.
  void _scheduleInitialScroll() {
    if (_initialScrollDone) return;
    _initialScrollDone = true;
    _scrollToBottomSoon(animate: false);
  }

  void _scrollToReplyTarget() {
    final target = _replyTarget;
    if (target == null) return;
    _messageAnchors.reveal(target: target, scrollController: _scrollController);
  }

  @override
  Widget build(BuildContext context) {
    final chatValue = ref.watch(projectChatProvider(widget.projectId));
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));
    final status = ref
        .watch(projectStatusProvider(widget.projectId))
        .asData
        ?.value;
    final liveStatus = status != null && status.isLive ? status : null;

    return Scaffold(
      appBar: AppBar(
        title: Text(projectValue.asData?.value.title ?? 'Book chat'),
        actions: [
          // Only offered once the book is finished: characters do not exist
          // until the manuscript they come from does.
          if (projectValue.asData?.value.status == 'complete')
            IconButton(
              tooltip: 'Call a character',
              onPressed: () => showCharacterCastSheet(
                context: context,
                projectId: widget.projectId,
              ),
              icon: const Icon(Icons.record_voice_over_outlined),
            ),
          IconButton(
            tooltip: 'Book progress',
            onPressed: () => context.push('/projects/${widget.projectId}'),
            icon: const Icon(Icons.menu_book_outlined),
          ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: chatValue.when(
        data: (chat) {
          _scheduleInitialScroll();
          final operations = _transcriptOperations(chat);
          return Column(
            children: [
              Expanded(
                child: RefreshIndicator(
                  onRefresh: () async => _refresh(),
                  child: ListView(
                    controller: _scrollController,
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                    children: [
                      ChatIntroCard(project: projectValue.asData?.value),
                      const SizedBox(height: 12),
                      if (_canLoadEarlier(chat)) ...[
                        Center(
                          child: TextButton.icon(
                            onPressed: _loadingEarlier
                                ? null
                                : () => _loadEarlier(chat),
                            icon: _loadingEarlier
                                ? const SizedBox.square(
                                    dimension: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.history),
                            label: const Text('Load earlier messages'),
                          ),
                        ),
                        const SizedBox(height: 8),
                      ],
                      if (_visibleMessages(chat).isEmpty &&
                          _pendingEcho == null)
                        const EmptyProjectChat()
                      else
                        for (final message in _visibleMessages(chat)) ...[
                          ProjectMessageBubble(
                            key: _messageAnchors.keyFor(message.id),
                            message: message,
                            editController: _editController,
                            editing: _editingMessageId == message.id,
                            submittingEdit:
                                _editing && _editingMessageId == message.id,
                            switchingBranch: _switchingBranch,
                            // Only a proposal the server would still accept
                            // shows Apply/Cancel. Applying or cancelling one
                            // settles it there, so a card left asking after
                            // that invites a tap the API can only replay.
                            showProposalActions:
                                message.editProposal != null &&
                                message.editProposal!.id ==
                                    chat.openProposalId,
                            // A live job closes the proposal card's Apply for
                            // the same reason it closes the composer: it would
                            // queue a second edit the API has to refuse.
                            sending: _sending || _editing || liveStatus != null,
                            // While the edit runs it has no card yet, so the
                            // reply itself carries the charge; once the card
                            // appears it owns the number.
                            showCreditCost: operations
                                .anchoredTo(message.id)
                                .isEmpty,
                            onStartEdit: message.isUser && liveStatus == null
                                ? () => _startEdit(message)
                                : null,
                            onReply: () => _startReply(message),
                            onCancelEdit: _cancelEdit,
                            onSubmitEdit: _submitEdit,
                            onSwitchBranch: (direction) =>
                                _switchBranch(message, direction),
                            onOpenPaywall: message.hasInsufficientCredits
                                ? () => _openPaywall(
                                    projectValue.asData?.value,
                                    credits:
                                        message.insufficientCreditsRequired,
                                    resumeProposalId:
                                        message.editProposal?.id,
                                  )
                                : null,
                            onOpenReplanCopy:
                                _replanCopyTargetProjectId(message) == null
                                ? null
                                : () => context.push(
                                    '/projects/${_replanCopyTargetProjectId(message)}/chat',
                                  ),
                            onApplyProposal: message.editProposal == null
                                ? null
                                : () => unawaited(
                                    _applyProposal(message.editProposal!.id),
                                  ),
                            onCancelProposal: message.editProposal == null
                                ? null
                                : () => unawaited(
                                    _cancelProposal(message.editProposal!.id),
                                  ),
                          ),
                          const SizedBox(height: 10),
                          for (final operation in operations.anchoredTo(
                            message.id,
                          )) ...[
                            _operationBubble(operation),
                            const SizedBox(height: 10),
                          ],
                        ],
                      if (_pendingEcho != null) ...[
                        PendingEchoBubble(
                          echo: _pendingEcho!,
                          onRetry: _retryPendingEcho,
                          onDismiss: _dismissPendingEcho,
                        ),
                        const SizedBox(height: 10),
                      ],
                      if (_creditsReadyProposalId != null) ...[
                        CreditsReadyBubble(
                          onProceed:
                              _sending || _editing || liveStatus != null
                              ? null
                              : _proceedWithCreditsReadyEdit,
                          onDismiss: () => setState(
                            () => _creditsReadyProposalId = null,
                          ),
                        ),
                        const SizedBox(height: 10),
                      ],
                      // Reading the message and working out what it asks for
                      // takes a model call or two, and until this the wait was
                      // silent. Suppressed once the work is live: the progress
                      // card below says the same thing with real numbers, and
                      // two busy indicators read as two things happening.
                      if (_showThinking(liveStatus)) ...[
                        const ChatThinkingBubble(
                          stages: bookChatThinkingStages,
                        ),
                        const SizedBox(height: 10),
                      ],
                      for (final operation in operations.unanchored)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: _operationBubble(operation),
                        ),
                      if (liveStatus != null) ...[
                        const SizedBox(height: 4),
                        ChatOperationProgressCard(status: liveStatus),
                        const SizedBox(height: 8),
                      ],
                    ],
                  ),
                ),
              ),
              ProjectChatComposerBar(
                controller: _controller,
                sending: _sending || _editing,
                onSend: _send,
                lockedLabel: _composerLockLabel(liveStatus),
                replyTarget: _replyTarget,
                onOpenReply: _scrollToReplyTarget,
                onCancelReply: _cancelReply,
              ),
            ],
          );
        },
        loading: () => const AppLoadingState(message: 'Loading book chat'),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Book chat unavailable',
          onRetry: _refresh,
          onGoHome: () => context.go('/home'),
        ),
      ),
    );
  }

  @override
  void _refresh() {
    if (mounted) {
      setState(() {
        _olderMessages.clear();
        _historyNextCursor = null;
        _historyHasMore = null;
      });
    }
    ref.invalidate(projectChatProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
    ref.invalidate(projectStatusProvider(widget.projectId));
  }

  TranscriptOperations _transcriptOperations(MobileProjectChat chat) {
    return splitTranscriptOperations(
      operations: chat.operations,
      messages: _visibleMessages(chat),
    );
  }

  Widget _operationBubble(MobileBookEditOperation operation) {
    return ProjectChatOperationBubble(
      projectId: widget.projectId,
      operation: operation,
      retrying: _retryingOperationId == operation.id,
      undoing: _undoing,
      onRetry: () => _retryOperation(operation),
      onUndo: () => unawaited(_undoLastEdit()),
    );
  }

  String? _replanCopyTargetProjectId(MobileProjectChatMessage message) {
    if (!message.isAssistant) return null;
    final targetProjectId = message.replanCopyTargetProjectId;
    if (targetProjectId == widget.projectId) return null;
    return targetProjectId;
  }

  Future<void> _send() async {
    final message = _controller.text.trim();
    if (message.isEmpty || _sending || _bookIsBusy) return;
    _controller.clear();
    final replyTo = _replyTarget;
    if (replyTo != null) {
      setState(() {
        _replyTarget = null;
        _messageAnchors.forget();
      });
    }
    final parkedContext = message == _parkedMessage ? _parkedReaderContext : null;
    _parkedReaderContext = null;
    _parkedMessage = null;
    await _sendMessage(message, replyTo: replyTo, readerContext: parkedContext);
  }

  /// Quotes a message in the composer. Starting a reply cancels an in-progress
  /// edit: the two share the composer, and an edit rewrites its own message
  /// rather than adding a new one.
  void _startReply(MobileProjectChatMessage message) {
    final target = ChatReplyTarget.from(
      messageId: message.id,
      role: message.role,
      content: message.content,
    );
    if (target == null) return;
    _messageAnchors.remember(target);
    setState(() {
      _editingMessageId = null;
      _replyTarget = target;
    });
  }

  void _cancelReply() {
    setState(() {
      _replyTarget = null;
      _messageAnchors.forget();
    });
  }

  Future<void> _retryPendingEcho() async {
    final echo = _pendingEcho;
    if (echo == null || _sending || _bookIsBusy) return;
    await _sendMessage(
      echo.text,
      replyTo: _pendingSendReplyTo,
      readerContext: _pendingSendReaderContext,
    );
  }

  void _dismissPendingEcho() {
    final echo = _pendingEcho;
    if (echo == null || _sending) return;
    setState(() {
      _pendingEcho = null;
      _pendingSendRequestId = null;
      _pendingSendMessage = null;
      // Hand the text back to the composer, but never clobber something the
      // user typed while the send was in flight.
      if (_controller.text.trim().isEmpty) {
        _controller.text = echo.text;
        _controller.selection = TextSelection.collapsed(
          offset: _controller.text.length,
        );
      }
    });
  }

  @override
  Future<void> _sendMessage(
    String message, {
    ChatReplyTarget? replyTo,
    Map<String, Object>? readerContext,
  }) async {
    // Retrying the same text reuses the request ID, so the server replays
    // the original turn instead of duplicating it. The quoted message is part
    // of the request: the same words replying to a different turn are a
    // different ask, and reusing the key would replay the first one.
    if (_pendingSendMessage != message ||
        _pendingSendReplyTo?.messageId != replyTo?.messageId) {
      _pendingSendRequestId = _newRequestId('chat');
      _pendingSendMessage = message;
      _pendingSendReplyTo = replyTo;
      _pendingSendReaderContext = readerContext;
    }
    final requestId = _pendingSendRequestId!;
    setState(() {
      _sending = true;
      _pendingEcho = PendingEcho(text: message);
      // A new request supersedes the top-up follow-up; its proposal card in
      // the transcript remains the way to run that edit.
      _creditsReadyProposalId = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .sendProjectChatMessage(
            projectId: widget.projectId,
            message: message,
            requestId: requestId,
            replyToMessageId: replyTo?.messageId,
            readerContext: _pendingSendReaderContext,
          );
      _pendingSendRequestId = null;
      _pendingSendMessage = null;
      _pendingSendReplyTo = null;
      _pendingSendReaderContext = null;
      _armFallingEdge(result.operation);
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectDetailProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      // Keep the optimistic bubble until the refreshed transcript (which
      // contains the real message) is on screen, so the message never blinks
      // out of the list.
      try {
        await ref.read(projectChatProvider(widget.projectId).future);
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _sending = false;
        _pendingEcho = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      if (result.operation != null && !result.operation!.isPlanRevision) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          SnackBar(content: Text(result.operation!.currentAction)),
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _pendingEcho = PendingEcho(
          text: message,
          failed: true,
          error: userFacingError(error),
        );
      });
    }
  }

  void _startEdit(MobileProjectChatMessage message) {
    if (_sending || _editing || _bookIsBusy) return;
    setState(() {
      _pendingEditRequestId = null;
      _pendingEditMessage = null;
      // Editing and replying share the composer area.
      _replyTarget = null;
      _messageAnchors.forget();
      _editingMessageId = message.id;
      _editController.text = message.content;
      _editController.selection = TextSelection.collapsed(
        offset: _editController.text.length,
      );
    });
  }

  void _cancelEdit() {
    setState(() {
      _editingMessageId = null;
      _pendingEditRequestId = null;
      _pendingEditMessage = null;
      _editController.clear();
    });
  }

  Future<void> _submitEdit() async {
    final messageId = _editingMessageId;
    final message = _editController.text.trim();
    if (messageId == null || message.isEmpty || _editing || _bookIsBusy) return;
    setState(() => _editing = true);
    if (_pendingEditMessage != message) {
      _pendingEditRequestId = _newRequestId('edit');
      _pendingEditMessage = message;
    }
    final requestId = _pendingEditRequestId!;
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .editProjectChatMessage(
            projectId: widget.projectId,
            messageId: messageId,
            message: message,
            requestId: requestId,
          );
      _pendingEditRequestId = null;
      _pendingEditMessage = null;
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectDetailProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      setState(() {
        _editing = false;
        _editingMessageId = null;
        _editController.clear();
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      if (result.operation != null && !result.operation!.isPlanRevision) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          SnackBar(content: Text(result.operation!.currentAction)),
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _editing = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _switchBranch(
    MobileProjectChatMessage message,
    String direction,
  ) async {
    if (_switchingBranch) return;
    setState(() => _switchingBranch = true);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .switchProjectChatBranch(
            projectId: widget.projectId,
            messageId: message.id,
            direction: direction,
          );
      ref.invalidate(projectChatProvider(widget.projectId));
      if (!mounted) return;
      setState(() => _switchingBranch = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _switchingBranch = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _openPaywall(
    MobileProjectDetail? project, {
    int? credits,
    String? resumeProposalId,
  }) async {
    final purchase = await showBillingPaywall(
      context,
      projectId: widget.projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded(
        credits: credits,
        reason: project == null
            ? 'Applying this edit.'
            : 'Applying this edit to "${project.title}".',
      ),
    );
    if (!mounted) return;
    ref.invalidate(billingProvider);
    _refresh();
    // Guide instead of going quiet: the purchase closed the shortfall that
    // blocked an edit, so say so and offer to run it — otherwise the chat sits
    // on the same "Add credits" reply as if nothing happened.
    if (purchase == null || resumeProposalId == null) return;
    final covered = await _balanceCovers(credits);
    if (!mounted || !covered) return;
    setState(() => _creditsReadyProposalId = resumeProposalId);
    _scrollToBottomSoon();
  }

  /// Whether the balance now covers what the blocked edit needed. An unknown
  /// balance counts as covered — Proceed re-checks server-side anyway, and the
  /// worst case is the same insufficient-credits reply with fresh numbers.
  Future<bool> _balanceCovers(int? required) async {
    if (required == null) return true;
    try {
      final billing = await ref.read(billingProvider.future);
      return billing.credits.available >= required;
    } catch (_) {
      return true;
    }
  }

  @override
  void _clearCreditsReadyPrompt() => _creditsReadyProposalId = null;

  void _proceedWithCreditsReadyEdit() {
    final proposalId = _creditsReadyProposalId;
    if (proposalId == null) return;
    setState(_clearCreditsReadyPrompt);
    unawaited(_applyProposal(proposalId));
  }

  /// Whether the newest message is already in view.
  ///
  /// Used to decide between following the conversation and leaving someone who
  /// has scrolled back where they are.
  bool get _isNearBottom {
    if (!_scrollController.hasClients) return true;
    final position = _scrollController.position;
    return position.maxScrollExtent - position.pixels < 120;
  }

  void _followBottom() {
    if (_isNearBottom) _scrollToBottomSoon();
  }

  /// Scrolls to the newest content once the frame that added it has laid out.
  ///
  /// Two passes, because a card arriving with the new content sizes itself
  /// during that first layout: a single scroll aims at an extent that is about
  /// to grow and stops just short of the bottom.
  @override
  void _scrollToBottomSoon({bool animate = true}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollToBottom(animate: animate);
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _scrollToBottom(animate: animate),
      );
      WidgetsBinding.instance.scheduleFrame();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  void _scrollToBottom({bool animate = true}) {
    if (!_scrollController.hasClients) return;
    final target = _scrollController.position.maxScrollExtent;
    if (!animate) {
      _scrollController.jumpTo(target);
      return;
    }
    _scrollController.animateTo(
      target,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }

  @override
  String _newRequestId(String prefix) {
    _requestSequence += 1;
    return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$_requestSequence';
  }

  bool _canLoadEarlier(MobileProjectChat chat) =>
      _historyHasMore ?? chat.hasMore;

  List<MobileProjectChatMessage> _visibleMessages(MobileProjectChat chat) {
    final byId = <String, MobileProjectChatMessage>{};
    for (final message in [..._olderMessages, ...chat.messages]) {
      byId[message.id] = message;
    }
    final messages = byId.values.toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return messages;
  }

  Future<void> _loadEarlier(MobileProjectChat chat) async {
    if (_loadingEarlier || !_canLoadEarlier(chat)) return;
    final cursor = _historyNextCursor ?? chat.nextCursor;
    if (cursor == null) return;
    setState(() => _loadingEarlier = true);
    try {
      final page = await ref
          .read(projectsRepositoryProvider)
          .getProjectChat(widget.projectId, beforeMessageId: cursor);
      if (!mounted) return;
      setState(() {
        final known = _olderMessages.map((message) => message.id).toSet();
        _olderMessages.insertAll(
          0,
          page.messages.where((message) => known.add(message.id)),
        );
        _historyNextCursor = page.nextCursor;
        _historyHasMore = page.hasMore;
        _loadingEarlier = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _loadingEarlier = false);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}
