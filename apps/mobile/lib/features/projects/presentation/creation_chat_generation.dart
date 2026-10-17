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
    this.onRetryGeneration,
  });

  final Widget child;
  final bool showGeneration;
  final AsyncValue<MobileProjectStatus>? statusValue;
  final String? projectId;
  final Future<void> Function(String projectId)? onRetryGeneration;

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
        // The book is its own moment, not a footnote to the plan: give it
        // more room than the gap between two messages.
        const SizedBox(height: AppSpacing.md),
        _GenerationProgressBubble(
          projectId: id,
          statusValue: status,
          onRetryGeneration: onRetryGeneration,
        ),
      ],
    );
  }
}

class _GenerationProgressBubble extends ConsumerStatefulWidget {
  const _GenerationProgressBubble({
    required this.projectId,
    required this.statusValue,
    this.onRetryGeneration,
  });

  final String projectId;
  final AsyncValue<MobileProjectStatus> statusValue;

  /// Restarts a book whose writing failed. The bubble is where the failure is
  /// read, so it is also where the fix is offered — the same retry the book
  /// page has, without making anyone leave the chat to find it.
  final Future<void> Function(String projectId)? onRetryGeneration;

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

  Future<void> _retryGeneration() async {
    final onRetry = widget.onRetryGeneration;
    if (onRetry == null || _busyAction != null) {
      return;
    }
    setState(() => _busyAction = 'retry');
    try {
      await onRetry(widget.projectId);
    } catch (error) {
      // The retry reports its own failures; anything that still escapes it
      // is said here rather than left as a spinner that never stops.
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
      }
    } finally {
      if (mounted) setState(() => _busyAction = null);
    }
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
      data: _buildStatus,
    );
  }

  Widget _buildStatus(MobileProjectStatus status) {
    final colors = Theme.of(context).colorScheme;
    // The step list's own number when there is one: it is what the bar
    // sits next to, and the two must never read differently.
    final progress = _monotonicPercent(
      (status.generationProgress?.percent ??
              status.editProgress?.percent ??
              status.progressPercent)
          .clamp(0, 100)
          .toInt(),
    );
    final failureMessage = status.failureMessage?.trim();
    // A scheduled automatic retry is still the book being written: the
    // worker will pick it up on its own, so it is neither a failure to
    // announce nor something to offer a second, competing retry for.
    final waitingForRetry = status.isAutomaticRetryPending;
    final isFailed =
        !waitingForRetry && (status.status == 'failed' || status.hasFailure);
    final canRetry =
        isFailed && status.retryAvailable && widget.onRetryGeneration != null;
    final reviewRequired = status.requiresReview;
    final isGenerating = status.status == 'generating';
    // The bubble is alive — sparkle turning, sheen crossing the bar —
    // only while the server says the book is being worked on. A finished
    // book with a stale percent, a failed one, one waiting for a person or
    // for a scheduled retry: all of those hold still.
    final working =
        !isFailed &&
        !waitingForRetry &&
        !reviewRequired &&
        (isGenerating || status.status == 'editing');
    final downloadExport = status.isComplete && !reviewRequired
        ? primaryAvailableExport(status.exports)
        : null;
    // An older API build sends no generationProgress, and an edit in
    // flight deliberately sends none: both fall through to the compact
    // bar-and-counters layout this bubble has always had.
    final rawSteps =
        status.generationProgress?.steps ??
        status.editProgress?.steps ??
        (isGenerating ? _fallbackGenerationSteps() : const []);
    final steps = imageAwareGenerationSteps(rawSteps, status);

    if (status.isComplete && !isFailed && !waitingForRetry && !reviewRequired) {
      return _buildFinished(status, downloadExport);
    }

    final title = reviewRequired
        ? 'Review required before export'
        : status.isComplete
        ? 'Ready to export'
        : waitingForRetry
        ? 'Retry scheduled'
        : isFailed
        ? 'Needs attention'
        : status.statusLabel;
    final detail = waitingForRetry
        // `effectiveAction` prefers the server's own retry wording.
        ? status.effectiveAction
        : isFailed && failureMessage != null && failureMessage.isNotEmpty
        ? failureMessage
        : reviewRequired && status.quality.issues.isNotEmpty
        ? status.quality.issues.first.message
        // Never a client-side guess over something the server said: the
        // fallback steps exist to shape the list, not to narrate.
        : status.generationProgress?.detail ??
              status.editProgress?.detail ??
              status.currentAction;
    // The icon works while the book does. Once it has settled — failed,
    // or waiting on a person — it lands on a still glyph.
    final Widget icon = isFailed || reviewRequired
        ? Icon(
            Icons.error_outline,
            key: const ValueKey('generation-icon-attention'),
            color: reviewRequired
                ? AppSemanticColors.of(context).warning
                : colors.error,
            size: 20,
          )
        : waitingForRetry
        ? Icon(
            Icons.autorenew_outlined,
            key: const ValueKey('generation-icon-retry'),
            color: colors.primary,
            size: 20,
          )
        : working
        ? PlanBuildSparkle(
            key: const ValueKey('generation-icon-working'),
            color: colors.primary,
            size: 20,
          )
        : Icon(
            Icons.auto_awesome_outlined,
            key: const ValueKey('generation-icon-idle'),
            color: colors.primary,
            size: 20,
          );
    final quote = status.recoveryQuote;
    final readable = status.exports.pdf.available;
    final stopped = isFailed || reviewRequired;
    return _GenerationProgressShell(
      working: working,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AnimatedSwitcher(
                duration: AppMotion.medium,
                switchInCurve: AppMotion.emphasized,
                transitionBuilder: (child, animation) => ScaleTransition(
                  scale: animation,
                  child: FadeTransition(opacity: animation, child: child),
                ),
                child: icon,
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
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    const SizedBox(height: 2),
                    RisingStatusText(
                      text: detail,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              AppAnimatedCount(
                value: progress,
                builder: (value) => '$value%',
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: stopped ? colors.onSurfaceVariant : colors.primary,
                  fontWeight: FontWeight.w800,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          PlanBuildProgressBar(
            value: progress / 100,
            active: working,
            // Shell is surfaceContainerHighest; theme track matches it.
            trackColor: colors.surface,
            semanticLabel: 'Book generation progress',
          ),
          if (working &&
              isGenerating &&
              status.generationProgress?.estimatedSecondsLeft != null) ...[
            const SizedBox(height: 8),
            TimeLeftNote(
              secondsLeft: status.generationProgress?.estimatedSecondsLeft,
            ),
          ],
          if (steps.isNotEmpty) ...[
            const SizedBox(height: 10),
            _StageList(steps: steps),
          ],
          if (status.status != 'editing') ...[
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
          ],
          if (waitingForRetry) ...[
            const SizedBox(height: 12),
            _RetryHint(nextRetryAt: status.nextRetryAt),
          ],
          if (canRetry) ...[
            const SizedBox(height: 14),
            _RetryGenerationButton(
              busy: _busyAction == 'retry',
              onRetry: () => unawaited(_retryGeneration()),
            ),
            if (quote != null) ...[
              const SizedBox(height: 6),
              _RetryCostNote(credits: quote.credits),
            ],
          ],
          if (readable || downloadExport != null || reviewRequired) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (readable)
                  _ReadBookButton(
                    projectId: widget.projectId,
                    // The retry, when there is one, is the one thing to do.
                    subordinate: canRetry,
                  ),
                if (downloadExport != null)
                  _CompletionDownloadButton(
                    export: downloadExport,
                    busyAction: _busyAction,
                    onDownload: _downloadExport,
                    primary: !readable,
                  ),
                if (reviewRequired &&
                    status.quality.affectedPageIndexes.isNotEmpty)
                  AppButton.outlined(
                    onPressed: () => context.push(
                      '/projects/${widget.projectId}/edit?pageIndex=${status.quality.affectedPageIndexes.first}',
                    ),
                    leading: const Icon(Icons.edit_note_outlined),
                    label:
                        'Fix page ${status.quality.affectedPageIndexes.first}',
                  ),
              ],
            ),
          ],
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
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: _ViewProgressButton(projectId: widget.projectId),
          ),
        ],
      ),
    );
  }

  /// A finished book, collapsed: cover, name, one line of facts, one primary
  /// action, and "Behind the book" folded away beneath them.
  Widget _buildFinished(
    MobileProjectStatus status,
    MobileExportAvailability? downloadExport,
  ) {
    final project = ref.watch(projectDetailProvider(widget.projectId)).value;
    final readable = status.exports.pdf.available;
    final pages = project != null && project.pageCount > 0
        ? project.pageCount
        : status.pageProgress.completed;
    final projectTitle = project?.title.trim();
    return GenerationFinishedCard(
      projectId: widget.projectId,
      title: projectTitle == null || projectTitle.isEmpty
          ? 'Your book'
          : projectTitle,
      coverImage: project?.coverImage,
      facts: finishedBookFacts(
        pages: pages,
        images: status.imageCount,
        durationMs: status.bookGenerationDurationMs,
      ),
      onOpen: () => context.push('/projects/${widget.projectId}'),
      primaryAction: readable
          ? _ReadBookButton(projectId: widget.projectId, expanded: true)
          : downloadExport != null
          ? _CompletionDownloadButton(
              export: downloadExport,
              busyAction: _busyAction,
              onDownload: _downloadExport,
              primary: true,
              expanded: true,
            )
          : null,
      notice: readable || downloadExport != null
          ? null
          : 'Your book file is being prepared.',
      secondaryActions: [
        if (readable && downloadExport != null)
          _CompletionDownloadButton(
            export: downloadExport,
            busyAction: _busyAction,
            onDownload: _downloadExport,
          ),
        _EditBookButton(projectId: widget.projectId),
      ],
      footer: BehindTheBookSection(
        projectId: widget.projectId,
        planningMs: status.planningDurationMs,
        bookMs: status.bookGenerationDurationMs,
      ),
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
                PlanBuildProgressBar(value: null, trackColor: colors.surface),
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
  const _GenerationProgressShell({required this.child, this.working = false});

  final Widget child;

  /// A soft brand wash across the top while the server is at work. It goes with
  /// the sparkle: a card that is done or stopped is plain.
  final bool working;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: AnimatedContainer(
          duration: AppMotion.medium,
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            gradient: working
                ? LinearGradient(
                    begin: AlignmentDirectional.topStart,
                    end: AlignmentDirectional.bottomEnd,
                    colors: [
                      colors.primary.withValues(alpha: 0.10),
                      colors.primary.withValues(alpha: 0),
                    ],
                    stops: const [0, 0.55],
                  )
                : null,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: working
                  ? colors.primary.withValues(alpha: 0.28)
                  : colors.outlineVariant,
            ),
          ),
          // Rises in once, when the bubble first joins the transcript.
          child: AppEntrance(offset: 12, child: child),
        ),
      ),
    );
  }
}

