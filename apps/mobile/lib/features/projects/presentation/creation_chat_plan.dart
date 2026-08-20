part of 'creation_chat_screen.dart';

// Plan preview bubbles shown once a book plan exists. The generation-progress
// bubble lives in creation_chat_generation.dart; imports and shared state live
// in the parent library file.

class _PlanBubble extends StatefulWidget {
  const _PlanBubble.live({
    super.key,
    required this.planValue,
    this.statusValue,
    this.busyAction,
  }) : plan = null;

  const _PlanBubble.snapshot({super.key, required this.plan})
    : planValue = null,
      statusValue = null,
      busyAction = null;

  final AsyncValue<MobileProjectDetail>? planValue;
  final AsyncValue<MobileProjectStatus>? statusValue;
  final MobilePlan? plan;
  final String? busyAction;

  @override
  State<_PlanBubble> createState() => _PlanBubbleState();
}

class _PlanBubbleState extends State<_PlanBubble> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.plan;
    if (snapshot != null) {
      if (snapshot.isApproved) {
        return _buildCompactApprovedPlanCard(context, snapshot);
      }
      return _buildPlanCard(
        context,
        snapshot,
        label: _planSnapshotLabel(snapshot),
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
          return _buildCompactApprovedPlanCard(context, plan);
        }
        return _buildPlanCard(context, plan);
      },
    );
  }

  Widget _buildFailureBubble(BuildContext context, String message) {
    return Align(
      alignment: Alignment.centerLeft,
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

  Widget _buildSpinnerBubble(
    BuildContext context,
    String label, {
    String semanticsLabel = 'Building plan',
  }) {
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
                semanticsLabel: semanticsLabel,
              ),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                label,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCompactApprovedPlanCard(BuildContext context, MobilePlan plan) {
    final colors = Theme.of(context).colorScheme;
    final chapterLabel = plan.chapters.length == 1
        ? '1 chapter'
        : '${plan.chapters.length} chapters';
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Card(
          margin: const EdgeInsets.symmetric(vertical: 8),
          color: colors.surfaceContainerHighest,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () => context.push('/projects/${plan.projectId}'),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.task_alt_outlined, color: colors.primary),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Book plan approved',
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          plan.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            AppStatusBadge(
                              label: chapterLabel,
                              icon: Icons.format_list_numbered,
                              tone: AppTone.success,
                            ),
                            Text(
                              'Tap to open your book',
                              style: Theme.of(context).textTheme.labelSmall
                                  ?.copyWith(color: colors.primary),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    Icons.open_in_new_outlined,
                    size: 18,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPlanCard(
    BuildContext context,
    MobilePlan plan, {
    String label = 'Book plan ready',
  }) {
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
                  Icon(
                    Icons.auto_stories_outlined,
                    color: colors.primary,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          plan.title,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  AppStatusBadge(
                    label: '${plan.chapters.length} ch.',
                    icon: Icons.format_list_numbered,
                    tone: AppTone.success,
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
              child: _PlanDetails(plan: plan),
            ),
          ],
        ],
      ),
    );
  }
}

class _PlanDetails extends StatelessWidget {
  const _PlanDetails({required this.plan});

  final MobilePlan plan;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
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
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 8),
        for (final chapter in plan.chapters) ...[
          _ChapterRow(chapter: chapter),
          if (chapter != plan.chapters.last) const SizedBox(height: 6),
        ],
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
              if (chapter.title.trim().isNotEmpty)
                Text(
                  chapter.title,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
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
