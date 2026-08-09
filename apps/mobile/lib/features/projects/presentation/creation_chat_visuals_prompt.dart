part of 'creation_chat_screen.dart';

// The generated-image confirmation shown just before a plan is built.
//
// Cover and interior art are independent choices, each charged at the current
// `imageGeneration` rate. Only interiors consume a monthly illustrated-book
// slot. This dialog keeps those costs visibly separate.
//
// Turning the cover off is not "no cover": the book gets one from the bundled
// design catalog for free, so the row reads "Designed cover" rather than the
// "Not included" the illustrations row uses.

/// The screen's opener, next to the dialog it presents — same arrangement as
/// `_CreationChatSheets`.
extension _CreationChatVisualsPrompt on _CreationChatScreenState {
  /// Asks about generated images unless the user already turned illustrations
  /// off or asked not to be asked. Returns false when the build is abandoned.
  Future<bool> confirmVisuals(
    MobileCreationPresets presets,
    int targetPages,
  ) async {
    if (!presets.illustrationsEnabled) {
      // Off is always a deliberate answer — set in Advanced settings, or asked
      // for in the chat. Re-opening the question would argue with it.
      return true;
    }
    final store = ref.read(creationPrefsStoreProvider);
    final prefs = await store.load();
    if (prefs.visualsPromptSuppressed) {
      return true;
    }
    if (!mounted) return false;
    final choice = await showDialog<_VisualsPromptResult>(
      context: context,
      builder: (_) =>
          _VisualsPromptDialog(presets: presets, targetPages: targetPages),
    );
    if (choice == null) {
      return false;
    }
    final controller = ref.read(creationChatControllerProvider.notifier);
    if (choice.coverEnabled != presets.coverEnabled) {
      controller.setCoverEnabled(choice.coverEnabled);
    }
    if (choice.illustrationsEnabled != presets.illustrationsEnabled) {
      // Only on a real change: the setter records the independent sticky
      // choice, which is useful when someone opts out and noise otherwise.
      controller.setIllustrationsEnabled(choice.illustrationsEnabled);
    }
    if (choice.dontShowAgain) {
      await store.save(prefs.copyWith(visualsPromptSuppressed: true));
    }
    return true;
  }
}

class _VisualsPromptResult {
  const _VisualsPromptResult({
    required this.coverEnabled,
    required this.illustrationsEnabled,
    required this.dontShowAgain,
  });

  final bool coverEnabled;
  final bool illustrationsEnabled;
  final bool dontShowAgain;
}

class _VisualsPromptDialog extends ConsumerStatefulWidget {
  const _VisualsPromptDialog({
    required this.presets,
    required this.targetPages,
  });

  final MobileCreationPresets presets;
  final int targetPages;

  @override
  ConsumerState<_VisualsPromptDialog> createState() =>
      _VisualsPromptDialogState();
}

class _VisualsPromptDialogState extends ConsumerState<_VisualsPromptDialog> {
  late bool _coverEnabled = widget.presets.coverEnabled;
  late bool _illustrationsEnabled = widget.presets.illustrationsEnabled;
  bool _dontShowAgain = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final billing = ref.watch(billingProvider).asData?.value;
    // Same source and same fallback as the page-count sheet, so the number here
    // matches the one that sheet quoted and the one approval will ask for.
    final creditCosts = billing?.creditCosts ?? const <String, dynamic>{};

    int estimate({required bool withCover, required bool withIllustrations}) =>
        estimateProjectCredits(
          bookType: widget.presets.bookType,
          qualityPreset: widget.presets.qualityPreset,
          coverEnabled: withCover,
          illustrationsEnabled: withIllustrations,
          targetPages: widget.targetPages,
          creditCosts: creditCosts,
        );

    final baseTotal = estimate(withCover: false, withIllustrations: false);
    final coverCredits =
        estimate(withCover: true, withIllustrations: false) - baseTotal;
    final illustrationCredits =
        estimate(withCover: false, withIllustrations: true) - baseTotal;
    final selectedTotal = estimate(
      withCover: _coverEnabled,
      withIllustrations: _illustrationsEnabled,
    );
    final imageCount = estimatedInteriorImageCount(
      bookType: widget.presets.bookType,
      illustrationsEnabled: true,
      targetPages: widget.targetPages,
    );

    return AlertDialog(
      // Content-heavy dialog — use more of the screen than the default
      // 40dp side insets / 560 max width leave for a short confirmation.
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      constraints: const BoxConstraints(minWidth: 320, maxWidth: 640),
      title: const Text('Choose book images'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Cover art and in-book illustrations are priced separately. '
                'Every book gets a cover either way — without AI art we pick a '
                'designed one to match it, free.',
                style: text.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _coverEnabled,
                onChanged: (value) => setState(() => _coverEnabled = value),
                secondary: const Icon(Icons.auto_stories_outlined),
                title: const Text('AI cover art'),
                subtitle: Text(_coverSubtitle(_coverEnabled)),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _illustrationsEnabled,
                onChanged: (value) =>
                    setState(() => _illustrationsEnabled = value),
                secondary: const Icon(Icons.image_outlined),
                title: const Text('In-book illustrations'),
                subtitle: Text(
                  _illustrationsSubtitle(
                    _illustrationsEnabled,
                    widget.presets.bookType,
                    billing?.imageQuota,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _VisualsCostRow(
                      label: 'Cover',
                      value: _coverEnabled
                          ? '+$coverCredits credits'
                          : 'Designed cover, free',
                      muted: !_coverEnabled,
                    ),
                    const SizedBox(height: 8),
                    _VisualsCostRow(
                      label: imageCount == 1
                          ? '1 illustration'
                          : '$imageCount illustrations',
                      value: _illustrationsEnabled
                          ? '+$illustrationCredits credits'
                          : 'Not included',
                      muted: !_illustrationsEnabled,
                    ),
                    const SizedBox(height: 8),
                    _VisualsCostRow(
                      label: '${widget.targetPages} pages, everything else',
                      value: '$baseTotal credits',
                      muted: true,
                    ),
                    const Divider(height: 22),
                    _VisualsCostRow(
                      label: 'Estimated total',
                      value: '≈ $selectedTotal credits',
                      emphasised: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'Estimated full package cost, charged when you approve the plan.',
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _dontShowAgain,
                onChanged: (value) =>
                    setState(() => _dontShowAgain = value ?? false),
                title: const Text("Don't ask again"),
                subtitle: const Text(
                  'You can still change this under Advanced settings.',
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Cancel',
        ),
        AppButton.primary(
          onPressed: () => Navigator.of(context).pop(
            _VisualsPromptResult(
              coverEnabled: _coverEnabled,
              illustrationsEnabled: _illustrationsEnabled,
              dontShowAgain: _dontShowAgain,
            ),
          ),
          label: 'Continue',
        ),
      ],
    );
  }
}

class _VisualsCostRow extends StatelessWidget {
  const _VisualsCostRow({
    required this.label,
    required this.value,
    this.muted = false,
    this.emphasised = false,
  });

  final String label;
  final String value;
  final bool muted;
  final bool emphasised;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final style = emphasised
        ? text.titleSmall?.copyWith(fontWeight: FontWeight.w800)
        : text.bodyMedium?.copyWith(
            color: muted ? colors.onSurfaceVariant : colors.onSurface,
          );
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: Text(label, style: style)),
        const SizedBox(width: 12),
        Text(
          value,
          style: style?.copyWith(
            fontWeight: FontWeight.w700,
            color: emphasised ? colors.primary : style.color,
          ),
        ),
      ],
    );
  }
}
