part of 'creation_chat_screen.dart';

// The scrolling transcript: message list, banners, and creation-chat message bubbles.
// Imports and shared state live in the parent library file.

class _Transcript extends StatelessWidget {
  const _Transcript({
    required this.state,
    required this.controller,
    this.planValue,
    this.projectChatValue,
    this.generationStatusValue,
    this.planBusyAction,
    this.activeProjectId,
    this.switchingProjectBranch = false,
    this.pendingProjectEcho,
    this.projectChatSending = false,
    this.onRetryPendingProjectEcho,
    this.onDismissPendingProjectEcho,
    this.onSwitchProjectBranch,
    this.onEditProjectMessage,
    this.onOpenReplanCopy,
    this.onOpenPaywall,
    this.onApplyEditProposal,
    this.onCancelEditProposal,
    this.onUndoProjectEdit,
    this.onRetryFailedMessage,
    this.onDismissFailedMessage,
    this.onRetryFailedOperation,
    this.onEditCreationMessage,
    this.onSwitchCreationBranch,
  });

  final CreationChatState state;
  final ScrollController controller;
  final AsyncValue<MobileProjectDetail>? planValue;
  final AsyncValue<MobileProjectChat>? projectChatValue;
  final AsyncValue<MobileProjectStatus>? generationStatusValue;
  final String? planBusyAction;
  final String? activeProjectId;
  final bool switchingProjectBranch;

  /// The output-stage message still in flight, or the one that failed.
  final PendingEcho? pendingProjectEcho;

  /// Whether a request about the finished book is waiting on the server.
  final bool projectChatSending;
  final VoidCallback? onRetryPendingProjectEcho;
  final VoidCallback? onDismissPendingProjectEcho;
  final void Function(MobileProjectChatMessage message, String direction)?
  onSwitchProjectBranch;
  final void Function(MobileProjectChatMessage message)? onEditProjectMessage;
  final ValueChanged<String>? onOpenReplanCopy;
  final void Function(MobileProjectChatMessage message)? onOpenPaywall;
  final void Function(String proposalId)? onApplyEditProposal;
  final void Function(String proposalId)? onCancelEditProposal;
  final VoidCallback? onUndoProjectEdit;
  final ValueChanged<String>? onRetryFailedMessage;
  final ValueChanged<String>? onDismissFailedMessage;
  final void Function(MobileBookEditOperation operation)?
  onRetryFailedOperation;
  final void Function(MobileCreationMessage message)? onEditCreationMessage;
  final void Function(MobileCreationMessage message, String direction)?
  onSwitchCreationBranch;

