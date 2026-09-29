part of 'creation_chat_screen.dart';

// Plan preview bubbles shown once a book plan exists. The generation-progress
// bubble lives in creation_chat_generation.dart; imports and shared state live
// in the parent library file.

class _PlanBubble extends ConsumerStatefulWidget {
  const _PlanBubble.live({
    super.key,
    required this.planValue,
    this.statusValue,
    this.busyAction,
  }) : plan = null;

  const _PlanBubble.snapshot({super.key, required this.plan, this.statusValue})
    : planValue = null,
      busyAction = null;

  final AsyncValue<MobileProjectDetail>? planValue;
  final AsyncValue<MobileProjectStatus>? statusValue;
  final MobilePlan? plan;
  final String? busyAction;

  @override
  ConsumerState<_PlanBubble> createState() => _PlanBubbleState();
}

class _PlanBubbleState extends ConsumerState<_PlanBubble> {
  /// What the reader chose. Null until they tap, so the default can follow the
  /// plan: the one awaiting a decision opens on its chapters, an old version
  /// stays a line.
  bool? _userExpanded;

  @override
  Widget build(BuildContext context) {
    final planningTime = formatGenerationDuration(
      widget.statusValue?.asData?.value.planningDurationMs,
    );
    final snapshot = widget.plan;
    if (snapshot != null) {
      if (snapshot.isApproved) {
        return _buildCompactApprovedPlanCard(context, snapshot, planningTime);
      }
      return _buildPlanCard(
        context,
        snapshot,
        label: _planSnapshotLabel(snapshot),
        planningTime: planningTime,
      );
    }

    return widget.planValue!.when(
      loading: () => _buildSpinnerBubble(
        context,
        widget.busyAction == 'revise'
            ? 'Revising your book plan…'
            : 'Building your book plan…',
        semanticsLabel: widget.busyAction == 'revise'
            ? 'Revising plan'
            : 'Building plan',
      ),
      error: (e, _) => _buildSpinnerBubble(context, 'Waiting for plan…'),
      data: (project) {
        final plan = project.plan;
        final liveStatus = widget.statusValue?.asData?.value;
        if (plan == null && _planGenerationFailed(project, liveStatus)) {
          return _buildFailureBubble(context, _planFailureMessage(liveStatus));
        }
        if (project.status == 'planning' || liveStatus?.status == 'planning') {
          final liveAction = liveStatus?.effectiveAction.trim();
          return _buildSpinnerBubble(
            context,
            liveAction != null && liveAction.isNotEmpty
                ? liveAction
                : _planProgressLabel(project),
            semanticsLabel: plan == null ? 'Building plan' : 'Revising plan',
          );
        }
        if (plan == null) {
          return _buildSpinnerBubble(
            context,
            project.currentAction.isNotEmpty
                ? project.currentAction
                : 'Building your book plan…',
          );
        }
        if (plan.isApproved) {
          return _buildCompactApprovedPlanCard(context, plan, planningTime);
        }
        return _buildPlanCard(context, plan, planningTime: planningTime);
      },
    );
  }

