import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/media/photo_picker.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../notes/presentation/notes_location.dart';
import '../../projects/data/projects_repository.dart';
import '../data/studio_local_drafts.dart';
import '../data/studio_repository.dart';
import '../domain/assist_models.dart';
import '../domain/assist_text.dart';
import '../domain/manuscript_blocks.dart';
import '../domain/manuscript_formatting.dart';
import 'chapter_conflict_card.dart';
import 'chapter_outline_sheet.dart';
import 'manuscript_settings_sheet.dart';
import 'publish_sheet.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_book_tools.dart';
import 'studio_ai_controller.dart';
import 'studio_ai_draft_outline.dart';
import 'studio_ai_inbox.dart';
import 'studio_ai_notes_panel.dart';
import 'studio_ai_sheet.dart';
import 'studio_ai_tools_sheet.dart';
import 'studio_document.dart';
import 'studio_editor.dart';
import 'studio_illustrate_sheet.dart';
import 'studio_session.dart';
import 'studio_sheets.dart';
import 'studio_toolbar.dart';
import 'studio_top_bar.dart';
import 'version_history_sheet.dart';

part 'studio_screen_ai.dart';
part 'studio_screen_ai_book.dart';

/// The Writing Studio: where an author writes their own book, chapter by
/// chapter, with pictures between the paragraphs.
///
/// `/projects/:id/write?chapter=<id>&publish=1`. Opens [chapterId], or the
/// chapter written in last; [openPublish] opens the publish sheet once the
/// book has loaded.
///
/// This widget is the wiring: it owns the [StudioSession] (see there for why
/// it is not a provider) and the [StudioAiController], answers the session's
/// and the editor's requests for sheets and pickers, and lays out the bar,
/// the editor, the notes panel, the keyboard's formatting bar or the status
/// line, and — at 840dp and wider — the outline as a pane beside the page.
/// The writing assistant's flows are in the part files
/// `studio_screen_ai.dart` (quick tools and pictures) and
/// `studio_screen_ai_book.dart` (chapter and book tools, the inbox).
class StudioScreen extends ConsumerStatefulWidget {
  const StudioScreen({
    required this.projectId,
    this.chapterId,
    this.openPublish = false,
    super.key,
  });

  final String projectId;
  final String? chapterId;
  final bool openPublish;

  /// From this width the outline sits beside the page instead of in a sheet.
  static const double twoPaneBreakpoint = 840;

  @override
  ConsumerState<StudioScreen> createState() => _StudioScreenState();
}