  @override
  Widget build(BuildContext context) {
    final projectChat = projectChatValue?.asData?.value;
    final currentProject = planValue?.asData?.value;
    final currentPlan = currentProject?.plan;
    final currentPlanKey = currentPlan == null ? null : _planKey(currentPlan);
    final showGenerationForCurrentPlan =
        generationStatusValue != null && (currentPlan?.isApproved ?? false);
    final projectItems = _projectTranscriptItems(projectChat);
    final hasLivePlanBubble =
        planValue != null &&
        _showsLivePlanBubble(planValue!, projectChat, planBusyAction);
    final hasTyping = state.assistantTyping && !hasLivePlanBubble;
    final hasProjectEcho = pendingProjectEcho != null;
    // Same rule the creation side uses: one busy affordance at a time. Once the
    // worker has the job, the generation bubble is the better signal.
    final hasOutputThinking =
        projectChatSending &&
        !hasTyping &&
        !hasLivePlanBubble &&
        !(generationStatusValue?.asData?.value.isLive ?? false);
    final itemCount =
        state.messages.length +
        (hasTyping ? 1 : 0) +
        (hasLivePlanBubble ? 1 : 0) +
        projectItems.length +
        (hasProjectEcho ? 1 : 0) +
        (hasOutputThinking ? 1 : 0);

    return ListView.builder(
      controller: controller,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        final item = _buildTranscriptItem(
          context: context,
          index: index,
          projectItems: projectItems,
          currentProject: currentProject,
          currentPlanKey: currentPlanKey,
          showGenerationForCurrentPlan: showGenerationForCurrentPlan,
          hasLivePlanBubble: hasLivePlanBubble,
          hasTyping: hasTyping,
          hasProjectEcho: hasProjectEcho,
          hasOutputThinking: hasOutputThinking,
        );
        // Only the newest entry animates in. Wrapping every row would replay
        // the entrance whenever an old row scrolled back into view, which
        // makes reading back through a conversation feel unstable.
        if (index != itemCount - 1) {
          return item;
        }
        return AppEntrance(
          key: ValueKey('transcript-newest-$index'),
          child: item,
        );
      },
    );
  }

  Widget _buildTranscriptItem({
    required BuildContext context,
    required int index,
    required List<_ProjectTranscriptItem> projectItems,
    required MobileProjectDetail? currentProject,
    required String? currentPlanKey,
    required bool showGenerationForCurrentPlan,
    required bool hasLivePlanBubble,
    required bool hasTyping,
    required bool hasProjectEcho,
    required bool hasOutputThinking,
  }) {
    var cursor = state.messages.length;
    if (index >= cursor && index < cursor + projectItems.length) {
      final item = projectItems[index - cursor];
      final plan = item.plan;
      if (plan != null) {
        return _PlanWithGenerationProgress(
          showGeneration:
              showGenerationForCurrentPlan && currentPlanKey == _planKey(plan),
          statusValue: generationStatusValue,
          projectId: plan.projectId,
          child: _PlanBubble.snapshot(
            key: ValueKey('project-plan-${plan.id}'),
            plan: plan,
          ),
        );
      }
      final operation = item.operation;
      if (operation != null) {
        return _OutputOperationBubble(
          operation: operation,
          onRetry: operation.isFailed && onRetryFailedOperation != null
              ? () => onRetryFailedOperation!(operation)
              : null,
          onUndo: operation.canUndo ? onUndoProjectEdit : null,
        );
      }
      return _ProjectChatMessageBubble(
        message: item.message!,
        switchingBranch: switchingProjectBranch,
        activeProjectId: activeProjectId,
        onSwitchBranch: onSwitchProjectBranch,
        onEdit: onEditProjectMessage,
        onOpenReplanCopy: onOpenReplanCopy,
        onOpenPaywall: item.message!.hasInsufficientCredits
            ? onOpenPaywall
            : null,
        showProposalActions: _isActiveCreationEditProposal(
          projectItems,
          item.message!,
        ),
        onApplyProposal:
            onApplyEditProposal == null || item.message!.editProposal == null
            ? null
            : () => onApplyEditProposal!(item.message!.editProposal!.id),
        onCancelProposal:
            onCancelEditProposal == null || item.message!.editProposal == null
            ? null
            : () => onCancelEditProposal!(item.message!.editProposal!.id),
      );
    }
    cursor += projectItems.length;
    if (hasLivePlanBubble && index == cursor) {
      return _PlanWithGenerationProgress(
        showGeneration: showGenerationForCurrentPlan,
        statusValue: generationStatusValue,
        projectId: currentProject?.id,
        child: _PlanBubble.live(
          key: const ValueKey('project-plan-live'),
          planValue: planValue!,
          busyAction: planBusyAction,
        ),
      );
    }
    if (hasLivePlanBubble) cursor++;
    if (hasTyping && index == cursor) {
      return const ChatThinkingBubble();
    }
    if (hasTyping) cursor++;
    // The just-sent message about the finished book, and the assistant working
    // on it. Last in the list because they are the newest thing that happened.
    if (hasProjectEcho && index == cursor) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: PendingEchoBubble(
          echo: pendingProjectEcho!,
          onRetry: onRetryPendingProjectEcho ?? () {},
          onDismiss: onDismissPendingProjectEcho ?? () {},
        ),
      );
    }
    if (hasProjectEcho) cursor++;
    if (hasOutputThinking && index == cursor) {
      return const ChatThinkingBubble(stages: bookChatThinkingStages);
    }
    return _MessageBubble(
      message: state.messages[index],
      attachmentThumbnails: state.attachmentThumbnails,
      attachmentUrls: state.attachmentUrls,
      onRetryFailed: onRetryFailedMessage,
      onDismissFailed: onDismissFailedMessage,
      onEdit: onEditCreationMessage,
      onSwitchBranch: onSwitchCreationBranch,
      switchingBranch: state.switchingBranch || state.isBusy,
    );
  }
}

