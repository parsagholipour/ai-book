import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'plan_approval.dart';
import 'plan_revision_retry.dart';
import 'project_route_error.dart';

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
  String? _revisionRequestId;
  String? _revisionRequestText;

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
    final chatValue = ref.watch(projectChatProvider(widget.projectId));
    MobileBookEditOperation? failedRevision;
    for (final operation in chatValue.asData?.value.operations ?? const []) {
      if (operation.isPlanRevision && operation.isFailed) {
        failedRevision = operation;
        break;
      }
    }
    projectValue.whenData(_stopPollingWhenProjectSettled);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book plan'),
        actions: [
          IconButton(
            tooltip: 'Book chat',
            onPressed: () => context.push('/projects/${widget.projectId}/chat'),
            icon: const Icon(Icons.chat_bubble_outline),
          ),
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
          failedRevision: failedRevision,
          onRetryRevision: failedRevision == null
              ? null
              : () => _retryRevision(failedRevision!),
          onEditFailedRequest: failedRevision?.submittedText == null
              ? null
              : () => _restoreFailedRevision(failedRevision!),
          onRefresh: () async =>
              ref.invalidate(projectDetailProvider(widget.projectId)),
          onDeleteProject: () => _confirmAndDelete(project),
          onGeneratePlan: () => _runPlanAction(
            action: 'plan',
            future: () =>
                ref.read(projectsRepositoryProvider).generatePlan(project.id),
          ),
          onRevisePlan: (message) => _revisePlan(project, message),
          onApprovePlan: project.plan == null
              ? null
              : () => _confirmAndApprove(project),
        ),
        loading: () => const AppLoadingState(message: 'Loading book plan'),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Plan unavailable',
          onRetry: () =>
              ref.invalidate(projectDetailProvider(widget.projectId)),
          onGoHome: () => context.go('/home'),
        ),
      ),
    );
  }

  void _restoreFailedRevision(MobileBookEditOperation operation) {
    final text = operation.submittedText?.trim();
    if (text == null || text.isEmpty) return;
    setState(() {
      _revisionController.text = text;
      _revisionController.selection = TextSelection.collapsed(
        offset: text.length,
      );
    });
  }

  Future<void> _retryRevision(MobileBookEditOperation operation) async {
    if (operation.isAutomaticRetryPending) {
      _startRefreshPoll();
      return;
    }
    if (!operation.retryAvailable) {
      _restoreFailedRevision(operation);
      return;
    }
    await _runPlanAction(
      action: 'retry-revision',
      future: () => ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: operation.projectId,
            operationId: operation.id,
            requestId: createPlanRevisionRetryRequestId(operation.id),
          )
          .then(
            (operation) => MobilePlanOperation(
              projectId: operation.projectId,
              planId: null,
              status: operation.status,
              currentAction: operation.displayAction,
              job:
                  operation.job ??
                  MobileQueuedJob(
                    id: operation.id,
                    status: operation.status,
                    currentAction: operation.displayAction,
                  ),
            ),
          ),
    );
    ref.invalidate(projectChatProvider(widget.projectId));
  }

  Future<void> _revisePlan(MobileProjectDetail project, String message) async {
    final trimmed = message.trim();
    if (_revisionRequestText != trimmed) {
      _revisionRequestText = trimmed;
      _revisionRequestId = 'revision-${DateTime.now().microsecondsSinceEpoch}';
    }
    await _runPlanAction(
      action: 'revise',
      future: () => ref
          .read(projectsRepositoryProvider)
          .revisePlan(
            planId: project.plan!.id,
            message: trimmed,
            requestId: _revisionRequestId,
          ),
      clearRevisionText: true,
      onSuccess: () {
        _revisionRequestText = null;
        _revisionRequestId = null;
      },
    );
  }

  Future<void> _runPlanAction({
    required String action,
    required Future<MobilePlanOperation> Function() future,
    bool clearRevisionText = false,
    VoidCallback? onSuccess,
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
      onSuccess?.call();
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
    final operation = await confirmAndApprovePlan(
      context,
      ref,
      project,
      onStart: () {
        if (mounted) {
          setState(() => _busyAction = 'approve');
        }
      },
      onSettled: () {
        if (mounted && _busyAction == 'approve') {
          setState(() => _busyAction = null);
        }
      },
    );
    if (operation == null || !mounted) {
      return;
    }
    context.push(
      '/projects/${project.id}/handoff',
      extra: operation.currentAction,
    );
  }

  Future<void> _confirmAndDelete(MobileProjectDetail project) async {
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete this project?',
      message:
          'This removes "${project.title}" and its generated files from your account. Some safety, billing, and support records may be retained.',
      confirmLabel: 'Delete project',
      destructive: true,
    );
    if (!confirmed || !mounted) {
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
    required this.failedRevision,
    this.onRetryRevision,
    this.onEditFailedRequest,
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
  final MobileBookEditOperation? failedRevision;
  final Future<void> Function()? onRetryRevision;
  final VoidCallback? onEditFailedRequest;

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
          if (failedRevision != null) ...[
            _FailedRevisionBanner(
              operation: failedRevision!,
              busy: busyAction == 'retry-revision',
              onRetry: onRetryRevision,
              onEditRequest: onEditFailedRequest,
            ),
            const SizedBox(height: 16),
          ],
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
            AppMetricChip(label: 'Version', value: '${plan.version}'),
            AppMetricChip(
              label: 'Length',
              value: '${project.targetPages} pages',
            ),
            AppMetricChip(
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
          AppPrimaryActionPanel(
            title: 'Ready to write',
            message: estimate == null
                ? 'Approve when this plan matches the book you want.'
                : 'Estimated package: $estimate credits. Available: ${billing!.credits.available}',
            icon: Icons.check_circle_outline,
            actionLabel: 'Approve and start writing',
            onAction: busyAction == null && onApprovePlan != null
                ? () => onApprovePlan!()
                : null,
            actionIcon: busyAction == 'approve'
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      semanticsLabel: 'Approving plan',
                    ),
                  )
                : const Icon(Icons.check_circle_outline),
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
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      semanticsLabel: 'Revising plan',
                    ),
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
            // The book leads its own page: cover beside title, the way it
            // would sit on a shelf.
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                BookCover(
                  title: project.title,
                  seed: project.id,
                  image: project.coverImage,
                  authorName: project.authorName,
                  width: 76,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        project.title,
                        key: const ValueKey('project-header-title'),
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      if (project.authorName?.trim().isNotEmpty == true) ...[
                        const SizedBox(height: 4),
                        Text(
                          'by ${project.authorName!.trim()}',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Text(
                        project.prompt,
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                AppMetricChip(label: 'Type', value: project.bookTypeLabel),
                AppMetricChip(
                  label: 'Length',
                  value: project.lengthPresetLabel,
                ),
                AppMetricChip(
                  label: 'Finish',
                  value: project.qualityPresetLabel,
                ),
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
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  semanticsLabel: 'Deleting project',
                ),
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
    return AppPrimaryActionPanel(
      title: isPlanning ? 'Creating your book plan' : 'Ready for a plan',
      message: project.currentAction,
      icon: Icons.auto_awesome_outlined,
      actionLabel: isPlanning ? 'Plan requested' : 'Create book plan',
      onAction: isPlanning ? null : () => onGeneratePlan(),
      actionIcon: isPlanning
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Creating book plan',
              ),
            )
          : const Icon(Icons.auto_awesome_outlined),
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
            AppSectionHeader(
              title: title,
              icon: icon,
              titleStyle: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
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
            borderRadius: BorderRadius.circular(10),
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
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      semanticsLabel: 'Sending revision',
                    ),
                  )
                : const Icon(Icons.send_outlined),
            label: const Text('Send revision'),
          ),
        ],
      ),
    );
  }
}

