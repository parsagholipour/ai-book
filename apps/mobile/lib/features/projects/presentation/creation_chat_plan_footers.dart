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

    // The icon keeps working until every step has landed, then settles into
    // a check: the one moment this card is allowed to look finished.
    final Widget icon = allStepsDone
        ? Icon(
            Icons.check_circle,
            key: const ValueKey('plan-progress-done'),
            color: colors.primary,
            size: 22,
          )
        : PlanBuildSparkle(
            key: const ValueKey('plan-progress-working'),
            color: colors.primary,
            size: 22,
          );

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          // The footer arrives as the Build pill leaves, so it rises into
          // place rather than replacing the pill in a single frame.
          child: AppEntrance(
            offset: 14,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: AnimatedSwitcher(
                        duration: AppMotion.medium,
                        switchInCurve: AppMotion.emphasized,
                        transitionBuilder: (child, animation) =>
                            ScaleTransition(
                              scale: animation,
                              child: FadeTransition(
                                opacity: animation,
                                child: child,
                              ),
                            ),
                        child: icon,
                      ),
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
                          RisingStatusText(
                            text: detail,
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: colors.onSurfaceVariant),
                          ),
                        ],
                      ),
                    ),
                    if (progress != null) ...[
                      const SizedBox(width: 12),
                      AppAnimatedCount(
                        value: progress,
                        builder: (value) => '$value%',
                        style: Theme.of(context).textTheme.labelLarge?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w800,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 12),
                PlanBuildProgressBar(
                  value: progress == null ? null : progress / 100,
                  semanticLabel: 'Book plan progress',
                ),
                const SizedBox(height: 12),
                AnimatedSize(
                  duration: AppMotion.reducedMotion(context)
                      ? Duration.zero
                      : AppMotion.medium,
                  curve: AppMotion.enter,
                  alignment: Alignment.topCenter,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final step in steps)
                        ProgressStepRow(
                          step: step,
                          showDetail: true,
                          inlineDetail: !step.isActive,
                        ),
                    ],
                  ),
                ),
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
      ),
    );
  }
}

class _PlanFailedFooter extends StatelessWidget {
  const _PlanFailedFooter({
    required this.message,
    required this.retrying,
    required this.retryAvailable,
    this.retryCredits,
    required this.onRetry,
    required this.onRefresh,
  });

  final String message;
  final bool retrying;
  final bool retryAvailable;
  final int? retryCredits;
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
            actionLabel: retryAvailable
                ? retryCredits == null
                      ? 'Retry plan'
                      : 'Retry plan · $retryCredits credits'
                : 'Check again',
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
              // Ideas for the empty box, only once the questions are through
              // and only while the keyboard is down: a stalled reader gets a
              // start, and one who is typing keeps the room. Once the questions
              // are through this pair is what gives way when the footer runs
              // out of height (a small phone at a large text size): it scrolls
              // from the bottom, so the box stays in view and the ideas leave
              // first, while Approve stays pinned below it.
              if (widget.hasMoreQuestions)
                _RevisionComposer(
                  controller: widget.revisionController,
                  focusNode: _revisionFocus,
                  enabled: !widget.isBusy,
                  onSend: widget.onRevise,
                )
              else
                Flexible(
                  fit: FlexFit.loose,
                  child: SingleChildScrollView(
                    reverse: true,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (!keyboardOpen) ...[
                          _RevisionSuggestions(
                            controller: widget.revisionController,
                            focusNode: _revisionFocus,
                            enabled: !widget.isBusy,
                          ),
                          const SizedBox(height: 8),
                        ],
                        _RevisionComposer(
                          controller: widget.revisionController,
                          focusNode: _revisionFocus,
                          enabled: !widget.isBusy,
                          onSend: widget.onRevise,
                        ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 8),
              _ApproveButton(
                approving: busyAction == 'approve',
                onApprove: (!widget.isBusy && busyAction == null)
                    ? widget.onApprove
                    : null,
              ),
              // Like the suggestions, only once the questions are through: while
              // one is open every pixel of the footer belongs to its answers.
              if (!widget.hasMoreQuestions && !keyboardOpen)
                _ApprovalCaption(projectId: plan.projectId),
            ],
          ),
        ),
      ),
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

/// One line of ideas for a plan change, shown while the box is empty. Tapping
/// one fills the box for editing — it never sends on its own.
class _RevisionSuggestions extends StatelessWidget {
  const _RevisionSuggestions({
    required this.controller,
    required this.focusNode,
    required this.enabled,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (context, value, _) {
        if (value.text.trim().isNotEmpty) {
          return const SizedBox.shrink();
        }
        // A plain scroll view, not a ListView: the transcript is the screen's
        // only list, and other code (and tests) finds it by that type.
        return SizedBox(
          // Chips grow with the text; a fixed 40 clips their labels.
          height: MediaQuery.textScalerOf(context).scale(40),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final suggestion in planRevisionSuggestions) ...[
                  ActionChip(
                    label: Text(suggestion),
                    onPressed: enabled
                        ? () {
                            controller.text = suggestion;
                            controller.selection = TextSelection.collapsed(
                              offset: suggestion.length,
                            );
                            focusNode.requestFocus();
                          }
                        : null,
                  ),
                  const SizedBox(width: 8),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// What the Approve button will cost, said beside it rather than after the
/// tap. The quote is the same `estimateApprovalCredits` the confirmation
/// dialog uses; until billing has loaded there is nothing to say and nothing is
/// drawn, so the footer never jumps to make room for a placeholder.
class _ApprovalCaption extends ConsumerWidget {
  const _ApprovalCaption({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final project = ref.watch(projectDetailProvider(projectId)).asData?.value;
    final billing = ref.watch(billingProvider).asData?.value;
    if (project == null || billing == null) {
      return const SizedBox.shrink();
    }
    final estimate = estimateApprovalCredits(project, billing.creditCosts);
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        'Book after approval: ≈ $estimate credits · You have '
        '${billing.credits.available}',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// Holds the footer while it changes kind — the Build pill's progress, the plan
/// review, the writing composer — so each arrives by cross-fading over the one
/// it replaces, anchored to the bottom edge, instead of cutting to it in one
/// frame.
///
/// Deliberately fade-only: the incoming footer is laid out at its real size at
/// once, so every control in it is there and tappable from the first frame. An
/// animated height would have to hold the controls hostage while it settled.
class _FooterHandoff extends StatelessWidget {
  const _FooterHandoff({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (AppMotion.reducedMotion(context)) {
      return child;
    }
    return AnimatedSwitcher(
      duration: AppMotion.fast,
      switchInCurve: AppMotion.enter,
      switchOutCurve: AppMotion.exit,
      layoutBuilder: (currentChild, previousChildren) => Stack(
        alignment: Alignment.bottomCenter,
        children: [...previousChildren, ?currentChild],
      ),
      child: KeyedSubtree(key: ValueKey(child.runtimeType), child: child),
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