bool _isActiveCreationEditProposal(
  List<_ProjectTranscriptItem> projectItems,
  MobileProjectChatMessage message,
) {
  if (message.editProposal == null) return false;
  for (var index = projectItems.length - 1; index >= 0; index -= 1) {
    final candidate = projectItems[index].message;
    if (candidate?.editProposal != null) {
      return candidate!.id == message.id;
    }
  }
  return false;
}

List<_ProjectTranscriptItem> _projectTranscriptItems(MobileProjectChat? chat) {
  if (chat == null) return const <_ProjectTranscriptItem>[];
  final items = <_ProjectTranscriptItem>[
    for (final plan in chat.plans) _ProjectTranscriptItem.plan(plan),
    for (final message in chat.messages)
      _ProjectTranscriptItem.message(message),
    for (final operation
        in chat.operations.where(_showsOperationInTranscript).take(3))
      _ProjectTranscriptItem.operation(operation),
  ];
  items.sort((a, b) {
    final byTime = a.createdAt.compareTo(b.createdAt);
    if (byTime != 0) return byTime;
    return a.sortPriority.compareTo(b.sortPriority);
  });
  return items;
}

bool _showsLivePlanBubble(
  AsyncValue<MobileProjectDetail> planValue,
  MobileProjectChat? chat,
  String? planBusyAction,
) {
  final hasSnapshots = (chat?.plans.isNotEmpty ?? false);
  if (!hasSnapshots) return true;
  if (planBusyAction == 'revise') return true;
  return planValue.maybeWhen(
    data: (project) => project.status == 'planning' || project.plan == null,
    loading: () => true,
    orElse: () => false,
  );
}

class _ProjectTranscriptItem {
  const _ProjectTranscriptItem.message(this.message)
    : plan = null,
      operation = null;

  const _ProjectTranscriptItem.plan(this.plan)
    : message = null,
      operation = null;

  const _ProjectTranscriptItem.operation(this.operation)
    : message = null,
      plan = null;

  final MobileProjectChatMessage? message;
  final MobilePlan? plan;
  final MobileBookEditOperation? operation;

  DateTime get createdAt =>
      plan?.createdAt ?? message?.createdAt ?? operation!.createdAt;

  int get sortPriority {
    if (plan != null) return 0;
    if (message != null) return 1;
    return 2;
  }
}

