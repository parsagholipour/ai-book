part of 'creation_chat_screen.dart';

// Input area: composer, attachments, quick-reply chips and the build button.
// Imports and shared state live in the parent library file.

class _ScrollableFooterContext extends StatefulWidget {
  const _ScrollableFooterContext({
    required this.child,
    this.showScrollAffordance = true,
    super.key,
  });

  final Widget child;

  /// When false (e.g. question drawer minimized), hide the "Scroll for more"
  /// cue even if the viewport could still scroll.
  final bool showScrollAffordance;

  @override
  State<_ScrollableFooterContext> createState() =>
      _ScrollableFooterContextState();
}

class _ScrollableFooterContextState extends State<_ScrollableFooterContext> {
  final _controller = ScrollController();
  bool _canScroll = false;
  bool _hasMoreBelow = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_updateScrollAffordance);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _updateScrollAffordance(),
    );
  }

  @override
  void didUpdateWidget(covariant _ScrollableFooterContext oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _updateScrollAffordance(),
    );
  }

  @override
  void dispose() {
    _controller.removeListener(_updateScrollAffordance);
    _controller.dispose();
    super.dispose();
  }

  void _updateScrollAffordance() {
    if (!mounted || !_controller.hasClients) return;
    final position = _controller.position;
    final canScroll = position.maxScrollExtent > 1;
    final hasMoreBelow = canScroll && position.extentAfter > 8;
    if (_canScroll == canScroll && _hasMoreBelow == hasMoreBelow) return;
    setState(() {
      _canScroll = canScroll;
      _hasMoreBelow = hasMoreBelow;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Stack(
      children: [
        ScrollbarTheme(
          data: ScrollbarThemeData(
            thumbVisibility: const WidgetStatePropertyAll(true),
            trackVisibility: const WidgetStatePropertyAll(true),
            thickness: const WidgetStatePropertyAll(6),
            radius: const Radius.circular(999),
            thumbColor: WidgetStatePropertyAll(colors.primary),
            trackColor: WidgetStatePropertyAll(colors.primaryContainer),
            trackBorderColor: WidgetStatePropertyAll(colors.outlineVariant),
          ),
          child: Scrollbar(
            controller: _controller,
            child: SingleChildScrollView(
              controller: _controller,
              padding: EdgeInsetsDirectional.only(end: _canScroll ? 12 : 0),
              child: widget.child,
            ),
          ),
        ),
        if (_hasMoreBelow && widget.showScrollAffordance)
          PositionedDirectional(
            start: 0,
            end: 12,
            bottom: 0,
            child: IgnorePointer(
              child: Container(
                height: 42,
                alignment: Alignment.bottomCenter,
                padding: const EdgeInsets.only(bottom: 3),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      colors.surface.withValues(alpha: 0),
                      colors.surface,
                    ],
                  ),
                ),
                child: Semantics(
                  label: 'More options below. Scroll for more.',
                  child: ExcludeSemantics(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.keyboard_arrow_down_rounded,
                          size: 18,
                          color: colors.primary,
                        ),
                        const SizedBox(width: 2),
                        Text(
                          'Scroll for more',
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: colors.primary,
                                fontWeight: FontWeight.w800,
                              ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Hard cap on footer height so the transcript always keeps usable space.
/// Interactive footers split their scrollable context from pinned controls.
class _FooterLimiter extends StatelessWidget {
  const _FooterLimiter({required this.maxHeight, required this.child});

  final double maxHeight;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: child,
    );
  }
}

class _ConversationFooter extends StatefulWidget {
  const _ConversationFooter({
    required this.state,
    required this.keyboardOpen,
    required this.composerController,
    required this.onSend,
    required this.onQuickReply,
    required this.onAnswerOption,
    required this.onAttach,
    required this.onRetryAttachment,
    required this.onRemoveAttachment,
    required this.onBuild,
  });

  final CreationChatState state;
  final bool keyboardOpen;
  final TextEditingController composerController;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onQuickReply;
  final ValueChanged<String> onAnswerOption;
  final VoidCallback onAttach;
  final ValueChanged<String> onRetryAttachment;
  final ValueChanged<String> onRemoveAttachment;
  final Future<void> Function() onBuild;

  @override
  State<_ConversationFooter> createState() => _ConversationFooterState();
}

class _ConversationFooterState extends State<_ConversationFooter> {
  bool _questionMinimized = false;

  @override
  void didUpdateWidget(covariant _ConversationFooter oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldPrompt = oldWidget.state.question?.prompt;
    final newPrompt = widget.state.question?.prompt;
    if (oldPrompt != newPrompt) {
      _questionMinimized = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final question = widget.state.question;
    final disabled = widget.state.isBusy;
    final keyboardOpen = widget.keyboardOpen;

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, question != null ? 4 : 10, 12, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (question != null ||
                  widget.state.quickReplies.isNotEmpty ||
                  widget.state.pendingAttachments.isNotEmpty)
                Flexible(
                  fit: FlexFit.loose,
                  child: _ScrollableFooterContext(
                    key: const ValueKey('conversation-context-scroll'),
                    showScrollAffordance: !_questionMinimized,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        // Visibility keeps the composer's element stable while
                        // the keyboard opens and closes.
                        if (question != null)
                          _QuestionPanel(
                            question: question,
                            collapsed: keyboardOpen,
                            minimized: _questionMinimized,
                            enabled: !disabled,
                            onMinimizedChanged: (minimized) =>
                                setState(() => _questionMinimized = minimized),
                            onSelect: widget.onAnswerOption,
                          )
                        else if (widget.state.quickReplies.isNotEmpty)
                          Visibility(
                            visible: !keyboardOpen,
                            child: _ChipRow(
                              options: widget.state.quickReplies,
                              enabled: !disabled,
                              icon: Icons.bolt_outlined,
                              onSelect: widget.onQuickReply,
                            ),
                          ),
                        if (question != null)
                          const SizedBox(height: 6)
                        else if (widget.state.quickReplies.isNotEmpty)
                          const SizedBox(height: 8),
                        if (widget.state.pendingAttachments.isNotEmpty) ...[
                          _PendingAttachmentsRow(
                            attachments: widget.state.pendingAttachments,
                            onRetry: widget.onRetryAttachment,
                            onRemove: widget.onRemoveAttachment,
                          ),
                          const SizedBox(height: 8),
                        ],
                      ],
                    ),
                  ),
                ),
              _Composer(
                controller: widget.composerController,
                enabled: !disabled,
                hasQuestion: question != null,
                hasAttachments: widget.state.pendingAttachments.isNotEmpty,
                canSendWithoutText:
                    widget.state.hasReadyAttachments &&
                    !widget.state.hasUploadingAttachments,
                waitingOnAttachments: widget.state.hasUploadingAttachments,
                onAttach: widget.onAttach,
                onSend: widget.onSend,
              ),
              const SizedBox(height: 8),
              _BuildButton(
                canBuild: widget.state.canBuild,
                building: widget.state.building,
                skipsQuestion: question != null,
                onBuild: widget.onBuild,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PendingAttachmentsRow extends StatelessWidget {
  const _PendingAttachmentsRow({
    required this.attachments,
    required this.onRetry,
    required this.onRemove,
  });

  final List<PendingCreationAttachment> attachments;
  final ValueChanged<String> onRetry;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final attachment = attachments[index];
          return _PendingAttachmentChip(
            attachment: attachment,
            onRetry: () => onRetry(attachment.localId),
            onRemove: () => onRemove(attachment.localId),
          );
        },
      ),
    );
  }
}

class _PendingAttachmentChip extends ConsumerWidget {
  const _PendingAttachmentChip({
    required this.attachment,
    required this.onRetry,
    required this.onRemove,
  });

  final PendingCreationAttachment attachment;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    final failedDetail = attachment.error?.trim();
    final statusLabel = attachment.isUploading
        ? 'Reading…'
        : attachment.isFailed
        ? (failedDetail == null || failedDetail.isEmpty
              ? 'Failed — tap to retry'
              : failedDetail)
        : attachment.attachment?.pages != null
        ? '${attachment.attachment!.pages} pages read'
        : 'Ready to send';
    return Semantics(
      label: 'Attachment ${attachment.name}, $statusLabel',
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: attachment.isFailed
            ? onRetry
            : attachment.isReady
            ? () => unawaited(_previewOrOpen(context, ref))
            : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: attachment.isFailed
                ? colors.errorContainer
                : colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _attachmentLeading(colors, ref),
              const SizedBox(width: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      attachment.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.labelMedium,
                    ),
                    Text(
                      statusLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.labelSmall?.copyWith(
                        color: attachment.isFailed
                            ? colors.onErrorContainer
                            : colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 4),
              InkWell(
                customBorder: const CircleBorder(),
                onTap: onRemove,
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child: Icon(Icons.close, size: 16),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _previewOrOpen(BuildContext context, WidgetRef ref) async {
    final localPath = attachment.localPath;
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto) {
      final resolved = resolveChatAssetUri(ref: ref, remoteUrl: remoteUrl);
      await showChatImagePreview(
        context: context,
        localPath: localPath,
        remoteUrl: resolved?.uri,
        headers: resolved?.headers,
        semanticLabel: attachment.name,
      );
      return;
    }
    await openChatAttachment(
      context: context,
      ref: ref,
      name: attachment.name,
      localPath: localPath,
      remoteUrl: remoteUrl,
      mimeType: attachment.mimeType,
    );
  }

  Widget _attachmentLeading(ColorScheme colors, WidgetRef ref) {
    if (attachment.isUploading) {
      return const SizedBox.square(
        dimension: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }
    if (attachment.isFailed) {
      return Icon(Icons.refresh, size: 20, color: colors.onErrorContainer);
    }
    final localPath = attachment.localPath;
    if (attachment.isPhoto &&
        localPath != null &&
        File(localPath).existsSync()) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image.file(
          File(localPath),
          width: 32,
          height: 32,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => const Icon(Icons.photo_outlined, size: 20),
        ),
      );
    }
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto && remoteUrl != null) {
      final headers = ref.watch(projectAssetHeadersProvider).value;
      final config = ref.watch(appConfigProvider);
      if (headers != null) {
        return ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: Image.network(
            config.apiBaseUrl.resolve(remoteUrl).toString(),
            headers: headers,
            width: 32,
            height: 32,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) =>
                const Icon(Icons.photo_outlined, size: 20),
          ),
        );
      }
    }
    return Icon(
      attachment.isPhoto ? Icons.photo_outlined : Icons.description_outlined,
      size: 20,
    );
  }
}

class _QuestionPanel extends StatelessWidget {
  const _QuestionPanel({
    required this.question,
    required this.collapsed,
    required this.minimized,
    required this.enabled,
    required this.onMinimizedChanged,
    required this.onSelect,
  });

  final MobileCreationQuestion question;

  /// While typing, only the prompt shows so the composer stays visible above
  /// the keyboard.
  final bool collapsed;
  final bool minimized;
  final bool enabled;
  final ValueChanged<bool> onMinimizedChanged;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final collapsed = this.collapsed || minimized;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Text(
                question.prompt,
                maxLines: collapsed ? 2 : null,
                overflow: collapsed ? TextOverflow.ellipsis : null,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            IconButton(
              tooltip: minimized ? 'Expand question' : 'Minimize question',
              constraints: const BoxConstraints.tightFor(width: 36, height: 36),
              padding: EdgeInsets.zero,
              iconSize: 22,
              visualDensity: VisualDensity.compact,
              onPressed: this.collapsed
                  ? null
                  : () => onMinimizedChanged(!minimized),
              icon: Icon(
                minimized
                    ? Icons.keyboard_arrow_up_rounded
                    : Icons.keyboard_arrow_down_rounded,
              ),
            ),
          ],
        ),
        if (!collapsed) ...[
          const SizedBox(height: 8),
          _QuestionOptionList(
            options: question.options,
            enabled: enabled,
            onSelect: onSelect,
            onSkip: () => onSelect('Skip this for now.'),
          ),
        ],
      ],
    );
  }
}

