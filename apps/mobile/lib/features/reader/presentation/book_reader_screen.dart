import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/project_export_actions.dart';
import '../data/reader_repository.dart';
import '../domain/reader_models.dart';
import 'reader_document_loader.dart';
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
    super.key,
  });

  final String projectId;

  /// A `Page.index` to open at, from a caller that knows which page it means —
  /// a review of an applied edit, say. Resolved to a rendered page once the
  /// document is open, because the PDF carries no such index.
  final int? openAtBookPage;

  @override
  ConsumerState<BookReaderScreen> createState() => _BookReaderScreenState();
}

class _BookReaderScreenState extends ConsumerState<BookReaderScreen> {
  ReaderDocumentLoader? _loader;

  /// Whether the paywall is on screen right now, so a rebuild underneath it
  /// cannot open a second copy.
  bool _paywallOpen = false;

  /// Whether the shortfall has already been put to the reader once.
  ///
  /// Closing the paywall is an answer — "not now" — and the screen behind it
  /// still needs credits, so re-offering on the rebuild that dismissal causes
  /// makes the sheet impossible to close and takes the back button with it: a
  /// reader who declined to unlock could not leave the book. The offer is
  /// therefore made once on arrival, and the locked state behind it keeps a
  /// button to ask for it again deliberately.
  bool _unlockOffered = false;

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

  /// Sends the reader to the paywall on the same terms as every other export
  /// action: an unlock the balance covers is spent silently by the download,
  /// and only a balance that cannot cover it interrupts the reader.
  Future<void> _offerUnlock(MobileExportAvailability export) async {
    if (_paywallOpen) return;
    _paywallOpen = true;
    _unlockOffered = true;
    await openProjectExportPaywall(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
    );
    if (!mounted) return;
    setState(() => _paywallOpen = false);
    // A download that failed for want of credits is worth one more attempt now
    // the reader has been to the shop: leaving it on its error card would make
    // a purchase look like it changed nothing. Against the book's current state
    // rather than this one — a trip through the store is long enough for the
    // unlock, the balance and the compile behind that URL to have all moved.
    final loader = _loader;
    if (loader != null && loader.stage == ReaderLoadStage.failed) {
      unawaited(loader.load(export, refresh: _refreshExport));
    }
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
    final billing = ref.watch(billingProvider).asData?.value;

    _statusSettled |= _refreshRequested && !statusValue.isLoading;
    if (!_statusSettled) {
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: const AppLoadingState(message: 'Opening your book'),
      );
    }

    return statusValue.when(
      loading: () => ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: const AppLoadingState(message: 'Opening your book'),
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
      data: (status) => _buildForStatus(status, billing?.credits.available),
    );
  }

  Widget _buildForStatus(MobileProjectStatus status, int? credits) {
    final export = status.exports.pdf;
    final loader = _loaderFor(ref.read(readerRepositoryProvider));

    if (!export.available && loader.document == null) {
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: AppEmptyState(
          icon: Icons.menu_book_outlined,
          title: 'Still being written',
          message: projectExportStateText(export, credits),
          actionLabel: 'Try again',
          onAction: () =>
              ref.invalidate(projectStatusProvider(widget.projectId)),
        ),
      );
    }

    if (projectExportNeedsCredits(export, credits) && loader.document == null) {
      if (!_unlockOffered) {
        // Scheduled rather than called inline: this runs during build.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !_unlockOffered) unawaited(_offerUnlock(export));
        });
      }
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: AppEmptyState(
          icon: Icons.lock_outline,
          title: 'Unlock to read',
          message: projectExportStateText(export, credits),
          actionLabel: 'Get credits',
          onAction: () => unawaited(_offerUnlock(export)),
        ),
      );
    }

    return ReaderView(
      projectId: widget.projectId,
      export: export,
      loader: loader,
      status: status,
      openAtBookPage: widget.openAtBookPage,
      onOpenPaywall: () => _offerUnlock(export),
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

/// Reports a successful unlock so the credit balance on other screens refreshes.
void notifyReaderUnlockSpent(WidgetRef ref) {
  AppHaptics.success();
  ref.invalidate(billingProvider);
}