/// The milestones of a run. A step that has landed is one quiet line with its
/// count beside it; the step that is moving carries its detail underneath, so
/// the list reads as "here is what is happening" rather than a checklist. The
/// list resizes smoothly as steps land instead of jumping.
class _StageList extends StatelessWidget {
  const _StageList({required this.steps});

  final List<MobileProjectStatusStep> steps;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
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
    );
  }
}

/// What a scheduled automatic retry means for the reader: nothing to do, and
/// roughly when. The time comes from the server's own `nextRetryAt`.
class _RetryHint extends StatefulWidget {
  const _RetryHint({required this.nextRetryAt});

  final DateTime? nextRetryAt;

  @override
  State<_RetryHint> createState() => _RetryHintState();
}

class _RetryHintState extends State<_RetryHint> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Coarse on purpose: "about 2 min" does not need a per-second repaint.
    _tick = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final timing = formatRetryCountdown(widget.nextRetryAt, DateTime.now());
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.schedule_outlined, size: 16, color: colors.onSurfaceVariant),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            '$timing You don’t need to do anything.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

/// What tapping Retry will cost, said before the tap. The number is the
/// server's own quote — the confirmation dialog repeats it with the balance.
class _RetryCostNote extends StatelessWidget {
  const _RetryCostNote({required this.credits});

