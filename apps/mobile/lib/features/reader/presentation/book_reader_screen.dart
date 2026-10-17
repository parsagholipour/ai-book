import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../projects/data/offline_library_store.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/project_export_actions.dart';
import '../data/reader_repository.dart';
import '../domain/reader_models.dart';
import 'reader_document_loader.dart';
import 'reader_opening_state.dart';
import 'reader_view.dart';

/// Reads a finished book inside the app.
///
/// Renders the same PDF the user would download, so what they read is exactly
/// what they get. The reading surface is wired back into the rest of the app:
/// selecting a passage can ask about it, rewrite it, or open the page editor,
/// and an edit that recompiles the book is picked up without leaving.
class BookReaderScreen extends ConsumerStatefulWidget {
  const BookReaderScreen({
    required this.projectId,
    this.openAtBookPage,
    this.openAtSheet,
    this.openAtSheetDigest,
    super.key,
  });

  final String projectId;

  /// A `Page.index` to open at, from a caller that knows which page it means —
  /// a review of an applied edit, say. Resolved to a rendered page once the
  /// document is open, because the PDF carries no such index.
  final int? openAtBookPage;

  /// Where that page starts in the PDF whose digest is [openAtSheetDigest],
  /// for a caller the server told — see [ReaderView.openAtSheet].
  final int? openAtSheet;
  final String? openAtSheetDigest;

  @override
  ConsumerState<BookReaderScreen> createState() => _BookReaderScreenState();
}

class _BookReaderScreenState extends ConsumerState<BookReaderScreen> {
  ReaderDocumentLoader? _loader;

  /// Whether the re-check of the book's state has been asked for yet.
  bool _refreshRequested = false;

  /// Whether a status fetched by *this* screen has arrived.
  ///
  /// The status stream ends as soon as the book stops working, and the provider
  /// keeps that final value for whoever asks next. Opening the reader from a
  /// screen that is still watching it therefore inherits a snapshot, not the
  /// truth — and after an edit the truth arrives late: the edit is marked
  /// applied and only then is the PDF recompiled. A reader opened against the
  /// pre-recompile snapshot carries the old export revision, so the cached file
  /// still matches it and the reader silently shows the text the user just
  /// changed.
  ///
  /// Asking again is not enough on its own. The provider still has the chat as
  /// a listener, so invalidating it is a *refresh*: Riverpod keeps the previous
  /// value and `AsyncValue.when` hands it straight back while the new one is in
  /// flight. Building from that would start downloading the stale revision
  /// before the fresh status could land — the download the whole re-check
  /// exists to avoid. So the screen waits for a value that is not still
  /// loading, and latches once it has one: later refreshes are the book being
  /// edited, which must not blank the page the reader is on.
  bool _statusSettled = false;

  @override
  void initState() {
    super.initState();
    // After the frame: invalidating a provider during build marks the scope
    // dirty while the framework is already building it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.invalidate(projectStatusProvider(widget.projectId));
      setState(() => _refreshRequested = true);
    });
  }

  @override
  void dispose() {
    _loader?.dispose();
    super.dispose();
  }

  ReaderDocumentLoader _loaderFor(ReaderRepository repository) {
    return _loader ??= ReaderDocumentLoader(
      repository: repository,
      projectId: widget.projectId,
    );
  }

  /// Re-reads the book's state and answers with the export it is now offering.
  ///
  /// The reader's retry comes through here rather than reusing the descriptor
  /// this screen was built with: a download only fails once the book has moved
  /// underneath it, so the descriptor that failed is the one least likely to
  /// still describe what is behind that URL. See `ReaderView._retryDownload`.
  ///
  /// Invalidating is a *refresh* while the chat still listens — Riverpod hands
  /// the previous value back until the new one lands — so the answer is taken
  /// from the future rather than from whatever `build` sees next. Failures are
  /// left to the caller, which falls back to the descriptor it already had.
  Future<MobileExportAvailability?> _refreshExport() async {
    if (!mounted) return null;
    final provider = projectStatusProvider(widget.projectId);
    ref.invalidate(provider);
    final status = await ref.read(provider.future);
    return status.exports.pdf;
  }

  @override
  Widget build(BuildContext context) {
    final statusValue = ref.watch(projectStatusProvider(widget.projectId));
    final offlineSession = ref.watch(
      authControllerProvider.select(
        (auth) => auth.asData?.value?.offline ?? false,
      ),
    );

    _statusSettled |= _refreshRequested && !statusValue.isLoading;
    // Out of reach of the server, the book on this phone is opened against
    // the last status kept for it. A session that started offline does not
    // wait for the status read to fail first; any other reader learns it
    // from that read.
    final unreachable =
        statusValue.hasError && isOfflineFailure(statusValue.error);
    if ((unreachable && (_statusSettled || offlineSession)) ||
        (offlineSession && statusValue.isLoading && !statusValue.hasValue)) {
      return _buildOffline(statusValue.value);
    }
    if (!_statusSettled) {
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: const ReaderOpeningState(),
      );
    }

    return statusValue.when(
      loading: () => ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: const ReaderOpeningState(),
      ),
      error: (error, _) => ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: AppErrorState(
          title: 'Could not open this book',
          message: userFacingError(error),
          onRetry: () =>
              ref.invalidate(projectStatusProvider(widget.projectId)),
        ),
      ),
      data: _buildForStatus,
    );
  }

  Widget _buildForStatus(MobileProjectStatus status) {
    final export = status.exports.pdf;
    final loader = _loaderFor(ref.read(readerRepositoryProvider));

    if (!export.available && loader.document == null) {
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: AppEmptyState(
          icon: Icons.menu_book_outlined,
          title: 'Still being written',
          message: projectExportStateText(export),
          actionLabel: 'Try again',
          onAction: () =>
              ref.invalidate(projectStatusProvider(widget.projectId)),
        ),
      );
    }

    return _readerView(status);
  }

  /// The reader with no server to ask. [latest] is the freshest status this
  /// run read; when it offers no PDF, the copy kept on this phone stands in.
  /// Neither is shown as live: the reader only reads.
  Widget _buildOffline(MobileProjectStatus? latest) {
    final saved = ref.watch(offlineBookStatusProvider(widget.projectId));
    final status = latest != null && latest.exports.pdf.available
        ? latest
        : saved.value?.status;
    if (status != null) {
      return _readerView(status, offline: true);
    }
    return ReaderScaffold(
      title: 'Reading',
      projectId: widget.projectId,
      body: saved.isLoading
          ? const ReaderOpeningState()
          : AppEmptyState(
              key: const Key('reader-offline-unsaved'),
              icon: Icons.cloud_off_outlined,
              title: 'Not on this phone yet',
              message:
                  "This book hasn't been opened on this phone, so there is "
                  'nothing to read without a connection. Connect to the '
                  'internet to open it.',
              actionLabel: 'Try again',
              onAction: () =>
                  ref.invalidate(projectStatusProvider(widget.projectId)),
            ),
    );
  }

  /// One place builds the reader, online or not, so going back online keeps
  /// the same [ReaderView] — its page, its markup and the document on screen.
  Widget _readerView(MobileProjectStatus status, {bool offline = false}) {
    final export = status.exports.pdf;
    return ReaderView(
      projectId: widget.projectId,
      export: export,
      loader: _loaderFor(ref.read(readerRepositoryProvider)),
      status: status,
      offline: offline,
      openAtBookPage: widget.openAtBookPage,
      openAtSheet: widget.openAtSheet,
      openAtSheetDigest: widget.openAtSheetDigest,
      onRefreshExport: _refreshExport,
    );
  }
}