class _StudioScreenState extends ConsumerState<StudioScreen>
    with WidgetsBindingObserver
    implements StudioSessionDelegate, StudioEditorHost {
  late final StudioSession _session = StudioSession(
    projectId: widget.projectId,
    repository: ref.read(studioRepositoryProvider),
    drafts: ref.read(studioLocalDraftsProvider),
  )..delegate = this;

  late final StudioAiController _ai = StudioAiController(
    projectId: widget.projectId,
    repository: ref.read(studioRepositoryProvider),
  )..onSettled = (assist) => _onAssistSettled(assist);

  bool _focusMode = false;
  bool _leaving = false;

  /// The text field the author was last in, for "insert at the cursor" once
  /// a sheet has taken the focus away.
  StudioTextEntry? _lastText;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _session.focusedText.addListener(_rememberFocusedText);
    unawaited(_start());
  }

  Future<void> _start() async {
    unawaited(_ai.refresh());
    await _session.start(chapterId: widget.chapterId);
    if (!mounted || !widget.openPublish) return;
    if (_session.loadError == null) await _publish();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _session.focusedText.removeListener(_rememberFocusedText);
    _ai.dispose();
    _session.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden) {
      unawaited(_session.flush());
      _ai.setVisible(false);
    } else if (state == AppLifecycleState.resumed) {
      _ai.setVisible(true);
      // Results that landed while the app was away show in the inbox.
      unawaited(_ai.refresh());
    }
  }

  // ---------------------------------------------------------------------------
  // The session's requests

  @override
  Future<StudioConflictChoice?> chooseConflictResolution(
    StudioConflict conflict,
  ) async {
    if (!mounted) return null;
    return showStudioConflictSheet(context, conflict: conflict);
  }

  @override
  void showStudioMessage(
    String message, {
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showAppSnackBar(
      SnackBar(
        content: Text(message),
        action: actionLabel == null
            ? null
            : SnackBarAction(label: actionLabel, onPressed: onAction ?? () {}),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // The editor's requests

  @override
  void insertPicture(StudioTextEntry? entry, int? offset) {
    unawaited(
      _pickAndUpload(
        (document, bytes) =>
            document.insertUpload(bytes, target: entry, offset: offset),
        onAi: () {
          final document = _session.document;
          if (document == null) return;
          final target = entry ?? document.lastText;
          if (offset != null) {
            target.controller.selection = TextSelection.collapsed(
              offset: offset.clamp(0, target.text.length),
            );
          }
          unawaited(_illustrateText(_AiTarget.capture(document, target)));
        },
      ),
    );
  }

  @override
  void addPagePicture(int pageIndex) {
    unawaited(
      _pickAndUpload(
        (document, bytes) => document.insertPagePictureUpload(pageIndex, bytes),
        onAi: () => unawaited(_illustratePage(pageIndex)),
      ),
    );
  }

  @override
  void runSelectionTool(StudioTextEntry entry, StudioSelectionTool tool) =>
      unawaited(_runSelectionToolFor(entry, tool));

  @override
  void retryAiPicture(StudioAiPictureEntry entry) =>
      unawaited(_retryAiPictureFor(entry));

  @override
  void removeAiPicture(StudioAiPictureEntry entry) =>
      _removeAiPictureFor(entry);

  @override
  void planChaptersWithAi() => unawaited(_planChapters());

  @override
  void replacePicture(StudioImageEntry entry) {
    unawaited(
      _pickAndUpload((document, bytes) => document.beginReplace(entry, bytes)),
    );
  }

  @override
  void deletePage(int pageIndex) {
    final document = _session.document;
    if (document == null) return;
    final blocks = document.deletePage(pageIndex);
    showStudioMessage(
      'Page ${pageIndex + 1} deleted',
      actionLabel: 'Undo',
      onAction: () {
        if (identical(_session.document, document)) {
          document.restorePage(pageIndex, blocks);
        }
      },
    );
  }

  @override
  void compareBookConflict() {
    final conflict = _session.bookConflict;
    final document = _session.document;
    if (conflict == null || document == null) return;
    unawaited(() async {
      final choice = await showChapterCompareSheet(
        context,
        mine: document.markdown,
        book: conflict.markdown,
      );
      switch (choice) {
        case ChapterCompareChoice.keepMine:
          await _session.keepMineOverBook();
        case ChapterCompareChoice.useBook:
          await _session.useBookVersion();
        case null:
          break;
      }
    }());
  }

  /// Asks where the picture comes from, picks it, and uploads it into the
  /// placeholder [place] makes, which shows the upload's progress in place.
  /// With [onAi], the sheet also offers a picture drawn by the AI.
  Future<void> _pickAndUpload(
    StudioUploadEntry Function(StudioDocument document, Uint8List bytes)
    place, {
    VoidCallback? onAi,
  }) async {
    final document = _session.document;
    if (document == null) return;
    final source = await showPictureSourceSheet(context, offerAi: onAi != null);
    if (source == null || !mounted) return;
    if (source == StudioPictureSource.ai) {
      onAi?.call();
      return;
    }
    XFile? file;
    try {
      file = await ref
          .read(photoPickerProvider)
          .pickImage(
            source: source == StudioPictureSource.camera
                ? ImageSource.camera
                : ImageSource.gallery,
            purpose: PhotoPickerPurpose.bookImage,
          );
    } catch (_) {
      showStudioMessage(
        source == StudioPictureSource.camera
            ? 'Could not open the camera.'
            : 'Could not open your photos.',
      );
      return;
    }
    if (file == null || !mounted) return;
    final bytes = await file.readAsBytes();
    if (!mounted || !identical(_session.document, document)) return;
    final upload = place(document, bytes);
    try {
      final image = await ref
          .read(studioRepositoryProvider)
          .uploadImage(
            projectId: widget.projectId,
            bytes: bytes,
            filename: _filenameFor(file),
            contentType: _contentTypeFor(file),
            onProgress: (sent, total) {
              if (total > 0) upload.progress.value = sent / total;
            },
          );
      if (!mounted || !identical(_session.document, document)) return;
      document.completeUpload(upload, image.url);
    } catch (error) {
      if (!mounted || !identical(_session.document, document)) return;
      document.cancelUpload(upload);
      showStudioMessage(
        error is ApiException && error.code != 'NETWORK_ERROR'
            ? userFacingError(error)
            : 'The picture didn’t upload. Check your connection and try again.',
      );
    }
  }

  /// A picker can hand back bytes with no name (a camera capture on some
  /// platforms); the server only reads the extension.
  static String _filenameFor(XFile file) {
    if (file.name.trim().isNotEmpty) return file.name;
    return switch (_contentTypeFor(file)) {
      'image/png' => 'picture.png',
      'image/webp' => 'picture.webp',
      'image/heic' => 'picture.heic',
      _ => 'picture.jpg',
    };
  }

  static String _contentTypeFor(XFile file) {
    final mime = file.mimeType;
    if (mime != null && mime.startsWith('image/')) return mime;
    final name = file.name.toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.heic') || name.endsWith('.heif')) return 'image/heic';
    return 'image/jpeg';
  }

  // ---------------------------------------------------------------------------
  // The bar's actions

  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    // The buffer is written before the network call, so a slow connection
    // never holds the author here; what did not reach the server is on the
    // device and comes back next time.
    await _session.flush().timeout(
      const Duration(seconds: 4),
      onTimeout: () => false,
    );
    if (!mounted) return;
    _refreshBookSurfaces();
    final navigator = Navigator.of(context);
    final router = GoRouter.maybeOf(context);
    if (navigator.canPop()) {
      navigator.pop();
    } else if (router != null) {
      // Opened with `go` (the two takeover doors do) or from a deep link:
      // nothing beneath to pop to, so the way back is the book's own page.
      router.go('/projects/${widget.projectId}');
    } else {
      _leaving = false;
    }
  }

  /// The book page and the library show words and "unpublished changes";
  /// they are read again when the author comes back to them.
  void _refreshBookSurfaces() {
    ref.invalidate(manuscriptProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  Future<void> _publish() async {
    final manuscript = _session.manuscript;
    if (manuscript == null) return;
    final block = manuscript.publishBlock;
    if (block != null) {
      showStudioMessage(block.message);
      return;
    }
    await _session.flush();
    if (!mounted) return;
    final published = await showPublishSheet(
      context,
      projectId: widget.projectId,
    );
    if (published && mounted) {
      await _session.reloadManuscript();
      _refreshBookSurfaces();
    }
  }

  Future<void> _openOutline() =>
      showChapterOutlineSheet(context, session: _session);

  /// The book's notebook, over the Studio: the session stays open beneath it,
  /// so coming back is back to the same line.
  void _openNotes() {
    final router = GoRouter.maybeOf(context);
    if (router == null) return;
    unawaited(_session.flush());
    unawaited(router.push<void>(bookNotesLocation(widget.projectId)));
  }

  Future<void> _onMenu(StudioMenuAction action) async {
    final chapterId = _session.chapterId;
    switch (action) {
      case StudioMenuAction.chapters:
        await _openOutline();
      case StudioMenuAction.bookNotes:
        _openNotes();
      case StudioMenuAction.versions:
        if (chapterId == null) return;
        await _session.flush();
        if (!mounted) return;
        final version = await showVersionHistorySheet(
          context,
          projectId: widget.projectId,
          chapterId: chapterId,
        );
        if (version != null && _session.chapterId == chapterId) {
          await _session.applyVersion(version);
        }
      case StudioMenuAction.settings:
        final manuscript = _session.manuscript;
        if (manuscript == null) return;
        final updated = await showManuscriptSettingsSheet(
          context,
          projectId: widget.projectId,
          manuscript: manuscript,
        );
        if (updated != null) _session.updateManuscript(updated);
      case StudioMenuAction.focus:
        setState(() => _focusMode = true);
      case StudioMenuAction.notes:
        final notes = await showChapterNotesSheet(
          context,
          notes: _session.notes,
        );
        if (notes != null) {
          _session.setNotes(notes);
          await _session.saveNow();
        }
      case StudioMenuAction.status:
        final status = await showChapterStatusSheet(
          context,
          current: _session.status,
        );
        if (status != null) _session.setStatus(status);
      case StudioMenuAction.aiTools:
        await _openBookTools();
      case StudioMenuAction.illustrateAll:
        await _illustrateEveryPage();
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts

  void _format(TextEditingValue Function(TextEditingValue) edit) {
    final entry = _session.focusedText.value;
    if (entry == null) return;
    entry.controller.value = edit(entry.controller.value);
  }

  Map<ShortcutActivator, VoidCallback> get _shortcuts => {
    for (final meta in const [false, true]) ...{
      SingleActivator(
        LogicalKeyboardKey.keyB,
        control: !meta,
        meta: meta,
      ): () =>
          _format(toggleBold),
      SingleActivator(
        LogicalKeyboardKey.keyI,
        control: !meta,
        meta: meta,
      ): () =>
          _format(toggleItalic),
      SingleActivator(
        LogicalKeyboardKey.keyS,
        control: !meta,
        meta: meta,
      ): () =>
          unawaited(_session.saveNow()),
    },
    // Ctrl/Cmd+Z and Shift+Z are the text fields' own: each body field's
    // UndoHistoryController is the one the toolbar's Undo and Redo drive.
  };

  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _session,
      builder: (context, _) {
        if (_session.loading) {
          return Scaffold(
            appBar: AppBar(
              leading: IconButton(
                tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                icon: const BackButtonIcon(),
                onPressed: _leave,
              ),
            ),
            body: const StudioEditorSkeleton(),
          );
        }
        final error = _session.loadError;
        if (error != null || _session.document == null) {
          return Scaffold(
            appBar: AppBar(),
            body: AppErrorState(
              title: 'Your book didn’t open',
              message: error == null
                  ? 'This book has no chapters to open.'
                  : userFacingError(error),
              icon: Icons.menu_book_outlined,
              onRetry: _start,
              secondaryLabel: 'Back to the book',
              onSecondary: _leave,
            ),
          );
        }
        return _buildStudio(context);
      },
    );
  }

  Widget _buildStudio(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final twoPane = width >= StudioScreen.twoPaneBreakpoint && !_focusMode;
    final editor = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: StudioEditor(session: _session, host: this),
        ),
        ListenableBuilder(
          listenable: _ai,
          builder: (context, _) {
            final notes = _ai.notes;
            if (notes == null) return const SizedBox.shrink();
            return StudioNotesPanel(
              view: notes,
              chapterLabel: _chapterLabel,
              onSelect: (note) => unawaited(_selectNote(note)),
              onMove: (index) {
                _ai.moveNote(index);
                // Stepping through finds each note's passage, as long as it
                // is in this chapter; another chapter opens only on a tap.
                final note = _ai.notes?.current;
                final elsewhere =
                    note?.chapterId != null &&
                    note?.chapterId != _session.chapterId;
                if (note != null && note.quote != null && !elsewhere) {
                  unawaited(_selectNote(note));
                }
              },
              onClose: _ai.closeNotes,
            );
          },
        ),
        SafeArea(
          top: false,
          child: ValueListenableBuilder<StudioTextEntry?>(
            valueListenable: _session.focusedText,
            builder: (context, entry, _) {
              if (entry != null) {
                return StudioToolbar(
                  key: ValueKey('studio-toolbar-${entry.id}'),
                  entry: entry,
                  onPicture: insertPicture,
                  onAi: (entry) => unawaited(_openAiTools(entry)),
                );
              }
              if (_focusMode) return const SizedBox.shrink();
              return StudioStatusLine(session: _session);
            },
          ),
        ),
      ],
    );
    Widget body = twoPane
        ? Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 320,
                child: Material(
                  color: Theme.of(context).colorScheme.surfaceContainerLow,
                  child: ChapterOutline(
                    session: _session,
                    notify: showStudioMessage,
                  ),
                ),
              ),
              const VerticalDivider(width: 1),
              Expanded(child: editor),
            ],
          )
        : editor;
    if (_focusMode) {
      body = Stack(
        children: [
          SafeArea(bottom: false, child: body),
          SafeArea(
            child: Align(
              alignment: AlignmentDirectional.topEnd,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.xs),
                child: _ExitFocusButton(
                  onPressed: () => setState(() => _focusMode = false),
                ),
              ),
            ),
          ),
        ],
      );
    }
    // A system back pops at once only when everything is saved and there is
    // a page to go back to; otherwise it goes through [_leave], which saves
    // and, when the Studio was opened with `go`, lands on the book.
    return PopScope(
      canPop:
          _session.saveState == StudioSaveState.saved &&
          Navigator.of(context).canPop(),
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) {
          _refreshBookSurfaces();
        } else {
          unawaited(_leave());
        }
      },
      child: CallbackShortcuts(
        bindings: _shortcuts,
        child: Scaffold(
          appBar: _focusMode
              ? null
              : StudioTopBar(
                  session: _session,
                  onBack: _leave,
                  onPublish: _publish,
                  onMenu: _onMenu,
                  onOpenOutline: twoPane ? null : _openOutline,
                  onOpenNotes: _openNotes,
                  ai: _ai,
                  onOpenInbox: () => unawaited(_openInbox()),
                ),
          body: body,
        ),
      ),
    );
  }
}

/// Focus mode's one piece of chrome: a quiet way back out.
class _ExitFocusButton extends StatelessWidget {
  const _ExitFocusButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHigh.withValues(alpha: 0.86),
      shape: const StadiumBorder(),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onPressed,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.sm,
            vertical: AppSpacing.xs,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.close_fullscreen_rounded,
                size: 16,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(
                'Exit focus',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
