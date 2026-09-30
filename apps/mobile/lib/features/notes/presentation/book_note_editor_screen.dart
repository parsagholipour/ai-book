import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../data/book_notes_repository.dart';
import '../domain/book_note.dart';
import 'book_note_session.dart';
import 'notes_common.dart';
import 'notes_location.dart';

enum _EditorAction { copy, delete }

/// One note, open for writing: a title, and a body that fills the page.
///
/// Every change saves itself a moment after the typing stops, and again when
/// the note is left or the app goes to the background. A new note is only
/// created once something is written in it; one left empty is never kept.
class BookNoteEditorScreen extends ConsumerStatefulWidget {
  const BookNoteEditorScreen({required this.projectId, this.noteId, super.key});

  final String projectId;

  /// The note to open; null for a new one.
  final String? noteId;

  @override
  ConsumerState<BookNoteEditorScreen> createState() =>
      _BookNoteEditorScreenState();
}

class _BookNoteEditorScreenState extends ConsumerState<BookNoteEditorScreen>
    with WidgetsBindingObserver {
  BookNoteSession? _session;
  final _bodyFocus = FocusNode();
  final _titleFocus = FocusNode();
  late final BookNotesActions _actions = ref.read(bookNotesActionsProvider);
  ScaffoldMessengerState? _messenger;
  bool _leaving = false;

  /// The note was not in the book's list: deleted elsewhere, or never there.
  bool _missing = false;

  String get _projectId => widget.projectId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final noteId = widget.noteId;
    if (noteId == null) {
      _start(null);
    } else {
      // Keeps the book's list alive for as long as the note is open, and
      // opens the note from it the moment it is there.
      final subscription = ref.listenManual(bookNotesProvider(_projectId), (
        previous,
        next,
      ) {
        if (_seed(next)) setState(() {});
      });
      _seed(subscription.read());
    }
  }

  /// Opens the note once the list holds it. True when that changed anything.
  bool _seed(AsyncValue<List<BookNote>> value) {
    if (_session != null || _missing) return false;
    final notes = value.value;
    if (notes == null) return false;
    BookNote? found;
    for (final note in notes) {
      if (note.id == widget.noteId) found = note;
    }
    if (found == null) {
      _missing = true;
    } else {
      _start(found);
    }
    return true;
  }

  void _start(BookNote? note) {
    _session = BookNoteSession(
      projectId: _projectId,
      repository: ref.read(bookNotesRepositoryProvider),
      note: note,
      onSaved: (saved) => _actions.saved(_projectId, saved),
      onRemoved: (noteId) => _actions.removed(_projectId, noteId),
      onNotice: _showNotice,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.maybeOf(context);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _session?.dispose();
    _bodyFocus.dispose();
    _titleFocus.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden) {
      final session = _session;
      if (session != null) unawaited(session.flush());
    }
  }

  void _showNotice(BookNoteNotice notice) {
    final messenger = _messenger;
    if (messenger == null) return;
    final open = notice.openNote;
    messenger.hideCurrentSnackBar();
    messenger.showAppSnackBar(
      SnackBar(
        content: Text(notice.message),
        action: open == null || !mounted
            ? null
            : SnackBarAction(
                label: 'Open',
                onPressed: () {
                  if (mounted) {
                    unawaited(
                      context.push(bookNoteLocation(_projectId, open.id)),
                    );
                  }
                },
              ),
      ),
    );
  }

  /// Saves what is left and goes back; asks first when the last changes
  /// would not save.
  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    final session = _session;
    if (session != null) {
      final result = await session.close();
      if (!mounted) return;
      if (result == BookNoteLeave.failed) {
        AppHaptics.warning();
        final discard = await showAppConfirmationDialog(
          context,
          title: 'Leave without saving?',
          message:
              'Your latest changes to this note could not be saved. If you '
              'leave now, they will be lost.',
          confirmLabel: 'Discard',
          cancelLabel: 'Keep editing',
          destructive: true,
        );
        if (!mounted) return;
        if (!discard) {
          _leaving = false;
          return;
        }
        session.discard();
      }
    }
    _pop();
  }

  void _pop() {
    final navigator = Navigator.of(context);
    if (navigator.canPop()) {
      navigator.pop();
      return;
    }
    // Opened with `go` (a deep link): the way back is the book's notes.
    final router = GoRouter.maybeOf(context);
    if (router != null) {
      router.go(bookNotesLocation(_projectId));
    } else {
      _leaving = false;
    }
  }

  Future<void> _onMenu(_EditorAction action) async {
    final session = _session;
    if (session == null) return;
    switch (action) {
      case _EditorAction.copy:
        final text = [
          session.title.text.trim(),
          session.body.text.trim(),
        ].where((part) => part.isNotEmpty).join('\n\n');
        if (text.isNotEmpty) {
          await Clipboard.setData(ClipboardData(text: text));
          AppHaptics.selection();
        }
        _messenger?.hideCurrentSnackBar();
        _messenger?.showAppSnackBar(
          SnackBar(
            content: Text(text.isEmpty ? 'Nothing to copy yet' : 'Note copied'),
          ),
        );
      case _EditorAction.delete:
        final messenger = _messenger;
        if (messenger == null || _leaving) return;
        _leaving = true;
        final taken = await session.prepareDelete();
        if (!mounted) return;
        _pop();
        unawaited(
          deleteBookNoteWithUndo(
            messenger: messenger,
            actions: _actions,
            projectId: _projectId,
            stored: taken.stored,
            restore: taken.draft,
          ),
        );
    }
  }

  void _focusBodyEnd() {
    final body = _session?.body;
    if (body == null) return;
    _bodyFocus.requestFocus();
    body.selection = TextSelection.collapsed(offset: body.text.length);
  }

  @override
  Widget build(BuildContext context) {
    final session = _session;
    if (session == null) return _waiting();
    return ListenableBuilder(
      listenable: session,
      builder: (context, _) => PopScope(
        canPop: session.canLeaveQuietly && Navigator.of(context).canPop(),
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(_leave());
        },
        child: Scaffold(appBar: _bar(session), body: _editor(session)),
      ),
    );
  }

  PreferredSizeWidget _bar(BookNoteSession session) {
    final theme = Theme.of(context);
    final bookTitle = watchNotesBookTitle(ref, _projectId);
    final pinned = session.pinned;
    return AppBar(
      toolbarHeight: 64,
      leading: IconButton(
        tooltip: MaterialLocalizations.of(context).backButtonTooltip,
        icon: const BackButtonIcon(),
        onPressed: _leave,
      ),
      titleSpacing: 0,
      title: _retryable(
        session,
        NotesBarTitle(
          title: Text(
            bookTitle ?? 'Note',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          subtitle: BookNoteSaveIndicator(session: session),
        ),
      ),
      actions: [
        IconButton(
          key: const ValueKey('book-note-pin'),
          tooltip: pinned ? 'Unpin note' : 'Pin note',
          isSelected: pinned,
          // The brand colour marks it on, beside the glyph filling in.
          color: pinned ? theme.colorScheme.primary : null,
          icon: const Icon(Icons.push_pin_outlined),
          selectedIcon: const Icon(Icons.push_pin),
          onPressed: () {
            AppHaptics.selection();
            unawaited(session.togglePinned());
          },
        ),
        PopupMenuButton<_EditorAction>(
          key: const ValueKey('book-note-more'),
          tooltip: 'More options',
          icon: const Icon(Icons.more_vert),
          onSelected: (action) => unawaited(_onMenu(action)),
          itemBuilder: (context) => const [
            PopupMenuItem(
              value: _EditorAction.copy,
              child: NotesMenuRow(icon: Icons.copy_rounded, label: 'Copy text'),
            ),
            PopupMenuItem(
              value: _EditorAction.delete,
              child: NotesMenuRow(
                icon: Icons.delete_outline,
                label: 'Delete note',
                destructive: true,
              ),
            ),
          ],
        ),
        const SizedBox(width: AppSpacing.xxs),
      ],
    );
  }

  /// While a save is failing the whole title block retries it: the
  /// indicator's own line is too small a target on its own.
  Widget _retryable(BookNoteSession session, Widget title) {
    if (session.saveState != BookNoteSaveState.failed) return title;
    return InkWell(
      onTap: session.retry,
      borderRadius: BorderRadius.circular(AppRadii.compact),
      excludeFromSemantics: true,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minHeight: AppSizes.minimumTouchTarget,
        ),
        child: Align(
          alignment: AlignmentDirectional.centerStart,
          widthFactor: 1,
          child: title,
        ),
      ),
    );
  }

  Widget _editor(BookNoteSession session) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final width = MediaQuery.sizeOf(context).width;
    final gutter = width < 480 ? 20.0 : 32.0;
    final titleStyle = theme.textTheme.headlineSmall?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.4,
      height: 1.25,
      color: colors.onSurface,
    );
    final bodyStyle = theme.textTheme.bodyLarge?.copyWith(
      height: 1.55,
      color: colors.onSurface,
    );
    final localizations = MaterialLocalizations.of(context);
    return SafeArea(
      top: false,
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: EdgeInsets.fromLTRB(gutter, AppSpacing.sm, gutter, 0),
                sliver: SliverList.list(
                  children: [
                    ListenableBuilder(
                      listenable: session.title,
                      builder: (context, _) => TextField(
                        key: const ValueKey('book-note-title'),
                        controller: session.title,
                        focusNode: _titleFocus,
                        maxLines: null,
                        maxLength: bookNoteTitleLimit,
                        maxLengthEnforcement: MaxLengthEnforcement.enforced,
                        textDirection: noteTextDirection(session.title.text),
                        textCapitalization: TextCapitalization.sentences,
                        textInputAction: TextInputAction.next,
                        onSubmitted: (_) => _bodyFocus.requestFocus(),
                        style: titleStyle,
                        decoration: _bare(
                          hint: 'Title',
                          hintStyle: titleStyle?.copyWith(
                            color: colors.onSurfaceVariant.withValues(
                              alpha: 0.7,
                            ),
                          ),
                        ).copyWith(counterText: ''),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    ListenableBuilder(
                      listenable: session.body,
                      builder: (context, _) => TextField(
                        key: const ValueKey('book-note-body'),
                        controller: session.body,
                        focusNode: _bodyFocus,
                        autofocus: !session.isCreated && session.isBlank,
                        maxLines: null,
                        minLines: 6,
                        maxLength: bookNoteBodyLimit,
                        maxLengthEnforcement: MaxLengthEnforcement.enforced,
                        keyboardType: TextInputType.multiline,
                        textDirection: noteTextDirection(session.body.text),
                        textCapitalization: TextCapitalization.sentences,
                        style: bodyStyle,
                        buildCounter:
                            (
                              context, {
                              required currentLength,
                              required isFocused,
                              required maxLength,
                            }) {
                              // Quiet until the limit is near enough to
                              // matter.
                              if (maxLength == null ||
                                  currentLength < maxLength - 1000) {
                                return null;
                              }
                              return Text(
                                '${localizations.formatDecimal(currentLength)}'
                                ' / ${localizations.formatDecimal(maxLength)}',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              );
                            },
                        decoration: _bare(
                          hint: 'Start writing…',
                          hintStyle: bodyStyle?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // The rest of the page is the body too: a tap anywhere below
              // the text puts the cursor at its end.
              SliverFillRemaining(
                hasScrollBody: false,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  excludeFromSemantics: true,
                  onTap: _focusBodyEnd,
                  child: const SizedBox(height: 160),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  InputDecoration _bare({required String hint, TextStyle? hintStyle}) {
    return InputDecoration(
      hintText: hint,
      hintStyle: hintStyle,
      isCollapsed: true,
      filled: false,
      contentPadding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      border: InputBorder.none,
      enabledBorder: InputBorder.none,
      focusedBorder: InputBorder.none,
      disabledBorder: InputBorder.none,
      errorBorder: InputBorder.none,
      focusedErrorBorder: InputBorder.none,
    );
  }

  /// Before the note is open: the list still loading, failing, or without it.
  Widget _waiting() {
    final value = ref.watch(bookNotesProvider(_projectId));
    final Widget body;
    if (_missing) {
      body = AppEmptyState(
        key: const ValueKey('book-note-missing'),
        icon: bookNotesIcon,
        title: 'This note is gone',
        message:
            'It may have been deleted on another device. Your other notes '
            'are still here.',
        actionLabel: 'See all notes',
        onAction: () => context.pushReplacement(bookNotesLocation(_projectId)),
      );
    } else if (value.hasError && !value.isLoading) {
      body = AppErrorState(
        title: 'Could not open this note',
        message: userFacingError(value.error!),
        onRetry: () => ref.invalidate(bookNotesProvider(_projectId)),
      );
    } else {
      body = const _EditorSkeleton();
    }
    return Scaffold(appBar: AppBar(), body: body);
  }
}

/// Saved · Saving… · Not saved — tap to retry, each with its own glyph so the
/// state never rides on the words alone.
class BookNoteSaveIndicator extends StatelessWidget {
  const BookNoteSaveIndicator({required this.session, super.key});

  final BookNoteSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final state = session.saveState;
    final (icon, color, text) = switch (state) {
      BookNoteSaveState.draft => (
        Icons.edit_outlined,
        colors.onSurfaceVariant,
        state.label,
      ),
      BookNoteSaveState.saving => (
        Icons.cloud_upload_outlined,
        colors.onSurfaceVariant,
        state.label,
      ),
      BookNoteSaveState.saved => (
        Icons.cloud_done_outlined,
        colors.onSurfaceVariant,
        state.label,
      ),
      BookNoteSaveState.failed => (
        Icons.cloud_off_outlined,
        colors.error,
        'Not saved — tap to retry',
      ),
    };
    final indicator = Semantics(
      liveRegion: true,
      button: state == BookNoteSaveState.failed,
      label: text,
      onTap: state == BookNoteSaveState.failed ? session.retry : null,
      child: ExcludeSemantics(
        child: AnimatedSwitcher(
          duration: AppMotion.adapt(context, AppMotion.fast),
          child: Row(
            key: ValueKey(state),
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  text,
                  key: const ValueKey('book-note-save-state'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: color,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (state != BookNoteSaveState.failed) return indicator;
    return GestureDetector(
      key: const ValueKey('book-note-retry'),
      behavior: HitTestBehavior.opaque,
      onTap: session.retry,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 24),
        child: indicator,
      ),
    );
  }
}

class _EditorSkeleton extends StatelessWidget {
  const _EditorSkeleton();

  @override
  Widget build(BuildContext context) {
    return const AppSkeletonGroup(
      label: 'Opening note',
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, AppSpacing.md, 20, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppSkeleton.line(widthFactor: 0.6, height: 24),
            SizedBox(height: AppSpacing.lg),
            AppSkeleton.line(widthFactor: 0.95),
            SizedBox(height: AppSpacing.sm),
            AppSkeleton.line(widthFactor: 0.88),
            SizedBox(height: AppSpacing.sm),
            AppSkeleton.line(widthFactor: 0.7),
          ],
        ),
      ),
    );
  }
}
