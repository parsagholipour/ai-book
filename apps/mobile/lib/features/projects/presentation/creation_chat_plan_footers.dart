part of 'creation_chat_screen.dart';

// Footers for the planning stages: progress steps, revision composer and approval.
// Imports and shared state live in the parent library file.

class _ProjectChatFooter extends StatelessWidget {
  const _ProjectChatFooter({
    required this.controller,
    required this.enabled,
    required this.projectStatus,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final String projectStatus;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final hintText = projectStatus == 'complete'
        ? 'Ask for an edit to this book…'
        : projectStatus == 'generating' || projectStatus == 'editing'
        ? 'Ask about this book…'
        : 'Ask for a change…';
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
                  enabled: enabled,
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
                  final canSend = enabled && value.text.trim().isNotEmpty;
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
    final planningProgress = statusValue?.asData?.value.planningProgress;
    final progress = planningProgress?.percent;
    final steps = planningProgress?.steps ?? _fallbackPlanningSteps(isRevision);
    final activeStep = steps.where((step) => step.isActive).firstOrNull;
    final allStepsDone = steps.isNotEmpty && steps.every((step) => step.isDone);
    final title = allStepsDone
        ? isRevision
              ? 'Your revised plan is ready'
              : 'Your book plan is ready'
        : isRevision
        ? 'Revising your book plan'
        : 'Creating your book plan';
    final detail = allStepsDone
        ? 'Opening it for review…'
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
              enabled: !widget.isBusy,
              onSelect: widget.onSelect,
              onCustom: question.allowCustom && !_showCustomField
                  ? () => setState(() => _showCustomField = true)
                  : null,
              onSkip: widget.onSkip,
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
                  autofocus: true,
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
    return FilledButton.icon(
      onPressed: onApprove,
      icon: approving
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Approving',
              ),
            )
          : const Icon(Icons.check_circle_outline),
      label: Text(approving ? 'Approving…' : 'Approve and start writing'),
    );
  }
}

// ---------------------------------------------------------------------------
// Chat-stage widgets (brief header, transcript, conversation footer)
// ---------------------------------------------------------------------------
