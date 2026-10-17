import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_models.dart';
import '../domain/library_mentions.dart';

/// How many lines of description show before "Read more".
const int _collapsedDescriptionLines = 5;

/// Who the character is: the description a book writes them from, the details
/// beside it, and the description the server read off their photo while it is
/// still on offer.
class CharacterProfileDetails extends StatelessWidget {
  const CharacterProfileDetails({
    required this.character,
    required this.busy,
    required this.onEdit,
    required this.onUseSuggestion,
    required this.onDismissSuggestion,
    required this.onOpenMention,
    super.key,
  });

  final LibraryCharacter character;
  final bool busy;
  final VoidCallback onEdit;
  final void Function(String suggestion) onUseSuggestion;
  final VoidCallback onDismissSuggestion;
  final ValueChanged<String> onOpenMention;

  String? get _suggestion {
    final suggestion = character.suggestedDescription?.trim();
    if (suggestion == null || suggestion.isEmpty) return null;
    // Already what they have; offering it back would be noise.
    return suggestion == character.description.trim() ? null : suggestion;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final suggestion = _suggestion;
    final hasDescription = character.description.trim().isNotEmpty;
    final hasDetails = character.fields.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // No pencil here: the Edit action is one screen up, and a second one
        // beside the heading read as a different action.
        const AppSectionHeader(title: 'About'),
        const SizedBox(height: AppSpacing.xs),
        if (!hasDescription && !hasDetails)
          _WriteNudge(busy: busy, onEdit: onEdit)
        else if (!hasDescription)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Write a description',
              leading: const Icon(Icons.notes_outlined),
              onPressed: busy ? null : onEdit,
            ),
          )
        else
          _ExpandableDescription(
            character: character,
            onOpenMention: onOpenMention,
          ),
        if (suggestion != null) ...[
          const SizedBox(height: AppSpacing.sm),
          AppCard(
            tone: AppTone.info,
            density: AppCardDensity.compact,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'From your picture',
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: AppSpacing.xxs),
                Text(suggestion, style: theme.textTheme.bodySmall),
                const SizedBox(height: AppSpacing.xs),
                // Offered, never applied: only the reader tapping this puts it
                // in their description.
                AppActionGroup(
                  primary: AppButton.tonal(
                    key: const ValueKey('character-use-suggestion'),
                    label: 'Use this',
                    onPressed: busy ? null : () => onUseSuggestion(suggestion),
                  ),
                  secondary: [
                    AppButton.text(
                      label: 'No thanks',
                      onPressed: busy ? null : onDismissSuggestion,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
        if (hasDetails) ...[
          const SizedBox(height: AppSpacing.lg),
          const AppSectionHeader(title: 'Details'),
          const SizedBox(height: AppSpacing.xs),
          _DetailsCard(fields: character.fields),
        ] else if (hasDescription) ...[
          const SizedBox(height: AppSpacing.xs),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Add details',
              leading: const Icon(Icons.add),
              onPressed: busy ? null : onEdit,
            ),
          ),
        ],
        if (character.usedInBooks) ...[
          const SizedBox(height: AppSpacing.md),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.menu_book_outlined,
                size: 16,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: AppSpacing.xxs),
              Expanded(
                child: Text(
                  'Mention @${character.name} in a chat to put them in a book.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

/// A character with nothing written about them: one prompt, not two buttons.
class _WriteNudge extends StatelessWidget {
  const _WriteNudge({required this.busy, required this.onEdit});

  final bool busy;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Nothing written yet. A few lines about who they are help every '
              'book write them the right way.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: AppButton.text(
                label: 'Write a description',
                leading: const Icon(Icons.notes_outlined),
                onPressed: busy ? null : onEdit,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The label/value pairs, as one card of rows rather than a box apiece: a
/// character with a dozen details reads as a list to scan, not a wall of tiles.
class _DetailsCard extends StatelessWidget {
  const _DetailsCard({required this.fields});

  final List<CharacterField> fields;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // A label and its value side by side need room for both; at a large text
    // size the label goes above its value instead.
    final stacked = MediaQuery.textScalerOf(context).scale(1) >= 1.3;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
      ),
      // Stretched, or a stacked row is only as wide as its text and sits in
      // the middle of the card.
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < fields.length; i++) ...[
            if (i > 0) Divider(height: 1, color: colors.outlineVariant),
            MergeSemantics(
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.md,
                  vertical: AppSpacing.sm,
                ),
                child: stacked
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            fields[i].key,
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: AppSpacing.xxs),
                          Text(
                            fields[i].value,
                            style: theme.textTheme.bodyMedium,
                          ),
                        ],
                      )
                    : Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            flex: 2,
                            child: Text(
                              fields[i].key,
                              style: theme.textTheme.labelLarge?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          Expanded(
                            flex: 3,
                            child: Text(
                              fields[i].value,
                              style: theme.textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The description, clamped to a few lines with a way to read the rest.
///
/// A description can run to two thousand characters, which on a phone is the
/// whole page; the details and the pictures under it are what a reader came
/// for, so the prose gives them the room until it is asked for.
class _ExpandableDescription extends StatefulWidget {
  const _ExpandableDescription({
    required this.character,
    required this.onOpenMention,
  });

  final LibraryCharacter character;
  final ValueChanged<String> onOpenMention;

  @override
  State<_ExpandableDescription> createState() => _ExpandableDescriptionState();
}

class _ExpandableDescriptionState extends State<_ExpandableDescription> {
  bool _expanded = false;

  /// Whether the prose is longer than the collapsed height at [width].
  ///
  /// Measured on the plain text: a mention is drawn as a widget, but it takes
  /// the room its `@name` would, which is all the question needs.
  bool _overflows(BuildContext context, double width, TextStyle? style) {
    final painter = TextPainter(
      text: TextSpan(text: widget.character.description, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: _collapsedDescriptionLines,
    )..layout(maxWidth: width);
    final exceeded = painter.didExceedMaxLines;
    painter.dispose();
    return exceeded;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.bodyMedium;
    return LayoutBuilder(
      builder: (context, constraints) {
        final overflows = _overflows(context, constraints.maxWidth, style);
        final collapsed = overflows && !_expanded;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AnimatedSize(
              duration: AppMotion.reducedMotion(context)
                  ? Duration.zero
                  : AppMotion.medium,
              curve: AppMotion.standard,
              alignment: Alignment.topCenter,
              child: _text(
                context,
                collapsed ? _collapsedDescriptionLines : null,
              ),
            ),
            if (overflows)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: AppButton.text(
                  key: const ValueKey('character-description-toggle'),
                  label: _expanded ? 'Show less' : 'Read more',
                  onPressed: () => setState(() => _expanded = !_expanded),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _text(BuildContext context, int? maxLines) {
    final character = widget.character;
    final theme = Theme.of(context);
    final ranges = savedLibraryMentionRanges(
      character.description,
      character.mentions,
    );
    if (ranges.isEmpty) {
      return Text(
        character.description,
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium,
      );
    }
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final range in ranges) {
      if (range.start > cursor) {
        spans.add(
          TextSpan(text: character.description.substring(cursor, range.start)),
        );
      }
      final token = character.description.substring(range.start, range.end);
      // Only a character mention has a page to open. A location, or a kind a
      // newer server invented, reads as an emphasised name and nothing more —
      // the alternative is a link that resolves to no character, which is a tap
      // that does nothing at all. Why either can reach a build that has no
      // library for it is on [LibraryMentionKind].
      spans.add(
        range.mention.kind == LibraryMentionKind.character
            ? WidgetSpan(
                alignment: PlaceholderAlignment.baseline,
                baseline: TextBaseline.alphabetic,
                child: GestureDetector(
                  key: ValueKey('character-mention-${range.mention.id}'),
                  behavior: HitTestBehavior.opaque,
                  onTap: () => widget.onOpenMention(range.mention.id),
                  child: Text(
                    token,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              )
            : TextSpan(
                text: token,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
      );
      cursor = range.end;
    }
    if (cursor < character.description.length) {
      spans.add(TextSpan(text: character.description.substring(cursor)));
    }
    return Text.rich(
      TextSpan(style: theme.textTheme.bodyMedium, children: spans),
      key: const ValueKey('character-linked-description'),
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
    );
  }
}
