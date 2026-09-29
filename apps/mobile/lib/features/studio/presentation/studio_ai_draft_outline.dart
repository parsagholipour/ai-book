import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../projects/presentation/plan_build_progress.dart'
    show PlanBuildProgressBar;
import '../domain/assist_models.dart';
import 'manuscript_editing_controller.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_results.dart';
import 'studio_ai_widgets.dart';

/// What the author did with a chapter draft.
enum StudioDraftChoice { insertAtEnd, replaceChapter, discard }

/// A chapter draft, read before anything happens to the chapter: add it after
/// what is there, replace the chapter with it (the text it replaces is kept in
/// version history), or discard it. Closing keeps it in the AI inbox.
Future<StudioDraftChoice?> showStudioDraftPreviewSheet(
  BuildContext context, {
  required String markdown,
  required String chapterTitle,
  required bool chapterHasText,
}) {
  return showAppBottomSheet<StudioDraftChoice>(
    context,
    builder: (sheetContext) {
      void choose(StudioDraftChoice choice) =>
          Navigator.of(sheetContext).pop(choice);
      return AppSheetScaffold(
        title: 'Your chapter draft',
        subtitle: chapterTitle,
        icon: Icons.edit_note_rounded,
        maxHeightFactor: 0.94,
        onClose: () => Navigator.of(sheetContext).pop(),
        footer: AppActionGroup(
          secondary: [
            AppButton.text(
              key: const ValueKey('studio-draft-discard'),
              label: 'Discard',
              onPressed: () => choose(StudioDraftChoice.discard),
            ),
            if (chapterHasText)
              AppButton.outlined(
                key: const ValueKey('studio-draft-replace'),
                label: 'Replace chapter',
                onPressed: () async {
                  final confirmed = await showAppConfirmationDialog(
                    sheetContext,
                    title: 'Replace this chapter’s text?',
                    message:
                        'The text you have now is kept in Version history, '
                        'so you can bring it back.',
                    confirmLabel: 'Replace',
                    destructive: true,
                  );
                  if (confirmed && sheetContext.mounted) {
                    choose(StudioDraftChoice.replaceChapter);
                  }
                },
              ),
          ],
          primary: AppButton.primary(
            key: const ValueKey('studio-draft-insert'),
            label: chapterHasText ? 'Insert at end' : 'Add to chapter',
            expanded: true,
            onPressed: () => choose(StudioDraftChoice.insertAtEnd),
          ),
        ),
        children: [StudioDraftPreview(markdown: markdown)],
      );
    },
  );
}

/// A draft in the editor's own typography, markdown styled as it will read.
class StudioDraftPreview extends StatefulWidget {
  const StudioDraftPreview({required this.markdown, super.key});

  final String markdown;

  @override
  State<StudioDraftPreview> createState() => _StudioDraftPreviewState();
}

class _StudioDraftPreviewState extends State<StudioDraftPreview> {
  late final _styled = ManuscriptEditingController(
    text: widget.markdown.trim(),
  );

  @override
  void dispose() {
    _styled.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = studioSuggestionStyle(context);
    return StudioSuggestionSurface(
      child: Text.rich(
        key: const ValueKey('studio-draft-preview'),
        _styled.buildTextSpan(
          context: context,
          style: style,
          withComposing: false,
        ),
      ),
    );
  }
}

/// Plan my chapters with AI: what the book is about, and the price on the
/// button. Resolves with the started request.
Future<ManuscriptAssist?> showStudioOutlineSheet(
  BuildContext context, {
  required String projectId,
  required bool pictureBook,
  required Future<ManuscriptAssist> Function(String premise) start,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (_) => _OutlineSheet(
      projectId: projectId,
      pictureBook: pictureBook,
      start: start,
    ),
  );
}

class _OutlineSheet extends ConsumerStatefulWidget {
  const _OutlineSheet({
    required this.projectId,
    required this.pictureBook,
    required this.start,
  });

  final String projectId;
  final bool pictureBook;
  final Future<ManuscriptAssist> Function(String premise) start;

  @override
  ConsumerState<_OutlineSheet> createState() => _OutlineSheetState();
}

class _OutlineSheetState extends ConsumerState<_OutlineSheet> {
  final _premise = TextEditingController();

