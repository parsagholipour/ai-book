part of 'creation_chat_screen.dart';

// The controls inside the Advanced settings sheet, split out from the sheets
// themselves so neither file outgrows its budget. They are dumb widgets: each
// takes its current value and a callback, and the sheet in
// `creation_chat_sheets.dart` is what knows the controller.

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
    final options = creationLanguageOptionsFor(language);
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
        Text(
          'Author name',
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
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
            helperText: 'Printed on the cover and the title page.',
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