  final int credits;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Text(
      credits <= 0
          ? 'This retry is free.'
          : 'A retry uses $credits credits, and they come back if it fails again.',
      style: Theme.of(
        context,
      ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
    );
  }
}

class _CompletionDownloadButton extends StatelessWidget {
  const _CompletionDownloadButton({
    required this.export,
    required this.busyAction,
    required this.onDownload,
    this.primary = false,
    this.expanded = false,
  });

  final MobileExportAvailability export;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onDownload;

  /// The one action of its card. Otherwise a download is a follow-up to
  /// reading, and is drawn outlined so it never competes with Read book.
  final bool primary;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final action = projectExportDownloadAction(export);
    final isDownloading = busyAction == action;
    final onPressed = isDownloading ? null : () => onDownload(export);
    const leading = Icon(Icons.open_in_new_outlined);
    final label = projectExportDownloadLabel(export);
    return primary
        ? AppButton.primary(
            onPressed: onPressed,
            loading: isDownloading,
            loadingLabel: 'Downloading export',
            leading: leading,
            label: label,
            expanded: expanded,
          )
        : AppButton.outlined(
            onPressed: onPressed,
            loading: isDownloading,
            loadingLabel: 'Downloading export',
            leading: leading,
            label: label,
            expanded: expanded,
          );
  }
}

