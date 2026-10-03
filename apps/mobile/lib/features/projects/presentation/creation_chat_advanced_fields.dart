part of 'creation_chat_screen.dart';

// The controls inside the Advanced settings sheet, split out from the sheets
// themselves so neither file outgrows its budget. They are dumb widgets: each
// takes its current value and a callback, and the sheet in
// `creation_chat_sheets.dart` is what knows the controller.

/// A section's title, with the "Your choice" mark beside it when the reader
/// overrode what the studio proposed. Every control below opens with one.
class _FieldTitle extends StatelessWidget {
  const _FieldTitle(this.title, {this.yourChoice = false});

  final String title;
  final bool yourChoice;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
        ),
        if (yourChoice)
          const AppStatusBadge(label: 'Your choice', icon: Icons.tune_outlined),
      ],
    );
  }
}

/// Book type as chips: eight short names are all visible at once, where the
/// dropdown this replaced hid seven of them behind a tap. The chosen option's
/// one-line description sits under the row.
class _BookTypePicker extends StatelessWidget {
  const _BookTypePicker({
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
    final colors = Theme.of(context).colorScheme;
    final selectedOption = options.firstWhere(
      (option) => option.value == selected,
      orElse: () => options.first,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FieldTitle(title, yourChoice: yourChoice),
        const SizedBox(height: AppSpacing.xs),
        Wrap(
          key: ValueKey('book-type-${selectedOption.value}'),
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xs,
          children: [
            for (final option in options)
              ChoiceChip(
                avatar: Icon(option.icon, size: 18),
                label: Text(option.title),
                selected: option.value == selectedOption.value,
                showCheckmark: false,
                onSelected: (_) => onChanged(option.value),
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        // Subtitles are whole sentences; the line wraps rather than clipping.
        AppSwitcher(
          child: Text(
            selectedOption.subtitle,
            key: ValueKey(selectedOption.value),
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

/// Page count as presets first, an exact number second. Most readers want "a
/// short one" or "about forty", and a bare number field asked them to know.
///
/// On the free plan the lengths past [maxPages] stay on screen with a lock
/// rather than disappearing: a reader who can see the forty-page book is one
/// tap from the offer that unlocks it. A locked chip opens that offer instead
/// of selecting ([onLocked]); a typed count past it is kept — the field is the
/// reader's own words — and the caption turns into the way to unlock it.
class _PageCountControl extends StatefulWidget {
  const _PageCountControl({
    required this.title,
    required this.yourChoice,
    required this.presets,
    required this.onAuto,
    required this.onCustom,
    this.estimateCredits,
    this.maxPages,
    this.onLocked,
  });

  final String title;
  final bool yourChoice;
  final MobileCreationPresets presets;
  final VoidCallback onAuto;
  final void Function(int targetPages, {String source}) onCustom;
  final int Function(int targetPages)? estimateCredits;

  /// The longest book this reader may build; null on a paid plan.
  final int? maxPages;

  /// Opens the long-book offer for a count past [maxPages].
  final Future<void> Function(int targetPages)? onLocked;

  bool _locks(int pages) => maxPages != null && pages > maxPages!;

  @override
  State<_PageCountControl> createState() => _PageCountControlState();
}

class _PageCountControlState extends State<_PageCountControl> {
  /// Common lengths, from a lead magnet to a full guide. Not a price table:
  /// each one is quoted through the same estimate as any typed count.
  static const _presetPages = [12, 24, 40, 60];

  late final TextEditingController _controller;

  /// Whether the exact-number field is open. A count that is not one of the
  /// presets keeps it open, since the field is the only place it can be read.
  late bool _customOpen;

  int? get _committedPages => widget.presets.pageCountMode == 'custom'
      ? widget.presets.targetPages
      : null;

  @override
  void initState() {
    super.initState();
    final pages = _committedPages;
    _customOpen = pages != null && !_presetPages.contains(pages);
    _controller = TextEditingController(text: _customOpen ? '$pages' : '');
  }

  @override
  void didUpdateWidget(covariant _PageCountControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    final pages = _committedPages;
    if (pages == null) {
      if (!_customOpen && _controller.text.isNotEmpty) _controller.clear();
      return;
    }
    if (_customOpen &&
        '$pages' != _controller.text &&
        _controller.text.isEmpty) {
      _controller.text = '$pages';
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  int? _validPages(String value) {
    final pages = int.tryParse(value.trim());
    if (pages == null || pages < 1 || pages > 600) return null;
    return pages;
  }

  void _onCustomChanged(String value) {
    final pages = _validPages(value);
    if (pages != null) widget.onCustom(pages);
  }

  /// What a free reader sees under a count past their limit: what it needs,
  /// and the way to get it, in place of the price line.
  Widget _lockedCaption(BuildContext context, int pages) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final onLocked = widget.onLocked;
    return Container(
      key: const ValueKey('page-count-locked'),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(
        color: colors.primaryContainer.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(AppRadii.control),
      ),
      child: Row(
        children: [
          Icon(Icons.lock_outline, size: 18, color: colors.primary),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Text(
              '$pages pages is a plan perk. Free books go up to '
              '${widget.maxPages} pages.',
              style: text.bodySmall,
            ),
          ),
          if (onLocked != null)
            TextButton(
              onPressed: () => unawaited(onLocked(pages)),
              child: const Text('Unlock'),
            ),
        ],
      ),
    );
  }

  /// The one place the cost of the chosen count is said, in the same terms as
  /// the plan-approval dialog.
  String _caption(int? pages, bool auto) {
    if (auto) return 'Ask me before building if the chat does not say pages.';
    final estimate = widget.estimateCredits;
    if (pages == null || estimate == null) {
      return 'Enter a number from 1 to 600.';
    }
    return 'Book after approval: ≈ ${estimate(pages)} credits for '
        '$pages pages, charged only after plan approval.';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final committed = _committedPages;
    final auto = !_customOpen && committed == null;
    final typed = _validPages(_controller.text);
    final captionPages = _customOpen ? typed : committed;
    final invalid =
        _controller.text.isNotEmpty && _validPages(_controller.text) == null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FieldTitle(widget.title, yourChoice: widget.yourChoice),
        const SizedBox(height: AppSpacing.xs),
        Wrap(
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xs,
          children: [
            ChoiceChip(
              avatar: const Icon(Icons.auto_awesome_outlined, size: 18),
              label: const Text('Auto'),
              selected: auto,
              showCheckmark: false,
              onSelected: (_) {
                setState(() => _customOpen = false);
                widget.onAuto();
              },
            ),
            for (final pages in _presetPages)
              ChoiceChip(
                key: ValueKey('page-preset-$pages'),
                avatar: widget._locks(pages)
                    ? const Icon(Icons.lock_outline, size: 18)
                    : null,
                label: Text('$pages pages'),
                tooltip: widget._locks(pages)
                    ? 'Books over ${widget.maxPages} pages need a plan'
                    : null,
                selected: !_customOpen && committed == pages,
                showCheckmark: false,
                onSelected: (_) {
                  final onLocked = widget.onLocked;
                  if (widget._locks(pages) &&
                      committed != pages &&
                      onLocked != null) {
                    unawaited(onLocked(pages));
                    return;
                  }
                  setState(() => _customOpen = false);
                  _controller.clear();
                  widget.onCustom(pages);
                },
              ),
            ChoiceChip(
              avatar: const Icon(Icons.edit_outlined, size: 18),
              label: const Text('Custom'),
              selected:
                  _customOpen ||
                  (committed != null && !_presetPages.contains(committed)),
              showCheckmark: false,
              onSelected: (_) => setState(() => _customOpen = true),
            ),
          ],
        ),
        if (_customOpen) ...[
          const SizedBox(height: AppSpacing.xs),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Pages',
              errorText: invalid ? 'Use 1 to 600 pages.' : null,
              filled: true,
              fillColor: colors.surface,
            ),
            onChanged: (value) {
              setState(() {});
              _onCustomChanged(value);
            },
          ),
        ],
        const SizedBox(height: AppSpacing.xs),
        if (!auto && captionPages != null && widget._locks(captionPages))
          _lockedCaption(context, captionPages)
        else
          Text(
            _caption(captionPages, auto),
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
      ],
    );
  }
}

/// The effort tiers as compact cards: the name and one plain line about what
/// you get, then what it costs. All four prices stay on screen because the
/// choice *is* a choice of price — but they sit under the words, not in them.
class _AdvancedGroup extends StatelessWidget {
  const _AdvancedGroup({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
    this.creditsPerPage,
    this.planCredits,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  /// What each option costs per page of writing, when the options are priced
  /// apart. Shown on the tile itself: a reader choosing between effort levels
  /// is choosing between prices, and finding that out from the estimate badge
  /// after the fact is how a tap becomes a surprise.
  ///
  /// A rate rather than a total, because the total answers a question the
  /// reader has not been asked yet — the page count is still 'auto' here. And
  /// writing only: illustrations are their own switch, priced per image a few
  /// rows down, so folding them in would make one number answer for two
  /// choices.
  final int Function(String value)? creditsPerPage;
  final int Function(String value)? planCredits;

  /// One plain line per tier. The presets' own subtitles are the fallback for a
  /// tier this map does not know.
  static const _blurbs = {
    'fast': 'Fastest. A solid first pass to judge the shape.',
    'balanced': 'Our everyday choice: clear, useful, well checked.',
    'premium': 'Stronger writing, with an extra review pass.',
    'ultra': 'Our best: extra drafts, the strongest one polished.',
  };

  String? _priceFor(CreationPresetOption option) {
    final rate = creditsPerPage?.call(option.value);
    final planning = planCredits?.call(option.value);
    if (rate == null && planning == null) return null;
    return [
      if (planning != null) 'Plan now: ${formatCredits(planning)} credits',
      if (rate != null) 'Book after approval: ≈ $rate credits per page',
    ].join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FieldTitle(title, yourChoice: yourChoice),
        const SizedBox(height: AppSpacing.xs),
        for (final option in options) ...[
          _CompactChoiceTile(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            blurb: _blurbs[option.value] ?? option.subtitle,
            detail: _priceFor(option),
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: AppSpacing.xs),
        ],
      ],
    );
  }
}

/// A radio-style card that fits three short lines in about 80dp: the compact
/// sibling of [AppChoiceTile], which is sized for a one-of-two decision, not a
/// column of four. Announces itself the same way, detail included.
class _CompactChoiceTile extends StatelessWidget {
  const _CompactChoiceTile({
    required this.selected,
    required this.icon,
    required this.title,
    required this.blurb,
    required this.onTap,
    this.detail,
  });

  final bool selected;
  final IconData icon;
  final String title;
  final String blurb;
  final String? detail;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final foreground = selected ? colors.onPrimaryContainer : colors.onSurface;
    final support = selected
        ? colors.onPrimaryContainer
        : colors.onSurfaceVariant;
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: [title, blurb, ?detail].join('. '),
      onTap: onTap,
      child: ExcludeSemantics(
        child: Card(
          margin: EdgeInsets.zero,
          color: selected ? colors.primaryContainer : null,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.card),
            side: selected
                ? BorderSide(
                    color: colors.primary.withValues(alpha: 0.45),
                    width: 1.4,
                  )
                : BorderSide(color: colors.outlineVariant),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.sm,
                  vertical: AppSpacing.sm,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Icon(
                        icon,
                        size: 22,
                        color: selected ? foreground : colors.primary,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: text.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                              color: foreground,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            blurb,
                            style: text.bodySmall?.copyWith(color: support),
                          ),
                          if (detail != null) ...[
                            const SizedBox(height: 4),
                            Text(
                              detail!,
                              style: text.labelSmall?.copyWith(
                                color: selected ? foreground : colors.primary,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Icon(
                      selected
                          ? Icons.radio_button_checked
                          : Icons.radio_button_unchecked,
                      size: 22,
                      color: selected ? foreground : colors.outline,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
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
    final options = creationLanguageOptionsFor(language);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FieldTitle('Language', yourChoice: yourChoice),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: language.isEmpty ? 'en' : language,
          isExpanded: true,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.translate_outlined),
          ),
          items: [
            for (final option in options)
              DropdownMenuItem(
                value: option.code,
                child: Text(option.label, overflow: TextOverflow.ellipsis),
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

/// The tone chips, which unlike every other control here have an off state
/// reachable only by tapping the selected chip again.
///
/// Tone has no "Auto" entry to return to — the row is the five examples and
/// nothing else — so a chip that only ever selects made the first tap
/// irreversible: the reader could swap warm for gentle but never get back to
/// letting the studio choose. Tapping the selected chip clears it, which is
/// what [ChoiceChip.onSelected] reports as `false`.
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
        _FieldTitle('Tone', yourChoice: yourChoice),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in _toneExamples)
              ChoiceChip(
                label: Text(option),
                selected: tone.toLowerCase() == option,
                onSelected: (selected) => onChanged(selected ? option : ''),
              ),
          ],
        ),
      ],
    );
  }
}

/// Whose name goes on the finished book.
///
/// No "Your choice" badge and no [CreationChoice] entry, unlike every field
/// above: the badge marks a value the studio proposed and the reader overrode,
/// and the studio still proposes no byline. A name stated in chat does land
/// here — `mergeChatOptionalDetails` fills it — but that is the reader's own
/// words being transcribed, not a suggestion to accept or reject. Stateful
/// only to own the controller across sheet rebuilds; the chat cannot run while
/// this sheet is open, and each open builds a fresh state from the field, so
/// there is no live external change to resync from.
class _AuthorNameField extends StatefulWidget {
  const _AuthorNameField({required this.authorName, required this.onChanged});

  final String authorName;
  final ValueChanged<String> onChanged;

  @override
  State<_AuthorNameField> createState() => _AuthorNameFieldState();
}

class _AuthorNameFieldState extends State<_AuthorNameField> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.authorName,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _FieldTitle('Author name'),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('author-name-field'),
          controller: _controller,
          // Matches the server bound on optionalDetails.authorName.
          maxLength: 120,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.done,
          decoration: InputDecoration(
            hintText: 'Whose name goes on the cover?',
            helperText: 'Printed once on the book cover.',
            counterText: '',
            filled: true,
            fillColor: Theme.of(context).colorScheme.surface,
          ),
          onChanged: widget.onChanged,
        ),
      ],
    );
  }
}

