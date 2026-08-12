part of 'creation_chat_screen.dart';

// Collapsible brief header: the book materializing as the chat fills the
// brief in, plus the output switcher. The expanded panel's contents live in
// creation_chat_brief_details.dart. Imports and shared state live in the
// parent library file.

/// What the collapsed row says about a built book: one badge and one pitch
/// line. Null badge label means the pill slot stays empty.
class _BuiltHeaderView {
  const _BuiltHeaderView({
    required this.pitch,
    this.badgeLabel,
    this.badgeIcon,
    this.badgeTone = AppTone.neutral,
  });

  final String pitch;
  final String? badgeLabel;
  final IconData? badgeIcon;
  final AppTone badgeTone;
}

/// Resolves the built book's badge and pitch from whichever source exists.
/// The status stream is only watched while the book is live
/// (_shouldWatchGenerationStatus), so the project detail is the fallback for
/// settled books; with neither loaded yet the header keeps the brief pitch.
///
/// None of this copy may equal the generation bubble's labels verbatim: the
/// bubble's suite asserts its exact strings appear exactly once, and the two
/// surfaces are on screen together. Composed lines like
/// 'Generating your book · 46%' stay distinct by construction.
_BuiltHeaderView? _builtHeaderView(
  MobileProjectStatus? liveStatus,
  MobileProjectDetail? project,
) {
  final status = liveStatus?.status ?? project?.status;
  if (status == null) {
    return null;
  }
  final statusLabel = (liveStatus?.statusLabel ?? project?.statusLabel ?? '')
      .trim();
  // The step list's number when there is one, same as the bubble — but with
  // no monotonic guard: a stale tick moving a text line backwards does not
  // read as work being undone the way an animating bar does.
  final percent =
      (liveStatus == null
              ? (project?.progressPercent ?? 0)
              : (liveStatus.generationProgress?.percent ??
                    liveStatus.progressPercent))
          .clamp(0, 100)
          .toInt();
  final workingPitch = statusLabel.isEmpty
      ? 'Working on your book · $percent%'
      : '$statusLabel · $percent%';

  if (liveStatus?.isAutomaticRetryPending ?? false) {
    return _BuiltHeaderView(
      pitch: workingPitch,
      badgeLabel: 'Retrying',
      badgeIcon: Icons.autorenew_outlined,
      badgeTone: AppTone.info,
    );
  }
  switch (status) {
    case 'planning':
      return _BuiltHeaderView(
        pitch: workingPitch,
        badgeLabel: 'Planning',
        badgeIcon: Icons.autorenew_outlined,
        badgeTone: AppTone.info,
      );
    case 'generating':
      return _BuiltHeaderView(
        pitch: workingPitch,
        badgeLabel: 'Writing',
        badgeIcon: Icons.autorenew_outlined,
        badgeTone: AppTone.info,
      );
    case 'editing':
      return _BuiltHeaderView(
        pitch: workingPitch,
        badgeLabel: 'Updating',
        badgeIcon: Icons.autorenew_outlined,
        badgeTone: AppTone.info,
      );
  }
  final requiresReview =
      liveStatus?.requiresReview ?? status == 'review_required';
  if (requiresReview) {
    return const _BuiltHeaderView(
      pitch: 'Finished — review recommended',
      badgeLabel: 'Review',
      badgeIcon: Icons.error_outline,
      badgeTone: AppTone.warning,
    );
  }
  final failed = liveStatus != null
      ? status == 'failed' || liveStatus.hasFailure
      : status == 'failed';
  if (failed) {
    return const _BuiltHeaderView(
      pitch: 'Something needs your attention',
      badgeLabel: 'Attention',
      badgeIcon: Icons.error_outline,
      badgeTone: AppTone.error,
    );
  }
  if (liveStatus?.isComplete ?? status == 'complete') {
    // Whichever source knows: a detail read mid-refresh can still say 0
    // while the status stream already counted the pages.
    final projectPages = project?.pageCount ?? 0;
    final pageCount = projectPages > 0
        ? projectPages
        : liveStatus?.pageProgress.completed ?? 0;
    return _BuiltHeaderView(
      pitch: pageCount > 0 ? 'Ready to read · $pageCount pages' : 'Ready to read',
      badgeLabel: 'Ready',
      badgeIcon: Icons.check_circle_outline,
      badgeTone: AppTone.success,
    );
  }
  // Anything else a built book can be is a plan waiting for its reader.
  return const _BuiltHeaderView(
    pitch: 'Plan ready to review',
    badgeLabel: 'Plan ready',
    badgeIcon: Icons.rate_review_outlined,
  );
}

class _BriefHeader extends StatefulWidget {
  const _BriefHeader({
    required this.state,
    this.activeProjectId,
    this.planValue,
    this.statusValue,
    this.onOpenAdvanced,
    this.onEditTitle,
  });

  final CreationChatState state;

  /// Non-null once the chat has a built book. The header then carries the
  /// screen's only title (the app bar names nothing), so it prefers the
  /// active output's title — the server keeps it synced to the project row,
  /// where a replan or rename lands — and retires the readiness pill, which
  /// only describes a brief that is still forming.
  final String? activeProjectId;