/// Numbered answer choices for the question drawer (not chips/badges).
class _QuestionOptionList extends StatelessWidget {
  const _QuestionOptionList({
    required this.options,
    required this.enabled,
    required this.onSelect,
    required this.onSkip,
    this.onCustom,
  });

  final List<String> options;
  final bool enabled;
  final ValueChanged<String> onSelect;
  final VoidCallback onSkip;
  final VoidCallback? onCustom;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < options.length; i++) ...[
          if (i > 0) const SizedBox(height: 4),
          Material(
            color: colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: enabled ? () => onSelect(options[i]) : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 10,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 22,
                      child: Text(
                        '${i + 1}.',
                        style: theme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          color: colors.primary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        options[i],
                        style: theme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 4),
        Row(
          children: [
            if (onCustom != null)
              TextButton.icon(
                onPressed: enabled ? onCustom : null,
                icon: const Icon(Icons.edit_outlined, size: 16),
                label: const Text('Custom…'),
              ),
            TextButton.icon(
              onPressed: enabled ? onSkip : null,
              icon: const Icon(Icons.skip_next_outlined, size: 18),
              label: const Text('Skip'),
            ),
          ],
        ),
      ],
    );
  }
}

class _ChipRow extends StatefulWidget {
  const _ChipRow({
    required this.options,
    required this.enabled,
    required this.icon,
    required this.onSelect,
  });