class _FailedRevisionBanner extends StatelessWidget {
  const _FailedRevisionBanner({
    required this.operation,
    required this.busy,
    this.onRetry,
    this.onEditRequest,
  });

  final MobileBookEditOperation operation;
  final bool busy;
  final Future<void> Function()? onRetry;
  final VoidCallback? onEditRequest;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Plan revision failed',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            const Text('Your current plan is unchanged.'),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (operation.retryAvailable && onRetry != null)
                  FilledButton.tonalIcon(
                    onPressed: busy ? null : () => onRetry!(),
                    icon: busy
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                    label: const Text('Retry revision'),
                  ),
                OutlinedButton.icon(
                  onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Your current plan is shown below.'),
                    ),
                  ),
                  icon: const Icon(Icons.article_outlined),
                  label: const Text('View current plan'),
                ),
                if (onEditRequest != null)
                  TextButton.icon(
                    onPressed: onEditRequest,
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Edit request'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _OperationBanner extends StatelessWidget {
  const _OperationBanner({required this.operation});

  final MobilePlanOperation operation;

  @override
  Widget build(BuildContext context) {
    return AppInlineNotice(
      icon: Icons.schedule_outlined,
      title: 'Book update',
      message: operation.currentAction,
      tone: AppNoticeTone.info,
    );
  }
}
