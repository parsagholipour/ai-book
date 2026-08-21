import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';

/// How much text the description field will hold at all, as a multiple of the
/// cap it advertises. See [CharacterDescriptionField]: the two bounds differ in
/// kind, not only in size.
const _descriptionCeilingMultiple = 20;

/// The character's description, and everything on screen about its length.
///
/// **The cap is advisory — prose past it is refused, never truncated.** Nothing
/// between this field and the update route enforces it, because the editor
/// writes this controller directly when it follows a mention target's rename
/// into the prose, and that write can land past the cap. With `maxLength`
/// enforced, the next keystroke that stayed over then ran
/// `truncate(newValue, max)` and took the *tail* — prose and `@markers` nowhere
/// near the caret, again on every keystroke after — and
/// `truncateAfterCompositionEnds` only defers that. So the field says how far
/// over it is, Save holds the body back, and a reader who pasted too much is
/// asked to shorten it rather than handed a copy already shortened for them
/// somewhere they were not looking.
///
/// **The ceiling is a different bound wearing the same shape.** Refusing to
/// truncate is a promise about descriptions, not about documents: nothing
/// bounded what this field would hold *at all*, so a select-all paste of a
/// whole manuscript left the controller carrying it — laid out by a six-line
/// field, diffed through the platform text channel on every keystroke after,
/// and re-measured by the editor on each one, which is the cost the editor's
/// own [characterDescriptionOverflow] short-circuit cannot reach. Twenty times
/// the cap is some thirteen printed pages, so anything a reader *meant* as a
/// description is orders of magnitude under it and meets the refusal above —
/// that is what the multiple is for, and why it may be raised but not tightened
/// toward the cap. Past the ceiling a paste arrives clipped and refused rather
/// than accepted, and at the ceiling a keystroke is a no-op rather than an
/// edit; both are only reachable with text nobody was going to fix inside a
/// six-line box.
class CharacterDescriptionField extends StatelessWidget {
  const CharacterDescriptionField({
    super.key,
    required this.controller,
    required this.max,
    required this.overflow,
    required this.onChanged,
  });

  final TextEditingController controller;

  /// The cap the counter is drawn against, mirrored from the update route.
  final int max;

  /// How far past [max] the description is right now; 0 while it fits.
  final int overflow;

  /// The reader typed in the description themselves — which is the only thing
  /// that makes the editor send one.
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return TextField(
      key: const ValueKey('character-description-field'),
      controller: controller,
      maxLength: max,
      maxLengthEnforcement: MaxLengthEnforcement.none,
      inputFormatters: [
        LengthLimitingTextInputFormatter(max * _descriptionCeilingMultiple),
      ],
      minLines: 3,
      maxLines: 6,
      decoration: InputDecoration(
        labelText: 'Description',
        // The counter every field here hides, shown for the one state it
        // answers, and the only thing that says why a Save was refused.
        counterText: overflow == 0 ? '' : '${max + overflow}/$max',
        hintText: 'What they look like, how they act, who they are.',
        errorText: overflow == 0 ? null : 'Too long to save.',
      ),
      onChanged: (_) => onChanged(),
    );
  }
}

/// How far [text] is past the description's cap of [max]; 0 while it fits.
///
/// Measured on the **trimmed** string, because that is the only string anything
/// counts: the editor's Save sends `text.trim()`, and the route's own
/// `z.string().trim().max(…)` counts what it stores. Reading the field's own
/// text instead put a trailing newline over the cap — "Too long to save." under
/// a 2001/2000 counter, over whitespace the reader cannot see — while the Save
/// trimmed it off and sent the description anyway. One unit follows from the
/// same choice: [CharacterDescriptionField] counts grapheme clusters and zod
/// counts UTF-16 units, but a trimmed string's grapheme reading is never the
/// longer one, and the field enforces nothing, so the route's is the only
/// ceiling that decides a save.
int characterDescriptionOverflow(String text, int max) {
  final over = text.trim().length - max;
  return over > 0 ? over : 0;
}

/// The two controllers behind one "Detail" row of the character editor.
///
/// Rows taken out of the form stay alive until the sheet closes: their text
/// fields may still be animating out when they are removed, so the sheet parks
/// them rather than disposing them where they are removed.
class CharacterDetailRow {
  CharacterDetailRow({String key = '', String value = ''})
    : key = TextEditingController(text: key),
      value = TextEditingController(text: value);

  final TextEditingController key;
  final TextEditingController value;

  void dispose() {
    key.dispose();
    value.dispose();
  }
}

/// One label/value pair of the character's Details list.
class CharacterDetailRowField extends StatelessWidget {
  const CharacterDetailRowField({
    super.key,
    required this.row,
    required this.keyMax,
    required this.valueMax,
    required this.onRemove,
  });

  final CharacterDetailRow row;
  final int keyMax;
  final int valueMax;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 2,
            child: TextField(
              controller: row.key,
              maxLength: keyMax,
              decoration: const InputDecoration(
                labelText: 'Detail',
                counterText: '',
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            flex: 3,
            child: TextField(
              controller: row.value,
              maxLength: valueMax,
              decoration: const InputDecoration(
                labelText: 'Value',
                counterText: '',
              ),
            ),
          ),
          IconButton(
            tooltip: 'Remove detail',
            icon: const Icon(Icons.close),
            onPressed: onRemove,
          ),
        ],
      ),
    );
  }
}

/// The description the server read off the character's photo, while it is
/// still on offer.
///
/// Accepting it only fills the field — nothing is sent, and Save carries it
/// like anything else the reader typed. Dismissing is the one control here
/// that reaches the server on its own.
class CharacterSuggestionCard extends StatelessWidget {
  const CharacterSuggestionCard({
    super.key,
    required this.suggestion,
    required this.onUse,
    required this.onDismiss,
  });

  final String suggestion;
  final VoidCallback? onUse;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.auto_awesome_outlined,
                  size: 16,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(
                  'Suggested from your photo',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(suggestion, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 2),
            Row(
              children: [
                AppButton.text(label: 'Use this', onPressed: onUse),
                AppButton.text(label: 'Dismiss', onPressed: onDismiss),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
