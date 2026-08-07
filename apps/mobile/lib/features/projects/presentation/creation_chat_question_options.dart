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
  });

  final List<String> options;
  final bool enabled;
  final bool multiSelect;
  final ValueChanged<String> onSelect;
  final VoidCallback onSkip;
  final VoidCallback? onCustom;

  /// Shown in place of the choices when there are none.
  final String? openAnswerHint;

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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.options.isEmpty && widget.openAnswerHint != null)
          Row(
            children: [
              Icon(
                Icons.keyboard_outlined,
                size: 16,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  widget.openAnswerHint!,
                  style: theme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        if (multi) ...[
          Text(
            'Pick as many as you like.',
            style: theme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          const SizedBox(height: 6),
        ],
        for (var i = 0; i < widget.options.length; i++) ...[
          if (i > 0) const SizedBox(height: 4),
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
                ? () => _toggle(widget.options[i])
                : () => widget.onSelect(widget.options[i]),
          ),
        ],
        const SizedBox(height: 4),
        Row(
          children: [
            if (widget.onCustom != null)
              TextButton.icon(
                onPressed: widget.enabled ? widget.onCustom : null,
                icon: const Icon(Icons.edit_outlined, size: 16),
                label: const Text('Custom…'),
              ),
            TextButton.icon(
              onPressed: widget.enabled ? widget.onSkip : null,
              icon: const Icon(Icons.skip_next_outlined, size: 18),
              label: const Text('Skip'),
            ),
            if (multi) ...[
              const Spacer(),
              FilledButton.icon(
                onPressed: widget.enabled && _selected.isNotEmpty
                    ? () => widget.onSelect(_sendableAnswer())
                    : null,
                icon: const Icon(Icons.send_rounded, size: 16),
                label: Text(
                  _selected.length <= 1
                      ? 'Send answer'
                      : 'Send ${_selected.length} answers',
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  /// The picks in the order they were offered, so the sent line reads like the
  /// question did rather than like the order they happened to be tapped in.
  String _sendableAnswer() => joinQuestionAnswers(
    widget.options.where(_selected.contains),
  );
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
    return Semantics(
      button: leading != null,
      checked: leading == null ? selected : null,
      child: Material(
        color: selected ? colors.primaryContainer : colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 22,
                  child:
                      leading ??
                      Icon(
                        selected
                            ? Icons.check_box_rounded
                            : Icons.check_box_outline_blank_rounded,
                        size: 20,
                        color: selected ? colors.primary : colors.outline,
                      ),
                ),
                const SizedBox(width: 6),
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
    );
  }
}
