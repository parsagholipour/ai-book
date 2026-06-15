import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

class ProjectDetailScreen extends ConsumerStatefulWidget {
  const ProjectDetailScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<ProjectDetailScreen> createState() =>
      _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends ConsumerState<ProjectDetailScreen> {
  final _revisionController = TextEditingController();
  Timer? _refreshTimer;
  String? _busyAction;
  MobilePlanOperation? _lastOperation;

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _revisionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));
    final billingValue = ref.watch(billingProvider);
    projectValue.whenData(_stopPollingWhenProjectSettled);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book plan'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: () =>
                ref.invalidate(projectDetailProvider(widget.projectId)),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: projectValue.when(
        data: (project) => _ProjectDetailBody(
          project: project,
          billing: billingValue.asData?.value,
          revisionController: _revisionController,
          busyAction: _busyAction,
          lastOperation: _lastOperation,
          onRefresh: () async =>
              ref.invalidate(projectDetailProvider(widget.projectId)),
          onDeleteProject: () => _confirmAndDelete(project),
          onGeneratePlan: () => _runPlanAction(
            action: 'plan',
            future: () =>
                ref.read(projectsRepositoryProvider).generatePlan(project.id),
          ),
          onRevisePlan: (message) => _runPlanAction(
            action: 'revise',
            future: () => ref
                .read(projectsRepositoryProvider)
                .revisePlan(planId: project.plan!.id, message: message),
            clearRevisionText: true,
          ),
          onApprovePlan: project.plan == null
              ? null
              : () => _confirmAndApprove(project),
        ),
        loading: () => const AppLoadingState(message: 'Loading book plan'),
        error: (error, stackTrace) => AppErrorState(
          title: 'Plan unavailable',
          message: userFacingError(error),
          onRetry: () =>
              ref.invalidate(projectDetailProvider(widget.projectId)),
        ),
      ),
    );
  }

  Future<void> _runPlanAction({
    required String action,
    required Future<MobilePlanOperation> Function() future,
    bool clearRevisionText = false,
  }) async {
    setState(() => _busyAction = action);
    try {
      final operation = await future();
      if (!mounted) {
        return;
      }
      setState(() {
        _lastOperation = operation;
        _busyAction = null;
        if (clearRevisionText) {
          _revisionController.clear();
        }
      });
      _startRefreshPoll();
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(widget.projectId));
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(operation.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _confirmAndApprove(MobileProjectDetail project) async {
    final plan = project.plan;
    if (plan == null) {
      return;
    }

    late final MobileBilling billing;
    try {
      billing = await ref.read(billingProvider.future);
    } catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
      return;
    }

    final estimate = estimateApprovalCredits(project, billing.creditCosts);
    final hasProjectUnlock = billing.entitlements.any(
      (entitlement) =>
          entitlement.type == 'EXPORT_UNLOCK' &&
          entitlement.projectId == project.id,
    );
    if (!mounted) {
      return;
    }
    if (billing.credits.available < estimate) {
      await showBillingPaywall(
        context,
        projectId: project.id,
        title: 'Credits needed',
        message:
            'This ${project.lengthPresetLabel.toLowerCase()} ${project.bookTypeLabel.toLowerCase()} needs about $estimate credits to write, prepare visuals, and unlock export. You have ${billing.credits.available}.',
      );
      ref.invalidate(billingProvider);
      if (!mounted) {
        return;
      }
      return;
    }
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Approve this plan?'),
        content: Text(
          hasProjectUnlock
              ? 'This project already has an export unlock. Starting the full book can still spend writing credits.'
              : 'Estimated package: $estimate credits. You have ${billing.credits.available} available.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Approve'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) {
      return;
    }

    setState(() => _busyAction = 'approve');
    try {
      final operation = await ref
          .read(projectsRepositoryProvider)
          .approvePlan(plan.id);
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      ref.invalidate(projectDetailProvider(widget.projectId));
      if (!mounted) {
        return;
      }
      context.push(
        '/projects/${project.id}/handoff',
        extra: operation.currentAction,
      );
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _confirmAndDelete(MobileProjectDetail project) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this project?'),
        content: Text(
          'This removes "${project.title}" and its generated files from your account. Some safety, billing, and support records may be retained.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete project'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }

    setState(() => _busyAction = 'delete');
    try {
      await ref.read(projectsRepositoryProvider).deleteProject(project.id);
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(project.id));
      if (!mounted) {
        return;
      }
      context.go('/home');
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Deleted ${project.title}.')));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  void _startRefreshPoll() {
    _refreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      if (ref.read(projectDetailProvider(widget.projectId)).isLoading) {
        return;
      }
      ref.invalidate(projectDetailProvider(widget.projectId));
    });
  }

  void _stopPollingWhenProjectSettled(MobileProjectDetail project) {
    if (_refreshTimer == null || project.status == 'planning') {
      return;
    }
    _refreshTimer?.cancel();
    _refreshTimer = null;
  }
}

