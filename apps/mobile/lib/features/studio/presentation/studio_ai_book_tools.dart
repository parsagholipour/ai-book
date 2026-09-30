import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/assist_models.dart';
import '../domain/studio_pricing.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_controller.dart';
import 'studio_ai_tools_sheet.dart';
import 'studio_ai_widgets.dart';

/// The chapter and book tools, which run in the background and are priced.
enum StudioBookTool { draft, feedback, consistency, outline, illustrateAll }

/// The AI tools sheet: the writing assistant for the whole chapter or book.
/// Each row says what the tool costs; the tap that spends is on the next
/// sheet, whose button carries the price.
Future<StudioBookTool?> showStudioBookToolsSheet(
  BuildContext context, {
  required String projectId,
  required int chapterChars,
  required bool pictureBook,
  required bool blankBook,
}) {
  return showAppBottomSheet<StudioBookTool>(
    context,
    builder: (sheetContext) => Consumer(
      builder: (context, ref, _) {
        String? price(LongAssistKind kind, {int? words, int chars = 0}) {
          final credits = watchStudioAssistPrice(
            ref,
            projectId,
            kind,
            targetWords: words,
            chapterChars: chars,
          );
          return credits == null ? null : studioCredits(credits);
        }

        void pick(StudioBookTool tool) => Navigator.of(sheetContext).pop(tool);
        return AppSheetScaffold(
          title: 'AI tools',
          subtitle:
              'For the whole chapter or book. They work in the background — '
              'keep writing while they do.',
          icon: Icons.auto_awesome_outlined,
          onClose: () => Navigator.of(sheetContext).pop(),
          children: [
            if (blankBook)
              _PricedTile(
                key: const ValueKey('studio-book-tool-outline'),
                icon: Icons.format_list_numbered_rounded,
                title: pictureBook
                    ? 'Plan my story with AI'
                    : 'Plan my chapters with AI',
                subtitle:
                    'Tell it what your book is about; get a plan to '
                    'write from.',
                price: price(LongAssistKind.outline),
                onTap: () => pick(StudioBookTool.outline),
              ),
            _PricedTile(
              key: const ValueKey('studio-book-tool-draft'),
              icon: Icons.edit_note_rounded,
              title: 'Draft this chapter from its notes',
              subtitle: 'A first draft to work from. You choose what to keep.',
              price: price(
                LongAssistKind.draftChapter,
                words: studioDefaultDraftWords,
              ),
              pricePrefix: 'from ',
              onTap: () => pick(StudioBookTool.draft),
            ),
            _PricedTile(
              key: const ValueKey('studio-book-tool-feedback'),
              icon: Icons.rate_review_outlined,
              title: 'Chapter feedback',
              subtitle:
                  'Notes on pacing, clarity and dialogue, pinned to the '
                  'lines they’re about.',
              price: price(LongAssistKind.chapterFeedback, chars: chapterChars),
              enabled: chapterChars > 0,
              onTap: () => pick(StudioBookTool.feedback),
            ),
            _PricedTile(
              key: const ValueKey('studio-book-tool-consistency'),
              icon: Icons.fact_check_outlined,
              title: 'Check consistency across the book',
              subtitle:
                  'Names, ages, places and dates that disagree between '
                  'chapters.',
              price: price(LongAssistKind.consistency),
              onTap: () => pick(StudioBookTool.consistency),
            ),
            if (pictureBook)
              _PricedTile(
                key: const ValueKey('studio-book-tool-illustrate-all'),
                icon: Icons.collections_outlined,
                title: 'Illustrate every page',
                subtitle:
                    'A picture for each page that has words and no '
                    'picture yet.',
                price: price(LongAssistKind.illustrate),
                pricePrefix: 'each ',
                onTap: () => pick(StudioBookTool.illustrateAll),
              ),
          ],
        );
      },
    ),
  );
}

