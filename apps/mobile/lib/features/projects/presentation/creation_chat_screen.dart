import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'creation_chat_controller.dart';
import 'creation_labels.dart';
import 'plan_approval.dart';

class CreationChatScreen extends ConsumerStatefulWidget {
  const CreationChatScreen({super.key});

  @override
  ConsumerState<CreationChatScreen> createState() => _CreationChatScreenState();
}

class _CreationChatScreenState extends ConsumerState<CreationChatScreen> {
  final _composerController = TextEditingController();
  final _revisionController = TextEditingController();
  final _scrollController = ScrollController();

  String? _projectId;
  String? _planBusyAction;
  Timer? _planRefreshTimer;
  int _lastScrollTrigger = 0;

  // Plan question tracking
  int _planQuestionIndex = 0;
  Map<int, String> _planQuestionAnswers = {};

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) {
        ref.read(creationChatControllerProvider.notifier).init();
      }
    });
  }

  @override
  void dispose() {
    _planRefreshTimer?.cancel();
    _composerController.dispose();
    _revisionController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(
      creationChatControllerProvider.select((s) => s.initError),
      (_, next) {
        if (next != null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
          ref.read(creationChatControllerProvider.notifier).clearError();
        }
      },
    );

    final state = ref.watch(creationChatControllerProvider);
    final isInPlanStage = _projectId != null;

    AsyncValue<MobileProjectDetail>? planValue;
    if (isInPlanStage) {
      planValue = ref.watch(projectDetailProvider(_projectId!));
      planValue?.whenData(_stopPollingWhenSettled);
    }

    final scrollTrigger = state.messages.length + (isInPlanStage ? 1 : 0) + (state.assistantTyping ? 1 : 0);
    _maybeScrollToBottom(scrollTrigger);

    return Scaffold(
      appBar: AppBar(
        title: Text(isInPlanStage ? 'Book plan' : 'New book'),
        actions: [
          if (isInPlanStage)
            IconButton(
              tooltip: 'Refresh',
              onPressed: () => ref.invalidate(projectDetailProvider(_projectId!)),
              icon: const Icon(Icons.refresh),
            )
          else
            IconButton(
              tooltip: 'Advanced settings',
              onPressed: state.hasSession ? () => _openAdvancedSheet(state) : null,
              icon: const Icon(Icons.tune),
            ),
        ],
      ),
      body: SafeArea(
        bottom: false,
        child: state.initializing
            ? const AppLoadingState(message: 'Starting your Book Studio')
            : Column(
                children: [
                  if (!isInPlanStage) _BriefHeader(state: state),
                  Expanded(
                    child: _Transcript(
                      state: state,
                      controller: _scrollController,
                      planValue: planValue,
                    ),
                  ),
                  if (isInPlanStage)
                    _buildPlanFooter(planValue!)
                  else
                    _ConversationFooter(
                      state: state,
                      composerController: _composerController,
                      onSend: _send,
                      onQuickReply: _send,
                      onAnswerOption: _send,
                      onAttachNotes: () => _openSourceNotesSheet(state),
                      onBuild: _build,
                    ),
                ],
              ),
      ),
    );
  }

  Widget _buildPlanFooter(AsyncValue<MobileProjectDetail> planValue) {
    return planValue.when(
      loading: () => const _PlanBuildingFooter(),
      error: (_, __) => const SizedBox.shrink(),
      data: (project) {
        final plan = project.plan;
        if (plan == null) {
          return const _PlanBuildingFooter();
        }
        if (plan.isApproved) {
          return const SizedBox.shrink();
        }
        final hasMoreQuestions =
            plan.questions.isNotEmpty && _planQuestionIndex < plan.questions.length;
        return _PlanFooter(
          plan: plan,
          questionIndex: _planQuestionIndex,
          hasMoreQuestions: hasMoreQuestions,
          isBusy: _planBusyAction != null,
          busyAction: _planBusyAction,
          revisionController: _revisionController,
          onSelectOption: (answer) => _onPlanQuestionSelect(project, plan, answer),
          onSkip: () => _onPlanQuestionSkip(project, plan),
          onRevise: (msg) => _revise(project, msg),
          onApprove: () => _approve(project),
        );
      },
    );
  }

  void _maybeScrollToBottom(int trigger) {
    if (trigger == _lastScrollTrigger) return;
    _lastScrollTrigger = trigger;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    _composerController.clear();
    try {
      await ref.read(creationChatControllerProvider.notifier).sendMessage(trimmed);
    } catch (_) {}
  }

  Future<void> _build() async {
    try {
      final result = await ref.read(creationChatControllerProvider.notifier).buildPlan();
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(result.project.id));
      ref.invalidate(billingProvider);
      if (!mounted) return;
      setState(() => _projectId = result.project.id);
      _startPlanPoll();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'INSUFFICIENT_CREDITS') {
        await showBillingPaywall(context, title: 'Credits needed', message: error.message);
        ref.invalidate(billingProvider);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(userFacingError(error))));
      }
    }
  }

  Future<void> _revise(MobileProjectDetail project, String message) async {
    final plan = project.plan;
    if (plan == null) return;
    setState(() => _planBusyAction = 'revise');
    try {
      final operation = await ref
          .read(projectsRepositoryProvider)
          .revisePlan(planId: plan.id, message: message);
      if (!mounted) return;
      setState(() {
        _planBusyAction = null;
        _revisionController.clear();
        _planQuestionIndex = 0;
        _planQuestionAnswers = {};
      });
      _startPlanPoll();
      ref.invalidate(projectDetailProvider(project.id));
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(operation.currentAction)));
    } catch (error) {
      if (!mounted) return;
      setState(() => _planBusyAction = null);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _approve(MobileProjectDetail project) async {
    final operation = await confirmAndApprovePlan(
      context,
      ref,
      project,
      onStart: () {
        if (mounted) setState(() => _planBusyAction = 'approve');
      },
      onSettled: () {
        if (mounted && _planBusyAction == 'approve') setState(() => _planBusyAction = null);
      },
    );
    if (operation == null || !mounted) return;
    context.push('/projects/${project.id}/handoff', extra: operation.currentAction);
  }

  void _onPlanQuestionSelect(MobileProjectDetail project, MobilePlan plan, String answer) {
    _planQuestionAnswers[_planQuestionIndex] = answer;
    final next = _planQuestionIndex + 1;
    if (next < plan.questions.length) {
      setState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  void _onPlanQuestionSkip(MobileProjectDetail project, MobilePlan plan) {
    final next = _planQuestionIndex + 1;
    if (next < plan.questions.length) {
      setState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  Future<void> _maybeSendPlanAnswers(MobileProjectDetail project, MobilePlan plan) async {
    final answers = Map<int, String>.from(_planQuestionAnswers);
    setState(() {
      _planQuestionIndex = plan.questions.length; // show revision bar
      _planQuestionAnswers = {};
    });
    if (answers.isEmpty) return;
    final lines = ['Please revise the plan using these planning answers:'];
    for (var i = 0; i < plan.questions.length; i++) {
      final answer = answers[i];
      if (answer != null) lines.add('- ${plan.questions[i].prompt}: $answer');
    }
    await _revise(project, lines.join('\n'));
  }

  Future<void> _openSourceNotesSheet(CreationChatState state) async {
    final controller = TextEditingController(text: state.sourceNotes);
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SourceNotesSheet(controller: controller),
    );
    controller.dispose();
    if (saved != null) {
      ref.read(creationChatControllerProvider.notifier).setSourceNotes(saved);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              saved.trim().isEmpty ? 'Source notes cleared.' : 'Source notes attached.',
            ),
          ),
        );
      }
    }
  }

  Future<void> _openAdvancedSheet(CreationChatState state) async {
    final controller = ref.read(creationChatControllerProvider.notifier);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AdvancedSheet(controller: controller),
    );
  }

  void _startPlanPoll() {
    _planRefreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      final id = _projectId;
      if (id == null) return;
      if (ref.read(projectDetailProvider(id)).isLoading) return;
      ref.invalidate(projectDetailProvider(id));
    });
  }

  void _stopPollingWhenSettled(MobileProjectDetail project) {
    if (_planRefreshTimer == null) return;
    if (project.status == 'planning' || project.plan == null) return;
    _planRefreshTimer?.cancel();
    _planRefreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Plan bubble (shown in the transcript once build is triggered)
// ---------------------------------------------------------------------------

class _PlanBubble extends StatefulWidget {
  const _PlanBubble({required this.planValue});

  final AsyncValue<MobileProjectDetail> planValue;

  @override
  State<_PlanBubble> createState() => _PlanBubbleState();
}

class _PlanBubbleState extends State<_PlanBubble> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return widget.planValue.when(
      loading: () => _buildSpinnerBubble(context, 'Building your book plan…'),
      error: (e, _) => _buildSpinnerBubble(context, 'Waiting for plan…'),
      data: (project) {
        final plan = project.plan;
        if (plan == null) {
          return _buildSpinnerBubble(
            context,
            project.currentAction.isNotEmpty
                ? project.currentAction
                : 'Building your book plan…',
          );
        }
        return _buildPlanCard(context, plan);
      },
    );
  }

  Widget _buildSpinnerBubble(BuildContext context, String label) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: colors.primary,
                semanticsLabel: 'Building plan',
              ),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                label,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlanCard(BuildContext context, MobilePlan plan) {
    final colors = Theme.of(context).colorScheme;
    final radius = BorderRadius.circular(16);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: radius,
        border: Border.all(color: colors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Icon(Icons.auto_stories_outlined, color: colors.primary, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Book plan ready',
                          style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          plan.title,
                          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  AppStatusBadge(
                    label: '${plan.chapters.length} ch.',
                    icon: Icons.format_list_numbered,
                    tone: AppNoticeTone.success,
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                    size: 20,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            Divider(height: 1, color: colors.outlineVariant),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if ((plan.subtitle ?? '').isNotEmpty) ...[
                    Text(
                      plan.subtitle!,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
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
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Icon(Icons.format_list_numbered, size: 15, color: colors.primary),
                      const SizedBox(width: 6),
                      Text(
                        'Chapters',
                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  for (final chapter in plan.chapters) ...[
                    _ChapterRow(chapter: chapter),
                    if (chapter != plan.chapters.last) const SizedBox(height: 6),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _PlanSection extends StatelessWidget {
  const _PlanSection({required this.icon, required this.title, required this.text});

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
              style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Text(text, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _ChapterRow extends StatelessWidget {
  const _ChapterRow({required this.chapter});

  final MobilePlanChapter chapter;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 22,
          child: Text(
            '${chapter.index}.',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w800,
              color: colors.primary,
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                chapter.title,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
              ),
              if (chapter.summary.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  chapter.summary,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Plan-stage footer
// ---------------------------------------------------------------------------

class _PlanBuildingFooter extends StatelessWidget {
  const _PlanBuildingFooter();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
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
                  semanticsLabel: 'Building plan',
                ),
              ),
              const SizedBox(width: 12),
              Text(
                'Building your book plan…',
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
}

class _PlanFooter extends StatelessWidget {
  const _PlanFooter({
    required this.plan,
    required this.questionIndex,
    required this.hasMoreQuestions,
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
  final bool isBusy;
  final String? busyAction;
  final TextEditingController revisionController;
  final ValueChanged<String> onSelectOption;
  final VoidCallback onSkip;
  final ValueChanged<String> onRevise;
  final VoidCallback onApprove;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

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
              if (hasMoreQuestions) ...[
                _PlanQuestionPanel(
                  key: ValueKey(questionIndex),
                  plan: plan,
                  questionIndex: questionIndex,
                  isBusy: isBusy,
                  onSelect: onSelectOption,
                  onSkip: onSkip,
                ),
                const SizedBox(height: 10),
                Divider(height: 1, color: colors.outlineVariant),
                const SizedBox(height: 10),
              ],
              _RevisionComposer(
                controller: revisionController,
                enabled: !isBusy,
                onSend: onRevise,
              ),
              const SizedBox(height: 8),
              _ApproveButton(
                approving: busyAction == 'approve',
                onApprove: busyAction == null ? onApprove : null,
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
    required this.isBusy,
    required this.onSelect,
    required this.onSkip,
    super.key,
  });

  final MobilePlan plan;
  final int questionIndex;
  final bool isBusy;
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Question ${widget.questionIndex + 1} of $total',
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          question.prompt,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in question.options)
              ActionChip(
                label: Text(option),
                onPressed: widget.isBusy ? null : () => widget.onSelect(option),
              ),
            if (question.allowCustom && !_showCustomField)
              ActionChip(
                avatar: const Icon(Icons.edit_outlined, size: 16),
                label: const Text('Custom…'),
                onPressed: widget.isBusy
                    ? null
                    : () => setState(() => _showCustomField = true),
              ),
            ActionChip(
              avatar: const Icon(Icons.skip_next_outlined, size: 18),
              label: const Text('Skip'),
              onPressed: widget.isBusy ? null : widget.onSkip,
            ),
          ],
        ),
        if (_showCustomField) ...[
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
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: 'Request a change to the plan…',
              filled: true,
              fillColor: colors.surfaceContainerHigh,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
              child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Approving'),
            )
          : const Icon(Icons.check_circle_outline),
      label: Text(approving ? 'Approving…' : 'Approve and start writing'),
    );
  }
}

// ---------------------------------------------------------------------------
// Chat-stage widgets (brief header, transcript, conversation footer)
// ---------------------------------------------------------------------------

class _BriefHeader extends StatefulWidget {
  const _BriefHeader({required this.state});

  final CreationChatState state;

  @override
  State<_BriefHeader> createState() => _BriefHeaderState();
}

class _BriefHeaderState extends State<_BriefHeader> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final brief = state.brief;
    final colors = Theme.of(context).colorScheme;
    final presets = state.presets;
    final lane = state.detectedLane;

    return Material(
      color: colors.surfaceContainerHigh,
      child: Column(
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
              child: Row(
                children: [
                  Icon(Icons.menu_book_outlined, color: colors.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Book brief',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          laneTitle(lane),
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
                  _ReadinessPill(readiness: state.readiness),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: _BriefDetails(state: state, brief: brief, presets: presets),
            ),
          Divider(height: 1, color: colors.outlineVariant),
        ],
      ),
    );
  }
}

class _BriefDetails extends StatelessWidget {
  const _BriefDetails({
    required this.state,
    required this.brief,
    required this.presets,
  });

  final CreationChatState state;
  final MobileBookRecipe? brief;
  final MobileCreationPresets presets;

  @override
  Widget build(BuildContext context) {
    final lane = state.detectedLane;
    final promise = brief == null ? '' : primaryPromise(brief!);
    final rows = <_BriefRow>[
      if ((brief?.audience ?? '').trim().isNotEmpty)
        _BriefRow(audienceLabel(lane), brief!.audience),
      if (promise.trim().isNotEmpty) _BriefRow(promiseLabel(lane), promise),
      if ((brief?.tone ?? '').trim().isNotEmpty) _BriefRow('Tone', brief!.tone),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            AppMetricChip(label: 'Type', value: bookTypeLabel(presets.bookType)),
            AppMetricChip(
              label: 'Size',
              value: '${pageRangeFor(presets.bookType, presets.lengthPreset)} pages',
            ),
            AppMetricChip(label: 'Finish', value: qualityLabel(presets.qualityPreset)),
            AppMetricChip(
              label: 'Visuals',
              value: presets.imagesEnabled ? 'Included' : 'Text-first',
            ),
            if (state.language != 'en')
              AppMetricChip(label: 'Language', value: languageLabel(state.language)),
          ],
        ),
        if (state.userChoices.isNotEmpty) ...[
          const SizedBox(height: 8),
          const AppStatusBadge(
            label: 'Your choices applied',
            icon: Icons.tune_outlined,
            tone: AppNoticeTone.success,
          ),
        ],
        for (final row in rows) ...[
          const SizedBox(height: 10),
          Text(
            row.label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(row.value),
        ],
        if (state.readiness.missing.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            'Helpful to add',
            style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          for (final item in state.readiness.missing)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text('• $item'),
            ),
        ],
      ],
    );
  }
}

class _BriefRow {
  const _BriefRow(this.label, this.value);

  final String label;
  final String value;
}

class _ReadinessPill extends StatelessWidget {
  const _ReadinessPill({required this.readiness});

  final MobileCreationReadiness readiness;

  @override
  Widget build(BuildContext context) {
    final ready = readiness.canBuild;
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: AppStatusBadge(
        label: ready ? 'Ready' : '${readiness.score}%',
        icon: ready ? Icons.check_circle_outline : Icons.timelapse_outlined,
        tone: ready ? AppNoticeTone.success : AppNoticeTone.neutral,
      ),
    );
  }
}

class _Transcript extends StatelessWidget {
  const _Transcript({
    required this.state,
    required this.controller,
    this.planValue,
  });

  final CreationChatState state;
  final ScrollController controller;
  final AsyncValue<MobileProjectDetail>? planValue;

  @override
  Widget build(BuildContext context) {
    final hasPlanBubble = planValue != null;
    final hasTyping = state.assistantTyping && !hasPlanBubble;
    final itemCount = state.messages.length + (hasTyping ? 1 : 0) + (hasPlanBubble ? 1 : 0);

    return ListView.builder(
      controller: controller,
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (hasPlanBubble && index == state.messages.length) {
          return _PlanBubble(planValue: planValue!);
        }
        if (hasTyping && index == state.messages.length) {
          return const _TypingBubble();
        }
        return _MessageBubble(message: state.messages[index]);
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});

  final MobileCreationMessage message;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final background = isUser ? colors.primary : colors.surfaceContainerHighest;
    final foreground = isUser ? colors.onPrimary : colors.onSurface;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isUser ? 16 : 4),
            bottomRight: Radius.circular(isUser ? 4 : 16),
          ),
        ),
        child: Text(
          message.content,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: foreground),
        ),
      ),
    );
  }
}