class _ProjectDetailBody extends StatelessWidget {
  const _ProjectDetailBody({
    required this.project,
    required this.revisionController,
    required this.onGeneratePlan,
    required this.onRevisePlan,
    required this.onRefresh,
    required this.onDeleteProject,
    required this.busyAction,
    required this.lastOperation,
    this.billing,
    this.onApprovePlan,
  });

  final MobileProjectDetail project;
  final MobileBilling? billing;
  final TextEditingController revisionController;
  final Future<void> Function() onGeneratePlan;
  final Future<void> Function(String message) onRevisePlan;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onDeleteProject;
  final Future<void> Function()? onApprovePlan;
  final String? busyAction;
  final MobilePlanOperation? lastOperation;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
        children: [
          _ProjectHeader(
            project: project,
            isDeleting: busyAction == 'delete',
            onDeleteProject: onDeleteProject,
          ),
          const SizedBox(height: 16),
          if (lastOperation != null) ...[
            _OperationBanner(operation: lastOperation!),
            const SizedBox(height: 16),
          ],
          if (project.plan == null)
            _NoPlanCard(
              project: project,
              busyAction: busyAction,
              onGeneratePlan: onGeneratePlan,
            )
          else
            ProjectPlanReview(
              project: project,
              plan: project.plan!,
              billing: billing,
              revisionController: revisionController,
              busyAction: busyAction,
              onQuestionAnswers: onRevisePlan,
              onRevisionRequest: onRevisePlan,
              onApprovePlan: onApprovePlan,
            ),
        ],
      ),
    );
  }
}

class ProjectPlanReview extends StatelessWidget {
  const ProjectPlanReview({
    required this.project,
    required this.plan,
    required this.revisionController,
    required this.onQuestionAnswers,
    required this.onRevisionRequest,
    required this.busyAction,
    this.billing,
    this.onApprovePlan,
    super.key,
  });

  final MobileProjectDetail project;
  final MobilePlan plan;
  final MobileBilling? billing;
  final TextEditingController revisionController;
  final Future<void> Function(String message) onQuestionAnswers;
  final Future<void> Function(String message) onRevisionRequest;
  final Future<void> Function()? onApprovePlan;
  final String? busyAction;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final estimate = billing == null
        ? null
        : estimateApprovalCredits(project, billing!.creditCosts);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          plan.title,
          style: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (plan.subtitle != null) ...[
          const SizedBox(height: 4),
          Text(
            plan.subtitle!,
            style: Theme.of(
              context,
            ).textTheme.bodyLarge?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _InfoChip(label: 'Version', value: '${plan.version}'),
            _InfoChip(label: 'Length', value: '${project.targetPages} pages'),
            _InfoChip(
              label: 'Visuals',
              value: project.imagesEnabled ? 'Included' : 'Text-first',
            ),
          ],
        ),
        const SizedBox(height: 16),
        _PlanSectionCard(
          title: 'Premise',
          icon: Icons.lightbulb_outline,
          child: Text(plan.premise),
        ),
        const SizedBox(height: 12),
        _PlanSectionCard(
          title: 'Audience',
          icon: Icons.groups_outlined,
          child: Text(plan.audience),
        ),
        const SizedBox(height: 12),
        _PlanSectionCard(
          title: 'Chapters',
          icon: Icons.format_list_numbered,
          child: Column(
            children: [
              for (final chapter in plan.chapters) ...[
                _ChapterTile(chapter: chapter),
                if (chapter != plan.chapters.last) const Divider(height: 18),
              ],
            ],
          ),
        ),
        if (!plan.isApproved) ...[
          const SizedBox(height: 12),
          PlanQuestionsCard(
            plan: plan,
            isBusy: busyAction == 'revise',
            onSubmitAnswers: onQuestionAnswers,
          ),
          const SizedBox(height: 12),
          _RevisionRequestCard(
            controller: revisionController,
            isBusy: busyAction == 'revise',
            onSubmit: onRevisionRequest,
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Ready to write',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    estimate == null
                        ? 'Approve when this plan matches the book you want.'
                        : 'Estimated package: $estimate credits · Available: ${billing!.credits.available}',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: busyAction == null && onApprovePlan != null
                        ? () => onApprovePlan!()
                        : null,
                    icon: busyAction == 'approve'
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.check_circle_outline),
                    label: const Text('Approve and start writing'),
                  ),
                ],
              ),
            ),
          ),
        ] else ...[
          const SizedBox(height: 12),
          _OperationBanner(
            operation: MobilePlanOperation(
              projectId: project.id,
              planId: plan.id,
              status: 'generation_queued',
              currentAction: 'This plan is approved.',
              job: const MobileQueuedJob(
                id: 'approved',
                status: 'completed',
                currentAction: 'This plan is approved.',
              ),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: () => context.push('/projects/${project.id}/handoff'),
            icon: const Icon(Icons.auto_stories_outlined),
            label: const Text('View generation progress'),
          ),
        ],
      ],
    );
  }
}

