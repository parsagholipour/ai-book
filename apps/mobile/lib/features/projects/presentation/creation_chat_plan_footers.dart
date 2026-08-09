part of 'creation_chat_screen.dart';

// Footers for the planning stages: progress steps, revision composer and approval.
// Imports and shared state live in the parent library file.

class _ProjectChatFooter extends StatelessWidget {
  const _ProjectChatFooter({
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.lockedLabel,
    required this.projectStatus,
    required this.onSend,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final String? lockedLabel;
  final String projectStatus;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    // A book being written or rewritten cannot take another request, so the
    // composer closes instead of looking like it is listening. Keep anything
    // already typed in the controller so it is ready once the job settles.
    final open = enabled && lockedLabel == null;
    final hintText =
        lockedLabel ??
        (projectStatus == 'complete'
            ? 'Ask for an edit to this book…'
            : 'Ask for a change…');
    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  enabled: open,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: hintText,
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
                  final canSend = open && value.text.trim().isNotEmpty;
                  return IconButton.filled(
                    tooltip: 'Send',
                    onPressed: canSend ? () => onSend(controller.text) : null,
                    icon: const Icon(Icons.send_rounded),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanBuildingFooter extends StatelessWidget {
  const _PlanBuildingFooter({
    this.message = 'Creating your book plan…',
    this.isRevision = false,
    this.statusValue,
  });

  final String message;
  final bool isRevision;
  final AsyncValue<MobileProjectStatus>? statusValue;

  @override
  Widget build(BuildContext context) {
    final status = statusValue?.asData?.value;
    final planningProgress = status?.planningProgress;
    // Rebuilding a finished book into a new one runs while the project sits at
    // `editing`, so it reports its steps on `editProgress` rather than
    // `planningProgress` — same shape, same card. Without this the footer fell
    // back to a static step list and an indeterminate bar for the whole job,
    // which is a long time to tell someone nothing.
    final editProgress = planningProgress == null ? status?.editProgress : null;
    final isRewrite = editProgress != null;
    final progress = planningProgress?.percent ?? editProgress?.percent;
    final steps =
        planningProgress?.steps ??
        editProgress?.steps ??
        _fallbackPlanningSteps(isRevision);
    final activeStep = steps.where((step) => step.isActive).firstOrNull;
    final allStepsDone = steps.isNotEmpty && steps.every((step) => step.isDone);
    final settledDetail = isRewrite
        // A finished replan is not a finished book: the writing starts here.
        ? 'Writing your new book…'
        : 'Opening it for review…';
    final title = isRewrite
        ? 'Rewriting your book'
        : allStepsDone
        ? isRevision
              ? 'Your revised plan is ready'
              : 'Your book plan is ready'
        : isRevision
        ? 'Revising your book plan'
        : 'Creating your book plan';
    final detail = allStepsDone
        ? settledDetail
        : activeStep?.label ?? message.replaceAll('…', '');
    final colors = Theme.of(context).colorScheme;

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.auto_awesome_outlined,
                    color: colors.primary,
                    size: 21,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AnimatedSwitcher(
                          duration: const Duration(milliseconds: 250),
                          child: Text(
                            title,
                            key: ValueKey(title),
                            style: Theme.of(context).textTheme.titleSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                        const SizedBox(height: 2),
                        AnimatedSwitcher(
                          duration: const Duration(milliseconds: 250),
                          child: Text(
                            detail,
                            key: ValueKey(detail),
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: colors.onSurfaceVariant),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (progress != null) ...[
                    const SizedBox(width: 12),
                    Text(
                      '$progress%',
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: colors.primary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
              TweenAnimationBuilder<double>(
                tween: Tween(end: progress == null ? 0 : progress / 100),
                duration: const Duration(milliseconds: 450),
                curve: Curves.easeOutCubic,
                builder: (context, animatedProgress, _) => Semantics(
                  label: 'Book plan progress',
                  value: progress == null
                      ? 'Working'
                      : '$progress percent complete',
                  child: ExcludeSemantics(
                    child: LinearProgressIndicator(
                      value: progress == null ? null : animatedProgress,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              for (final step in steps) ProgressStepRow(step: step),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.notifications_none_outlined,
                    size: 16,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      'You can leave this chat — we’ll keep working.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanFailedFooter extends StatelessWidget {
  const _PlanFailedFooter({
    required this.message,
    required this.retrying,
    required this.retryAvailable,
    required this.onRetry,
    required this.onRefresh,
  });

  final String message;
  final bool retrying;
  final bool retryAvailable;
  final VoidCallback onRetry;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          child: AppPrimaryActionPanel(
            icon: Icons.error_outline,
            title: retryAvailable
                ? 'Your plan needs a retry'
                : 'Your plan needs attention',
            message: message,
            actionLabel: retryAvailable ? 'Retry plan' : 'Check again',
            actionIcon: Icon(
              retryAvailable ? Icons.replay_outlined : Icons.refresh_outlined,
            ),
            loading: retrying,
            loadingLabel: 'Retrying…',
            onAction: retrying
                ? null
                : retryAvailable
                ? onRetry
                : onRefresh,
            tone: AppTone.error,
          ),
        ),
      ),
    );
  }
}

String _planFailureMessage(MobileProjectStatus? status) {
  final safeMessage = status?.retryAvailable == true
      ? 'Your idea is saved, but we couldn’t create the plan. Retry when you’re ready.'
      : 'Your idea is saved, but we couldn’t create the plan. Check again for recovery options.';

  // Backend failure messages can contain provider and schema diagnostics. They
  // are useful while developing, but should never be rendered by production or
  // profile builds.
  if (!kDebugMode) return safeMessage;

  final detail = status?.failureMessage?.trim();
  return detail != null && detail.isNotEmpty ? detail : safeMessage;
}

bool _planGenerationFailed(
  MobileProjectDetail project,
  MobileProjectStatus? status,
) {
  return status?.status == 'failed' ||
      (status == null && project.status == 'failed');
}

List<MobileProjectStatusStep> _fallbackPlanningSteps(bool isRevision) => [
  MobileProjectStatusStep(
    key: 'understand',
    label: isRevision
        ? 'Understanding your changes'
        : 'Understanding your idea',
    status: 'active',
  ),
  MobileProjectStatusStep(
    key: 'shape',
    label: isRevision ? 'Improving your plan' : 'Shaping the chapters and flow',
    status: 'pending',
  ),
  MobileProjectStatusStep(
    key: 'finalize',
    label: isRevision ? 'Saving your revision' : 'Finalizing your plan',
    status: 'pending',
  ),
];

class _PlanFooter extends StatefulWidget {
  const _PlanFooter({
    required this.plan,
    required this.questionIndex,
    required this.hasMoreQuestions,
    required this.keyboardOpen,
    required this.isBusy,
    required this.busyAction,
    required this.revisionController,
    required this.onSelectOption,
    required this.onSkip,
    required this.onRevise,
    required this.onApprove,
  });

  final MobilePlan plan;
  final int questionIndex;
  final bool hasMoreQuestions;
  final bool keyboardOpen;
  final bool isBusy;
  final String? busyAction;
  final TextEditingController revisionController;
  final ValueChanged<String> onSelectOption;
  final VoidCallback onSkip;
  final ValueChanged<String> onRevise;
  final VoidCallback onApprove;

  @override
  State<_PlanFooter> createState() => _PlanFooterState();
}

class _PlanFooterState extends State<_PlanFooter> {
  final _revisionFocus = FocusNode();
  bool _questionMinimized = false;

  @override
  void initState() {
    super.initState();
    _revisionFocus.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(covariant _PlanFooter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.questionIndex != widget.questionIndex) {
      _questionMinimized = false;
    }
  }

  @override
  void dispose() {
    _revisionFocus.removeListener(_onFocusChanged);
    _revisionFocus.dispose();
    super.dispose();
  }

  void _onFocusChanged() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final plan = widget.plan;
    final busyAction = widget.busyAction;
    // While typing a revision, collapse the question panel to its prompt and
    // drop the Approve button so the composer stays visible above the
    // keyboard instead of overflowing off screen.
    final keyboardOpen = widget.keyboardOpen;
    final typingRevision = _revisionFocus.hasFocus && keyboardOpen;

    // Show a clear loading state while the plan is being revised.
    if (busyAction == 'revise') {
      return Material(
        color: colors.surface,
        elevation: 8,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: colors.primary,
                    semanticsLabel: 'Revising plan',
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  'Revising the plan…',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widget.hasMoreQuestions)
                Flexible(
                  fit: FlexFit.loose,
                  child: _ScrollableFooterContext(
                    key: const ValueKey('plan-question-scroll'),
                    showScrollAffordance: !_questionMinimized,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _PlanQuestionPanel(
                          key: ValueKey(widget.questionIndex),
                          plan: plan,
                          questionIndex: widget.questionIndex,
                          collapsed: typingRevision,
                          minimized: _questionMinimized,
                          keyboardOpen: keyboardOpen,
                          isBusy: widget.isBusy,
                          onMinimizedChanged: (minimized) =>
                              setState(() => _questionMinimized = minimized),
                          onSelect: widget.onSelectOption,
                          onSkip: widget.onSkip,
                        ),
                        const SizedBox(height: 10),
                        Divider(height: 1, color: colors.outlineVariant),
                        const SizedBox(height: 10),
                      ],
                    ),
                  ),
                ),
              _RevisionComposer(
                controller: widget.revisionController,
                focusNode: _revisionFocus,
                enabled: !widget.isBusy,
                onSend: widget.onRevise,
              ),
              const SizedBox(height: 8),
              _ApproveButton(
                approving: busyAction == 'approve',
                onApprove: (!widget.isBusy && busyAction == null)
                    ? widget.onApprove
                    : null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanQuestionPanel extends StatefulWidget {
  const _PlanQuestionPanel({
    required this.plan,
    required this.questionIndex,
    required this.collapsed,
    required this.minimized,
    required this.keyboardOpen,
    required this.isBusy,
    required this.onMinimizedChanged,
    required this.onSelect,
    required this.onSkip,
    super.key,
  });

  final MobilePlan plan;
  final int questionIndex;

  /// While typing a revision below, only the prompt shows so the composer
  /// stays visible above the keyboard.
  final bool collapsed;
  final bool minimized;
  final bool keyboardOpen;
  final bool isBusy;
  final ValueChanged<bool> onMinimizedChanged;
  final ValueChanged<String> onSelect;
  final VoidCallback onSkip;

  @override
  State<_PlanQuestionPanel> createState() => _PlanQuestionPanelState();
}

class _PlanQuestionPanelState extends State<_PlanQuestionPanel> {
  final _customController = TextEditingController();
  bool _showCustomField = false;

  /// The field only steals focus when the reader asked for it with "Custom…".
  /// A question that has no options opens the field on its own, and raising the
  /// keyboard there would collapse the question it is meant to answer.
  bool _autofocusCustomField = false;

  @override
  void initState() {
    super.initState();
    _syncCustomFieldToQuestion();
  }

  @override
  void didUpdateWidget(covariant _PlanQuestionPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.questionIndex != widget.questionIndex) {
      // Typing state belongs to one question, not to the panel.
      _customController.clear();
      _showCustomField = false;
      _autofocusCustomField = false;
      _syncCustomFieldToQuestion();
    }
  }

  /// An open question (no premade answers) is answered by typing, so show the
  /// field instead of hiding it behind a "Custom…" tap.
  void _syncCustomFieldToQuestion() {
    final question = widget.plan.questions.elementAtOrNull(
      widget.questionIndex,
    );
    if (question != null && question.options.isEmpty && question.allowCustom) {
      _showCustomField = true;
    }
  }

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  void _submitCustom() {
    final text = _customController.text.trim();
    if (text.isNotEmpty) widget.onSelect(text);
  }

  @override
  Widget build(BuildContext context) {
    final question = widget.plan.questions[widget.questionIndex];
    final total = widget.plan.questions.length;
    final colors = Theme.of(context).colorScheme;
    final collapsed = widget.collapsed || widget.minimized;
    // While typing a custom answer, hide the option chips (via Visibility so
    // the field's slot doesn't shift and drop focus) to keep it visible
    // above the keyboard.
    final typingCustom = _showCustomField && widget.keyboardOpen && !collapsed;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Question ${widget.questionIndex + 1} of $total',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
            IconButton(
              tooltip: widget.minimized
                  ? 'Expand question'
                  : 'Minimize question',
              constraints: const BoxConstraints.tightFor(width: 36, height: 36),
              padding: EdgeInsets.zero,
              iconSize: 22,
              visualDensity: VisualDensity.compact,
              onPressed: widget.collapsed
                  ? null
                  : () => widget.onMinimizedChanged(!widget.minimized),
              icon: Icon(
                widget.minimized
                    ? Icons.keyboard_arrow_up_rounded
                    : Icons.keyboard_arrow_down_rounded,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          question.prompt,
          maxLines: (collapsed || typingCustom) ? 2 : null,
          overflow: (collapsed || typingCustom) ? TextOverflow.ellipsis : null,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (!collapsed) ...[
          const SizedBox(height: 8),
          Visibility(
            visible: !typingCustom,
            child: _QuestionOptionList(
              options: question.options,
              multiSelect: question.answerKind.allowsMultiple,
              enabled: !widget.isBusy,
              onSelect: widget.onSelect,
              onCustom: question.allowCustom && !_showCustomField
                  ? () => setState(() {
                      _showCustomField = true;
                      _autofocusCustomField = true;
                    })
                  : null,
              onSkip: widget.onSkip,
              openAnswerHint: _showCustomField
                  ? null
                  : 'Type your answer below.',
            ),
          ),
        ],
        if (!collapsed && _showCustomField) ...[
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _customController,
                  enabled: !widget.isBusy,
                  autofocus: _autofocusCustomField,
                  minLines: 1,
                  maxLines: 3,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _submitCustom(),
                  decoration: InputDecoration(
                    hintText: 'Type your own answer…',
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
                valueListenable: _customController,
                builder: (context, value, _) {
                  return IconButton.filled(
                    tooltip: 'Submit answer',
                    onPressed: (!widget.isBusy && value.text.trim().isNotEmpty)
                        ? _submitCustom
                        : null,
                    icon: const Icon(Icons.send_rounded),
                  );
                },
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _RevisionComposer extends StatelessWidget {
  const _RevisionComposer({
    required this.controller,
    required this.enabled,
    required this.onSend,
    this.focusNode,
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onSend;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            focusNode: focusNode,
            enabled: enabled,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: 'Ask about or request a change to the plan…',
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
            final canSend = enabled && value.text.trim().isNotEmpty;
            return IconButton.filled(
              tooltip: 'Send revision',
              onPressed: canSend
                  ? () {
                      onSend(controller.text);
                      controller.clear();
                    }
                  : null,
              icon: const Icon(Icons.send_rounded),
            );
          },
        ),
      ],
    );
  }
}

class _ApproveButton extends StatelessWidget {
  const _ApproveButton({required this.approving, required this.onApprove});

  final bool approving;
  final VoidCallback? onApprove;

  @override
  Widget build(BuildContext context) {
    return AppButton.primary(
      onPressed: onApprove,
      loading: approving,
      loadingLabel: 'Approving…',
      leading: const Icon(Icons.check_circle_outline),
      label: 'Approve and start writing',
    );
  }
}

// ---------------------------------------------------------------------------
// Chat-stage widgets (brief header, transcript, conversation footer)
// ---------------------------------------------------------------------------
