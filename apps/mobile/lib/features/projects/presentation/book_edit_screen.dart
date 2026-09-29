import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/chat_text_direction.dart';
import '../domain/project_models.dart';
import 'book_edit_widgets.dart';
import 'project_chat_screen.dart';

/// Manual Edit Mode: the user edits the generated book text themselves.
///
/// Saving posts the changed pages to the API, which records a free edit
/// operation and drops a saved-export card into the book chat. When the
/// screen is opened from an existing saved-export card,
/// [savedExportMessageId] makes the save update that card in place instead
/// of creating a new one.
class BookEditScreen extends ConsumerStatefulWidget {
  const BookEditScreen({
    required this.projectId,
    this.savedExportMessageId,
    this.initialPageIndex,
    super.key,
  });

  final String projectId;
  final String? savedExportMessageId;
  final int? initialPageIndex;

  @override
  ConsumerState<BookEditScreen> createState() => _BookEditScreenState();
}

class _BookEditScreenState extends ConsumerState<BookEditScreen> {
  MobileEditableBook? _book;
  Object? _loadError;
  bool _loading = true;
  bool _saving = false;
  String? _pendingSaveRequestId;
  String? _pendingSaveFingerprint;
  String? _selectedPageId;
  final Map<String, TextEditingController> _titleControllers = {};
  final Map<String, TextEditingController> _markdownControllers = {};
  final Map<String, UndoHistoryController> _undoControllers = {};
  final Set<String> _dirtyPageIds = {};
  ScrollController _stripController = ScrollController();

  @override
  void initState() {
    super.initState();
    _loadBook();
  }

  @override
  void dispose() {
    for (final controller in _titleControllers.values) {
      controller.dispose();
    }
    for (final controller in _markdownControllers.values) {
      controller.dispose();
    }
    for (final controller in _undoControllers.values) {
      controller.dispose();
    }
    _stripController.dispose();
    super.dispose();
  }

