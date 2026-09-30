import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/assist_models.dart';
import '../domain/assist_text.dart';
import 'studio_ai_widgets.dart';

/// The tool the author picked from the writing assistant.
sealed class StudioAiTool {
  const StudioAiTool();
}

/// Rewrite, fix, continue, describe, what next, or ask.
final class StudioQuickTool extends StudioAiTool {
  const StudioQuickTool(this.kind, {this.preset, this.instruction});

  final QuickAssistKind kind;
  final RewritePreset? preset;
  final String? instruction;
}

/// A picture of the selected passage.
final class StudioIllustrateTool extends StudioAiTool {
  const StudioIllustrateTool();
}

/// The chapter and book tools (draft, feedback, consistency, outline).
final class StudioBookToolsTool extends StudioAiTool {
  const StudioBookToolsTool();
}

/// The writing-assistant items on a text field's selection menu.
enum StudioSelectionTool {
  rewrite('Rewrite'),
  fix('Fix'),
  illustrate('Illustrate'),
  ask('Ask'),

  /// One item standing in for the four where the menu has no room.
  more('✨ AI');

  const StudioSelectionTool(this.label);

  final String label;
}

/// The writing assistant, for the text the author is touching: with a
/// selection, the tools that work on it (rewrite with a direction, fix,
/// describe, illustrate, ask); at a cursor, the ones that write on from it.
/// Nothing runs from here without a second look: every tool opens the
/// suggestion sheet, and nothing changes the text without a tap there.
Future<StudioAiTool?> showStudioAiToolsSheet(
  BuildContext context, {
  required bool hasSelection,
  int selectionLength = 0,
}) {
  return showAppBottomSheet<StudioAiTool>(
    context,
    builder: (_) => _ToolsSheet(
      hasSelection: hasSelection,
      tooLong: selectionLength > assistSelectionChars,
    ),
  );
}

class _ToolsSheet extends StatefulWidget {
  const _ToolsSheet({required this.hasSelection, required this.tooLong});

  final bool hasSelection;
  final bool tooLong;

  @override
  State<_ToolsSheet> createState() => _ToolsSheetState();
}

class _ToolsSheetState extends State<_ToolsSheet> {
  final _instruction = TextEditingController();

  @override
  void initState() {
    super.initState();
    _instruction.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _instruction.dispose();
    super.dispose();
  }

  void _pick(StudioAiTool tool) => Navigator.of(context).pop(tool);

  void _rewriteWithInstruction() {
    final text = _instruction.text.trim();
    if (text.isEmpty) return;
    _pick(StudioQuickTool(QuickAssistKind.rewrite, instruction: text));
  }

  @override
  Widget build(BuildContext context) {
    final selection = widget.hasSelection;
    return AppSheetScaffold(
      title: 'Writing assistant',
      subtitle: selection
          ? 'For the text you selected. Nothing changes until you choose.'
          : 'From where your cursor is. Nothing changes until you choose.',
      icon: Icons.auto_awesome_outlined,
      onClose: () => Navigator.of(context).pop(),
      children: selection ? _selectionTools(context) : _cursorTools(),
    );
  }

