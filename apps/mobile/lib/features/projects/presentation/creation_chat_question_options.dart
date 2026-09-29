part of 'creation_chat_screen.dart';

// The answer list shared by the two question drawers: the interviewer's
// clarification in the composer footer and the planner's question in the plan
// footer. Imports live in the parent library file.

/// Numbered answer choices for a question drawer (not chips/badges).
///
/// An empty [options] list is an open question: the answer is a value only the
/// reader can supply, so the card points at the message box instead of showing
/// invented choices. The keyboard stays down until they tap it.
///
/// When [multiSelect] is true the rows become checkboxes and nothing is sent
/// until the reader confirms, because a question several options answer at once
/// ("which of these themes?") is only answered by the whole set they picked.
class _QuestionOptionList extends StatefulWidget {
  const _QuestionOptionList({
    required this.options,
    required this.enabled,
    required this.onSelect,
    required this.onSkip,
    this.multiSelect = false,
    this.onCustom,
    this.openAnswerHint,
    this.multiSelectHint,
  });

  final List<String> options;
  final bool enabled;
  final bool multiSelect;
  final ValueChanged<String> onSelect;
  final VoidCallback onSkip;
  final VoidCallback? onCustom;

  /// Shown in place of the choices when there are none.
  final String? openAnswerHint;

  /// Localized "pick several" hint; falls back to English when absent.
  final String? multiSelectHint;

  @override
  State<_QuestionOptionList> createState() => _QuestionOptionListState();
}

class _QuestionOptionListState extends State<_QuestionOptionList> {
  final _selected = <String>{};

  @override
  void didUpdateWidget(covariant _QuestionOptionList oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A new question reuses this element (the composer footer keeps its slot),
    // so picks made against the old options must not travel with it.
    if (!listEquals(oldWidget.options, widget.options)) {
      _selected.clear();
    }
  }

  void _toggle(String option) {
    setState(() {
      if (!_selected.remove(option)) {
        _selected.add(option);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    final multi = widget.multiSelect && widget.options.length > 1;
    final picked = _selected.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.options.isEmpty && widget.openAnswerHint != null)
          Row(
            children: [
              Icon(
                Icons.keyboard_outlined,
                size: 18,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.openAnswerHint!,
                  style: theme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        if (multi) ...[
          // How many it takes is the thing a multi question has to say up
          // front, and how many are chosen so far is the thing the button
          // below it repeats — so the count sits here, beside the rule.
          Row(
            children: [
              Icon(
                Icons.checklist_rounded,
                size: 18,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.multiSelectHint ?? 'Pick as many as you like.',
                  style: theme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
              if (picked > 0) ...[
                const SizedBox(width: 8),
                Semantics(
                  liveRegion: true,
                  child: Text(
                    '$picked selected',
                    style: theme.labelMedium?.copyWith(
                      color: colors.primary,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
        ],
        for (var i = 0; i < widget.options.length; i++) ...[
          if (i > 0) const SizedBox(height: 6),
          _QuestionOptionRow(
            option: widget.options[i],
            leading: multi
                ? null
                : Text(
                    '${i + 1}.',
                    style: theme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: colors.primary,
                    ),
                  ),
            selected: multi && _selected.contains(widget.options[i]),
            enabled: widget.enabled,
            onTap: multi
                ? () {
                    AppHaptics.selection();
                    _toggle(widget.options[i]);
                  }
                : () {
                    AppHaptics.selection();
                    widget.onSelect(widget.options[i]);
                  },
          ),
        ],
        const SizedBox(height: 6),
        // A Wrap, not a Row: Custom, Skip and Send outgrow one line at a large
        // text size, and Send drops below them instead of overflowing.
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.onCustom != null)
                  AppButton.text(
                    onPressed: widget.enabled ? widget.onCustom : null,
                    leading: const Icon(Icons.edit_outlined, size: 16),
                    label: 'Custom…',
                  ),
                AppButton.text(
                  onPressed: widget.enabled ? widget.onSkip : null,
                  leading: const Icon(Icons.skip_next_outlined, size: 18),
                  label: 'Skip',
                ),
              ],
            ),
            if (multi)
              AppButton.primary(
                onPressed: widget.enabled && _selected.isNotEmpty
                    ? () => widget.onSelect(_sendableAnswer())
                    : null,
                leading: const Icon(Icons.send_rounded, size: 16),
                label: _selected.length <= 1
                    ? 'Send answer'
                    : 'Send ${_selected.length} answers',
              ),
          ],
        ),
      ],
    );
  }

  /// The picks in the order they were offered, so the sent line reads like the
  /// question did rather than like the order they happened to be tapped in.
  String _sendableAnswer() =>
      joinQuestionAnswers(widget.options.where(_selected.contains));
}

class _QuestionOptionRow extends StatelessWidget {
  const _QuestionOptionRow({
    required this.option,
    required this.leading,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final String option;

  /// The row number for a single-answer question; null for a checkbox row.
  final Widget? leading;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadii.control),
      side: BorderSide(
        color: selected
            ? colors.primary.withValues(alpha: 0.7)
            : colors.outlineVariant,
        width: selected ? 1.6 : 1,
      ),
    );
    return Semantics(
      button: leading != null,
      checked: leading == null ? selected : null,
      child: AnimatedContainer(
        duration: AppMotion.fast,
        curve: AppMotion.standard,
        decoration: ShapeDecoration(
          color: selected ? colors.primaryContainer : colors.surfaceContainer,
          shape: shape,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            customBorder: shape,
            onTap: enabled ? onTap : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 46),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    SizedBox(
                      width: 24,
                      child:
                          leading ??
                          Icon(
                            selected
                                ? Icons.check_box_rounded
                                : Icons.check_box_outline_blank_rounded,
                            size: 22,
                            color: selected ? colors.primary : colors.outline,
                          ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        option,
                        style: theme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: selected ? colors.onPrimaryContainer : null,
                        ),
                      ),
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