  @override
  void initState() {
    super.initState();
    _premise.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _premise.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppSheetScaffold(
      title: widget.pictureBook ? 'Plan my story' : 'Plan my chapters',
      subtitle: widget.pictureBook
          ? 'A page-by-page plan, in your notes, to write from.'
          : 'A chapter-by-chapter outline to write from. You write the book.',
      icon: Icons.format_list_numbered_rounded,
      onClose: () => Navigator.of(context).pop(),
      footer: StudioPaidButton<ManuscriptAssist>(
        projectId: widget.projectId,
        label: widget.pictureBook ? 'Plan my story' : 'Plan my chapters',
        credits: watchStudioAssistPrice(
          ref,
          widget.projectId,
          LongAssistKind.outline,
        ),
        enabled: _premise.text.trim().isNotEmpty,
        reason: 'Planning your book’s chapters.',
        start: () => widget.start(_premise.text.trim()),
        onStarted: (assist) => Navigator.of(context).pop(assist),
      ),
      children: [
        TextField(
          key: const ValueKey('studio-outline-premise'),
          controller: _premise,
          autofocus: true,
          minLines: 4,
          maxLines: 10,
          maxLength: 6000,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(
            labelText: 'What is your book about?',
            hintText:
                'A lighthouse keeper’s daughter finds letters from a sailor '
                'lost fifty years ago…',
            alignLabelWithHint: true,
            counterText: '',
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          'You’ll see the plan before anything changes. Each chapter gets a '
          'title and notes on what happens in it.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// What the author did with an outline.
enum StudioOutlineChoice { used, discarded }

/// An outline, read before it becomes chapters. "Use this outline" makes them
/// — showing each one as it is added — and resolves [StudioOutlineChoice.used]
/// once all are in; a failure says why and can be tried again without adding
/// any chapter twice.
Future<StudioOutlineChoice?> showStudioOutlinePreviewSheet(
  BuildContext context, {
  required List<AssistOutlineChapter> chapters,
  required Future<String?> Function(void Function(int done, int total) progress)
  apply,
}) {
  return showAppBottomSheet<StudioOutlineChoice>(
    context,
    isDismissible: false,
    builder: (_) => _OutlinePreviewSheet(chapters: chapters, apply: apply),
  );
}

class _OutlinePreviewSheet extends StatefulWidget {
  const _OutlinePreviewSheet({required this.chapters, required this.apply});

  final List<AssistOutlineChapter> chapters;
  final Future<String?> Function(void Function(int done, int total) progress)
  apply;

  @override
  State<_OutlinePreviewSheet> createState() => _OutlinePreviewSheetState();
}

class _OutlinePreviewSheetState extends State<_OutlinePreviewSheet> {
  bool _applying = false;
  int _done = 0;
  String? _error;

  Future<void> _use() async {
    setState(() {
      _applying = true;
      _error = null;
      _done = 0;
    });
    final error = await widget.apply((done, total) {
      if (mounted) setState(() => _done = done);
    });
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop(StudioOutlineChoice.used);
      return;
    }
    setState(() {
      _applying = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final total = widget.chapters.length;
    return AppSheetScaffold(
      title: 'Your outline',
      subtitle: total == 1 ? '1 chapter' : '$total chapters',
      icon: Icons.format_list_numbered_rounded,
      onClose: _applying ? null : () => Navigator.of(context).pop(),
      footer: _applying
          ? Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Adding chapter ${(_done + 1).clamp(1, total)} of $total…',
                  key: const ValueKey('studio-outline-progress'),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelLarge,
                ),
                const SizedBox(height: AppSpacing.xs),
                PlanBuildProgressBar(value: _done / total, height: 6),
              ],
            )
          : AppActionGroup(
              secondary: [
                AppButton.text(
                  key: const ValueKey('studio-outline-discard'),
                  label: 'Discard',
                  onPressed: () =>
                      Navigator.of(context).pop(StudioOutlineChoice.discarded),
                ),
              ],
              primary: AppButton.primary(
                key: const ValueKey('studio-outline-use'),
                label: _error == null ? 'Use this outline' : 'Try again',
                expanded: true,
                onPressed: () => unawaited(_use()),
              ),
            ),
      children: [
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: AppInlineNotice(
              title: 'Not every chapter was added',
              message: _error!,
              tone: AppTone.error,
            ),
          ),
        for (var i = 0; i < total; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 28,
                  child: _applying && i < _done
                      ? Icon(
                          Icons.check_rounded,
                          size: 18,
                          color: colors.primary,
                        )
                      : Text(
                          '${i + 1}',
                          style: theme.textTheme.labelLarge?.copyWith(
                            color: colors.primary,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.chapters[i].title,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (widget.chapters[i].notes.trim().isNotEmpty)
                        Text(
                          widget.chapters[i].notes.trim(),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        Text(
          'Each chapter keeps its notes privately — they’re never printed.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