class _PricedTile extends StatelessWidget {
  const _PricedTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.price,
    required this.onTap,
    this.pricePrefix = '',
    this.enabled = true,
    super.key,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String? price;
  final String pricePrefix;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return StudioAiToolTile(
      icon: icon,
      title: title,
      subtitle: subtitle,
      enabled: enabled,
      onTap: onTap,
      detail: price == null ? 'Checking the price…' : '$pricePrefix$price',
      trailing: Icon(
        Icons.chevron_right_rounded,
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

/// One priced background tool, confirmed: what it does, what it leaves
/// alone, and the button with the price. Resolves with the started request.
Future<ManuscriptAssist?> showStudioPaidToolSheet(
  BuildContext context, {
  required String projectId,
  required String title,
  required IconData icon,
  required String description,
  required String actionLabel,
  required String reason,
  required int? Function(WidgetRef ref) price,
  required Future<ManuscriptAssist> Function() start,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (sheetContext) => Consumer(
      builder: (context, ref, _) => AppSheetScaffold(
        title: title,
        icon: icon,
        onClose: () => Navigator.of(sheetContext).pop(),
        footer: StudioPaidButton<ManuscriptAssist>(
          projectId: projectId,
          label: actionLabel,
          credits: price(ref),
          reason: reason,
          start: start,
          onStarted: (assist) => Navigator.of(sheetContext).pop(assist),
        ),
        children: [
          Text(description, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'Nothing in your text changes. It takes a minute or two; you can '
            'keep writing, and the result waits in your AI inbox.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    ),
  );
}

/// The draft lengths on offer, in words.
const studioDraftLengths = [500, 1500, 3000];

/// Draft this chapter from my notes: the notes it works from (or, with none,
/// why it needs them and a way to write them), a length, and the price for
/// that length on the button.
Future<ManuscriptAssist?> showStudioDraftSheet(
  BuildContext context, {
  required String projectId,
  required String chapterTitle,
  required String notes,
  required Future<String?> Function() editNotes,
  required Future<ManuscriptAssist> Function(int targetWords, String notes)
  start,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (_) => _DraftSheet(
      projectId: projectId,
      chapterTitle: chapterTitle,
      notes: notes,
      editNotes: editNotes,
      start: start,
    ),
  );
}

class _DraftSheet extends ConsumerStatefulWidget {
  const _DraftSheet({
    required this.projectId,
    required this.chapterTitle,
    required this.notes,
    required this.editNotes,
    required this.start,
  });

  final String projectId;
  final String chapterTitle;
  final String notes;
  final Future<String?> Function() editNotes;
  final Future<ManuscriptAssist> Function(int targetWords, String notes) start;

  @override
  ConsumerState<_DraftSheet> createState() => _DraftSheetState();
}

class _DraftSheetState extends ConsumerState<_DraftSheet> {
  late String _notes = widget.notes;
  int _words = studioDefaultDraftWords;

  Future<void> _editNotes() async {
    final notes = await widget.editNotes();
    if (notes != null && mounted) setState(() => _notes = notes);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final hasNotes = _notes.trim().isNotEmpty;
    final price = watchStudioAssistPrice(
      ref,
      widget.projectId,
      LongAssistKind.draftChapter,
      targetWords: _words,
    );
    return AppSheetScaffold(
      title: 'Draft this chapter',
      subtitle: widget.chapterTitle,
      icon: Icons.edit_note_rounded,
      onClose: () => Navigator.of(context).pop(),
      footer: hasNotes
          ? StudioPaidButton<ManuscriptAssist>(
              projectId: widget.projectId,
              label: 'Draft chapter',
              credits: price,
              reason: 'Drafting this chapter from its notes.',
              start: () => widget.start(_words, _notes),
              onStarted: (assist) => Navigator.of(context).pop(assist),
            )
          : AppButton.primary(
              key: const ValueKey('studio-draft-write-notes'),
              label: 'Write chapter notes',
              expanded: true,
              onPressed: _editNotes,
            ),
      children: [
        if (!hasNotes)
          const AppInlineNotice(
            key: ValueKey('studio-draft-needs-notes'),
            title: 'Drafting starts from the chapter notes',
            message:
                'Write a few lines about what happens in this chapter — who '
                'is in it, what changes, how it ends. The draft follows them.',
            icon: Icons.notes_rounded,
          )
        else ...[
          const StudioAiSectionLabel('From the chapter notes'),
          Material(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.control),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadii.control),
              onTap: _editNotes,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        _notes.trim(),
                        key: const ValueKey('studio-draft-notes'),
                        maxLines: 5,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Icon(Icons.edit_outlined, size: 18, color: colors.primary),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          const StudioAiSectionLabel('Length'),
          SegmentedButton<int>(
            key: const ValueKey('studio-draft-length'),
            showSelectedIcon: false,
            segments: [
              for (final words in studioDraftLengths)
                ButtonSegment(
                  value: words,
                  label: Text(
                    '${words == 1500
                        ? '1,500'
                        : words == 3000
                        ? '3,000'
                        : '$words'} words',
                  ),
                ),
            ],
            selected: {_words},
            onSelectionChanged: (value) => setState(() => _words = value.first),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'The draft arrives as a suggestion: you read it first, then add it '
            'to the chapter or leave it.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }
}

/// What the wait says for a background tool, in order.
List<String> studioLongStages(LongAssistKind kind) => switch (kind) {
  LongAssistKind.illustrate => const [
    'Starting your picture…',
    'Sketching the scene…',
    'Still drawing…',
  ],
  LongAssistKind.draftChapter => const [
    'Reading your notes…',
    'Reading how the last chapter ended…',
    'Writing a draft…',
    'Still writing…',
  ],
  LongAssistKind.chapterFeedback => const [
    'Reading your chapter…',
    'Making notes…',
    'Still reading…',
  ],
  LongAssistKind.consistency => const [
    'Reading your whole book…',
    'Comparing names, places and dates…',
    'Still reading…',
  ],
  LongAssistKind.outline => const [
    'Reading what your book is about…',
    'Planning your chapters…',
    'Still planning…',
  ],
};

/// Waits on a background tool with the author: its stage, a bar that only
/// climbs, and a way back to writing. Resolves with the assist once it is
/// ready; null when the author went back to writing (the result then waits
/// in the inbox) or it failed (the sheet said why).
Future<ManuscriptAssist?> showStudioAssistWaitSheet(
  BuildContext context, {
  required StudioAiController controller,
  required String assistId,
  required LongAssistKind kind,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (_) =>
        _WaitSheet(controller: controller, assistId: assistId, kind: kind),
  );
}

class _WaitSheet extends StatefulWidget {
  const _WaitSheet({
    required this.controller,
    required this.assistId,
    required this.kind,
  });

  final StudioAiController controller;
  final String assistId;
  final LongAssistKind kind;

  @override
  State<_WaitSheet> createState() => _WaitSheetState();
}

class _WaitSheetState extends State<_WaitSheet> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    widget.controller.watch(widget.assistId);
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    widget.controller.unwatch(widget.assistId);
    super.dispose();
  }

  void _changed() {
    final assist = widget.controller.assist(widget.assistId);
    if (assist == null || _closing) {
      if (mounted) setState(() {});
      return;
    }
    if (assist.status == ManuscriptAssistStatus.ready) {
      _closing = true;
      Navigator.of(context).pop(assist);
      return;
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final assist = widget.controller.assist(widget.assistId);
    final failed = assist?.status == ManuscriptAssistStatus.failed;
    return AppSheetScaffold(
      title: widget.kind.label,
      icon: Icons.auto_awesome_outlined,
      onClose: () => Navigator.of(context).pop(),
      footer: AppButton.outlined(
        key: const ValueKey('studio-wait-keep-writing'),
        label: failed ? 'Close' : 'Keep writing',
        expanded: true,
        onPressed: () => Navigator.of(context).pop(),
      ),
      children: [
        if (failed)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
            child: Column(
              children: [
                Icon(
                  Icons.error_outline_rounded,
                  size: 32,
                  color: theme.colorScheme.error,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  assist?.error ?? 'This couldn’t be finished.',
                  key: const ValueKey('studio-wait-failed'),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleMedium,
                ),
              ],
            ),
          )
        else
          StudioAiWaiting(
            stages: studioLongStages(widget.kind),
            tau: const Duration(seconds: 30),
            note:
                'This can take a minute or two. Keep writing if you like — '
                'it will wait in your AI inbox, at the top of the page, when '
                'it’s ready.',
          ),
      ],
    );
  }
}