  List<Widget> _selectionTools(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final enabled = !widget.tooLong;
    return [
      if (widget.tooLong)
        const Padding(
          padding: EdgeInsets.only(bottom: AppSpacing.sm),
          child: AppInlineNotice(
            key: ValueKey('studio-ai-too-long'),
            title: 'That’s a lot of text',
            message:
                'Select a shorter passage — up to about a thousand words — '
                'and try again.',
            icon: Icons.select_all_rounded,
            tone: AppTone.warning,
          ),
        ),
      const StudioAiSectionLabel('Rewrite'),
      Wrap(
        spacing: AppSpacing.xs,
        runSpacing: AppSpacing.xs,
        children: [
          for (final preset in RewritePreset.values)
            ActionChip(
              key: ValueKey('studio-ai-preset-${preset.wire}'),
              label: Text(preset.label),
              onPressed: enabled
                  ? () => _pick(
                      StudioQuickTool(QuickAssistKind.rewrite, preset: preset),
                    )
                  : null,
            ),
        ],
      ),
      const SizedBox(height: AppSpacing.sm),
      TextField(
        key: const ValueKey('studio-ai-instruction'),
        controller: _instruction,
        enabled: enabled,
        maxLength: 500,
        textCapitalization: TextCapitalization.sentences,
        textInputAction: TextInputAction.send,
        onSubmitted: (_) => _rewriteWithInstruction(),
        decoration: InputDecoration(
          hintText: 'Or say how — “make her sound tired”',
          counterText: '',
          suffixIcon: IconButton(
            tooltip: 'Rewrite this way',
            icon: Icon(Icons.arrow_upward_rounded, color: colors.primary),
            onPressed: _instruction.text.trim().isEmpty || !enabled
                ? null
                : _rewriteWithInstruction,
          ),
        ),
      ),
      const SizedBox(height: AppSpacing.sm),
      const StudioAiSectionLabel('More for this passage'),
      _ToolTile(
        key: const ValueKey('studio-ai-tool-proofread'),
        icon: Icons.spellcheck_rounded,
        title: QuickAssistKind.proofread.label,
        subtitle: 'Spelling, grammar and punctuation — nothing else.',
        enabled: enabled,
        onTap: () => _pick(const StudioQuickTool(QuickAssistKind.proofread)),
      ),
      _ToolTile(
        key: const ValueKey('studio-ai-tool-describe'),
        icon: Icons.brush_outlined,
        title: QuickAssistKind.describe.label,
        subtitle: 'More of what can be seen, heard and felt.',
        enabled: enabled,
        onTap: () => _pick(const StudioQuickTool(QuickAssistKind.describe)),
      ),
      _ToolTile(
        key: const ValueKey('studio-ai-tool-illustrate'),
        icon: Icons.image_outlined,
        title: 'Illustrate',
        subtitle: 'A picture of this passage. You see the price first.',
        enabled: enabled,
        onTap: () => _pick(const StudioIllustrateTool()),
      ),
      _ToolTile(
        key: const ValueKey('studio-ai-tool-ask'),
        icon: Icons.question_answer_outlined,
        title: QuickAssistKind.ask.label,
        subtitle: 'A question about these lines, answered here.',
        enabled: enabled,
        onTap: () => _pick(const StudioQuickTool(QuickAssistKind.ask)),
      ),
    ];
  }

  List<Widget> _cursorTools() => [
    _ToolTile(
      key: const ValueKey('studio-ai-tool-continue'),
      icon: Icons.edit_note_rounded,
      title: QuickAssistKind.continueWriting.label,
      subtitle: 'A few sentences in your voice, picking up at the cursor.',
      onTap: () =>
          _pick(const StudioQuickTool(QuickAssistKind.continueWriting)),
    ),
    _ToolTile(
      key: const ValueKey('studio-ai-tool-brainstorm'),
      icon: Icons.lightbulb_outline_rounded,
      title: QuickAssistKind.brainstorm.label,
      subtitle: 'Three ideas for where it could go.',
      onTap: () => _pick(const StudioQuickTool(QuickAssistKind.brainstorm)),
    ),
    _ToolTile(
      key: const ValueKey('studio-ai-tool-ask'),
      icon: Icons.question_answer_outlined,
      title: 'Ask about this chapter',
      subtitle: 'Anything about what you’ve written so far.',
      onTap: () => _pick(const StudioQuickTool(QuickAssistKind.ask)),
    ),
    const Padding(
      padding: EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Divider(height: 1),
    ),
    _ToolTile(
      key: const ValueKey('studio-ai-tool-book'),
      icon: Icons.auto_stories_outlined,
      title: 'Chapter & book tools',
      subtitle: 'Draft from chapter notes, feedback, a consistency check.',
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: () => _pick(const StudioBookToolsTool()),
    ),
  ];
}

/// One tool: a tinted glyph, a plain name, and a line saying what it does.
class StudioAiToolTile extends StatelessWidget {
  const StudioAiToolTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.enabled = true,
    this.trailing,
    this.detail,
    super.key,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool enabled;
  final Widget? trailing;

  /// A third, quieter line: what the tool costs.
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadii.control),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: AppSpacing.sm - 2,
            horizontal: AppSpacing.xxs,
          ),
          child: Row(
            children: [
              DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.primaryContainer.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(AppRadii.compact),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  child: Icon(icon, size: 22, color: colors.primary),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    if (detail != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        detail!,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}

typedef _ToolTile = StudioAiToolTile;
