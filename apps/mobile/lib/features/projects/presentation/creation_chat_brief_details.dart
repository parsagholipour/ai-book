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
    this.onEditTitle,
  });

  final CreationChatState state;
  final MobileBookRecipe? brief;
  final MobileCreationPresets presets;

  /// A built book has nothing left to add: the readiness hints and estimate
  /// are advice for a brief still being written.
  final bool built;
  final MobileProjectDetail? project;
  final MobileProjectStatus? liveStatus;
  final Future<void> Function({_AdvancedSection? section})? onOpenAdvanced;

  /// Opens the title sheet; null once built. Lives here as the pen chip
  /// rather than beside the headline, so the collapsed bar stays plain.
  final Future<void> Function()? onEditTitle;

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
    // A chip opens the sheet at its own setting; on a phone the Visuals
    // switches sit two screens down from where the sheet starts.
    VoidCallback? chipTap(_AdvancedSection section) => onOpenAdvanced == null
        ? null
        : () => unawaited(onOpenAdvanced!(section: section));
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
        // What the book is about comes first: the settings and the price only
        // mean something once the idea they apply to is on screen.
        for (final row in rows) ...[
          Text(row.label, style: sectionStyle),
          const SizedBox(height: 2),
          Text(row.value),
          const SizedBox(height: 10),
        ],
        Row(
          children: [
            Expanded(child: Text('Settings', style: sectionStyle)),
            if (onChipTap != null)
              // The chips below open the same sheet, but nothing about a chip
              // says so; a named action does.
              TextButton(
                onPressed: onChipTap,
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, AppSizes.minimumTouchTarget),
                ),
                child: const Text('Change'),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Wrap(
          spacing: 8,
          // Each chip is a 48dp touch target around a 32dp pill.
          runSpacing: 0,
          children: [
            if (onEditTitle != null)
              _TappableBriefChip(
                icon: Icons.edit_outlined,
                label: 'Edit title',
                onTap: () => unawaited(onEditTitle!()),
              ),
            _TappableBriefChip(
              label: 'Type',
              value: bookTypeLabel(
                state.userChoices.contains(CreationChoice.bookType)
                    ? presets.bookTypeChoice
                    : 'auto',
              ),
              onTap: chipTap(_AdvancedSection.bookType),
            ),
            // A length past the free limit wears a lock here, in the brief,
            // long before Build — the chip opens the setting that unlocks it.
            Consumer(
              builder: (context, ref, _) {
                final pages = presets.pageCountMode == 'custom'
                    ? presets.targetPages
                    : null;
                final locked =
                    !built &&
                    pages != null &&
                    (ref
                            .watch(billingProvider)
                            .asData
                            ?.value
                            .locksBookPages(pages) ??
                        false);
                return _TappableBriefChip(
                  label: 'Size',
                  value: pageCountLabelFor(presets),
                  icon: locked ? Icons.lock_outline : null,
                  onTap: chipTap(_AdvancedSection.pages),
                );
              },
            ),
            _TappableBriefChip(
              label: 'Effort',
              value: qualityLabel(presets.qualityPreset),
              onTap: chipTap(_AdvancedSection.effort),
            ),
            // A declined AI cover still buys a designed one, so the chip says
            // which cover the book gets — "Not included" read as no cover.
            _TappableBriefChip(
              label: 'Cover',
              value: presets.coverEnabled ? 'AI art' : 'Designed',
              onTap: chipTap(_AdvancedSection.visuals),
            ),
            _TappableBriefChip(
              label: 'Illustrations',
              value: presets.illustrationsEnabled ? 'Included' : 'Not included',
              onTap: chipTap(_AdvancedSection.visuals),
            ),
            if (state.language != 'en')
              _TappableBriefChip(
                label: 'Language',
                value: languageLabel(state.language),
                onTap: chipTap(_AdvancedSection.more),
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
          const SizedBox(height: 12),
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
          Text('What it costs', style: sectionStyle),
          const SizedBox(height: 6),
          _BriefCreditEstimate(presets: presets),
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
  const _TappableBriefChip({
    required this.label,
    this.value,
    this.icon,
    this.onTap,
  });

  final String label;
  final String? value;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final chip = AppMetricChip(label: label, value: value, icon: icon);
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
          // The chip stays compact; the tap area is a full touch target tall.
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Center(widthFactor: 1, child: chip),
          ),
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
  ConsumerState<_BriefQuickActions> createState() => _BriefQuickActionsState();
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
            // Read book is the primary; a download beside it is not.
            primary: !exports.pdf.available,
          ),
        _ViewProgressButton(projectId: widget.projectId, finished: complete),
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

/// Both charges in the reader journey, kept visibly separate because they
/// happen at different decisions: planning now, writing after approval.
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
    final planCredits = estimatePlanGenerationCredits(
      qualityPreset: presets.qualityPreset,
      creditCosts: creditCosts,
    );
    final bookCredits = estimateProjectCredits(
      bookType: presets.bookType,
      bookTypeChoice: presets.bookTypeChoice,
      qualityPreset: presets.qualityPreset,
      coverEnabled: presets.coverEnabled,
      illustrationsEnabled: presets.illustrationsEnabled,
      targetPages: pages,
      creditCosts: creditCosts,
    );
    return Column(
      children: [
        _EstimateChargeRow(label: 'Plan now', credits: planCredits),
        const SizedBox(height: 6),
        _EstimateChargeRow(
          label: 'Book after approval · ~$pages pages',
          credits: bookCredits,
        ),
        const SizedBox(height: 6),
        _EstimateChargeRow(label: 'Total', credits: planCredits + bookCredits),
      ],
    );
  }
}

class _EstimateChargeRow extends StatelessWidget {
  const _EstimateChargeRow({required this.label, required this.credits});

  final String label;
  final int credits;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            label,
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
