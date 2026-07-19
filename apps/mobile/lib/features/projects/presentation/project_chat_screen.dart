import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'message_actions_menu.dart';
import 'project_route_error.dart';
import 'saved_export_card.dart';

class ProjectChatScreen extends ConsumerStatefulWidget {
  const ProjectChatScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<ProjectChatScreen> createState() => _ProjectChatScreenState();
}

/// A just-sent user message shown optimistically until the refreshed
/// transcript (or a failure) replaces it.
class _PendingEcho {
  const _PendingEcho({required this.text, this.failed = false, this.error});

  final String text;
  final bool failed;
  final String? error;
}

class _ProjectChatScreenState extends ConsumerState<ProjectChatScreen> {
  final _controller = TextEditingController();
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
  int _requestSequence = 0;
  _PendingEcho? _pendingEcho;
  final List<MobileProjectChatMessage> _olderMessages = [];

  @override
  void dispose() {
    _controller.dispose();
    _editController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final chatValue = ref.watch(projectChatProvider(widget.projectId));
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));

    return Scaffold(
      appBar: AppBar(
        title: Text(projectValue.asData?.value.title ?? 'Book chat'),
        actions: [
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
        data: (chat) => Column(
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
                    _ChatIntroCard(project: projectValue.asData?.value),
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
                    for (final operation
                        in chat.operations
                            .where((operation) => operation.isRunning)
                            .take(3))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _OperationBubble(operation: operation),
                      ),
                    if (_visibleMessages(chat).isEmpty && _pendingEcho == null)
                      const _EmptyProjectChat()
                    else
                      for (final message in _visibleMessages(chat)) ...[
                        _ProjectMessageBubble(
                          message: message,
                          editController: _editController,
                          editing: _editingMessageId == message.id,
                          submittingEdit:
                              _editing && _editingMessageId == message.id,
                          switchingBranch: _switchingBranch,
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
                        ),
                        const SizedBox(height: 10),
                      ],
                    if (_pendingEcho != null) ...[
                      _PendingEchoBubble(
                        echo: _pendingEcho!,
                        onRetry: _retryPendingEcho,
                        onDismiss: _dismissPendingEcho,
                      ),
                      const SizedBox(height: 10),
                    ],
                  ],
                ),
              ),
            ),
            _ProjectChatComposer(
              controller: _controller,
              sending: _sending || _editing,
              onSend: _send,
            ),
          ],
        ),
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

  String? _replanCopyTargetProjectId(MobileProjectChatMessage message) {
    if (!message.isAssistant) return null;
    final targetProjectId = message.replanCopyTargetProjectId;
    if (targetProjectId == widget.projectId) return null;
    return targetProjectId;
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
      _pendingEcho = _PendingEcho(text: message);
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
      if (result.operation != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.operation!.currentAction)),
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _pendingEcho = _PendingEcho(
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
      if (result.operation != null) {
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

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
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

class _ChatIntroCard extends StatelessWidget {
  const _ChatIntroCard({this.project});

  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final status = project?.status;
    final hint = status == 'plan_ready'
        ? 'Ask questions or request plan changes. Plan edits use credits and apply automatically.'
        : status == 'complete'
        ? 'Ask questions or request edits to the latest generated book. Real edits use credits and apply automatically.'
        : 'You can ask questions now. Editing unlocks after planning or generation reaches the right stage.';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.auto_fix_high_outlined, color: colors.primary),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Edit in chat',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(hint),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyProjectChat extends StatelessWidget {
  const _EmptyProjectChat();

  @override
  Widget build(BuildContext context) {
    return const AppEmptyState(
      title: 'No messages yet',
      message:
          'Ask “What should I improve?” or “Rewrite page 3 to sound warmer.”',
      icon: Icons.chat_bubble_outline,
    );
  }
}

class _OperationBubble extends StatelessWidget {
  const _OperationBubble({required this.operation});

  final MobileBookEditOperation operation;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      color: colors.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(operation.currentAction)),
            if (operation.creditsCharged > 0)
              Text('${operation.creditsCharged} credits'),
          ],
        ),
      ),
    );
  }
}

/// The optimistic bubble for a message that is still in flight or has failed.
class _PendingEchoBubble extends StatelessWidget {
  const _PendingEchoBubble({
    required this.echo,
    required this.onRetry,
    required this.onDismiss,
  });

