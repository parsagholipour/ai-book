part of 'creation_chat_screen.dart';

// The live book-generation progress bubble and the actions that appear
// beside it once the book is finished. Imports and shared state live in the
// parent library file.

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

  /// The highest percent this bubble has drawn.
  ///
  /// The server's number is monotonic by construction, but a reconnect can
  /// deliver a stale tick, and a bar that animates backwards reads as work
  /// being undone. Held outside setState because it is resolved during build.
  int _shownPercent = 0;

  @override
  void didUpdateWidget(_GenerationProgressBubble oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.projectId != widget.projectId) {
      _shownPercent = 0;
    }
  }

  int _monotonicPercent(int next) {
    if (next > _shownPercent) {
      _shownPercent = next;
    }
    return _shownPercent;
  }

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
      loading: () => const _GenerationProgressSkeleton(),
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
        // The step list's own number when there is one: it is what the bar
        // sits next to, and the two must never read differently.
        final progress = _monotonicPercent(
          (status.generationProgress?.percent ?? status.progressPercent)
              .clamp(0, 100)
              .toInt(),
        );
        final failureMessage = status.failureMessage?.trim();
        final isFailed = status.status == 'failed' || status.hasFailure;
        final reviewRequired = status.requiresReview;
        final isGenerating = status.status == 'generating';
        final downloadExport = status.isComplete && !reviewRequired
            ? primaryUnlockedAvailableExport(status.exports)
            : null;
        // An older API build sends no generationProgress, and an edit in
        // flight deliberately sends none: both fall through to the compact
        // bar-and-counters layout this bubble has always had.
        final rawSteps =
            status.generationProgress?.steps ??
            (isGenerating ? _fallbackGenerationSteps() : const []);
        final steps = imageAwareGenerationSteps(rawSteps, status);
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
            // Never a client-side guess over something the server said: the
            // fallback steps exist to shape the list, not to narrate.
            : status.generationProgress?.detail ?? status.currentAction;
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
                  const SizedBox(width: 12),
                  Text(
                    '$progress%',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      color: colors.primary,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TweenAnimationBuilder<double>(
                tween: Tween(end: progress / 100),
                duration: const Duration(milliseconds: 450),
                curve: Curves.easeOutCubic,
                builder: (context, animatedProgress, _) => Semantics(
                  label: 'Book generation progress',
                  value: '$progress percent complete',
                  child: ExcludeSemantics(
                    // Shell is surfaceContainerHighest; theme track matches it.
                    child: LinearProgressIndicator(
                      value: animatedProgress,
                      backgroundColor: colors.surface,
                    ),
                  ),
                ),
              ),
              if (steps.isNotEmpty) ...[
                const SizedBox(height: 12),
                for (final step in steps) ProgressStepRow(step: step),
              ],
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
              if (isGenerating) ...[
                const SizedBox(height: 10),
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
            ],
          ),
        );
      },
    );
  }
}

/// Milestones to show in the beat between approving a plan and the server's
/// first status tick, so the bubble never opens as an empty box.
List<MobileProjectStatusStep> _fallbackGenerationSteps() => const [
  MobileProjectStatusStep(
    key: 'prepare',
    label: 'Preparing your chapters',
    status: 'active',
  ),
  MobileProjectStatusStep(
    key: 'write',
    label: 'Writing your pages',
    status: 'pending',
  ),
  MobileProjectStatusStep(
    key: 'illustrate',
    label: 'Creating your book images',
    status: 'pending',
  ),
  MobileProjectStatusStep(
    key: 'finish',
    label: 'Building your book',
    status: 'pending',
  ),
];

/// The bubble's own shape, drawn while the first status is still in flight —
/// the layout is readable before the content arrives, which a spinner never is.
class _GenerationProgressSkeleton extends StatelessWidget {
  const _GenerationProgressSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget bar(double width, double height) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.onSurfaceVariant.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(height / 2),
      ),
    );

    return _GenerationProgressShell(
      child: Semantics(
        label: 'Checking writing progress…',
        child: ExcludeSemantics(
          child: AppShimmer(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                bar(160, 14),
                const SizedBox(height: 8),
                bar(210, 11),
                const SizedBox(height: 14),
                LinearProgressIndicator(backgroundColor: colors.surface),
                const SizedBox(height: 16),
                for (var row = 0; row < 3; row++) ...[
                  bar(140 + row * 18, 11),
                  if (row < 2) const SizedBox(height: 10),
                ],
              ],
            ),
          ),
        ),
      ),
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

/// Opens the book's own page — plan, progress and exports in one place.
class _ViewProgressButton extends StatelessWidget {
  const _ViewProgressButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: () => context.push('/projects/$projectId'),
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