/// The chrome the reader wears before there is a book to render.
///
/// Public because [ReaderView] shows the same thing while the download runs;
/// it used to hand-roll a second copy, which is how the escape hatch below
/// ended up on one of them only.
class ReaderScaffold extends StatelessWidget {
  const ReaderScaffold({
    required this.title,
    required this.projectId,
    required this.body,
    super.key,
  });

  final String title;
  final String projectId;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        // Reading is always leavable, including from the states that are not
        // reading yet. A reader who arrived by deep link has nothing behind
        // them to pop, so the book's own page stands in for back rather than a
        // bar with no way out of it.
        leading: Navigator.of(context).canPop()
            ? null
            : IconButton(
                tooltip: 'Close',
                icon: const Icon(Icons.close),
                onPressed: () => context.go('/projects/$projectId'),
              ),
      ),
      body: Center(child: body),
    );
  }
}

/// Builds the widget that renders a PDF document.
///
/// Overridable so widget tests can exercise the reader's chrome and state
/// machine without PDFium, whose native libraries are not loaded under
/// `flutter test`.
///
/// Takes a [PdfDocumentRef] rather than a path because the path is not an
/// identity here: every compile of a book is published over the same
/// `book.pdf`, and pdfrx canonicalizes documents by that name. See
/// [readerDocumentRef].
typedef ReaderViewerBuilder =
    Widget Function(
      BuildContext context,
      PdfDocumentRef documentRef,
      PdfViewerController controller,
      PdfViewerParams params,
      int initialPageNumber,
    );

/// Names a downloaded compile in a way pdfrx can tell apart from the last one.
///
/// `PdfDocumentRefFile` keys itself on the filename, `PdfViewer` skips its
/// update when the key is unchanged, and the loader behind that key refuses to
/// open a file it has already opened. Since `ExportCache` publishes every
/// compile over `book.pdf`, all three of those conspire to keep the *previous*
/// book on screen after a reload — with the banner cleared and new markup
/// stamped with a revision it was never placed against.
///
/// The revision alone is not enough: a download the server could not vouch for
/// carries none, and two such downloads must still be different documents. The
/// size and the moment it arrived stand in.
PdfDocumentRef readerDocumentRef(CachedExport export) {
  return PdfDocumentRefFile(
    export.path,
    key: PdfDocumentRefKey(export.path, [
      export.revision,
      export.digest,
      export.byteSize,
      export.downloadedAt,
    ]),
  );
}

Widget defaultReaderViewerBuilder(
  BuildContext context,
  PdfDocumentRef documentRef,
  PdfViewerController controller,
  PdfViewerParams params,
  int initialPageNumber,
) {
  return PdfViewer(
    documentRef,
    controller: controller,
    params: params,
    initialPageNumber: initialPageNumber,
  );
}

final readerViewerBuilderProvider = Provider<ReaderViewerBuilder>(
  (ref) => defaultReaderViewerBuilder,
);