class PlanQuestionsCard extends StatefulWidget {
  const PlanQuestionsCard({
    required this.plan,
    required this.onSubmitAnswers,
    this.isBusy = false,
    super.key,
  });

  final MobilePlan plan;
  final Future<void> Function(String message) onSubmitAnswers;
  final bool isBusy;

  @override
  State<PlanQuestionsCard> createState() => _PlanQuestionsCardState();
}

class _PlanQuestionsCardState extends State<PlanQuestionsCard> {
  final _customController = TextEditingController();
  final Map<int, String> _answers = {};
  var _index = 0;

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final questions = widget.plan.questions;
    if (questions.isEmpty) {
      return const _PlanSectionCard(
        title: 'Questions',
        icon: Icons.help_outline,
        child: Text('No open questions for this plan.'),
      );
    }

    final question = questions[_index];
    final currentAnswer = _answers[_index];
    return _PlanSectionCard(
      title: 'Questions',
      icon: Icons.help_outline,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Question ${_index + 1} of ${questions.length}',
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 8),
          Text(
            question.prompt,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          if (question.options.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final option in question.options)
                  FilterChip(
                    label: Text(option),
                    selected: currentAnswer == option,
                    onSelected: widget.isBusy
                        ? null
                        : (_) => setState(() {
                            _answers[_index] = option;
                            _customController.clear();
                          }),
                  ),
              ],
            ),
          ],
          if (question.allowCustom) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _customController,
              enabled: !widget.isBusy,
              decoration: const InputDecoration(
                labelText: 'Custom answer',
                hintText: 'Type your own answer',
              ),
              minLines: 2,
              maxLines: 4,
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton(
                onPressed: _index == 0 || widget.isBusy
                    ? null
                    : () => _goToQuestion(_index - 1),
                child: const Text('Previous'),
              ),
              OutlinedButton(
                onPressed: widget.isBusy
                    ? null
                    : () {
                        _answers[_index] = 'No preference.';
                        _goToNextOrStay();
                      },
                child: const Text('Skip'),
              ),
              FilledButton(
                onPressed: widget.isBusy ? null : _saveAndGoNext,
                child: Text(
                  _index == questions.length - 1 ? 'Save answer' : 'Next',
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: widget.isBusy || _answers.isEmpty
                ? null
                : () => widget.onSubmitAnswers(_answersMessage()),
            icon: widget.isBusy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.auto_fix_high_outlined),
            label: const Text('Revise with answers'),
          ),
        ],
      ),
    );
  }

  void _saveAndGoNext() {
    final custom = _customController.text.trim();
    if (custom.isNotEmpty) {
      _answers[_index] = custom;
    }
    _goToNextOrStay();
  }

  void _goToNextOrStay() {
    if (_index < widget.plan.questions.length - 1) {
      _goToQuestion(_index + 1);
    } else {
      setState(() {});
    }
  }

  void _goToQuestion(int index) {
    setState(() {
      _index = index;
      final answer = _answers[index];
      final options = widget.plan.questions[index].options;
      _customController.text =
          answer != null &&
              !options.contains(answer) &&
              answer != 'No preference.'
          ? answer
          : '';
    });
  }

  String _answersMessage() {
    final lines = <String>[
      'Please revise the plan using these planning answers:',
    ];
    for (var i = 0; i < widget.plan.questions.length; i += 1) {
      final answer = _answers[i];
      if (answer == null) {
        continue;
      }
      lines.add('- ${widget.plan.questions[i].prompt} Answer: $answer');
    }
    return lines.join('\n');
  }
}

