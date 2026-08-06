part of 'creation_chat_screen.dart';

// Modal sheets for page count, source notes and advanced book settings.
// Imports and shared state live in the parent library file.

/// The screen's own openers for the sheets below. They live here, next to the
/// sheets they present, rather than among the screen's chat logic.
extension _CreationChatSheets on _CreationChatScreenState {
  Future<void> openSourceNotesSheet(CreationChatState state) async {
    final controller = TextEditingController(text: state.sourceNotes);
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SourceNotesSheet(controller: controller),
    );
    controller.dispose();
    if (saved != null) {
      ref.read(creationChatControllerProvider.notifier).setSourceNotes(saved);
      if (mounted) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          SnackBar(
            content: Text(
              saved.trim().isEmpty
                  ? 'Source notes cleared.'
                  : 'Source notes attached.',
            ),
          ),
        );
      }
    }
  }

  Future<void> openAdvancedSheet() async {
    final controller = ref.read(creationChatControllerProvider.notifier);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AdvancedSheet(controller: controller),
    );
  }
}

class _PageCountSelection {
  const _PageCountSelection({required this.targetPages, required this.source});

  final int targetPages;
  final String source;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

class _PageCountPromptSheet extends StatefulWidget {
  const _PageCountPromptSheet({
    required this.preflight,
    required this.estimateCredits,
  });

  final MobileCreationBuildPreflight preflight;
  final int Function(int targetPages) estimateCredits;