class _TypingBubble extends StatelessWidget {
  const _TypingBubble();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Assistant is thinking',
                color: colors.primary,
              ),
            ),
            const SizedBox(width: 10),
            Text(
              'Thinking…',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConversationFooter extends StatelessWidget {
  const _ConversationFooter({
    required this.state,
    required this.composerController,
    required this.onSend,
    required this.onQuickReply,
    required this.onAnswerOption,
    required this.onAttachNotes,
    required this.onBuild,
  });

  final CreationChatState state;
  final TextEditingController composerController;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onQuickReply;
  final ValueChanged<String> onAnswerOption;
  final VoidCallback onAttachNotes;
  final Future<void> Function() onBuild;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final question = state.question;
    final disabled = state.isBusy;

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
              if (question != null)
                _QuestionPanel(
                  question: question,
                  enabled: !disabled,
                  onSelect: onAnswerOption,
                )
              else if (state.quickReplies.isNotEmpty)
                _ChipRow(
                  options: state.quickReplies,
                  enabled: !disabled,
                  icon: Icons.bolt_outlined,
                  onSelect: onQuickReply,
                ),
              if (question != null || state.quickReplies.isNotEmpty) const SizedBox(height: 8),
              _Composer(
                controller: composerController,
                enabled: !disabled,
                hasSourceNotes: state.hasSourceNotes,
                onAttachNotes: onAttachNotes,
                onSend: onSend,
              ),
              const SizedBox(height: 8),
              _BuildButton(
                canBuild: state.canBuild,
                building: state.building,
                onBuild: onBuild,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QuestionPanel extends StatelessWidget {
  const _QuestionPanel({
    required this.question,
    required this.enabled,
    required this.onSelect,
  });

  final MobileCreationQuestion question;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          question.prompt,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in question.options)
              ActionChip(
                label: Text(option),
                onPressed: enabled ? () => onSelect(option) : null,
              ),
            ActionChip(
              avatar: const Icon(Icons.skip_next_outlined, size: 18),
              label: const Text('Skip'),
              onPressed: enabled ? () => onSelect('Skip this for now.') : null,
            ),
          ],
        ),
      ],
    );
  }
}

