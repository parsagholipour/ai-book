part of 'creation_chat_screen.dart';

// Contents of the brief header's expanded panel: quick actions for a built
// book, the preset chips, shape preview, materials and the build estimate.
// The title is edited through the pen beside the headline instead, which
// opens _TitleSheet. Imports live in the parent library file.

class _BriefDetails extends StatelessWidget {
  const _BriefDetails({
    required this.state,
    required this.brief,
    required this.presets,
    required this.built,
    this.project,
    this.liveStatus,
    this.onOpenAdvanced,
  });

  final CreationChatState state;
  final MobileBookRecipe? brief;
  final MobileCreationPresets presets;

  /// A built book has nothing left to add: the readiness hints and estimate
  /// are advice for a brief still being written.
  final bool built;
  final MobileProjectDetail? project;
  final MobileProjectStatus? liveStatus;
  final Future<void> Function()? onOpenAdvanced;

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
    final onChipTap = onOpenAdvanced == null
        ? null
        : () => unawaited(onOpenAdvanced!());
    final sectionStyle = Theme.of(
      context,
    ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (built && project != null) ...[
          _BriefQuickActions(
            projectId: project!.id,
            project: project!,
            liveStatus: liveStatus,
          ),
          const SizedBox(height: 10),
        ],
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _TappableBriefChip(
              label: 'Type',
              value: bookTypeLabel(
                state.userChoices.contains(CreationChoice.bookType)
                    ? presets.bookTypeChoice
                    : 'auto',
              ),
              onTap: onChipTap,
            ),
            _TappableBriefChip(
              label: 'Size',
              value: pageCountLabelFor(presets),
              onTap: onChipTap,
            ),
            _TappableBriefChip(
              label: 'Finish',
              value: qualityLabel(presets.qualityPreset),
              onTap: onChipTap,
            ),
            _TappableBriefChip(
              label: 'Cover',
              value: presets.coverEnabled ? 'Included' : 'Not included',
              onTap: onChipTap,
            ),
            _TappableBriefChip(
              label: 'Illustrations',
              value: presets.illustrationsEnabled ? 'Included' : 'Not included',
              onTap: onChipTap,
            ),
            if (state.language != 'en')
              _TappableBriefChip(
                label: 'Language',
                value: languageLabel(state.language),
                onTap: onChipTap,
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
        if (!built && state.shapePreview.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text('Shape', style: sectionStyle),
          const SizedBox(height: 4),
          for (final item in state.shapePreview)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text('• $item'),
            ),
        ],
        if (!built &&
            (state.pendingAttachments.isNotEmpty || state.hasSourceNotes)) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (state.pendingAttachments.isNotEmpty)
                AppMetricChip(
                  icon: Icons.attach_file_outlined,
                  label: state.pendingAttachments.length == 1
                      ? '1 attachment'
                      : '${state.pendingAttachments.length} attachments',
                  value: state.hasUploadingAttachments ? 'uploading' : null,
                ),
              if (state.hasSourceNotes)
                const AppMetricChip(
                  icon: Icons.notes_outlined,
                  label: 'Source notes attached',
                ),
            ],
          ),
        ],
        if (!built) ...[
          const SizedBox(height: 12),
          _BriefCreditEstimate(presets: presets),
        ],
        for (final row in rows) ...[
          const SizedBox(height: 10),
          Text(row.label, style: sectionStyle),
          const SizedBox(height: 2),
          Text(row.value),
        ],
        if (!built && state.readiness.missing.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('Helpful to add', style: sectionStyle),
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

/// AppMetricChip is a plain container shared across the app; wrapping it
/// locally keeps the shared widget non-interactive while these chips open
/// Advanced settings. A null onTap renders exactly the plain chip.
class _TappableBriefChip extends StatelessWidget {
  const _TappableBriefChip({required this.label, this.value, this.onTap});

  final String label;
  final String? value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final chip = AppMetricChip(label: label, value: value);
    if (onTap == null) {
      return chip;
    }
    return Semantics(
      button: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.pill),
          onTap: onTap,
          child: chip,
        ),
      ),
    );
  }
}

/// Shortcut row for a built book. A Consumer because download spends state:
/// openProjectExport needs ref, and finishing one refreshes the status and
/// detail providers — the same flow the generation bubble runs.
class _BriefQuickActions extends ConsumerStatefulWidget {
  const _BriefQuickActions({
    required this.projectId,
    required this.project,
    this.liveStatus,
  });

  final String projectId;
  final MobileProjectDetail project;
  final MobileProjectStatus? liveStatus;

  @override
  ConsumerState<_BriefQuickActions> createState() =>
      _BriefQuickActionsState();
}

class _BriefQuickActionsState extends ConsumerState<_BriefQuickActions> {
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
    final liveStatus = widget.liveStatus;
    final project = widget.project;
    final status = liveStatus?.status ?? project.status;
    final exports = liveStatus?.exports ?? project.exports;
    final complete = liveStatus?.isComplete ?? status == 'complete';
    final requiresReview =
        liveStatus?.requiresReview ?? status == 'review_required';
    // The bubble's predicate: only a finished, review-clear book offers its
    // primary unlocked export here.
    final downloadExport = complete && !requiresReview
        ? primaryUnlockedAvailableExport(exports)
        : null;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (exports.pdf.available) _ReadBookButton(projectId: widget.projectId),
        if (complete) _ListenBookButton(projectId: widget.projectId),
        if (downloadExport != null)
          _CompletionDownloadButton(
            export: downloadExport,
            busyAction: _busyAction,
            onDownload: _downloadExport,
          ),
        _ViewProgressButton(projectId: widget.projectId),
      ],
    );
  }
}

/// Opens the audiobook player. Narration needs a finished book — the same
/// gate the actions menu uses — so the button is hidden, not disabled.
class _ListenBookButton extends StatelessWidget {
  const _ListenBookButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return AppButton.outlined(
      onPressed: () => context.push('/projects/$projectId/listen'),
      leading: const Icon(Icons.headphones_outlined),
      label: 'Listen',
    );
  }
}

/// The build's price before anyone taps Build: the same estimate the
/// page-count sheet and plan approval quote, so no surface names a different
/// number. Watches billing directly — the Advanced sheet already reads the
/// cost map this way, and threading it through the header for one badge is
/// not worth it. The auto page count is the preset default, not the
/// chat-detected one, which is what the '~' says.
class _BriefCreditEstimate extends ConsumerWidget {
  const _BriefCreditEstimate({required this.presets});

  final MobileCreationPresets presets;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final creditCosts =
        ref.watch(billingProvider).asData?.value.creditCosts ??
        const <String, dynamic>{};
    final targetPages = presets.targetPages;
    final pages = presets.pageCountMode == 'custom' && targetPages != null
        ? targetPages
        : targetPageCountFor(presets.bookType, presets.lengthPreset);
    final credits = estimateProjectCredits(
      bookType: presets.bookType,
      qualityPreset: presets.qualityPreset,
      coverEnabled: presets.coverEnabled,
      illustrationsEnabled: presets.illustrationsEnabled,
      targetPages: pages,
      creditCosts: creditCosts,
    );
    return Row(
      children: [
        Expanded(
          child: Text(
            'Estimated build cost · ~$pages pages',
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        CreditCostBadge(credits: credits, kind: CreditCostKind.quoted),
      ],
    );
  }
}