  Future<void> _loadBook() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final book = await ref
          .read(projectsRepositoryProvider)
          .getEditableBook(widget.projectId);
      if (!mounted) return;
      for (final controller in _titleControllers.values) {
        controller.dispose();
      }
      for (final controller in _markdownControllers.values) {
        controller.dispose();
      }
      for (final controller in _undoControllers.values) {
        controller.dispose();
      }
      _titleControllers.clear();
      _markdownControllers.clear();
      _undoControllers.clear();
      _dirtyPageIds.clear();
      for (final page in book.pages) {
        final titleController = TextEditingController(text: page.title);
        final markdownController = TextEditingController(text: page.markdown);
        titleController.addListener(() => _refreshDirty(book, page.id));
        markdownController.addListener(() => _refreshDirty(book, page.id));
        _titleControllers[page.id] = titleController;
        _markdownControllers[page.id] = markdownController;
        _undoControllers[page.id] = UndoHistoryController();
      }
      MobileEditableBookPage? requestedPage;
      for (final page in book.pages) {
        if (page.index == widget.initialPageIndex) {
          requestedPage = page;
          break;
        }
      }
      final selected =
          requestedPage ?? (book.pages.isEmpty ? null : book.pages.first);
      _stripController.dispose();
      // Open with the page being edited in view, whichever page that is.
      _stripController = ScrollController(
        initialScrollOffset: selected == null
            ? 0
            : bookEditStripOffsetFor(book.pages.indexOf(selected)),
      );
      setState(() {
        _book = book;
        _loading = false;
        _selectedPageId = selected?.id;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loadError = error;
        _loading = false;
      });
    }
  }

  void _refreshDirty(MobileEditableBook book, String pageId) {
    final page = book.pages.firstWhere((candidate) => candidate.id == pageId);
    final dirty =
        _titleControllers[pageId]!.text != page.title ||
        _markdownControllers[pageId]!.text != page.markdown;
    if (dirty == _dirtyPageIds.contains(pageId)) return;
    setState(() {
      if (dirty) {
        _dirtyPageIds.add(pageId);
      } else {
        _dirtyPageIds.remove(pageId);
      }
    });
  }

  bool get _hasChanges => _dirtyPageIds.isNotEmpty;

  Future<void> _save() async {
    final book = _book;
    if (book == null || !_hasChanges || _saving) return;
    final edits = [
      for (final page in book.pages)
        if (_dirtyPageIds.contains(page.id))
          MobileManualBookPageEdit(
            id: page.id,
            title: _titleControllers[page.id]!.text.trim(),
            markdown: _markdownControllers[page.id]!.text,
            baseRevision: page.revision,
          ),
    ];
    if (edits.any(
      (edit) => edit.title.isEmpty || edit.markdown.trim().isEmpty,
    )) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(
          content: Text('Every edited page needs a title and some text.'),
        ),
      );
      return;
    }
    setState(() => _saving = true);
    final fingerprint = edits
        .map(
          (edit) =>
              '${edit.id}:${edit.baseRevision}:${edit.title}:${edit.markdown}',
        )
        .join('\u0000');
    if (_pendingSaveFingerprint != fingerprint) {
      _pendingSaveRequestId =
          'manual-edit-${DateTime.now().microsecondsSinceEpoch}';
      _pendingSaveFingerprint = fingerprint;
    }
    final requestId = _pendingSaveRequestId!;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .saveManualBookEdit(
            projectId: widget.projectId,
            pages: edits,
            savedExportMessageId: widget.savedExportMessageId,
            requestId: requestId,
          );
      _pendingSaveRequestId = null;
      _pendingSaveFingerprint = null;
      ref.invalidate(projectChatProvider(widget.projectId));
      ref.invalidate(projectDetailProvider(widget.projectId));
      ref.invalidate(projectStatusProvider(widget.projectId));
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      messenger.showAppSnackBar(
        const SnackBar(
          content: Text('Saved. The exports are refreshing with your changes.'),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      if (error is ApiException && error.code == 'EDIT_CONFLICT') {
        _pendingSaveRequestId = null;
        _pendingSaveFingerprint = null;
        await _showConflictDialog();
        return;
      }
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    }
  }

  Future<void> _showConflictDialog() async {
    final reload = await showAppConfirmationDialog(
      context,
      title: 'Book changed',
      message:
          'This book was changed somewhere else while you were editing. '
          'Reload it to keep editing the latest version. Your unsaved edits '
          'here will be lost.',
      cancelLabel: 'Keep my draft',
      confirmLabel: 'Reload book',
      destructive: true,
    );
    if (reload && mounted) {
      await _loadBook();
    }
  }

  Future<bool> _confirmDiscard() async {
    return showAppConfirmationDialog(
      context,
      title: 'Discard edits?',
      message: 'You have unsaved changes to this book.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard',
      destructive: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final book = _book;
    return PopScope(
      canPop: !_hasChanges || _saving,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final navigator = Navigator.of(context);
        if (await _confirmDiscard() && mounted) {
          navigator.pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                book?.title ?? 'Edit Mode',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              Text(
                _hasChanges
                    ? 'Edit Mode · ${_dirtyPageIds.length} unsaved'
                    : 'Edit Mode',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          actions: [
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 12),
              child: AppButton.primary(
                onPressed: _hasChanges && !_saving ? _save : null,
                loading: _saving,
                loadingLabel: 'Saving',
                leading: const Icon(Icons.save_outlined, size: 18),
                label: 'Save',
              ),
            ),
          ],
        ),
        body: _loading
            ? const AppLoadingState(message: 'Loading your book')
            : _loadError != null
            ? AppErrorState(
                title: 'Book unavailable',
                message: userFacingError(_loadError!),
                actionLabel: 'Retry',
                onRetry: _loadBook,
              )
            : book == null || book.pages.isEmpty
            ? const AppEmptyState(
                title: 'Nothing to edit yet',
                message: 'This book has no generated pages.',
                icon: Icons.edit_off_outlined,
              )
            : _buildEditor(context, book),
      ),
    );
  }

  void _revertPage(MobileEditableBookPage page) {
    _titleControllers[page.id]!.text = page.title;
    _markdownControllers[page.id]!.text = page.markdown;
    _undoControllers[page.id]!.value = UndoHistoryValue.empty;
  }

  /// Hands the open page to the chat as a draft the reader reviews and sends.
  /// Unsaved edits stay here, under the chat, until the reader comes back.
  void _askChat(BookEditAsk ask, MobileEditableBookPage page) {
    final excerpt = bookEditExcerpt(_markdownControllers[page.id]!.text);
    context.push(
      '/projects/${widget.projectId}/chat',
      extra: ProjectChatLaunch(draft: ask.draft(excerpt)),
    );
  }

  Widget _buildEditor(BuildContext context, MobileEditableBook book) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final selectedPage = book.pages.firstWhere(
      (page) => page.id == _selectedPageId,
      orElse: () => book.pages.first,
    );
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    final direction = switch (chatTextDirection(selectedPage.markdown)) {
      TextDirectionHint.rtl => TextDirection.rtl,
      TextDirectionHint.ltr => TextDirection.ltr,
      null => null,
    };
    final undo = _undoControllers[selectedPage.id]!;
    final dirty = _dirtyPageIds.contains(selectedPage.id);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        BookEditPageStrip(
          pages: book.pages,
          selectedId: selectedPage.id,
          dirtyIds: _dirtyPageIds,
          controller: _stripController,
          onSelect: (page) => setState(() => _selectedPageId = page.id),
        ),
        Divider(height: 1, color: colors.outlineVariant),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _PageToolbar(
                  page: selectedPage,
                  total: book.pages.length,
                  markdown: _markdownControllers[selectedPage.id]!,
                  undo: undo,
                  dirty: dirty,
                  onRevert: () => _revertPage(selectedPage),
                ),
                const SizedBox(height: 8),
                TextField(
                  key: ValueKey('title-${selectedPage.id}'),
                  controller: _titleControllers[selectedPage.id],
                  textDirection: direction,
                  textCapitalization: TextCapitalization.sentences,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Page title',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: TextField(
                    key: ValueKey('text-${selectedPage.id}'),
                    controller: _markdownControllers[selectedPage.id],
                    undoController: undo,
                    textDirection: direction,
                    keyboardType: TextInputType.multiline,
                    maxLines: null,
                    expands: true,
                    textAlignVertical: TextAlignVertical.top,
                    style: theme.textTheme.bodyMedium?.copyWith(height: 1.6),
                    decoration: const InputDecoration(
                      labelText: 'Page text',
                      alignLabelWithHint: true,
                      border: OutlineInputBorder(),
                      helperText: 'Markdown formatting is kept in the exports.',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        // Out of the way while typing: the keyboard needs the room, and the
        // chips are for the moment the reader stops and wonders what else is
        // possible.
        if (!keyboardOpen)
          BookEditAskBar(onPick: (ask) => _askChat(ask, selectedPage)),
      ],
    );
  }
}

/// "Page 3 of 28 · 214 words", with Undo, Redo and Revert for this page.
class _PageToolbar extends StatelessWidget {
  const _PageToolbar({
    required this.page,
    required this.total,
    required this.markdown,
    required this.undo,
    required this.dirty,
    required this.onRevert,
  });

  final MobileEditableBookPage page;
  final int total;
  final TextEditingController markdown;
  final UndoHistoryController undo;
  final bool dirty;
  final VoidCallback onRevert;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      children: [
        Expanded(
          child: ValueListenableBuilder<TextEditingValue>(
            valueListenable: markdown,
            builder: (context, value, _) => Text(
              'Page ${page.index} of $total · '
              '${bookEditWordCount(value.text)} words',
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        ),
        if (dirty)
          TextButton(onPressed: onRevert, child: const Text('Revert page')),
        ValueListenableBuilder<UndoHistoryValue>(
          valueListenable: undo,
          builder: (context, value, _) => Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: 'Undo typing',
                onPressed: value.canUndo ? undo.undo : null,
                icon: const Icon(Icons.undo),
              ),
              IconButton(
                tooltip: 'Redo typing',
                onPressed: value.canRedo ? undo.redo : null,
                icon: const Icon(Icons.redo),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
