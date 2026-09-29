import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import 'studio_ai_picture_card.dart';
import 'studio_document.dart';
import 'studio_editor.dart';
import 'studio_image_block.dart';

/// A picture book authored page by page: one card per page, the picture on
/// top and the words below, the way the printed page will stack them.
class StudioPicturePages extends StatelessWidget {
  const StudioPicturePages({
    required this.projectId,
    required this.document,
    required this.host,
    required this.bodyStyle,
    required this.direction,
    super.key,
  });

  final String projectId;
  final StudioDocument document;
  final StudioEditorHost host;
  final TextStyle bodyStyle;
  final TextDirection? direction;

  @override
  Widget build(BuildContext context) {
    final pages = document.pages;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final page in pages)
          Padding(
            // Keyed by the page's own text, which moves with the page and
            // survives a picture arriving in its slot.
            key: ValueKey('studio-page-${page.firstText?.id ?? page.index}'),
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: _PageCard(
              projectId: projectId,
              page: page,
              pageCount: pages.length,
              document: document,
              host: host,
              bodyStyle: bodyStyle,
              direction: direction,
            ),
          ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: AppButton.outlined(
            key: const ValueKey('studio-add-page'),
            label: 'Add page',
            leading: const Icon(Icons.add_rounded),
            onPressed: document.addPage,
          ),
        ),
      ],
    );
  }
}

enum _PageAction { moveUp, moveDown, delete }

class _PageCard extends StatelessWidget {
  const _PageCard({
    required this.projectId,
    required this.page,
    required this.pageCount,
    required this.document,
    required this.host,
    required this.bodyStyle,
    required this.direction,
  });

  final String projectId;
  final StudioPage page;
  final int pageCount;
  final StudioDocument document;
  final StudioEditorHost host;
  final TextStyle bodyStyle;
  final TextDirection? direction;

  Future<void> _openMenu(BuildContext context) async {
    final action = await showAppActionSheet<_PageAction>(
      context,
      title: 'Page ${page.index + 1}',
      builder: (sheetContext) {
        final colors = Theme.of(sheetContext).colorScheme;
        void pick(_PageAction action) => Navigator.of(sheetContext).pop(action);
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              enabled: page.index > 0,
              leading: const Icon(Icons.arrow_upward_rounded),
              title: const Text('Move up'),
              onTap: () => pick(_PageAction.moveUp),
            ),
            ListTile(
              enabled: page.index < pageCount - 1,
              leading: const Icon(Icons.arrow_downward_rounded),
              title: const Text('Move down'),
              onTap: () => pick(_PageAction.moveDown),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colors.error),
              title: Text('Delete page', style: TextStyle(color: colors.error)),
              onTap: () => pick(_PageAction.delete),
            ),
          ],
        );
      },
    );
    switch (action) {
      case _PageAction.moveUp:
        document.movePage(page.index, up: true);
      case _PageAction.moveDown:
        document.movePage(page.index, up: false);
      case _PageAction.delete:
        host.deletePage(page.index);
      case null:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final picture = page.picture;
    final firstText = page.firstText;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.outlineVariant),
        boxShadow: AppElevation.resting(colors),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          AppSpacing.xs,
          AppSpacing.xxs,
          AppSpacing.md,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Page ${page.index + 1}',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'Page ${page.index + 1} options',
                  icon: const Icon(Icons.more_horiz),
                  onPressed: () => _openMenu(context),
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  switch (picture) {
                    StudioImageEntry() => StudioImageBlock(
                      key: ValueKey('studio-entry-${picture.id}'),
                      entry: picture,
                      showMoves: false,
                      onAction: (action) {
                        switch (action) {
                          case StudioImageAction.replace:
                            host.replacePicture(picture);
                          case StudioImageAction.remove:
                            document.removeEntry(picture);
                          case StudioImageAction.moveUp ||
                              StudioImageAction.moveDown:
                            break;
                        }
                      },
                    ),
                    StudioUploadEntry() => StudioUploadingBlock(
                      key: ValueKey('studio-entry-${picture.id}'),
                      entry: picture,
                    ),
                    StudioAiPictureEntry() => StudioAiPictureCard(
                      key: ValueKey('studio-entry-${picture.id}'),
                      entry: picture,
                      projectId: projectId,
                      slot: true,
                      onRetry: () => host.retryAiPicture(picture),
                      onRemove: () => host.removeAiPicture(picture),
                    ),
                    _ => StudioPictureSlot(
                      onTap: () => host.addPagePicture(page.index),
                    ),
                  },
                  const SizedBox(height: AppSpacing.md),
                  for (final entry in page.body)
                    _PageBodyEntry(
                      key: ValueKey('studio-entry-${entry.id}'),
                      projectId: projectId,
                      entry: entry,
                      document: document,
                      host: host,
                      bodyStyle: bodyStyle,
                      direction: direction,
                      hint: identical(entry, firstText)
                          ? 'What happens on this page?'
                          : null,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PageBodyEntry extends StatelessWidget {
  const _PageBodyEntry({
    required this.projectId,
    required this.entry,
    required this.document,
    required this.host,
    required this.bodyStyle,
    required this.direction,
    required this.hint,
    super.key,
  });

  final String projectId;
  final StudioEntry entry;
  final StudioDocument document;
  final StudioEditorHost host;
  final TextStyle bodyStyle;
  final TextDirection? direction;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final entry = this.entry;
    return switch (entry) {
      StudioTextEntry() => StudioTextField(
        entry: entry,
        style: bodyStyle,
        fallbackDirection: direction,
        hint: hint,
        onAiTool: (tool) => host.runSelectionTool(entry, tool),
      ),
      StudioImageEntry() => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: StudioImageBlock(
          entry: entry,
          canMoveUp: document.canMoveUp(entry),
          canMoveDown: document.canMoveDown(entry),
          onAction: (action) {
            switch (action) {
              case StudioImageAction.replace:
                host.replacePicture(entry);
              case StudioImageAction.moveUp:
                document.moveEntry(entry, up: true);
              case StudioImageAction.moveDown:
                document.moveEntry(entry, up: false);
              case StudioImageAction.remove:
                document.removeEntry(entry);
            }
          },
        ),
      ),
      StudioUploadEntry() => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: StudioUploadingBlock(entry: entry),
      ),
      StudioAiPictureEntry() => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: StudioAiPictureCard(
          entry: entry,
          projectId: projectId,
          onRetry: () => host.retryAiPicture(entry),
          onRemove: () => host.removeAiPicture(entry),
        ),
      ),
      StudioFigureEntry() => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: StudioFigureCard(entry: entry),
      ),
      StudioPageBreakEntry() => const SizedBox.shrink(),
    };
  }
}