  final _PendingEcho echo;
  final VoidCallback onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final background = echo.failed ? colors.errorContainer : colors.primary;
    final foreground = echo.failed ? colors.onErrorContainer : colors.onPrimary;
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Flexible(
                      child: Text(
                        echo.text,
                        style: TextStyle(color: foreground),
                      ),
                    ),
                    if (!echo.failed) ...[
                      const SizedBox(width: 8),
                      SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: foreground,
                        ),
                      ),
                    ],
                  ],
                ),
                if (echo.failed) ...[
                  const SizedBox(height: 6),
                  Text(
                    echo.error ?? 'The message could not be sent.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: foreground,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 4,
                    children: [
                      TextButton(
                        onPressed: onDismiss,
                        child: Text(
                          'Dismiss',
                          style: TextStyle(color: foreground),
                        ),
                      ),
                      FilledButton.tonalIcon(
                        onPressed: onRetry,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: const Text('Retry'),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectMessageBubble extends StatelessWidget {
  const _ProjectMessageBubble({
    required this.message,
    required this.editController,
    required this.editing,
    required this.submittingEdit,
    required this.switchingBranch,
    required this.onSwitchBranch,
    this.onStartEdit,
    this.onCancelEdit,
    this.onSubmitEdit,
    this.onOpenPaywall,
    this.onOpenReplanCopy,
  });

  final MobileProjectChatMessage message;
  final TextEditingController editController;
  final bool editing;
  final bool submittingEdit;
  final bool switchingBranch;
  final ValueChanged<String> onSwitchBranch;
  final VoidCallback? onStartEdit;
  final VoidCallback? onCancelEdit;
  final VoidCallback? onSubmitEdit;
  final VoidCallback? onOpenPaywall;
  final VoidCallback? onOpenReplanCopy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final branch = message.branch;
    final manualEdit = message.isAssistant ? message.manualEdit : null;
    final background = editing
        ? colors.surfaceContainerHighest
        : isUser
        ? colors.primary
        : colors.surfaceContainerHighest;
    final foreground = editing
        ? colors.onSurface
        : isUser
        ? colors.onPrimary
        : colors.onSurface;
    final bubble = GestureDetector(
      onLongPressStart: (details) {
        showMessageActionsMenu(
          context: context,
          position: details.globalPosition,
          message: message.content,
          onEdit: isUser ? onStartEdit : null,
        );
      },
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (editing)
                  _InlineMessageEditor(
                    controller: editController,
                    submitting: submittingEdit,
                    onCancel: onCancelEdit,
                    onSubmit: onSubmitEdit,
                  )
                else
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Flexible(
                        child: Text(
                          message.content,
                          style: TextStyle(color: foreground),
                        ),
                      ),
                      if (isUser && onStartEdit != null) ...[
                        const SizedBox(width: 4),
                        IconButton(
                          tooltip: 'Edit message',
                          visualDensity: VisualDensity.compact,
                          constraints: const BoxConstraints(
                            minWidth: 32,
                            minHeight: 32,
                          ),
                          padding: EdgeInsets.zero,
                          onPressed: onStartEdit,
                          icon: Icon(
                            Icons.edit_outlined,
                            size: 18,
                            color: foreground,
                          ),
                        ),
                      ],
                    ],
                  ),
                if (branch != null) ...[
                  const SizedBox(height: 8),
                  BranchNavigator(
                    branch: branch,
                    foreground: foreground,
                    switching: switchingBranch,
                    onPrevious: () => onSwitchBranch('previous'),
                    onNext: () => onSwitchBranch('next'),
                  ),
                ],
                if (onOpenPaywall != null) ...[
                  const SizedBox(height: 10),
                  FilledButton.icon(
                    onPressed: onOpenPaywall,
                    icon: const Icon(Icons.add_card_outlined),
                    label: const Text('Add credits'),
                  ),
                ],
                if (onOpenReplanCopy != null) ...[
                  const SizedBox(height: 10),
                  ActionChip(
                    avatar: const Icon(Icons.open_in_new_outlined, size: 18),
                    label: const Text('Open the new book'),
                    onPressed: onOpenReplanCopy,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: manualEdit == null
          ? bubble
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                bubble,
                SavedExportCard(message: message),
              ],
            ),
    );
  }
}

class _InlineMessageEditor extends StatelessWidget {
  const _InlineMessageEditor({
    required this.controller,
    required this.submitting,
    this.onCancel,
    this.onSubmit,
  });

  final TextEditingController controller;
  final bool submitting;
  final VoidCallback? onCancel;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: controller,
          autofocus: true,
          minLines: 1,
          maxLines: 6,
          textInputAction: TextInputAction.newline,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          runSpacing: 8,
          children: [
            TextButton(
              onPressed: submitting ? null : onCancel,
              child: const Text('Cancel'),
            ),
            FilledButton.icon(
              onPressed: submitting ? null : onSubmit,
              icon: submitting
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send_outlined),
              label: const Text('Save & Submit'),
            ),
          ],
        ),
      ],
    );
  }
}

class _ProjectChatComposer extends StatelessWidget {
  const _ProjectChatComposer({
    required this.controller,
    required this.sending,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surface,
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: const InputDecoration(
                    hintText: 'Ask or request an edit…',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: sending ? null : onSend,
                child: sending
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send_outlined),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