/// Restarts writing after a failure, from the chat the failure was read in.
class _RetryGenerationButton extends StatelessWidget {
  const _RetryGenerationButton({required this.busy, required this.onRetry});

  final bool busy;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return AppButton.primary(
      onPressed: busy ? null : onRetry,
      loading: busy,
      loadingLabel: 'Retrying generation',
      leading: const Icon(Icons.replay_outlined),
      label: 'Retry generation',
      expanded: true,
    );
  }
}

/// Opens the finished book in the in-app reader.
class _ReadBookButton extends StatelessWidget {
  const _ReadBookButton({
    required this.projectId,
    this.expanded = false,
    this.subordinate = false,
  });

  final String projectId;
  final bool expanded;

  /// Drawn outlined when something else on the card is the one thing to do.
  final bool subordinate;

  @override
  Widget build(BuildContext context) {
    void open() => context.push('/projects/$projectId/read');
    const icon = Icon(Icons.auto_stories_outlined);
    return subordinate
        ? AppButton.outlined(
            onPressed: open,
            leading: icon,
            label: 'Read book',
            expanded: expanded,
          )
        : AppButton.primary(
            onPressed: open,
            leading: icon,
            label: 'Read book',
            expanded: expanded,
          );
  }
}

/// Opens the book's own page — plan, progress and exports in one place.
///
/// A finished book has no progress left to view, so it calls the same page
/// what it is; a book still being worked on or stopped keeps the old label.
class _ViewProgressButton extends StatelessWidget {
  const _ViewProgressButton({required this.projectId, this.finished = false});

  final String projectId;
  final bool finished;

  @override
  Widget build(BuildContext context) {
    return AppButton.text(
      onPressed: () => context.push('/projects/$projectId'),
      leading: const Icon(Icons.menu_book_outlined),
      label: finished ? 'Book details' : 'View progress',
    );
  }
}

/// Opens manual Edit Mode so the user can change the book text themselves.
class _EditBookButton extends StatelessWidget {
  const _EditBookButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return AppButton.outlined(
      onPressed: () => context.push('/projects/$projectId/edit'),
      leading: const Icon(Icons.edit_note_outlined),
      label: 'Edit book',
    );
  }
}
