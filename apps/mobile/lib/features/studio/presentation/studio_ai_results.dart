import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/edit_diff_view.dart';
import '../domain/assist_models.dart';
import '../domain/assist_text.dart';
import 'manuscript_editing_controller.dart';
import 'studio_editor.dart';

/// The surface every suggestion sits on: the page's own tint with a hairline,
/// never the primary button's fill, so a suggestion never reads as a button.
class StudioSuggestionSurface extends StatelessWidget {
  const StudioSuggestionSurface({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: child,
      ),
    );
  }
}

/// The reading style a suggestion is shown in: the editor's, a step smaller.
TextStyle studioSuggestionStyle(BuildContext context) =>
    studioBodyStyle(context).copyWith(fontSize: 17, height: 1.55);

/// A rewrite or description: what changed, word by word — or, switched, the
/// new text as it would read.
class StudioRewriteResult extends StatefulWidget {
  const StudioRewriteResult({
    required this.original,
    required this.suggestion,
    super.key,
  });

  final String original;
  final String suggestion;

  @override
  State<StudioRewriteResult> createState() => _StudioRewriteResultState();
}

class _StudioRewriteResultState extends State<StudioRewriteResult> {
  bool _plain = false;

  @override
  Widget build(BuildContext context) {
    final style = studioSuggestionStyle(context);
    final palette = EditDiffPalette.of(context);
    final colors = Theme.of(context).colorScheme;
    final runs = diffWords(widget.original, widget.suggestion);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: SegmentedButton<bool>(
            key: const ValueKey('studio-ai-diff-toggle'),
            showSelectedIcon: false,
            style: const ButtonStyle(visualDensity: VisualDensity.compact),
            segments: const [
              ButtonSegment(value: false, label: Text('Changes')),
              ButtonSegment(value: true, label: Text('New text')),
            ],
            selected: {_plain},
            onSelectionChanged: (value) => setState(() => _plain = value.first),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        StudioSuggestionSurface(
          child: _plain
              ? SelectableText(
                  widget.suggestion.trim(),
                  key: const ValueKey('studio-ai-plain'),
                  style: style,
                )
              : SelectableText.rich(
                  key: const ValueKey('studio-ai-diff'),
                  TextSpan(
                    children: [
                      for (final run in runs)
                        TextSpan(
                          text: run.text,
                          style: switch (run.type) {
                            MobileEditDiffRunType.equal => style.copyWith(
                              color: colors.onSurface,
                            ),
                            MobileEditDiffRunType.insert => style.copyWith(
                              color: palette.insertForeground,
                              backgroundColor: palette.insertBackground,
                              fontWeight: FontWeight.w600,
                            ),
                            MobileEditDiffRunType.delete => style.copyWith(
                              color: palette.deleteForeground,
                              backgroundColor: palette.deleteBackground,
                              decoration: TextDecoration.lineThrough,
                              decorationColor: palette.deleteForeground,
                            ),
                          },
                        ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}

/// A continuation, in the editor's typography, right after the last words
/// before the cursor (faded), so it reads as the chapter would.
class StudioContinuationResult extends StatefulWidget {
  const StudioContinuationResult({
    required this.before,
    required this.continuation,
    super.key,
  });

  final String before;
  final String continuation;

  @override
  State<StudioContinuationResult> createState() =>
      _StudioContinuationResultState();
}

class _StudioContinuationResultState extends State<StudioContinuationResult> {
  late ManuscriptEditingController _styled = ManuscriptEditingController(
    text: widget.continuation,
  );

  @override
  void didUpdateWidget(StudioContinuationResult oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.continuation != widget.continuation) {
      _styled.dispose();
      _styled = ManuscriptEditingController(text: widget.continuation);
    }
  }

  @override
  void dispose() {
    _styled.dispose();
    super.dispose();
  }

  /// The last sentence or so before the cursor.
  static String _tail(String before) {
    final paragraph = before.split(RegExp(r'\n[ \t]*\n')).last;
    final clipped = clipTail(paragraph, 160);
    return clipped.length < paragraph.length ? '…$clipped' : clipped;
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final style = studioSuggestionStyle(context);
    final tail = _tail(widget.before);
    return StudioSuggestionSurface(
      child: Text.rich(
        key: const ValueKey('studio-ai-continuation'),
        TextSpan(
          children: [
            if (tail.trim().isNotEmpty)
              TextSpan(
                text: tail,
                style: style.copyWith(
                  color: colors.onSurfaceVariant.withValues(alpha: 0.7),
                ),
              ),
            TextSpan(
              style: style.copyWith(
                backgroundColor: colors.primaryContainer.withValues(
                  alpha: 0.35,
                ),
              ),
              children: [
                _styled.buildTextSpan(
                  context: context,
                  style: style,
                  withComposing: false,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Proofreading: each fix in its sentence, with a box to leave it out.
class StudioProofreadResult extends StatelessWidget {
  const StudioProofreadResult({
    required this.selection,
    required this.placements,
    required this.checked,
    required this.onToggle,
    super.key,
  });

  final String selection;
  final List<CorrectionPlacement> placements;
  final Set<int> checked;
  final void Function(int index, bool value) onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    if (placements.isEmpty) {
      return StudioSuggestionSurface(
        child: Column(
          key: const ValueKey('studio-ai-no-mistakes'),
          children: [
            Icon(Icons.task_alt_rounded, color: colors.primary, size: 32),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'No mistakes found',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.xxs),
            Text(
              'The spelling, grammar and punctuation in this passage all '
              'check out.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }
    final palette = EditDiffPalette.of(context);
    final base = theme.textTheme.bodyMedium!.copyWith(height: 1.45);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < placements.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xs),
            child: StudioSuggestionSurface(
              child: InkWell(
                key: ValueKey('studio-ai-correction-$i'),
                onTap: () => onToggle(i, !checked.contains(i)),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 28,
                      height: 24,
                      child: Checkbox(
                        value: checked.contains(i),
                        visualDensity: VisualDensity.compact,
                        onChanged: (value) => onToggle(i, value ?? false),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text.rich(
                            _correctionSpan(
                              placements[i],
                              base: base,
                              faded: colors.onSurfaceVariant,
                              palette: palette,
                            ),
                          ),
                          if (placements[i].correction.reason.trim().isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                placements[i].correction.reason.trim(),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }

  TextSpan _correctionSpan(
    CorrectionPlacement placement, {
    required TextStyle base,
    required Color faded,
    required EditDiffPalette palette,
  }) {
    const reach = 28;
    final start = placement.start;
    final end = placement.end;
    // A few words either side, cut at a space rather than inside a word.
    var from = (start - reach).clamp(0, start);
    if (from > 0) {
      final space = selection.indexOf(' ', from);
      from = space < 0 || space >= start ? start : space + 1;
    }
    var to = (end + reach).clamp(end, selection.length);
    if (to < selection.length) {
      final space = selection.lastIndexOf(' ', to);
      to = space <= end ? end : space;
    }
    final lead = selection.substring(from, start);
    final trail = selection.substring(end, to);
    final replace = placement.correction.replace;
    return TextSpan(
      style: base,
      children: [
        TextSpan(
          text: '${from > 0 ? '…' : ''}${lead.replaceAll('\n', ' ')}',
          style: TextStyle(color: faded),
        ),
        TextSpan(
          text: placement.correction.find,
          style: TextStyle(
            color: palette.deleteForeground,
            backgroundColor: palette.deleteBackground,
            decoration: TextDecoration.lineThrough,
            decorationColor: palette.deleteForeground,
          ),
        ),
        if (replace.isNotEmpty)
          TextSpan(
            text: replace,
            style: TextStyle(
              color: palette.insertForeground,
              backgroundColor: palette.insertBackground,
              fontWeight: FontWeight.w700,
            ),
          ),
        TextSpan(
          text:
              '${trail.replaceAll('\n', ' ')}'
              '${to < selection.length ? '…' : ''}',
          style: TextStyle(color: faded),
        ),
      ],
    );
  }
}

/// What could happen next: a card per idea; the open one offers to write it.
class StudioIdeasResult extends StatelessWidget {
  const StudioIdeasResult({
    required this.ideas,
    required this.open,
    required this.onOpen,
    required this.onWrite,
    super.key,
  });

  final List<AssistIdea> ideas;
  final int? open;
  final ValueChanged<int> onOpen;
  final ValueChanged<AssistIdea> onWrite;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < ideas.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xs),
            child: AppCard(
              key: ValueKey('studio-ai-idea-$i'),
              density: AppCardDensity.compact,
              selected: open == i,
              onTap: () => onOpen(i),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Text(
                        '${i + 1}',
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.xs),
                      Expanded(
                        child: Text(
                          ideas[i].title,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (ideas[i].text.trim().isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      ideas[i].text,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                  if (open == i) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: AppButton.tonal(
                        key: const ValueKey('studio-ai-write-idea'),
                        label: 'Write this',
                        leading: const Icon(Icons.edit_note_rounded),
                        onPressed: () => onWrite(ideas[i]),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// An answer to the author's question, which they can select or copy.
class StudioAnswerResult extends StatefulWidget {
  const StudioAnswerResult({
    required this.question,
    required this.answer,
    super.key,
  });

  final String question;
  final String answer;

  @override
  State<StudioAnswerResult> createState() => _StudioAnswerResultState();
}

class _StudioAnswerResultState extends State<StudioAnswerResult> {
  // Said on the button itself: a snack bar would open under the sheet.
  bool _copied = false;

  @override
  void didUpdateWidget(StudioAnswerResult oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.answer != widget.answer) _copied = false;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          widget.question,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        StudioSuggestionSurface(
          child: SelectableText(
            widget.answer,
            key: const ValueKey('studio-ai-answer'),
            style: theme.textTheme.bodyLarge?.copyWith(height: 1.5),
          ),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: AppButton.text(
            key: const ValueKey('studio-ai-copy'),
            label: _copied ? 'Copied' : 'Copy',
            leading: Icon(
              _copied ? Icons.check_rounded : Icons.copy_rounded,
              size: 18,
            ),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: widget.answer));
              if (mounted) setState(() => _copied = true);
            },
          ),
        ),
      ],
    );
  }
}