class _ProjectHeader extends StatelessWidget {
  const _ProjectHeader({
    required this.project,
    required this.onDeleteProject,
    this.isDeleting = false,
  });

  final MobileProjectDetail project;
  final bool isDeleting;
  final Future<void> Function() onDeleteProject;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              project.title,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              project.prompt,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _InfoChip(label: 'Type', value: project.bookTypeLabel),
                _InfoChip(label: 'Length', value: project.lengthPresetLabel),
                _InfoChip(label: 'Finish', value: project.qualityPresetLabel),
              ],
            ),
            const SizedBox(height: 12),
            ProjectPrivacyActions(
              isDeleting: isDeleting,
              onDeleteProject: onDeleteProject,
            ),
          ],
        ),
      ),
    );
  }
}

class ProjectPrivacyActions extends StatelessWidget {
  const ProjectPrivacyActions({
    required this.onDeleteProject,
    this.isDeleting = false,
    super.key,
  });

  final bool isDeleting;
  final Future<void> Function() onDeleteProject;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton.icon(
        onPressed: isDeleting ? null : () => onDeleteProject(),
        icon: isDeleting
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.delete_outline),
        label: const Text('Delete project'),
      ),
    );
  }
}

class _NoPlanCard extends StatelessWidget {
  const _NoPlanCard({
    required this.project,
    required this.busyAction,
    required this.onGeneratePlan,
  });

  final MobileProjectDetail project;
  final String? busyAction;
  final Future<void> Function() onGeneratePlan;

  @override
  Widget build(BuildContext context) {
    final isPlanning = project.status == 'planning' || busyAction == 'plan';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isPlanning ? 'Creating your book plan' : 'Ready for a plan',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(project.currentAction),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: isPlanning ? null : () => onGeneratePlan(),
              icon: isPlanning
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.auto_awesome_outlined),
              label: Text(isPlanning ? 'Plan requested' : 'Create book plan'),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanSectionCard extends StatelessWidget {
  const _PlanSectionCard({
    required this.title,
    required this.icon,
    required this.child,
  });

  final String title;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _ChapterTile extends StatelessWidget {
  const _ChapterTile({required this.chapter});

  final MobilePlanChapter chapter;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: colors.secondaryContainer,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            '${chapter.index}',
            style: TextStyle(
              color: colors.onSecondaryContainer,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                chapter.title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(chapter.summary),
              const SizedBox(height: 4),
              Text(
                '${chapter.targetPages} pages',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _RevisionRequestCard extends StatelessWidget {
  const _RevisionRequestCard({
    required this.controller,
    required this.isBusy,
    required this.onSubmit,
  });

  final TextEditingController controller;
  final bool isBusy;
  final Future<void> Function(String message) onSubmit;

  @override
  Widget build(BuildContext context) {
    return _PlanSectionCard(
      title: 'Request a revision',
      icon: Icons.edit_note_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: controller,
            enabled: !isBusy,
            decoration: const InputDecoration(
              labelText: 'What should change?',
              hintText:
                  'Example: Make it more practical for first-time coaches.',
            ),
            minLines: 3,
            maxLines: 6,
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: isBusy
                ? null
                : () {
                    final message = controller.text.trim();
                    if (message.isNotEmpty) {
                      onSubmit(message);
                    }
                  },
            icon: isBusy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send_outlined),
            label: const Text('Send revision'),
          ),
        ],
      ),
    );
  }
}

class _OperationBanner extends StatelessWidget {
  const _OperationBanner({required this.operation});

  final MobilePlanOperation operation;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.tertiaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Icon(Icons.schedule_outlined, color: colors.onTertiaryContainer),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                operation.currentAction,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: colors.onTertiaryContainer,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoChip extends StatelessWidget {
  const _InfoChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        '$label: $value',
        style: Theme.of(context).textTheme.labelMedium,
      ),
    );
  }
}