/// The rarely-touched settings — language, tone, author name — folded behind
/// one row so the sheet opens on the choices that change a book's shape and
/// price. Opens by itself when any of them is already set, so a value the
/// reader (or the chat) chose is never hidden.
class _MoreOptions extends StatefulWidget {
  const _MoreOptions({
    required this.summary,
    required this.initiallyOpen,
    required this.children,
  });

  /// What is set inside, in a few words, shown while folded.
  final String summary;
  final bool initiallyOpen;
  final List<Widget> children;

  @override
  State<_MoreOptions> createState() => _MoreOptionsState();
}

class _MoreOptionsState extends State<_MoreOptions> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final reduced = AppMotion.reducedMotion(context);
    void toggle() => setState(() => _open = !_open);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          container: true,
          button: true,
          expanded: _open,
          label: 'More options. ${widget.summary}',
          onTap: toggle,
          child: ExcludeSemantics(
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadii.control),
              onTap: toggle,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'More options',
                            style: text.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          Text(
                            widget.summary,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: text.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    AnimatedRotation(
                      turns: _open ? 0.5 : 0,
                      duration: reduced ? Duration.zero : AppMotion.medium,
                      child: Icon(
                        Icons.expand_more,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: reduced ? Duration.zero : AppMotion.medium,
          curve: AppMotion.enter,
          alignment: Alignment.topCenter,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var i = 0; i < widget.children.length; i++) ...[
                        if (i > 0) const SizedBox(height: AppSpacing.md),
                        widget.children[i],
                      ],
                    ],
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}
