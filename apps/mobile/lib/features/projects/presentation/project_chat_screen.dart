import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../voice/presentation/character_cast_sheet.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'plan_revision_retry.dart';
import 'project_chat_bubbles.dart';
import 'project_chat_composer.dart';
import 'project_route_error.dart';

/// What a screen wants the book chat to do when it opens.
///
/// Carried as the route's `extra`. The reader uses it so acting on a passage
/// lands in the chat immediately: sending first and navigating afterwards left
/// the user looking at the book for as long as the request took.
class ProjectChatLaunch {
  const ProjectChatLaunch({this.draft, this.send});

  /// Text to prefill the composer with, left unsent.
  final String? draft;

  /// Text to send as soon as the chat is on screen.
  final String? send;
}

class ProjectChatScreen extends ConsumerStatefulWidget {
  const ProjectChatScreen({
    required this.projectId,
    this.initialDraft,
    this.initialMessage,
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

  @override
  ConsumerState<ProjectChatScreen> createState() => _ProjectChatScreenState();
}

class _ProjectChatScreenState extends ConsumerState<ProjectChatScreen> {
  late final _controller = TextEditingController(
    text: widget.initialDraft ?? '',
  );
  final _editController = TextEditingController();
  final _scrollController = ScrollController();
  bool _sending = false;
  bool _editing = false;
  bool _switchingBranch = false;
  bool _loadingEarlier = false;
  String? _editingMessageId;
  String? _pendingSendRequestId;
  String? _pendingSendMessage;
  String? _pendingEditRequestId;
  String? _pendingEditMessage;
  String? _historyNextCursor;
  bool? _historyHasMore;
  String? _retryingOperationId;
  bool _undoing = false;
  int _requestSequence = 0;
  bool _initialScrollDone = false;
  ProviderSubscription<AsyncValue<MobileProjectStatus>>? _statusSubscription;
  bool _wasLive = false;
  PendingEcho? _pendingEcho;
  final List<MobileProjectChatMessage> _olderMessages = [];

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
      if (mounted) unawaited(_sendMessage(message));
    });
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
            onPressed: () =>
                context.push('/projects/${widget.projectId}/handoff'),
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
                            message: message,
                            editController: _editController,
                            editing: _editingMessageId == message.id,
                            submittingEdit:
                                _editing && _editingMessageId == message.id,
                            switchingBranch: _switchingBranch,
                            showProposalActions: _isActiveEditProposal(
                              chat,
                              message,
                            ),
                            sending: _sending || _editing,
                            // While the edit runs it has no card yet, so the
                            // reply itself carries the charge; once the card
                            // appears it owns the number.
                            showCreditCost: operations
                                .anchoredTo(message.id)
                                .isEmpty,
                            onStartEdit: message.isUser
                                ? () => _startEdit(message)
                                : null,
                            onCancelEdit: _cancelEdit,
                            onSubmitEdit: _submitEdit,
                            onSwitchBranch: (direction) =>
                                _switchBranch(message, direction),
                            onOpenPaywall: message.hasInsufficientCredits
                                ? () => _openPaywall(projectValue.asData?.value)
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
              ProjectChatComposer(
                controller: _controller,
                sending: _sending || _editing,
                onSend: _send,
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

  /// Splits the operations worth showing into the ones that belong under a
  /// visible message and the ones with nowhere else to go.
  ///
  /// Every applied and failed edit appears, each under the turn that produced
  /// it, so the transcript reads as the book's history. Rendering them at the
  /// end of the list instead put "Edit applied" and its credit charge underneath
  /// whatever the user asked most recently — including a proposal still waiting
  /// on Apply, which read as if that proposal had gone through and been billed.
  _TranscriptOperations _transcriptOperations(MobileProjectChat chat) {
    final visibleIds = _visibleMessages(
      chat,
    ).map((message) => message.id).toSet();
    final anchored = <String, List<MobileBookEditOperation>>{};
    final unanchored = <MobileBookEditOperation>[];
    for (final operation in chat.operations) {
      if (!operation.isFailed && !operation.isApplied) {
        continue;
      }
      final anchor = operation.anchorMessageId;
      if (anchor != null && visibleIds.contains(anchor)) {
        (anchored[anchor] ??= []).add(operation);
        continue;
      }
      // Nowhere to sit in the transcript. Only the most recent couple are worth
      // stacking at the end; older ones would be history without its context.
      if (unanchored.length < 2) {
        unanchored.add(operation);
      }
    }
    return _TranscriptOperations(anchored: anchored, unanchored: unanchored);
  }

  Widget _operationBubble(MobileBookEditOperation operation) {
    final openAtPage = operation.affectedPageIndexes.isEmpty
        ? null
        : operation.affectedPageIndexes.reduce((a, b) => a < b ? a : b);
    return OperationBubble(
      operation: operation,
      retrying: _retryingOperationId == operation.id,
      undoing: _undoing,
      onRetry: operation.isFailed ? () => _retryOperation(operation) : null,
      onUndo: operation.canUndo ? () => unawaited(_undoLastEdit()) : null,
      onViewPlan: operation.isPlanRevision
          ? () => context.push('/projects/${widget.projectId}')
          : null,
      onOpenBook: operation.isApplied
          ? () => context.push(
              '/projects/${widget.projectId}/read'
              '${openAtPage == null ? '' : '?page=$openAtPage'}',
            )
          : null,
      // A failed edit keeps whatever snapshots it managed to write, but its card
      // is for getting the book back on track — Retry, not a diff.
      onSeeChanges: operation.isApplied && operation.changesAvailable
          ? () => context.push(
              '/projects/${widget.projectId}/changes/${operation.id}',
            )
          : null,
    );
  }

  String? _replanCopyTargetProjectId(MobileProjectChatMessage message) {
    if (!message.isAssistant) return null;
    final targetProjectId = message.replanCopyTargetProjectId;
    if (targetProjectId == widget.projectId) return null;
    return targetProjectId;
  }

  /// Only the newest priced proposal shows Apply/Cancel, so older cards stay
  /// read-only history after the user continues chatting.
  bool _isActiveEditProposal(
    MobileProjectChat chat,
    MobileProjectChatMessage message,
  ) {
    if (message.editProposal == null) return false;
    final messages = _visibleMessages(chat);
    for (var index = messages.length - 1; index >= 0; index -= 1) {
      final candidate = messages[index];
      if (candidate.editProposal != null) {
        return candidate.id == message.id;
      }
    }
    return false;
  }

  Future<void> _send() async {
    final message = _controller.text.trim();
    if (message.isEmpty || _sending) return;
    _controller.clear();
    await _sendMessage(message);
  }

  Future<void> _retryPendingEcho() async {
    final echo = _pendingEcho;
    if (echo == null || _sending) return;
    await _sendMessage(echo.text);
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

  Future<void> _sendMessage(String message) async {
    // Retrying the same text reuses the request ID, so the server replays
    // the original turn instead of duplicating it.
    if (_pendingSendMessage != message) {
      _pendingSendRequestId = _newRequestId('chat');
      _pendingSendMessage = message;
    }
    final requestId = _pendingSendRequestId!;
    setState(() {
      _sending = true;
      _pendingEcho = PendingEcho(text: message);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .sendProjectChatMessage(
            projectId: widget.projectId,
            message: message,
            requestId: requestId,
          );
      _pendingSendRequestId = null;
      _pendingSendMessage = null;
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
        ScaffoldMessenger.of(context).showSnackBar(
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
    if (_sending || _editing) return;
    setState(() {
      _pendingEditRequestId = null;
      _pendingEditMessage = null;
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
    if (messageId == null || message.isEmpty || _editing) return;
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
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.operation!.currentAction)),
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _editing = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
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
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

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
      ScaffoldMessenger.of(context).showSnackBar(
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
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _applyProposal(String proposalId) async {
    if (_sending) return;
    if (proposalId.isEmpty) {
      await _sendMessage('apply it');
      return;
    }
    final requestId = _newRequestId('proposal-apply');
    setState(() => _sending = true);
    // Move to where the progress will appear before the request even returns.
    _scrollToBottomSoon();
    try {
      await ref
          .read(projectsRepositoryProvider)
          .applyEditProposal(
            projectId: widget.projectId,
            proposalId: proposalId,
            requestId: requestId,
          );
      if (!mounted) return;
      setState(() => _sending = false);
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(billingProvider);
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() => _sending = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
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
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _undoLastEdit() async {
    if (_undoing || _sending) return;
    final requestId = _newRequestId('undo');
    setState(() => _undoing = true);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .undoLastBookEdit(projectId: widget.projectId, requestId: requestId);
      if (!mounted) return;
      setState(() => _undoing = false);
      _refresh();
      _scrollToBottomSoon();
    } catch (error) {
      if (!mounted) return;
      setState(() => _undoing = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _openPaywall(MobileProjectDetail? project) async {
    await showBillingPaywall(
      context,
      projectId: widget.projectId,
      title: 'Add credits',
      message: project == null
          ? 'Add credits to apply this edit.'
          : 'Add credits to edit "${project.title}".',
    );
    ref.invalidate(billingProvider);
    _refresh();
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
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}

/// Operation bubbles placed against the transcript: [anchored] renders under the
/// message that produced it, [unanchored] falls back to the end of the list.
class _TranscriptOperations {
  const _TranscriptOperations({
    required this.anchored,
    required this.unanchored,
  });

  final Map<String, List<MobileBookEditOperation>> anchored;
  final List<MobileBookEditOperation> unanchored;

  List<MobileBookEditOperation> anchoredTo(String messageId) =>
      anchored[messageId] ?? const [];
}
