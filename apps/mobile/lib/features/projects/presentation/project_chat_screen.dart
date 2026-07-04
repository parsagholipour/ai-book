import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'message_actions_menu.dart';
import 'project_route_error.dart';

class ProjectChatScreen extends ConsumerStatefulWidget {
  const ProjectChatScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<ProjectChatScreen> createState() => _ProjectChatScreenState();
}

class _ProjectChatScreenState extends ConsumerState<ProjectChatScreen> {
  final _controller = TextEditingController();
  final _editController = TextEditingController();
  final _scrollController = ScrollController();
  bool _sending = false;
  bool _editing = false;
  bool _switchingBranch = false;
  String? _editingMessageId;

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
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                  children: [
                    _ChatIntroCard(project: projectValue.asData?.value),
                    const SizedBox(height: 12),
                    for (final operation
                        in chat.operations
                            .where((operation) => operation.isRunning)
                            .take(3))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _OperationBubble(operation: operation),
                      ),
                    if (chat.messages.isEmpty)
                      const _EmptyProjectChat()
                    else
                      for (final message in chat.messages) ...[
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
    ref.invalidate(projectChatProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
    ref.invalidate(projectStatusProvider(widget.projectId));
  }

  Future<void> _send() async {
    final message = _controller.text.trim();
    if (message.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      _controller.clear();
      final result = await ref
          .read(projectsRepositoryProvider)
          .sendProjectChatMessage(
            projectId: widget.projectId,
            message: message,
          );
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectDetailProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      setState(() => _sending = false);
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      if (result.operation != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.operation!.currentAction)),
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _sending = false);
      _controller.text = message;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  void _startEdit(MobileProjectChatMessage message) {
    if (_sending || _editing) return;
    setState(() {
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
      _editController.clear();
    });
  }

  Future<void> _submitEdit() async {
    final messageId = _editingMessageId;
    final message = _editController.text.trim();
    if (messageId == null || message.isEmpty || _editing) return;
    setState(() => _editing = true);
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .editProjectChatMessage(
            projectId: widget.projectId,
            messageId: messageId,
            message: message,
          );
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
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Text(
        'No messages yet. Ask “What should I improve?” or “Rewrite page 3 to sound warmer.”',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
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

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final branch = message.branch;
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
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPressStart: (details) {
          if (isUser && onStartEdit != null) {
            onStartEdit!();
            return;
          }
          showMessageActionsMenu(
            context: context,
            position: details.globalPosition,
            message: message.content,
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
                    _BranchNavigator(
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
                ],
              ),
            ),
          ),
        ),
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

class _BranchNavigator extends StatelessWidget {
  const _BranchNavigator({
    required this.branch,
    required this.foreground,
    required this.switching,
    required this.onPrevious,
    required this.onNext,
  });

  final MobileProjectChatBranch branch;
  final Color foreground;
  final bool switching;
  final VoidCallback onPrevious;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    final color = foreground.withValues(alpha: 0.85);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: 'Previous branch',
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          padding: EdgeInsets.zero,
          onPressed: switching || !branch.canGoPrevious ? null : onPrevious,
          icon: Icon(Icons.chevron_left, color: color, size: 20),
        ),
        Text(
          '${branch.index}/${branch.total}',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
          ),
        ),
        IconButton(
          tooltip: 'Next branch',
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          padding: EdgeInsets.zero,
          onPressed: switching || !branch.canGoNext ? null : onNext,
          icon: Icon(Icons.chevron_right, color: color, size: 20),
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