  @override
  State<_PageCountPromptSheet> createState() => _PageCountPromptSheetState();
}

class _PageCountPromptSheetState extends State<_PageCountPromptSheet> {
  final _customController = TextEditingController();

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  int? get _customPages {
    final value = int.tryParse(_customController.text.trim());
    if (value == null || value < 1 || value > 600) {
      return null;
    }
    return value;
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final colors = Theme.of(context).colorScheme;
    final recommendations = widget.preflight.recommendations;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'How many pages?',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Pick a page count before I build the plan. These suggestions come from your chat.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            for (final recommendation in recommendations) ...[
              Card(
                margin: EdgeInsets.zero,
                child: ListTile(
                  leading: const Icon(Icons.auto_awesome_outlined),
                  title: Text(recommendation.label),
                  subtitle: recommendation.description.isEmpty
                      ? null
                      : Text(recommendation.description),
                  trailing: Text(
                    '≈ ${widget.estimateCredits(recommendation.targetPages)} credits',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: colors.primary,
                    ),
                  ),
                  onTap: () => Navigator.of(context).pop(
                    _PageCountSelection(
                      targetPages: recommendation.targetPages,
                      source: 'recommended',
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
            if (recommendations.isNotEmpty) ...[
              Text(
                'Estimated full package cost, charged when you approve the plan.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
            ],
            TextField(
              controller: _customController,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                labelText: 'Custom pages',
                helperText: _customPages == null
                    ? 'Enter a number from 1 to 600.'
                    : '≈ ${widget.estimateCredits(_customPages!)} credits '
                          'for $_customPages pages.',
              ),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) {
                final pages = _customPages;
                if (pages != null) {
                  Navigator.of(context).pop(
                    _PageCountSelection(targetPages: pages, source: 'settings'),
                  );
                }
              },
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ValueListenableBuilder<TextEditingValue>(
                    valueListenable: _customController,
                    builder: (context, value, child) {
                      final pages = _customPages;
                      return FilledButton(
                        onPressed: pages == null
                            ? null
                            : () => Navigator.of(context).pop(
                                _PageCountSelection(
                                  targetPages: pages,
                                  source: 'settings',
                                ),
                              ),
                        child: const Text('Use custom'),
                      );
                    },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SourceNotesSheet extends StatelessWidget {
  const _SourceNotesSheet({required this.controller});

  final TextEditingController controller;

  static const _limit = 12000;

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Source notes',
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 6),
          Text(
            'Paste an outline, lesson material, sales copy, or a story seed. Private reference, up to 12,000 characters.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            minLines: 6,
            maxLines: 12,
            maxLength: _limit,
            decoration: const InputDecoration(
              labelText: 'Source notes',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(''),
                  child: const Text('Clear'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: () => Navigator.of(context).pop(controller.text),
                  child: const Text('Attach'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AdvancedSheet extends ConsumerWidget {
  const _AdvancedSheet({required this.controller});

  final CreationChatController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(creationChatControllerProvider);
    final presets = state.presets;
    // Watched (not read) so the page-cost estimate reacts to Finish and
    // in-book illustration changes made in this same sheet.
    final creditCosts =
        ref.watch(billingProvider).asData?.value.creditCosts ??
        const <String, dynamic>{};
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Advanced settings',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Override anything the studio chose. Your selections stick across the conversation.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            _BookTypeDropdown(
              title: 'Book type',
              yourChoice: state.userChoices.contains(CreationChoice.bookType),
              options: bookTypePresetOptions,
              selected: state.userChoices.contains(CreationChoice.bookType)
                  ? presets.bookTypeChoice
                  : 'auto',
              onChanged: controller.setBookType,
            ),
            const SizedBox(height: 14),
            _PageCountControl(
              title: 'Pages',
              yourChoice: state.userChoices.contains(CreationChoice.length),
              presets: presets,
              onAuto: controller.setPageCountAuto,
              onCustom: controller.setCustomTargetPages,
              estimateCredits: (pages) => estimateProjectCredits(
                bookType: presets.bookType,
                qualityPreset: presets.qualityPreset,
                coverEnabled: presets.coverEnabled,
                illustrationsEnabled: presets.illustrationsEnabled,
                targetPages: pages,
                creditCosts: creditCosts,
              ),
            ),
            const SizedBox(height: 14),
            _AdvancedGroup(
              title: 'Finish',
              yourChoice: state.userChoices.contains(CreationChoice.finish),
              options: qualityPresetOptions,
              selected: presets.qualityPreset,
              onChanged: controller.setQualityPreset,
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: presets.coverEnabled,
              onChanged: controller.setCoverEnabled,
              secondary: const Icon(Icons.auto_stories_outlined),
              title: Row(
                children: [
                  const Expanded(child: Text('AI cover art')),
                  if (state.userChoices.contains(CreationChoice.cover))
                    const AppStatusBadge(
                      label: 'Your choice',
                      icon: Icons.tune_outlined,
                    ),
                ],
              ),
              subtitle: Text(_coverSubtitle(presets.coverEnabled)),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: presets.illustrationsEnabled,
              onChanged: controller.setIllustrationsEnabled,
              secondary: const Icon(Icons.image_outlined),
              title: Row(
                children: [
                  const Expanded(child: Text('In-book illustrations')),
                  if (state.userChoices.contains(CreationChoice.illustrations))
                    const AppStatusBadge(
                      label: 'Your choice',
                      icon: Icons.tune_outlined,
                    ),
                ],
              ),
              subtitle: Text(
                _illustrationsSubtitle(
                  presets.illustrationsEnabled,
                  presets.bookType,
                  ref.watch(billingProvider).asData?.value.imageQuota,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _LanguageField(
              language: state.language,
              yourChoice: state.userChoices.contains(CreationChoice.language),
              onChanged: controller.setLanguage,
            ),
            const SizedBox(height: 14),
            _ToneField(
              tone: state.optionalDetails.tone,
              yourChoice: state.userChoices.contains(CreationChoice.tone),
              onChanged: controller.setTone,
            ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Which server refusals the paywall can answer, and what to call it when it
/// opens. Anything else is a snackbar — the paywall is not a general error
/// screen, it is the one that has something to offer.
String? _paywallTitleForError(String? code) => switch (code) {
  'INSUFFICIENT_CREDITS' => 'Credits needed',
  'IMAGE_LIMIT_REACHED' => 'Out of illustrated books',
  _ => null,
};

/// The credits-needed section for a refusal that has one.
///
/// A 402 carries what the build would have cost, which is worth more than its
/// message ("You need more credits for this action."). An image limit is not
/// about credits at all — no section, the server's own wording instead.
PaywallCreditsNeeded? _paywallCreditsNeededForError(ApiException error) {
  if (error.code != 'INSUFFICIENT_CREDITS') {
    return null;
  }
  return PaywallCreditsNeeded.fromApiError(
    error,
    reason:
        'Writing this book, preparing its visuals and unlocking its export.',
  );
}

String _coverSubtitle(bool enabled) {
  return enabled
      ? 'One cover image drawn for your book.'
      : 'Free: a designed cover is chosen to match your book.';
}

/// Says what illustrations will cost against the month's budget, when there is
/// one.
/// A null quota is a plan with no image limit, so it says nothing extra.
String _illustrationsSubtitle(
  bool enabled,
  String bookType,
  MobileImageQuota? quota,
) {
  if (!enabled) {
    return 'No generated images inside the book.';
  }
  final base = 'Up to ${visualLimitFor(bookType)} in-book illustrations.';
  if (quota == null) {
    return base;
  }
  if (quota.isExhausted) {
    return '$base You have used all ${quota.limit} illustrated books this month — upgrade to keep going.';
  }
  return '$base ${quota.remaining} of ${quota.limit} illustrated books left this month.';
}

class _BookTypeDropdown extends StatelessWidget {
  const _BookTypeDropdown({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final selectedOption = options.firstWhere(
      (option) => option.value == selected,
      orElse: () => options.first,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          key: ValueKey('book-type-$selected'),
          initialValue: selectedOption.value,
          isExpanded: true,
          decoration: InputDecoration(
            prefixIcon: Icon(selectedOption.icon),
            helperText: selectedOption.subtitle,
          ),
          items: [
            for (final option in options)
              DropdownMenuItem(
                value: option.value,
                child: Row(
                  children: [
                    Icon(option.icon, size: 20),
                    const SizedBox(width: 10),
                    Expanded(child: Text(option.title)),
                  ],
                ),
              ),
          ],
          onChanged: (value) {
            if (value != null) onChanged(value);
          },
        ),
      ],
    );
  }
}

class _PageCountControl extends StatefulWidget {
  const _PageCountControl({
    required this.title,
    required this.yourChoice,
    required this.presets,
    required this.onAuto,
    required this.onCustom,
    this.estimateCredits,
  });

  final String title;
  final bool yourChoice;
  final MobileCreationPresets presets;
  final VoidCallback onAuto;
  final void Function(int targetPages, {String source}) onCustom;
  final int Function(int targetPages)? estimateCredits;

  @override
  State<_PageCountControl> createState() => _PageCountControlState();
}

class _PageCountControlState extends State<_PageCountControl> {
  late final TextEditingController _controller;
  late bool _customSelected;

  @override
  void initState() {
    super.initState();
    _customSelected = widget.presets.pageCountMode == 'custom';
    _controller = TextEditingController(
      text: widget.presets.targetPages?.toString() ?? '',
    );
  }

  @override
  void didUpdateWidget(covariant _PageCountControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextCustom = widget.presets.pageCountMode == 'custom';
    if (nextCustom != _customSelected) {
      _customSelected = nextCustom;
    }
    final nextText = widget.presets.targetPages?.toString() ?? '';
    if (nextText != _controller.text && nextText.isNotEmpty) {
      _controller.text = nextText;
    }
    if (!nextCustom && _controller.text.isNotEmpty) {
      _controller.clear();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onCustomChanged(String value) {
    final pages = int.tryParse(value.trim());
    if (pages == null || pages < 1 || pages > 600) {
      return;
    }
    widget.onCustom(pages);
  }

  /// Estimated package cost for the currently entered custom page count, in
  /// the same terms as the plan-approval dialog.
  String? _customEstimateHelper() {
    final estimateCredits = widget.estimateCredits;
    final pages = int.tryParse(_controller.text.trim());
    if (estimateCredits == null || pages == null || pages < 1 || pages > 600) {
      return null;
    }
    return '≈ ${estimateCredits(pages)} credits for $pages pages, '
        'charged when you approve the plan.';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                widget.title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (widget.yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        AppChoiceTile(
          selected: !_customSelected,
          icon: Icons.auto_awesome_outlined,
          title: 'Auto',
          subtitle: 'Ask me before building if the chat does not say pages.',
          onTap: () {
            setState(() => _customSelected = false);
            widget.onAuto();
          },
        ),
        const SizedBox(height: 8),
        AppChoiceTile(
          selected: _customSelected,
          icon: Icons.format_list_numbered,
          title: 'Custom',
          subtitle: 'Use an exact page count.',
          onTap: () => setState(() => _customSelected = true),
        ),
        if (_customSelected) ...[
          const SizedBox(height: 8),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Pages',
              helperText:
                  _customEstimateHelper() ?? 'Enter a number from 1 to 600.',
              errorText:
                  _controller.text.isNotEmpty &&
                      (int.tryParse(_controller.text) == null ||
                          int.parse(_controller.text) < 1 ||
                          int.parse(_controller.text) > 600)
                  ? 'Use 1 to 600 pages.'
                  : null,
              filled: true,
              fillColor: colors.surface,
            ),
            onChanged: (value) {
              setState(() {});
              _onCustomChanged(value);
            },
          ),
        ],
      ],
    );
  }
}

class _AdvancedGroup extends StatelessWidget {
  const _AdvancedGroup({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        for (final option in options) ...[
          AppChoiceTile(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            subtitle: option.subtitle,
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _LanguageField extends StatelessWidget {
  const _LanguageField({
    required this.language,
    required this.yourChoice,
    required this.onChanged,
  });

  final String language;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final known = creationLanguageOptions.any((o) => o.code == language);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Language',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: known ? language : 'en',
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.translate_outlined),
          ),
          items: [
            for (final option in creationLanguageOptions)
              DropdownMenuItem(value: option.code, child: Text(option.label)),
          ],
          onChanged: (value) {
            if (value != null) onChanged(value);
          },
        ),
      ],
    );
  }
}

class _ToneField extends StatelessWidget {
  const _ToneField({
    required this.tone,
    required this.yourChoice,
    required this.onChanged,
  });

  final String tone;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  static const _toneExamples = [
    'warm',
    'funny',
    'practical',
    'polished',
    'gentle',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Tone',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in _toneExamples)
              ChoiceChip(
                label: Text(option),
                selected: tone.toLowerCase() == option,
                onSelected: (_) => onChanged(option),
              ),
          ],
        ),
      ],
    );
  }
}
