import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

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
  final Set<String> _dirtyPageIds = {};

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
      _titleControllers.clear();
      _markdownControllers.clear();
      _dirtyPageIds.clear();
      for (final page in book.pages) {
        final titleController = TextEditingController(text: page.title);
        final markdownController = TextEditingController(text: page.markdown);
        titleController.addListener(() => _refreshDirty(book, page.id));
        markdownController.addListener(() => _refreshDirty(book, page.id));
        _titleControllers[page.id] = titleController;
        _markdownControllers[page.id] = markdownController;
      }
      MobileEditableBookPage? requestedPage;
      for (final page in book.pages) {
        if (page.index == widget.initialPageIndex) {
          requestedPage = page;
          break;
        }
      }
      setState(() {
        _book = book;
        _loading = false;
        _selectedPageId =
            requestedPage?.id ??
            (book.pages.isEmpty ? null : book.pages.first.id);
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
                'Edit Mode',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          actions: [
            Padding(
              padding: const EdgeInsets.only(right: 12),
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

  Widget _buildEditor(BuildContext context, MobileEditableBook book) {
    final colors = Theme.of(context).colorScheme;
    final selectedPage = book.pages.firstWhere(
      (page) => page.id == _selectedPageId,
      orElse: () => book.pages.first,
    );
    return Column(
      children: [
        SizedBox(
          height: 52,
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            scrollDirection: Axis.horizontal,
            itemCount: book.pages.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final page = book.pages[index];
              final dirty = _dirtyPageIds.contains(page.id);
              return ChoiceChip(
                selected: page.id == selectedPage.id,
                // The checkmark would paint over the unsaved dot on the very
                // page being edited, which is the one most likely to be dirty.
                showCheckmark: false,
                onSelected: (_) => setState(() => _selectedPageId = page.id),
                avatar: dirty
                    ? Icon(Icons.circle, size: 10, color: colors.primary)
                    : null,
                label: Text(
                  'Page ${page.index}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              );
            },
          ),
        ),
        Divider(height: 1, color: colors.outlineVariant),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _titleControllers[selectedPage.id],
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
                    controller: _markdownControllers[selectedPage.id],
                    keyboardType: TextInputType.multiline,
                    maxLines: null,
                    expands: true,
                    textAlignVertical: TextAlignVertical.top,
                    style: Theme.of(
                      context,
                    ).textTheme.bodyMedium?.copyWith(height: 1.6),
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
      ],
    );
  }
}