  /// The built book's detail: the real cover art, and the settled status
  /// once the live stream is no longer watched.
  final AsyncValue<MobileProjectDetail>? planValue;

  /// The live status stream; only watched while the book is being worked on.
  final AsyncValue<MobileProjectStatus>? statusValue;

  /// Opens Advanced settings from the preset chips. Null once built: the
  /// sheet edits the pre-build presets, which a built book no longer reads.
  final Future<void> Function()? onOpenAdvanced;

  /// Opens the title sheet from the pen chip in the expanded panel; null
  /// once built, when the title belongs to the book rather than the brief.
  final Future<void> Function()? onEditTitle;

  @override
  State<_BriefHeader> createState() => _BriefHeaderState();
}

class _BriefHeaderState extends State<_BriefHeader> {
  bool _expanded = false;

  String? _activeOutputTitle() {
    final projectId = widget.activeProjectId;
    if (projectId == null) return null;
    for (final output in widget.state.outputs) {
      if (output.projectId == projectId) {
        final title = output.title.trim();
        return title.isEmpty ? null : title;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final built = widget.activeProjectId != null;
    final project = built ? widget.planValue?.asData?.value : null;
    final liveStatus = built ? widget.statusValue?.asData?.value : null;
    final builtView = built ? _builtHeaderView(liveStatus, project) : null;
    final brief = state.brief;
    final colors = Theme.of(context).colorScheme;
    final presets = state.presets;
    final typeTitle = bookTypeLabel(
      state.userChoices.contains(CreationChoice.bookType)
          ? presets.bookTypeChoice
          : 'auto',
    );
    final workingTitle =
        _activeOutputTitle() ??
        workingCreationTitle(
          optionalDetails: state.optionalDetails,
          brief: brief,
        );
    // Untitled: name the detected shape rather than repeating 'New book'
    // (the sidebar's default) or the word 'Auto'.
    final headline =
        workingTitle ??
        (state.detectedLane != 'auto'
            ? laneTitle(state.detectedLane)
            : 'Your next book');
    final pitch =
        builtView?.pitch ??
        creationPitchLine(brief: brief, bookTypeChoiceLabel: typeTitle);

    return Material(
      color: colors.surfaceContainerHigh,
      child: Column(
        children: [
          InkWell(
            key: const ValueKey('creationBriefHeader'),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
              child: Row(
                children: [
                  CreationCoverGlimpse(
                    title: workingTitle,
                    readinessScore: state.readiness.score,
                    // A built book is past forming: solid whatever the
                    // restored readiness says.
                    canBuild: built || state.readiness.canBuild,
                    seed: state.draftId ?? 'draft',
                    image: project?.coverImage,
                    palette: coverPreviewColors(state.coverPreview),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          headline,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          pitch,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (!built)
                    _ReadinessPill(readiness: state.readiness)
                  else if (builtView?.badgeLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: AppStatusBadge(
                        label: builtView!.badgeLabel!,
                        icon: builtView.badgeIcon,
                        tone: builtView.badgeTone,
                        semanticLabel: 'Book status: ${builtView.badgeLabel}',
                      ),
                    ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            // Bounded and scrollable: the details share one fixed-height
            // column with the transcript, the question card and the build
            // footer, so growing without a cap pushes "Build the plan" off
            // the screen and overflows the column. A third of the space the
            // keyboard leaves is the most a helper bar may take.
            ConstrainedBox(
              key: const ValueKey('creationBriefDetails'),
              constraints: BoxConstraints(
                maxHeight: math.max(
                  (MediaQuery.sizeOf(context).height -
                          MediaQuery.viewInsetsOf(context).bottom) *
                      0.3,
                  120.0,
                ),
              ),
              // The same visible scrollbar and "Scroll for more" cue the
              // question drawer uses, so a clipped list is never mistaken
              // for the whole list.
              child: _ScrollableFooterContext(
                fadeColor: colors.surfaceContainerHigh,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                  child: _BriefDetails(
                    state: state,
                    brief: brief,
                    presets: presets,
                    built: built,
                    project: project,
                    liveStatus: liveStatus,
                    onOpenAdvanced: widget.onOpenAdvanced,
                    onEditTitle: widget.onEditTitle,
                  ),
                ),
              ),
            ),
          Divider(height: 1, color: colors.outlineVariant),
        ],
      ),
    );
  }
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
        tone: ready ? AppTone.success : AppTone.neutral,
      ),
    );
  }
}

class _OutputSwitcher extends StatelessWidget {
  const _OutputSwitcher({
    required this.outputs,
    required this.activeProjectId,
    required this.onSelect,
  });

  final List<MobileCreationOutput> outputs;
  final String activeProjectId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHigh,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 52,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: outputs.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final output = outputs[index];
                final selected = output.projectId == activeProjectId;
                return FilterChip(
                  selected: selected,
                  showCheckmark: false,
                  avatar: Icon(
                    selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_unchecked,
                    size: 18,
                  ),
                  label: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 180),
                    child: Text(
                      output.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  onSelected: (_) => onSelect(output.projectId),
                );
              },
            ),
          ),
          Divider(height: 1, color: colors.outlineVariant),
        ],
      ),
    );
  }
}
