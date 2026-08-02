import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../domain/project_models.dart';

// The plan, in the two shapes the book page needs it: the full review a reader
// approves from, and the collapsed summary it becomes once they have.

/// The plan while it is still the reader's decision.
///
/// Everything here is an answer to "is this the book you wanted?" — the shape
/// of it, the open questions, a way to ask for changes, and the approval that
/// starts the writing. Once approved this is replaced by [PlanSummaryCard]:
/// the page moves on to what is happening now.
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
        PlanSectionCard(
          title: 'Premise',
          icon: Icons.lightbulb_outline,
          child: Text(plan.premise),
        ),
        const SizedBox(height: 12),
        PlanSectionCard(
          title: 'Audience',
          icon: Icons.groups_outlined,
          child: Text(plan.audience),
        ),
        const SizedBox(height: 12),
        PlanSectionCard(
          title: 'Chapters',
          icon: Icons.format_list_numbered,
          child: PlanChapterList(chapters: plan.chapters),
        ),
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
      ],
    );
  }
}

/// The plan once it has been approved: still there, no longer the point.
///
/// Approving used to hand the reader to another screen and leave this one
/// showing a plan they could not change. Collapsed to a line that opens on
/// demand, it stops competing with the writing for the top of the page.
class PlanSummaryCard extends StatelessWidget {
  const PlanSummaryCard({required this.plan, super.key});

  final MobilePlan plan;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final pages = plan.chapters.fold<int>(
      0,
      (total, chapter) => total + chapter.targetPages,
    );
    final chapterCount = plan.chapters.length;
    final summary = [
      chapterCount == 1 ? '1 chapter' : '$chapterCount chapters',
      if (pages > 0) '$pages pages',
      'Version ${plan.version}',
    ].join(' · ');

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Theme(
        // The tile draws its own hairlines above and below when open, which
        // read as a second card edge inside this one.
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          leading: Icon(Icons.list_alt_outlined, color: colors.primary),
          title: Text(
            'Book plan',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(
            summary,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          tilePadding: const EdgeInsets.symmetric(horizontal: 16),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              plan.premise,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 6),
            Text(
              'For ${plan.audience}',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            const Divider(height: 24),
            PlanChapterList(chapters: plan.chapters),
          ],
        ),
      ),
    );
  }
}

/// Prompt for a plan that does not exist yet.
class NoPlanCard extends StatelessWidget {
  const NoPlanCard({
    required this.project,
    required this.busyAction,
    required this.onGeneratePlan,
    super.key,
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

/// A failed plan revision, with the ways back from it.
class PlanRevisionFailedBanner extends StatelessWidget {
  const PlanRevisionFailedBanner({
    required this.operation,
    required this.busy,
    this.onRetry,
    this.onEditRequest,
    super.key,
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
      return const PlanSectionCard(
        title: 'Questions',
        icon: Icons.help_outline,
        child: Text('No open questions for this plan.'),
      );
    }

    final question = questions[_index];
    final currentAnswer = _answers[_index];
    return PlanSectionCard(
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

class PlanSectionCard extends StatelessWidget {
  const PlanSectionCard({
    required this.title,
    required this.icon,
    required this.child,
    super.key,
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

class PlanChapterList extends StatelessWidget {
  const PlanChapterList({required this.chapters, super.key});

  final List<MobilePlanChapter> chapters;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final chapter in chapters) ...[
          _ChapterTile(chapter: chapter),
          if (chapter != chapters.last) const Divider(height: 18),
        ],
      ],
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
    return PlanSectionCard(
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