  final List<String> options;
  final bool enabled;
  final IconData icon;
  final ValueChanged<String> onSelect;

  @override
  State<_ChipRow> createState() => _ChipRowState();
}

class _ChipRowState extends State<_ChipRow> {
  final _scrollController = ScrollController();
  bool _moreBefore = false;
  bool _moreAfter = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_updateEdges);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateEdges());
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _updateEdges() {
    if (!mounted || !_scrollController.hasClients) return;
    final position = _scrollController.position;
    final moreBefore = position.extentBefore > 1;
    final moreAfter = position.extentAfter > 1;
    if (moreBefore == _moreBefore && moreAfter == _moreAfter) return;
    setState(() {
      _moreBefore = moreBefore;
      _moreAfter = moreAfter;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      height: 40,
      child: ShaderMask(
        shaderCallback: (bounds) => LinearGradient(
          begin: AlignmentDirectional.centerStart,
          end: AlignmentDirectional.centerEnd,
          colors: [
            _moreBefore ? Colors.transparent : Colors.white,
            Colors.white,
            Colors.white,
            _moreAfter ? Colors.transparent : Colors.white,
          ],
          stops: const [0.0, 0.07, 0.93, 1.0],
        ).createShader(bounds, textDirection: Directionality.of(context)),
        blendMode: BlendMode.dstIn,
        child: NotificationListener<ScrollMetricsNotification>(
          // Fades depend on content extent, which is only known after layout.
          onNotification: (_) {
            _updateEdges();
            return false;
          },
          child: ListView.separated(
            controller: _scrollController,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 2),
            itemCount: widget.options.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final option = widget.options[index];
              return ActionChip(
                avatar: Icon(widget.icon, size: 18, color: colors.primary),
                label: Text(option),
                onPressed: widget.enabled
                    ? () => widget.onSelect(option)
                    : null,
              );
            },
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.hasQuestion,
    required this.hasAttachments,
    required this.canSendWithoutText,
    required this.waitingOnAttachments,
    required this.onAttach,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool hasQuestion;
  final bool hasAttachments;

  /// Ready attachments allow sending with an empty message.
  final bool canSendWithoutText;

  /// While a file is still being read, sending waits so it isn't left behind.
  final bool waitingOnAttachments;
  final VoidCallback onAttach;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        IconButton(
          tooltip: 'Attach a photo, document, or notes',
          onPressed: enabled ? onAttach : null,
          icon: Icon(
            hasAttachments ? Icons.attach_file : Icons.attach_file_outlined,
            color: hasAttachments ? colors.primary : null,
          ),
        ),
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: hasAttachments
                  ? 'Add a note about the file…'
                  : hasQuestion
                  ? 'Answer the question above…'
                  : 'Describe your book…',
              filled: true,
              fillColor: colors.surfaceContainerHigh,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            final canSend =
                enabled &&
                !waitingOnAttachments &&
                (value.text.trim().isNotEmpty || canSendWithoutText);
            return IconButton.filled(
              tooltip: waitingOnAttachments ? 'Reading your file…' : 'Send',
              onPressed: canSend ? () => onSend(controller.text) : null,
              icon: const Icon(Icons.send_rounded),
            );
          },
        ),
      ],
    );
  }
}

class _BuildButton extends StatelessWidget {
  const _BuildButton({
    required this.canBuild,
    required this.building,
    required this.skipsQuestion,
    required this.onBuild,
  });

  final bool canBuild;
  final bool building;

  /// A question is on screen. Answering it is optional, so the button says so
  /// rather than looking like the wrong way out of the card.
  final bool skipsQuestion;
  final Future<void> Function() onBuild;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: canBuild && !building ? () => onBuild() : null,
      icon: building
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Building the plan',
              ),
            )
          : const Icon(Icons.auto_awesome_outlined),
      label: Text(
        building
            ? 'Building the plan'
            : skipsQuestion
            ? 'Skip and build the plan'
            : 'Build the plan',
      ),
    );
  }
}
