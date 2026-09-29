import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/manuscript_models.dart';
import '../domain/manuscript_word_count.dart';
import 'studio_session.dart';

/// Two versions of a chapter and three ways out: keep this device's, take the
/// other device's, or keep both (this device's becomes a chapter of its own).
Future<StudioConflictChoice?> showStudioConflictSheet(
  BuildContext context, {
  required StudioConflict conflict,
}) {
  return showAppBottomSheet<StudioConflictChoice>(
    context,
    builder: (sheetContext) {
      void choose(StudioConflictChoice choice) =>
          Navigator.of(sheetContext).pop(choice);
      final server = conflict.server;
      return AppSheetScaffold(
        title: 'This chapter was changed on another device',
        subtitle: conflict.fromBuffer
            ? 'This device still has changes that never reached your book. '
                  'Which version do you want to keep?'
            : 'Someone saved this chapter from another device while you were '
                  'writing here. Which version do you want to keep?',
        icon: Icons.devices_outlined,
        footer: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppButton.primary(
              label: 'Keep this device’s version',
              expanded: true,
              onPressed: () => choose(StudioConflictChoice.keepMine),
            ),
            const SizedBox(height: AppSpacing.xs),
            AppButton.outlined(
              label: 'Use the other version',
              expanded: true,
              onPressed: () => choose(StudioConflictChoice.useOther),
            ),
            const SizedBox(height: AppSpacing.xxs),
            AppButton.text(
              label: 'Keep both',
              expanded: true,
              onPressed: () => choose(StudioConflictChoice.keepBoth),
            ),
          ],
        ),
        children: [
          _VersionPreview(
            label: 'This device',
            title: conflict.deviceTitle,
            markdown: conflict.deviceMarkdown,
          ),
          const SizedBox(height: AppSpacing.sm),
          _VersionPreview(
            label: 'The other version',
            title: server.title,
            markdown: server.markdown,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            '“Keep both” saves this device’s version as a new chapter right '
            'after this one.',
            style: Theme.of(sheetContext).textTheme.bodySmall?.copyWith(
              color: Theme.of(sheetContext).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      );
    },
  );
}

class _VersionPreview extends StatelessWidget {
  const _VersionPreview({
    required this.label,
    required this.title,
    required this.markdown,
  });

  final String label;
  final String title;
  final String markdown;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final words = manuscriptWordCount(markdown);
    final excerpt = _plainExcerpt(markdown);
    return AppCard(
      density: AppCardDensity.compact,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: theme.textTheme.labelSmall?.copyWith(
              color: colors.primary,
              fontWeight: FontWeight.w800,
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: AppSpacing.xxs),
          Text(
            title.trim().isEmpty ? 'Untitled chapter' : title.trim(),
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            formatStudioWords(words),
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          if (excerpt.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              excerpt,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }
}

String _plainExcerpt(String markdown) => markdown
    .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '')
    .replaceAll(RegExp(r'[#>*_~`]'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

/// The chapter's private notes: never printed, saved with the chapter.
/// Resolves with the notes to keep, or null when nothing changed. Closing the
/// sheet any way keeps what was typed, as Done does.
Future<String?> showChapterNotesSheet(
  BuildContext context, {
  required String notes,
}) async {
  var latest = notes;
  await showAppBottomSheet<void>(
    context,
    builder: (sheetContext) => _TextSheet(
      initial: notes,
      onChanged: (text) => latest = text,
      builder: (context, controller, submit) => AppSheetScaffold(
        title: 'Chapter notes',
        subtitle: 'Private to you. Notes are never printed in the book.',
        icon: Icons.sticky_note_2_outlined,
        footer: AppButton.primary(
          label: 'Done',
          expanded: true,
          onPressed: submit,
        ),
        children: [
          TextField(
            key: const ValueKey('studio-notes-field'),
            controller: controller,
            autofocus: notes.isEmpty,
            minLines: 6,
            maxLines: 14,
            maxLength: 20000,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              hintText: 'Ideas, research, what this chapter has to do…',
              counterText: '',
            ),
          ),
        ],
      ),
    ),
  );
  return latest == notes ? null : latest;
}

/// Idea · Drafting · Revised · Final.
Future<ManuscriptChapterStatus?> showChapterStatusSheet(
  BuildContext context, {
  required ManuscriptChapterStatus current,
}) {
  return showAppActionSheet<ManuscriptChapterStatus>(
    context,
    title: 'Chapter status',
    builder: (sheetContext) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final status in ManuscriptChapterStatus.values)
          ListTile(
            leading: Icon(chapterStatusIcon(status)),
            title: Text(status.label),
            subtitle: Text(_statusHint(status)),
            trailing: status == current
                ? Icon(
                    Icons.check_rounded,
                    color: Theme.of(sheetContext).colorScheme.primary,
                  )
                : null,
            selected: status == current,
            onTap: () => Navigator.of(sheetContext).pop(status),
          ),
      ],
    ),
  );
}

