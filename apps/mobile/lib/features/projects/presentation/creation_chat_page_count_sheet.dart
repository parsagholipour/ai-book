part of 'creation_chat_screen.dart';

// The page-count sheet Build opens when the chat never said how long the book
// is, and the long-book offer every page picker in the creation chat runs for
// a count past the free tier's length. Imports live in the parent library file.

class _PageCountSelection {
  const _PageCountSelection({required this.targetPages, required this.source});

  final int targetPages;
  final String source;
}

class _PageCountPromptSheet extends StatefulWidget {
  const _PageCountPromptSheet({
    required this.preflight,
    required this.estimateCredits,
    this.resolveLocked,
    this.ceilingPages = maxPlanBookPages,
  });

  final MobileCreationBuildPreflight preflight;
  final int Function(int targetPages) estimateCredits;

  /// The longest book any plan writes (`paidMaxBookPages`): a recommendation
  /// past it is not offered, and a typed count past it is not accepted.
  final int ceilingPages;

  /// Runs the long-book offer for a count past the free limit, answering with
  /// the count to use or null when the reader closed it.
  final Future<int?> Function(int targetPages)? resolveLocked;

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
    if (value == null || value < 1 || value > widget.ceilingPages) {
      return null;
    }
    return value;
  }

  /// The count Continue submits when the custom field is empty: the flagged
  /// recommendation, or the first option if the payload omitted the flag.
  MobilePageCountRecommendation? get _continueRecommendation {
    final recommendations = _options;
    for (final recommendation in recommendations) {
      if (recommendation.isRecommended) {
        return recommendation;
      }
    }
    return recommendations.isEmpty ? null : recommendations.first;
  }

  /// A count past the free limit goes through the offer first; whatever the
  /// reader settles on there is what the sheet answers with.
  Future<void> _popSelection(int targetPages, String source) async {
    var pages = targetPages;
    var from = source;
    final resolveLocked = widget.resolveLocked;
    if (widget.preflight.locks(pages) && resolveLocked != null) {
      final resolved = await resolveLocked(pages);
      if (resolved == null || !mounted) return;
      if (resolved != pages) from = 'settings';
      pages = resolved;
    }
    if (!mounted) return;
    Navigator.of(
      context,
    ).pop(_PageCountSelection(targetPages: pages, source: from));
  }

  /// The recommendations, plus the free tier's longest book when every one of
  /// them is past it — a free reader is never left with only locked choices.
  List<MobilePageCountRecommendation> get _options {
    final options = [
      for (final option in widget.preflight.recommendations)
        if (option.targetPages <= widget.ceilingPages) option,
    ]..sort((a, b) => a.targetPages.compareTo(b.targetPages));
    // Every recommendation was past what any plan writes: the longest book
    // that can be written stands in, so Continue still has something to send.
    if (options.isEmpty && widget.preflight.recommendations.isNotEmpty) {
      final ceiling = widget.ceilingPages;
      options.add(
        MobilePageCountRecommendation(
          targetPages: ceiling,
          label: '$ceiling pages',
          description: 'The longest book Tomeza writes right now.',
        ),
      );
    }
    final max = widget.preflight.maxPages;
    if (max != null &&
        max > 0 &&
        options.isNotEmpty &&
        options.every((option) => option.targetPages > max)) {
      options.insert(
        0,
        MobilePageCountRecommendation(
          targetPages: max,
          label: '$max pages',
          description: 'The longest book the free plan writes.',
        ),
      );
    }
    return options;
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final colors = Theme.of(context).colorScheme;
    final recommendations = _options;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: _ScrollableFooterContext(
        key: const ValueKey('page-count-scroll'),
        fadeColor: colors.surfaceContainerLowest,
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
            const SizedBox(height: AppSpacing.xxs),
            Text(
              'Your chat did not say how long the book should be. Pick a length, or type your own.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.sm),
            for (final recommendation in recommendations) ...[
              _PageCountOption(
                recommendation: recommendation,
                credits: widget.estimateCredits(recommendation.targetPages),
                locked: widget.preflight.locks(recommendation.targetPages),
                onTap: () => unawaited(
                  _popSelection(recommendation.targetPages, 'recommended'),
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
            ],
            if (recommendations.isNotEmpty) ...[
              Text(
                'Book after approval only: charged after you approve the plan. Planning is charged separately when Build starts.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: AppSpacing.md),
            ],
            TextField(
              controller: _customController,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                labelText: 'Custom pages',
                helperMaxLines: 4,
                helperText: _customPages == null
                    ? 'Enter a number from 1 to ${widget.ceilingPages}.'
                    : widget.preflight.locks(_customPages!)
                    ? '$_customPages pages needs a plan — free books go up '
                          'to ${widget.preflight.maxPages} pages.'
                    : '≈ ${widget.estimateCredits(_customPages!)} credits '
                          'for $_customPages pages.',
              ),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) {
                final pages = _customPages;
                if (pages != null) {
                  unawaited(_popSelection(pages, 'settings'));
                }
              },
            ),
            const SizedBox(height: 14),
            AppActionGroup(
              primary: ValueListenableBuilder<TextEditingValue>(
                valueListenable: _customController,
                builder: (context, value, child) {
                  final customPages = _customPages;
                  if (value.text.trim().isNotEmpty) {
                    return AppButton.primary(
                      onPressed: customPages == null
                          ? null
                          : () => unawaited(
                              _popSelection(customPages, 'settings'),
                            ),
                      label:
                          customPages != null &&
                              widget.preflight.locks(customPages)
                          ? 'Unlock $customPages pages'
                          : 'Use custom',
                      expanded: true,
                    );
                  }
                  final recommended = _continueRecommendation;
                  return AppButton.primary(
                    onPressed: recommended == null
                        ? null
                        : () => unawaited(
                            _popSelection(
                              recommended.targetPages,
                              'recommended',
                            ),
                          ),
                    label: 'Continue',
                    expanded: true,
                  );
                },
              ),
              secondary: [
                AppButton.outlined(
                  onPressed: () => Navigator.of(context).pop(),
                  label: 'Cancel',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One recommended count with its price or plan badge and optional label.
class _PageCountOption extends StatelessWidget {
  const _PageCountOption({
    required this.recommendation,
    required this.credits,
    required this.onTap,
    this.locked = false,
  });

  final MobilePageCountRecommendation recommendation;
  final int credits;
  final VoidCallback onTap;

  /// Past the free limit: still offered, with the plan badge where the price
  /// would be, because a tap opens the offer rather than choosing it.
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final pagesLabel = '${recommendation.targetPages} pages';
    return Card(
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.control),
        side: BorderSide(
          color: recommendation.isRecommended
              ? colors.primary
              : colors.outlineVariant,
          width: recommendation.isRecommended ? 2 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: AppSpacing.sm,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: AppSpacing.xs,
                runSpacing: AppSpacing.xxs,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    pagesLabel,
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  if (recommendation.isRecommended)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.xs,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: colors.primaryContainer,
                        borderRadius: BorderRadius.circular(AppRadii.compact),
                      ),
                      child: Text(
                        'Recommended',
                        style: text.labelSmall?.copyWith(
                          color: colors.onPrimaryContainer,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  if (locked)
                    Container(
                      key: ValueKey(
                        'page-option-locked-${recommendation.targetPages}',
                      ),
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.xs,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        border: Border.all(color: colors.primary),
                        borderRadius: BorderRadius.circular(AppRadii.compact),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.lock_outline,
                            size: 14,
                            color: colors.primary,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            'With a plan',
                            style: text.labelSmall?.copyWith(
                              color: colors.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    Text(
                      '≈ $credits credits',
                      style: text.labelMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: colors.primary,
                      ),
                    ),
                ],
              ),
              if (recommendation.label != pagesLabel) ...[
                const SizedBox(height: 2),
                Text(recommendation.label, style: text.labelMedium),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Runs the long-book offer for [limit] and answers with the page count to
/// use: the one asked for once the reader has a plan, the free tier's longest
/// if they chose to keep it free, or null when they closed the offer.
Future<int?> _resolveLongBook(
  BuildContext context,
  WidgetRef ref,
  BookPageLimit limit,
) async {
  final choice = await showLongBookOffer(context, limit: limit);
  ref.invalidate(billingProvider);
  return switch (choice) {
    LongBookChoice.unlocked => limit.requestedPages,
    LongBookChoice.shorten => limit.limit,
    null => null,
  };
}