  Widget _buildFailureBubble(BuildContext context, String message) {
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: AppInlineNotice(
            icon: Icons.error_outline,
            title: 'Plan generation failed',
            message: message,
            tone: AppTone.error,
          ),
        ),
      ),
    );
  }

  /// The plan being written: the working sparkle the footer's progress card
  /// uses, beside the live sentence, so the transcript and the footer agree on
  /// what "busy" looks like instead of one of them being a bare spinner.
  Widget _buildSpinnerBubble(
    BuildContext context,
    String label, {
    String semanticsLabel = 'Building plan',
  }) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Semantics(
        label: semanticsLabel,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: const BorderRadiusDirectional.only(
              topStart: Radius.circular(16),
              topEnd: Radius.circular(16),
              bottomStart: Radius.circular(4),
              bottomEnd: Radius.circular(16),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              PlanBuildSparkle(color: colors.primary, size: 20),
              const SizedBox(width: 10),
              Flexible(
                child: RisingStatusText(
                  text: label,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// An approved plan is history, not a decision: one quiet row that opens the
  /// book. It no longer restates the title — the header above and the book card
  /// below both carry it — so a finished chat reads as one story, not three
  /// cards saying the same name.
  Widget _buildCompactApprovedPlanCard(
    BuildContext context,
    MobilePlan plan,
    String? planningTime,
  ) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final facts = _planFacts(plan);
    final quiet = text.bodySmall?.copyWith(color: colors.onSurfaceVariant);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Card(
          margin: const EdgeInsets.symmetric(vertical: 6),
          color: colors.surfaceContainerHighest,
          clipBehavior: Clip.antiAlias,
          child: Semantics(
            button: true,
            hint: 'Opens your book',
            child: InkWell(
              onTap: () => context.push('/projects/${plan.projectId}'),
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.md,
                    vertical: AppSpacing.sm,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.task_alt_outlined,
                        color: colors.primary,
                        size: 20,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Book plan approved',
                              style: text.titleSmall?.copyWith(
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Wrap(
                              spacing: 6,
                              children: [
                                Text(facts, style: quiet),
                                if (planningTime != null) ...[
                                  Text('·', style: quiet),
                                  Text(
                                    'Planning took $planningTime',
                                    style: quiet,
                                  ),
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: AppSpacing.xs),
                      Icon(
                        Icons.chevron_right,
                        size: 20,
                        color: colors.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// A plan the reader can still act on opens on its chapters — page counts
  /// beside each — with the cover and illustration settings that will be
  /// charged. An old, superseded version folds to one line.
  Widget _buildPlanCard(
    BuildContext context,
    MobilePlan plan, {
    String label = 'Book plan ready',
    String? planningTime,
  }) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final expanded = _userExpanded ?? !plan.isSuperseded;
    final project = widget.planValue?.asData?.value ?? _projectFor(plan);
    final current = project != null && project.plan?.id == plan.id;
    final reduced = AppMotion.reducedMotion(context);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(
          color: plan.isSuperseded
              ? colors.outlineVariant
              : colors.primary.withValues(alpha: 0.35),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: expanded,
            child: InkWell(
              onTap: () => setState(() => _userExpanded = !expanded),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Icon(
                        Icons.auto_stories_outlined,
                        color: colors.primary,
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            label,
                            style: text.labelSmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            plan.title,
                            style: text.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            _planFacts(plan),
                            style: text.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          if (planningTime != null) ...[
                            const SizedBox(height: 2),
                            Text(
                              'Planning took $planningTime',
                              style: text.bodySmall?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    AnimatedRotation(
                      turns: expanded ? 0.5 : 0,
                      duration: reduced ? Duration.zero : AppMotion.medium,
                      child: Icon(
                        Icons.expand_more,
                        color: colors.onSurfaceVariant,
                        size: 22,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: reduced ? Duration.zero : AppMotion.medium,
            curve: AppMotion.enter,
            alignment: Alignment.topCenter,
            child: expanded
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Divider(height: 1, color: colors.outlineVariant),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                        child: _PlanDetails(
                          plan: plan,
                          project: current ? project : null,
                        ),
                      ),
                    ],
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }

  /// The book this snapshot belongs to, when the transcript already holds it —
  /// the cover and illustration switches live on the project, not the plan.
  MobileProjectDetail? _projectFor(MobilePlan plan) =>
      ref.watch(projectDetailProvider(plan.projectId)).asData?.value;
}

/// "6 chapters · 24 pages": what a plan adds up to, from its own chapters.
String _planFacts(MobilePlan plan) {
  final chapters = plan.chapters.length;
  final pages = plan.chapters.fold<int>(
    0,
    (total, chapter) => total + chapter.targetPages,
  );
  return [
    chapters == 1 ? '1 chapter' : '$chapters chapters',
    if (pages > 0) pages == 1 ? '1 page' : '$pages pages',
  ].join(' · ');
}

class _PlanDetails extends StatelessWidget {
  const _PlanDetails({required this.plan, this.project});

  final MobilePlan plan;

  /// Present only for the plan the book is actually built from: its cover and
  /// illustration settings are what approval will charge for.
  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final project = this.project;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if ((plan.subtitle ?? '').isNotEmpty) ...[
          Text(
            plan.subtitle!,
            style: text.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontStyle: FontStyle.italic,
            ),
          ),
          const SizedBox(height: 12),
        ],
        if (project != null) ...[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AppMetricChip(
                icon: Icons.auto_stories_outlined,
                label: project.coverEnabled ? 'AI cover art' : 'Designed cover',
              ),
              AppMetricChip(
                icon: Icons.image_outlined,
                label: project.illustrationsEnabled
                    ? 'With illustrations'
                    : 'No illustrations',
              ),
            ],
          ),
          const SizedBox(height: 14),
        ],
        Row(
          children: [
            Icon(Icons.format_list_numbered, size: 15, color: colors.primary),
            const SizedBox(width: 6),
            Text(
              'Chapters',
              style: text.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 10),
        PlanChapterList(chapters: plan.chapters),
        const SizedBox(height: 14),
        _PlanSection(
          icon: Icons.lightbulb_outline,
          title: 'Premise',
          text: plan.premise,
        ),
        const SizedBox(height: 10),
        _PlanSection(
          icon: Icons.groups_outlined,
          title: 'Audience',
          text: plan.audience,
        ),
      ],
    );
  }
}

class _PlanSection extends StatelessWidget {
  const _PlanSection({
    required this.icon,
    required this.title,
    required this.text,
  });

  final IconData icon;
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 14, color: colors.primary),
            const SizedBox(width: 5),
            Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Text(text, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Plan-stage footer
// ---------------------------------------------------------------------------

// The one-question-at-a-time panel the plan footer opens with.

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