IconData chapterStatusIcon(ManuscriptChapterStatus status) => switch (status) {
  ManuscriptChapterStatus.idea => Icons.lightbulb_outline,
  ManuscriptChapterStatus.drafting => Icons.edit_outlined,
  ManuscriptChapterStatus.revised => Icons.rate_review_outlined,
  ManuscriptChapterStatus.finalDraft => Icons.task_alt_rounded,
};

String _statusHint(ManuscriptChapterStatus status) => switch (status) {
  ManuscriptChapterStatus.idea => 'Notes and a direction',
  ManuscriptChapterStatus.drafting => 'Being written',
  ManuscriptChapterStatus.revised => 'Written and reworked',
  ManuscriptChapterStatus.finalDraft => 'Ready for readers',
};

/// A new name for a chapter, or null when cancelled or unchanged.
Future<String?> showRenameChapterSheet(
  BuildContext context, {
  required String title,
}) async {
  final result = await showAppBottomSheet<String>(
    context,
    builder: (sheetContext) => _TextSheet(
      initial: title,
      builder: (context, controller, submit) => AppSheetScaffold(
        title: 'Rename chapter',
        onClose: () => Navigator.of(context).pop(),
        footer: AppButton.primary(
          label: 'Save',
          expanded: true,
          onPressed: submit,
        ),
        children: [
          TextField(
            key: const ValueKey('studio-rename-field'),
            controller: controller,
            autofocus: true,
            maxLength: 200,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => submit(),
            decoration: const InputDecoration(
              labelText: 'Chapter title',
              counterText: '',
            ),
          ),
        ],
      ),
    ),
  );
  final trimmed = result?.trim();
  if (trimmed == null || trimmed == title.trim()) return null;
  return trimmed;
}

/// A sheet that owns its text controller, so the controller lives exactly as
/// long as the field (through the closing animation) rather than as long as
/// the caller's await. [submit] pops with the text.
class _TextSheet extends StatefulWidget {
  const _TextSheet({
    required this.initial,
    required this.builder,
    this.onChanged,
  });

  final String initial;
  final ValueChanged<String>? onChanged;
  final Widget Function(
    BuildContext context,
    TextEditingController controller,
    VoidCallback submit,
  )
  builder;

  @override
  State<_TextSheet> createState() => _TextSheetState();
}

class _TextSheetState extends State<_TextSheet> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  )..addListener(() => widget.onChanged?.call(_controller.text));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(
    context,
    _controller,
    () => Navigator.of(context).pop(_controller.text),
  );
}

/// Where a picture should come from.
enum StudioPictureSource { gallery, camera, ai }

/// Photos, the camera — and, where [offerAi] (a new picture, not a
/// replacement), a picture drawn by the AI, priced on the next sheet.
Future<StudioPictureSource?> showPictureSourceSheet(
  BuildContext context, {
  bool offerAi = false,
}) {
  return showAppActionSheet<StudioPictureSource>(
    context,
    title: 'Add a picture',
    builder: (sheetContext) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ListTile(
          leading: const Icon(Icons.photo_library_outlined),
          title: const Text('Choose from photos'),
          onTap: () =>
              Navigator.of(sheetContext).pop(StudioPictureSource.gallery),
        ),
        ListTile(
          leading: const Icon(Icons.photo_camera_outlined),
          title: const Text('Take a photo'),
          onTap: () =>
              Navigator.of(sheetContext).pop(StudioPictureSource.camera),
        ),
        if (offerAi)
          ListTile(
            key: const ValueKey('studio-picture-source-ai'),
            leading: Icon(
              Icons.auto_awesome_outlined,
              color: Theme.of(sheetContext).colorScheme.primary,
            ),
            title: const Text('Illustrate with AI'),
            subtitle: const Text('Describe it; see the price before it starts'),
            onTap: () => Navigator.of(sheetContext).pop(StudioPictureSource.ai),
          ),
      ],
    ),
  );
}