class _EditingMessageBanner extends StatelessWidget {
  const _EditingMessageBanner({required this.onCancel});

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        child: Row(
          children: [
            Icon(Icons.edit_outlined, size: 18, color: colors.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'Editing message',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
            IconButton(
              tooltip: 'Cancel edit',
              visualDensity: VisualDensity.compact,
              onPressed: onCancel,
              icon: const Icon(Icons.close, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatWarningsBanner extends StatelessWidget {
  const _ChatWarningsBanner({required this.warnings});

  final List<String> warnings;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.info_outline,
              size: 18,
              color: colors.onTertiaryContainer,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                warnings.join(' '),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanErrorFooter extends StatelessWidget {
  const _PlanErrorFooter({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
          child: Row(
            children: [
              Icon(Icons.error_outline, color: colors.error, size: 20),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String? _formatChatTimestamp(DateTime? value) {
  if (value == null) return null;
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    this.attachmentThumbnails = const <String, String>{},
    this.attachmentUrls = const <String, String>{},
    this.onRetryFailed,
    this.onDismissFailed,
    this.onEdit,
    this.onSwitchBranch,
    this.switchingBranch = false,
  });

  final MobileCreationMessage message;
  final Map<String, String> attachmentThumbnails;
  final Map<String, String> attachmentUrls;
  final ValueChanged<String>? onRetryFailed;
  final ValueChanged<String>? onDismissFailed;
  final void Function(MobileCreationMessage message)? onEdit;
  final void Function(MobileCreationMessage message, String direction)?
  onSwitchBranch;
  final bool switchingBranch;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final failed = message.isFailedSend;
    final background = failed
        ? colors.errorContainer
        : isUser
        ? colors.primary
        : colors.surfaceContainerHighest;
    final foreground = failed
        ? colors.onErrorContainer
        : isUser
        ? colors.onPrimary
        : colors.onSurface;
    final hasText = message.content.trim().isNotEmpty;
    final timestamp = _formatChatTimestamp(message.createdAt);
    final localId = message.localId;
    final branch = message.branch;
    final canEdit = isUser && !failed && message.id != null && onEdit != null;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: MessageHoldFeedback(
        onLongPressStart: (details) => showMessageActionsMenu(
          context: context,
          position: details.globalPosition,
          message: message.content,
          onEdit: canEdit ? () => onEdit!(message) : null,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 5),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.82,
          ),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(16),
              topRight: const Radius.circular(16),
              bottomLeft: Radius.circular(isUser ? 16 : 4),
              bottomRight: Radius.circular(isUser ? 4 : 16),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (message.includedSourceNotes) ...[
                Text(
                  'Included source notes',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: foreground.withValues(alpha: 0.85),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
              ],
              if (message.hasAttachments) ...[
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final attachment in message.attachments)
                      _MessageAttachmentChip(
                        attachment: attachment,
                        thumbnailPath: attachmentThumbnails[attachment.id],
                        remoteUrl: attachmentUrls[attachment.id],
                        foreground: foreground,
                      ),
                  ],
                ),
                if (hasText) const SizedBox(height: 6),
              ],
              if (hasText)
                Text(
                  message.content,
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(color: foreground),
                ),
              if (!isUser && message.research?.sources.isNotEmpty == true) ...[
                const SizedBox(height: 10),
                _ResearchSources(
                  sources: message.research!.sources,
                  foreground: foreground,
                ),
              ],
              if (timestamp != null) ...[
                const SizedBox(height: 6),
                Text(
                  timestamp,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: foreground.withValues(alpha: 0.7),
                  ),
                ),
              ],
              if (branch != null && onSwitchBranch != null) ...[
                const SizedBox(height: 8),
                BranchNavigator(
                  branch: branch,
                  foreground: foreground,
                  switching: switchingBranch,
                  onPrevious: () => onSwitchBranch!(message, 'previous'),
                  onNext: () => onSwitchBranch!(message, 'next'),
                ),
              ],
              if (failed && localId != null) ...[
                const SizedBox(height: 8),
                Text(
                  message.sendError ?? 'Message failed to send.',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: foreground,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    if (onRetryFailed != null)
                      TextButton(
                        onPressed: () => onRetryFailed!(localId),
                        style: TextButton.styleFrom(
                          foregroundColor: foreground,
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Retry'),
                      ),
                    if (onDismissFailed != null)
                      TextButton(
                        onPressed: () => onDismissFailed!(localId),
                        style: TextButton.styleFrom(
                          foregroundColor: foreground,
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Dismiss'),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ResearchSources extends StatelessWidget {
  const _ResearchSources({required this.sources, required this.foreground});

  final List<MobileCreationResearchSource> sources;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.public,
              size: 15,
              color: foreground.withValues(alpha: 0.8),
            ),
            const SizedBox(width: 5),
            Text(
              'Sources',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: foreground,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        for (var index = 0; index < sources.length; index++)
          _ResearchSourceLink(
            index: index + 1,
            source: sources[index],
            foreground: foreground,
          ),
      ],
    );
  }
}

class _ResearchSourceLink extends StatelessWidget {
  const _ResearchSourceLink({
    required this.index,
    required this.source,
    required this.foreground,
  });

  final int index;
  final MobileCreationResearchSource source;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    final uri = source.uri;
    final label = '$index. ${source.title}${_domain(uri)}';
    final text = Text(
      label,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.labelMedium?.copyWith(
        color: foreground,
        decoration: uri == null ? null : TextDecoration.underline,
        decorationColor: foreground,
      ),
    );
    if (uri == null) {
      return Padding(padding: const EdgeInsets.only(top: 3), child: text);
    }
    return Semantics(
      link: true,
      label: 'Source $index. ${source.title}. Opens ${uri.host}',
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: () => _open(context, uri),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: text,
        ),
      ),
    );
  }

  String _domain(Uri? uri) => uri == null || uri.host.isEmpty
      ? ''
      : ' · ${uri.host.replaceFirst(RegExp(r'^www\\.'), '')}';

  Future<void> _open(BuildContext context, Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not open that source.')),
      );
    }
  }
}

class _MessageAttachmentChip extends ConsumerWidget {
  const _MessageAttachmentChip({
    required this.attachment,
    required this.foreground,
    this.thumbnailPath,
    this.remoteUrl,
  });

  final MobileCreationMessageAttachment attachment;
  final Color foreground;
  final String? thumbnailPath;

  /// Server copy of the file, used when no local thumbnail exists (app
  /// restart or another device).
  final String? remoteUrl;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!attachment.isPhoto) {
      return _documentChip(context, ref);
    }
    final path = thumbnailPath;
    if (path != null && File(path).existsSync()) {
      return _tappablePhoto(
        context,
        ref,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.file(
            File(path),
            width: 120,
            height: 120,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => _remotePhotoOrChip(context, ref),
          ),
        ),
        localPath: path,
      );
    }
    return _remotePhotoOrChip(context, ref);
  }

  Widget _tappablePhoto(
    BuildContext context,
    WidgetRef ref, {
    required Widget child,
    String? localPath,
    String? networkUri,
    Map<String, String>? headers,
  }) {
    return Semantics(
      button: true,
      label: 'Preview ${attachment.name}',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => unawaited(
            showChatImagePreview(
              context: context,
              localPath: localPath,
              remoteUrl: networkUri,
              headers: headers,
              semanticLabel: attachment.name,
            ),
          ),
          child: child,
        ),
      ),
    );
  }

  Widget _remotePhotoOrChip(BuildContext context, WidgetRef ref) {
    final url = remoteUrl;
    if (url == null) {
      return _expiredPhotoChip(context);
    }
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(url).toString();
    return headersValue.when(
      data: (headers) => _tappablePhoto(
        context,
        ref,
        localPath: thumbnailPath,
        networkUri: uri,
        headers: headers,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.network(
            uri,
            headers: headers,
            width: 120,
            height: 120,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => _expiredPhotoChip(context),
          ),
        ),
      ),
      loading: () => const SizedBox.square(
        dimension: 120,
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      ),
      error: (_, _) => _expiredPhotoChip(context),
    );
  }

  Widget _documentChip(BuildContext context, WidgetRef ref) {
    final canOpen =
        (thumbnailPath != null && File(thumbnailPath!).existsSync()) ||
        remoteUrl != null;
    return Semantics(
      button: canOpen,
      label: canOpen ? 'Open ${attachment.name}' : attachment.name,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: canOpen
              ? () => unawaited(
                  openChatAttachment(
                    context: context,
                    ref: ref,
                    name: attachment.name,
                    localPath: thumbnailPath,
                    remoteUrl: remoteUrl,
                  ),
                )
              : null,
          child: _chipBody(
            context,
            icon: Icons.description_outlined,
            subtitle: canOpen ? 'Tap to open' : null,
          ),
        ),
      ),
    );
  }

  Widget _expiredPhotoChip(BuildContext context) {
    return _chipBody(
      context,
      icon: Icons.photo_outlined,
      subtitle: 'Preview expired',
    );
  }

  Widget _chipBody(
    BuildContext context, {
    required IconData icon,
    String? subtitle,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: foreground.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: foreground),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  attachment.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: foreground),
                ),
                if (subtitle != null)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: foreground.withValues(alpha: 0.75),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
