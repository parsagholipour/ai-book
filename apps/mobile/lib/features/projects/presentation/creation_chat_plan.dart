part of 'creation_chat_screen.dart';

// Plan preview and generation-progress bubbles shown once a book is being built.
// Imports and shared state live in the parent library file.

class _PlanWithGenerationProgress extends StatelessWidget {
  const _PlanWithGenerationProgress({
    required this.child,
    required this.showGeneration,
    this.statusValue,
    this.projectId,
  });

  final Widget child;
  final bool showGeneration;
  final AsyncValue<MobileProjectStatus>? statusValue;
  final String? projectId;

  @override
  Widget build(BuildContext context) {
    final status = statusValue;
    final id = projectId;
    if (!showGeneration || status == null || id == null) {
      return child;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        child,
        _GenerationProgressBubble(projectId: id, statusValue: status),
      ],
    );
  }
}

class _GenerationProgressBubble extends ConsumerStatefulWidget {
  const _GenerationProgressBubble({
    required this.projectId,
    required this.statusValue,
  });

  final String projectId;
  final AsyncValue<MobileProjectStatus> statusValue;

  @override
  ConsumerState<_GenerationProgressBubble> createState() =>
      _GenerationProgressBubbleState();
}

class _GenerationProgressBubbleState
    extends ConsumerState<_GenerationProgressBubble> {
  String? _busyAction;

  Future<void> _downloadExport(MobileExportAvailability export) async {
    if (_busyAction != null) {
      return;
    }
    setState(() => _busyAction = projectExportDownloadAction(export));
    await openProjectExport(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refreshExportState,
    );
    if (!mounted) {
      return;
    }
    setState(() => _busyAction = null);
  }

  void _refreshExportState() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  @override
  Widget build(BuildContext context) {
    return widget.statusValue.when(
      loading: () => _GenerationProgressShell(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Theme.of(context).colorScheme.primary,
                semanticsLabel: 'Checking writing progress',
              ),
            ),
            const SizedBox(width: 10),
            const Flexible(child: Text('Checking writing progress…')),
          ],
        ),
      ),
      error: (_, _) => _GenerationProgressShell(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Progress is unavailable right now.'),
            const SizedBox(height: 8),
            _ViewProgressButton(projectId: widget.projectId),
          ],
        ),
      ),
      data: (status) {
        final colors = Theme.of(context).colorScheme;
        final progress = status.progressPercent.clamp(0, 100).toInt();
        final failureMessage = status.failureMessage?.trim();
        final isFailed = status.status == 'failed' || status.hasFailure;
        final reviewRequired = status.requiresReview;
        final downloadExport = status.isComplete && !reviewRequired
            ? primaryUnlockedAvailableExport(status.exports)
            : null;
        final title = reviewRequired
            ? 'Review required before export'
            : status.isComplete
            ? 'Ready to export'
            : isFailed
            ? 'Needs attention'
            : status.statusLabel;
        final detail =
            isFailed && failureMessage != null && failureMessage.isNotEmpty
            ? failureMessage
            : reviewRequired && status.quality.issues.isNotEmpty
            ? status.quality.issues.first.message
            : status.currentAction;
        return _GenerationProgressShell(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    isFailed || reviewRequired
                        ? Icons.error_outline
                        : status.isComplete
                        ? Icons.check_circle_outline
                        : Icons.auto_awesome_outlined,
                    color: isFailed || reviewRequired
                        ? colors.error
                        : colors.primary,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                detail,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Semantics(
                      label: 'Book generation progress',
                      value: '$progress percent complete',
                      child: ExcludeSemantics(
                        child: LinearProgressIndicator(value: progress / 100),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    '$progress%',
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppMetricChip(
                    icon: Icons.menu_book_outlined,
                    label:
                        '${status.pageProgress.completed}/${status.pageProgress.target} pages',
                  ),
                  AppMetricChip(
                    icon: Icons.image_outlined,
                    label: status.imageCount == 1
                        ? '1 visual'
                        : '${status.imageCount} visuals',
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (status.exports.pdf.available)
                    _ReadBookButton(projectId: widget.projectId),
                  if (downloadExport != null)
                    _CompletionDownloadButton(
                      export: downloadExport,
                      busyAction: _busyAction,
                      onDownload: _downloadExport,
                    ),
                  if (status.isComplete)
                    _EditBookButton(projectId: widget.projectId),
                  if (reviewRequired &&
                      status.quality.affectedPageIndexes.isNotEmpty)
                    OutlinedButton.icon(
                      onPressed: () => context.push(
                        '/projects/${widget.projectId}/edit?pageIndex=${status.quality.affectedPageIndexes.first}',
                      ),
                      icon: const Icon(Icons.edit_note_outlined),
                      label: Text(
                        'Fix page ${status.quality.affectedPageIndexes.first}',
                      ),
                    ),
                  _ViewProgressButton(projectId: widget.projectId),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _GenerationProgressShell extends StatelessWidget {
  const _GenerationProgressShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: child,
        ),
      ),
    );
  }
}

class _CompletionDownloadButton extends StatelessWidget {
  const _CompletionDownloadButton({
    required this.export,
    required this.busyAction,
    required this.onDownload,
  });

  final MobileExportAvailability export;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onDownload;

  @override
  Widget build(BuildContext context) {
    final action = projectExportDownloadAction(export);
    final isDownloading = busyAction == action;
    return FilledButton.icon(
      onPressed: isDownloading ? null : () => onDownload(export),
      icon: isDownloading
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Downloading export',
              ),
            )
          : const Icon(Icons.open_in_new_outlined),
      label: Text(projectExportDownloadLabel(export, false)),
    );
  }
}

/// Opens the finished book in the in-app reader.
class _ReadBookButton extends StatelessWidget {
  const _ReadBookButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: () => context.push('/projects/$projectId/read'),
      icon: const Icon(Icons.auto_stories_outlined),
      label: const Text('Read book'),
    );
  }
}

class _ViewProgressButton extends StatelessWidget {
  const _ViewProgressButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: () => context.push('/projects/$projectId/handoff'),
      icon: const Icon(Icons.menu_book_outlined),
      label: const Text('View progress'),
    );
  }
}

/// Opens manual Edit Mode so the user can change the book text themselves.
class _EditBookButton extends StatelessWidget {
  const _EditBookButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: () => context.push('/projects/$projectId/edit'),
      icon: const Icon(Icons.edit_note_outlined),
      label: const Text('Edit book'),
    );
  }
}

class _PlanBubble extends StatefulWidget {
  const _PlanBubble.live({super.key, required this.planValue, this.busyAction})
    : plan = null;

  const _PlanBubble.snapshot({super.key, required this.plan})
    : planValue = null,
      busyAction = null;

  final AsyncValue<MobileProjectDetail>? planValue;
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
        if (project.status == 'planning') {
          return _buildSpinnerBubble(
            context,
            _planProgressLabel(project),
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
                              tone: AppNoticeTone.success,
                            ),
                            Text(
                              'Tap to open plan page',
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