class _ChipRow extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: options.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final option = options[index];
          return ActionChip(
            avatar: Icon(icon, size: 18),
            label: Text(option),
            onPressed: enabled ? () => onSelect(option) : null,
          );
        },
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.hasSourceNotes,
    required this.onAttachNotes,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool hasSourceNotes;
  final VoidCallback onAttachNotes;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        IconButton(
          tooltip: hasSourceNotes ? 'Source notes attached' : 'Attach source notes',
          onPressed: onAttachNotes,
          icon: Icon(
            hasSourceNotes ? Icons.attach_file : Icons.attach_file_outlined,
            color: hasSourceNotes ? colors.primary : null,
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
              hintText: 'Describe your book or answer above…',
              filled: true,
              fillColor: colors.surfaceContainerHigh,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
    );
  }
}

class _BuildButton extends StatelessWidget {
  const _BuildButton({
    required this.canBuild,
    required this.building,
    required this.onBuild,
  });

  final bool canBuild;
  final bool building;
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
      label: Text(building ? 'Building the plan' : 'Build the plan'),
    );
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

class _SourceNotesSheet extends StatelessWidget {
  const _SourceNotesSheet({required this.controller});

  final TextEditingController controller;

  static const _limit = 12000;

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Source notes',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 6),
          Text(
            'Paste an outline, lesson material, sales copy, or a story seed. Private reference, up to 12,000 characters.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            minLines: 6,
            maxLines: 12,
            maxLength: _limit,
            decoration: const InputDecoration(
              labelText: 'Source notes',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(''),
                  child: const Text('Clear'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: () => Navigator.of(context).pop(controller.text),
                  child: const Text('Attach'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AdvancedSheet extends ConsumerWidget {
  const _AdvancedSheet({required this.controller});

  final CreationChatController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(creationChatControllerProvider);
    final presets = state.presets;
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Advanced settings',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Override anything the studio chose. Your selections stick across the conversation.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            _AdvancedGroup(
              title: 'Book type',
              yourChoice: state.userChoices.contains(CreationChoice.bookType),
              options: bookTypePresetOptions,
              selected: presets.bookType,
              onChanged: controller.setBookType,
            ),
            const SizedBox(height: 14),
            _AdvancedGroup(
              title: 'Length',
              yourChoice: state.userChoices.contains(CreationChoice.length),
              options: lengthPresetOptions(presets.bookType),
              selected: presets.lengthPreset,
              onChanged: controller.setLengthPreset,
            ),
            const SizedBox(height: 14),
            _AdvancedGroup(
              title: 'Finish',
              yourChoice: state.userChoices.contains(CreationChoice.finish),
              options: qualityPresetOptions,
              selected: presets.qualityPreset,
              onChanged: controller.setQualityPreset,
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: presets.imagesEnabled,
              onChanged: controller.setImagesEnabled,
              secondary: const Icon(Icons.image_outlined),
              title: Row(
                children: [
                  const Expanded(child: Text('Visuals')),
                  if (state.userChoices.contains(CreationChoice.visuals))
                    const AppStatusBadge(label: 'Your choice', icon: Icons.tune_outlined),
                ],
              ),
              subtitle: Text(
                presets.imagesEnabled
                    ? 'Cover plus up to ${visualLimitFor(presets.bookType)} supporting visuals.'
                    : 'Text-first project with no planned visuals.',
              ),
            ),
            const SizedBox(height: 10),
            _LanguageField(
              language: state.language,
              yourChoice: state.userChoices.contains(CreationChoice.language),
              onChanged: controller.setLanguage,
            ),
            const SizedBox(height: 14),
            _ToneField(
              tone: state.optionalDetails.tone,
              yourChoice: state.userChoices.contains(CreationChoice.tone),
              onChanged: controller.setTone,
            ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }
}

class _AdvancedGroup extends StatelessWidget {
  const _AdvancedGroup({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(label: 'Your choice', icon: Icons.tune_outlined),
          ],
        ),
        const SizedBox(height: 8),
        for (final option in options) ...[
          AppChoiceTile(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            subtitle: option.subtitle,
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _LanguageField extends StatelessWidget {
  const _LanguageField({
    required this.language,
    required this.yourChoice,
    required this.onChanged,
  });

  final String language;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final known = creationLanguageOptions.any((o) => o.code == language);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Language',
                style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(label: 'Your choice', icon: Icons.tune_outlined),
          ],
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: known ? language : 'en',
          decoration: const InputDecoration(prefixIcon: Icon(Icons.translate_outlined)),
          items: [
            for (final option in creationLanguageOptions)
              DropdownMenuItem(value: option.code, child: Text(option.label)),
          ],
          onChanged: (value) {
            if (value != null) onChanged(value);
          },
        ),
      ],
    );
  }
}

class _ToneField extends StatelessWidget {
  const _ToneField({
    required this.tone,
    required this.yourChoice,
    required this.onChanged,
  });

  final String tone;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  static const _toneExamples = ['warm', 'funny', 'practical', 'polished', 'gentle'];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Tone',
                style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(label: 'Your choice', icon: Icons.tune_outlined),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in _toneExamples)
              ChoiceChip(
                label: Text(option),
                selected: tone.toLowerCase() == option,
                onSelected: (_) => onChanged(option),
              ),
          ],
        ),
      ],
    );
  }
}
