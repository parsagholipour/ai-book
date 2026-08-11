part of 'creation_chat_screen.dart';

// Collapsible brief header: the book materializing as the chat fills the
// brief in, plus the output switcher. Imports and shared state live in the
// parent library file.

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
    final typeTitle = bookTypeLabel(
      state.userChoices.contains(CreationChoice.bookType)
          ? presets.bookTypeChoice
          : 'auto',
    );
    final workingTitle = workingCreationTitle(
      optionalDetails: state.optionalDetails,
      brief: brief,
      titleSuggestions: state.titleSuggestions,
      sessionTitle: state.sessionTitle,
    );
    // Untitled: name the detected shape rather than repeating 'New book'
    // (the app bar's default) or the word 'Auto'.
    final headline =
        workingTitle ??
        (state.detectedLane != 'auto'
            ? laneTitle(state.detectedLane)
            : 'Your next book');
    final pitch = creationPitchLine(
      brief: brief,
      bookTypeChoiceLabel: typeTitle,
    );

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
                    canBuild: state.readiness.canBuild,
                    seed: state.draftId ?? 'draft',
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
            // Bounded and scrollable: the details share one fixed-height
            // column with the transcript, the question card and the build
            // footer, so growing without a cap pushes "Build the plan" off
            // the screen and overflows the column. A third of the space the
            // keyboard leaves is the most a helper bar may take.
            ConstrainedBox(
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
            AppMetricChip(
              label: 'Type',
              value: bookTypeLabel(
                state.userChoices.contains(CreationChoice.bookType)
                    ? presets.bookTypeChoice
                    : 'auto',
              ),
            ),
            AppMetricChip(label: 'Size', value: pageCountLabelFor(presets)),
            AppMetricChip(
              label: 'Finish',
              value: qualityLabel(presets.qualityPreset),
            ),
            AppMetricChip(
              label: 'Cover',
              value: presets.coverEnabled ? 'Included' : 'Not included',
            ),
            AppMetricChip(
              label: 'Illustrations',
              value: presets.illustrationsEnabled ? 'Included' : 'Not included',
            ),
            if (state.language != 'en')
              AppMetricChip(
                label: 'Language',
                value: languageLabel(state.language),
              ),
          ],
        ),
        if (state.userChoices.isNotEmpty) ...[
          const SizedBox(height: 8),
          const AppStatusBadge(
            label: 'Your choices applied',
            icon: Icons.tune_outlined,
            tone: AppTone.success,
          ),
        ],
        for (final row in rows) ...[
          const SizedBox(height: 10),
          Text(
            row.label,
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(row.value),
        ],
        if (state.readiness.missing.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            'Helpful to add',
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
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
