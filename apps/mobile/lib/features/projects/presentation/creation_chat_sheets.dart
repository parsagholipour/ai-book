part of 'creation_chat_screen.dart';

// Modal sheets for source notes, the title and advanced book settings; the
// page-count sheet Build opens lives in creation_chat_page_count_sheet.dart.
// Imports and shared state live in the parent library file.

/// The screen's own openers for the sheets below. They live here, next to the
/// sheets they present, rather than among the screen's chat logic.
extension _CreationChatSheets on _CreationChatScreenState {
  Future<void> openSourceNotesSheet(CreationChatState state) async {
    final controller = TextEditingController(text: state.sourceNotes);
    final saved = await showAppBottomSheet<String>(
      context,
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

  /// Opens at [section] when a chip asked for one, at the top otherwise.
  Future<void> openAdvancedSheet({_AdvancedSection? section}) async {
    final controller = ref.read(creationChatControllerProvider.notifier);
    await showAppBottomSheet<void>(
      context,
      builder: (_) => _AdvancedSheet(controller: controller, section: section),
    );
  }

  Future<void> openTitleSheet() async {
    final state = ref.read(creationChatControllerProvider);
    final working = workingCreationTitle(
      optionalDetails: state.optionalDetails,
      brief: state.brief,
    );
    final saved = await showAppBottomSheet<String>(
      context,
      builder: (_) => _TitleSheet(
        initial: working ?? '',
        suggestions: state.titleSuggestions,
      ),
    );
    final trimmed = saved?.trim() ?? '';
    if (trimmed.isNotEmpty) {
      ref.read(creationChatControllerProvider.notifier).setTitle(trimmed);
    }
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

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
          AppActionGroup(
            primary: AppButton.primary(
              onPressed: () => Navigator.of(context).pop(controller.text),
              label: 'Attach',
              expanded: true,
            ),
            secondary: [
              AppButton.outlined(
                onPressed: () => Navigator.of(context).pop(''),
                label: 'Clear',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Names the book: type a title or take one of the model's suggestions.
/// A sheet rather than chips in the brief header — it holds every suggestion
/// without costing the helper bar a row. Owns its controller: the opener's
/// await resolves before the exit animation finishes, so disposing there
/// would pull the controller out from under the still-animating field.
class _TitleSheet extends StatefulWidget {
  const _TitleSheet({required this.initial, required this.suggestions});

  final String initial;
  final List<String> suggestions;

  @override
  State<_TitleSheet> createState() => _TitleSheetState();
}

class _TitleSheetState extends State<_TitleSheet> {
  late final _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final ideas = <String>[];
    final seen = <String>{};
    for (final suggestion in widget.suggestions) {
      final trimmed = suggestion.trim();
      if (trimmed.isEmpty || !seen.add(trimmed.toLowerCase())) continue;
      ideas.add(trimmed);
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Book title',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'The working title for the cover and the chat — change it any '
              'time before the build.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _controller,
              textInputAction: TextInputAction.done,
              // The server accepts up to 160 characters for a title.
              maxLength: 160,
              onSubmitted: (value) => Navigator.of(context).pop(value),
              decoration: const InputDecoration(labelText: 'Title'),
            ),
            if (ideas.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Ideas from the chat',
                style: Theme.of(
                  context,
                ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final idea in ideas)
                    ActionChip(
                      label: Text(
                        idea,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onPressed: () => Navigator.of(context).pop(idea),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 12),
            AppButton.primary(
              onPressed: () => Navigator.of(context).pop(_controller.text),
              label: 'Use this title',
              expanded: true,
            ),
          ],
        ),
      ),
    );
  }
}

const _yourChoiceBadge = AppStatusBadge(
  label: 'Your choice',
  icon: Icons.tune_outlined,
);

/// The settings a brief chip can open the sheet at.
enum _AdvancedSection { bookType, pages, effort, visuals, more }

class _AdvancedSheet extends ConsumerStatefulWidget {
  const _AdvancedSheet({required this.controller, this.section});

  final CreationChatController controller;
  final _AdvancedSection? section;

  @override
  ConsumerState<_AdvancedSheet> createState() => _AdvancedSheetState();
}

class _AdvancedSheetState extends ConsumerState<_AdvancedSheet> {
  final _sectionKeys = {
    for (final section in _AdvancedSection.values) section: GlobalKey(),
  };

  @override
  void initState() {
    super.initState();
    final section = widget.section;
    if (section == null) return;
    // After the sheet's first layout, so the section has a place to scroll to.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _sectionKeys[section]?.currentContext;
      if (!mounted || target == null) return;
      unawaited(
        Scrollable.ensureVisible(
          target,
          duration: AppMotion.reducedMotion(context)
              ? Duration.zero
              : AppMotion.medium,
          curve: AppMotion.enter,
        ),
      );
    });
  }

  /// A zero-height mark where a section starts: what a chip scrolls to.
  Widget _sectionAnchor(_AdvancedSection section) =>
      SizedBox(key: _sectionKeys[section]);

  /// A locked length was chosen: offer the plan, and take whichever length
  /// the reader settles on — the one they wanted once they have a plan, the
  /// free tier's longest if they would rather keep it free.
  Future<void> _unlockPages(
    int pages,
    CreationChatController controller,
  ) async {
    final limit = ref.read(billingProvider).asData?.value.maxBookPages;
    if (limit == null) {
      controller.setCustomTargetPages(pages);
      return;
    }
    final resolved = await _resolveLongBook(
      context,
      ref,
      BookPageLimit(limit: limit, requestedPages: pages),
    );
    if (resolved != null) controller.setCustomTargetPages(resolved);
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final state = ref.watch(creationChatControllerProvider);
    final presets = state.presets;
    // Watched (not read) so the page-cost estimate reacts to Finish and
    // in-book illustration changes made in this same sheet.
    final creditCosts =
        ref.watch(billingProvider).asData?.value.creditCosts ??
        const <String, dynamic>{};
    // Named on both image switches. Effort changes it — the top tier draws on a
    // better image model — so it is read against the chosen preset.
    final imageCredits = _imageCredits(presets.qualityPreset, creditCosts);
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final colors = Theme.of(context).colorScheme;
    final tone = state.optionalDetails.tone.trim();
    final author = state.optionalDetails.authorName.trim();
    final moreSummary = [
      languageLabel(state.language),
      if (tone.isNotEmpty) tone,
      if (author.isNotEmpty) 'by $author',
    ].join(' · ');

    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(18, 4, 18, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Advanced settings',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Override anything the studio chose. Your selections stick across the conversation.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _sectionAnchor(_AdvancedSection.bookType),
                  _BookTypePicker(
                    title: 'Book type',
                    yourChoice: state.userChoices.contains(
                      CreationChoice.bookType,
                    ),
                    options: bookTypePresetOptions,
                    selected:
                        state.userChoices.contains(CreationChoice.bookType)
                        ? presets.bookTypeChoice
                        : 'auto',
                    onChanged: controller.setBookType,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _sectionAnchor(_AdvancedSection.pages),
                  _PageCountControl(
                    title: 'Pages',
                    yourChoice: state.userChoices.contains(
                      CreationChoice.length,
                    ),
                    presets: presets,
                    onAuto: controller.setPageCountAuto,
                    onCustom: controller.setCustomTargetPages,
                    maxPages: ref
                        .watch(billingProvider)
                        .asData
                        ?.value
                        .maxBookPages,
                    onLocked: (pages) => _unlockPages(pages, controller),
                    estimateCredits: (pages) => estimateProjectCredits(
                      bookType: presets.bookType,
                      bookTypeChoice: presets.bookTypeChoice,
                      qualityPreset: presets.qualityPreset,
                      coverEnabled: presets.coverEnabled,
                      illustrationsEnabled: presets.illustrationsEnabled,
                      targetPages: pages,
                      creditCosts: creditCosts,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  _sectionAnchor(_AdvancedSection.effort),
                  _AdvancedGroup(
                    title: 'Effort',
                    yourChoice: state.userChoices.contains(
                      CreationChoice.finish,
                    ),
                    options: qualityPresetOptions,
                    selected: presets.qualityPreset,
                    onChanged: controller.setQualityPreset,
                    creditsPerPage: (quality) =>
                        _writingCreditsPerPage(presets, quality, creditCosts),
                    planCredits: (quality) => estimatePlanGenerationCredits(
                      qualityPreset: quality,
                      creditCosts: creditCosts,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  _sectionAnchor(_AdvancedSection.visuals),
                  const _FieldTitle('Visuals'),
                  const SizedBox(height: AppSpacing.xs),
                  StableToggleTile(
                    value: presets.coverEnabled,
                    chosen: state.userChoices.contains(CreationChoice.cover),
                    canBeChosen: true,
                    tileFor: (value, chosen) => AppToggleTile(
                      value: value,
                      onChanged: controller.setCoverEnabled,
                      icon: Icons.auto_stories_outlined,
                      title: 'AI cover art',
                      titleBadge: chosen ? _yourChoiceBadge : null,
                      subtitle: _coverSubtitle(
                        value,
                        imageCredits: imageCredits,
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  StableToggleTile(
                    value: presets.illustrationsEnabled,
                    chosen: state.userChoices.contains(
                      CreationChoice.illustrations,
                    ),
                    canBeChosen: true,
                    tileFor: (value, chosen) => AppToggleTile(
                      value: value,
                      onChanged: controller.setIllustrationsEnabled,
                      icon: Icons.image_outlined,
                      title: 'In-book illustrations',
                      titleBadge: chosen ? _yourChoiceBadge : null,
                      subtitle: _illustrationsSubtitle(
                        value,
                        presets.bookType,
                        ref.watch(billingProvider).asData?.value.imageQuota,
                        imageCredits: imageCredits,
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  // Set values open the fold by themselves, so nothing chosen
                  // is ever hidden behind it.
                  _sectionAnchor(_AdvancedSection.more),
                  _MoreOptions(
                    summary: moreSummary,
                    initiallyOpen:
                        state.language != 'en' && state.language.isNotEmpty ||
                        tone.isNotEmpty ||
                        author.isNotEmpty,
                    children: [
                      _LanguageField(
                        language: state.language,
                        yourChoice: state.userChoices.contains(
                          CreationChoice.language,
                        ),
                        onChanged: controller.setLanguage,
                      ),
                      _ToneField(
                        tone: state.optionalDetails.tone,
                        yourChoice: state.userChoices.contains(
                          CreationChoice.tone,
                        ),
                        onChanged: controller.setTone,
                      ),
                      _AuthorNameField(
                        authorName: state.optionalDetails.authorName,
                        onChanged: controller.setAuthorName,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          // Pinned: the way out never scrolls away with the settings.
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
            child: AppButton.primary(
              onPressed: () => Navigator.of(context).pop(),
              label: 'Done',
              expanded: true,
            ),
          ),
        ],
      ),
    );
  }
}

/// Which server refusals the paywall can answer, and what to call it when it
/// opens. Anything else is a snackbar — the paywall is not a general error
/// screen, it is the one that has something to offer.
String? _paywallTitleForError(String? code) => switch (code) {
  'INSUFFICIENT_CREDITS' => 'Credits needed for your plan',
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
        'Creating your book plan now. Writing the book is charged separately, only after you approve the plan.',
  );
}

/// What one page of writing costs at an effort level, images excluded.
///
/// Images are a separate switch two rows down and are priced per image, so
/// blending them into this rate would have one number answer for two
/// independent choices — and it would move every time the reader toggled a
/// picture. Everything the *writing* costs is in it, including the flat parts
/// spread over the pages they produce, so the rates compare the way the bill
/// will: it is the whole quote for a book with no generated images, divided by
/// the pages that book has.
///
/// The page count is the one this book would actually get. `targetPages` is
/// null for as long as the count is 'auto' — which is the default — so the
/// preset's own count stands in, exactly as the brief's estimate badge does.
int _writingCreditsPerPage(
  MobileCreationPresets presets,
  String qualityPreset,
  Map<String, dynamic> creditCosts,
) {
  final pages = presets.pageCountMode == 'custom' && presets.targetPages != null
      ? presets.targetPages!
      : targetPageCountFor(presets.bookType, presets.lengthPreset);
  if (pages < 1) {
    return 0;
  }
  final writingCredits = estimateProjectCredits(
    bookType: presets.bookType,
    qualityPreset: qualityPreset,
    coverEnabled: false,
    illustrationsEnabled: false,
    targetPages: pages,
    creditCosts: creditCosts,
  );
  return (writingCredits / pages).round();
}

/// The per-image price at this effort level, which is what makes images
/// "separate" true rather than merely unstated: the rate above leaves them out,
/// so this is where their cost is named.
int _imageCredits(String qualityPreset, Map<String, dynamic> creditCosts) {
  final withCover = estimateProjectCredits(
    bookType: 'lead_magnet',
    qualityPreset: qualityPreset,
    coverEnabled: true,
    illustrationsEnabled: false,
    targetPages: 1,
    creditCosts: creditCosts,
  );
  final without = estimateProjectCredits(
    bookType: 'lead_magnet',
    qualityPreset: qualityPreset,
    coverEnabled: false,
    illustrationsEnabled: false,
    targetPages: 1,
    creditCosts: creditCosts,
  );
  return withCover - without;
}

/// [imageCredits] is omitted where the surface already itemises the cost —
/// the visuals dialog prints a cover/illustrations/total table right below
/// these switches, and saying it twice reads as two charges.
String _coverSubtitle(bool enabled, {int? imageCredits}) {
  if (!enabled) {
    return 'Free: a designed cover is chosen to match your book.';
  }
  return imageCredits == null
      ? 'One cover image drawn for your book.'
      : 'One cover image drawn for your book, $imageCredits credits.';
}

/// Says what illustrations will cost against the month's budget, when there is
/// one.
/// A null quota is a plan with no image limit, so it says nothing extra.
/// See [_coverSubtitle] for why [imageCredits] is optional.
String _illustrationsSubtitle(
  bool enabled,
  String bookType,
  MobileImageQuota? quota, {
  int? imageCredits,
}) {
  if (!enabled) {
    return 'No generated images inside the book.';
  }
  final base = imageCredits == null
      ? 'Up to ${visualLimitFor(bookType)} in-book illustrations.'
      : 'Up to ${visualLimitFor(bookType)} in-book illustrations, '
            '$imageCredits credits each.';
  if (quota == null) {
    return base;
  }
  if (quota.isExhausted) {
    return '$base You have used all ${quota.limit} illustrated books this month — upgrade to keep going.';
  }
  return '$base ${quota.remaining} of ${quota.limit} illustrated books left this month.';
}
