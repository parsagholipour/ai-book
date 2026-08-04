part of 'creation_chat_screen.dart';

// The illustrations confirmation shown just before a plan is built.
//
// Illustrations are the single most expensive line item in a book — the quote
// carries one `imageGeneration` charge per estimated interior image, and on the
// free tier an illustrated book also spends one of the month's slots — yet they
// are on by default and the only switch for them sits inside Advanced settings.
// This dialog puts the choice and its price in front of the user once, on the
// way to the plan, and lets them opt out of being asked again.

/// The screen's opener, next to the dialog it presents — same arrangement as
/// `_CreationChatSheets`.
extension _CreationChatVisualsPrompt on _CreationChatScreenState {
  /// Asks about illustrations unless the user turned them off already or asked
  /// not to be asked. Returns false when the build should be abandoned.
  Future<bool> confirmVisuals(
    MobileCreationPresets presets,
    int targetPages,
  ) async {
    if (!presets.imagesEnabled) {
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
    if (choice.imagesEnabled != presets.imagesEnabled) {
      // Only on a real change: the setter also records CreationChoice.visuals,
      // which pins the value against later server merges. That is right when
      // someone turns illustrations off, and noise when they just say yes.
      ref
          .read(creationChatControllerProvider.notifier)
          .setImagesEnabled(choice.imagesEnabled);
    }
    if (choice.dontShowAgain) {
      await store.save(prefs.copyWith(visualsPromptSuppressed: true));
    }
    return true;
  }
}

class _VisualsPromptResult {
  const _VisualsPromptResult({
    required this.imagesEnabled,
    required this.dontShowAgain,
  });

  final bool imagesEnabled;
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
  late bool _imagesEnabled = widget.presets.imagesEnabled;
  bool _dontShowAgain = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final billing = ref.watch(billingProvider).asData?.value;
    // Same source and same fallback as the page-count sheet, so the number here
    // matches the one that sheet quoted and the one approval will ask for.
    final creditCosts = billing?.creditCosts ?? const <String, dynamic>{};

    int estimate(bool withImages) => estimateProjectCredits(
      bookType: widget.presets.bookType,
      qualityPreset: widget.presets.qualityPreset,
      imagesEnabled: withImages,
      targetPages: widget.targetPages,
      creditCosts: creditCosts,
    );

    final illustratedTotal = estimate(true);
    final textOnlyTotal = estimate(false);
    final addedCredits = illustratedTotal - textOnlyTotal;
    final imageCount = estimatedInteriorImageCount(
      bookType: widget.presets.bookType,
      imagesEnabled: true,
      targetPages: widget.targetPages,
    );

    return AlertDialog(
      title: const Text('Add illustrations?'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Illustrations are the most expensive part of a book. A '
                'text-first book costs less and is quicker to make.',
                style: text.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _imagesEnabled,
                onChanged: (value) => setState(() => _imagesEnabled = value),
                secondary: const Icon(Icons.image_outlined),
                title: const Text('Illustrations'),
                subtitle: Text(
                  _visualsSubtitle(
                    _imagesEnabled,
                    widget.presets.bookType,
                    billing?.imageQuota,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _VisualsCostRow(
                      label: imageCount == 1
                          ? '1 illustration'
                          : '$imageCount illustrations',
                      value: _imagesEnabled
                          ? '+$addedCredits credits'
                          : 'Not included',
                      muted: !_imagesEnabled,
                    ),
                    const SizedBox(height: 6),
                    _VisualsCostRow(
                      label: '${widget.targetPages} pages, everything else',
                      value: '$textOnlyTotal credits',
                      muted: true,
                    ),
                    const Divider(height: 18),
                    _VisualsCostRow(
                      label: 'Estimated total',
                      value:
                          '≈ ${_imagesEnabled ? illustratedTotal : textOnlyTotal} credits',
                      emphasised: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Estimated full package cost, charged when you approve the plan.',
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 4),
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
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(
            _VisualsPromptResult(
              imagesEnabled: _imagesEnabled,
              dontShowAgain: _dontShowAgain,
            ),
          ),
          child: const Text('Continue'),
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
