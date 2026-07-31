import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/project_export_actions.dart';
import '../data/reader_repository.dart';
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
  bool _paywallShown = false;

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
    if (_paywallShown) return;
    _paywallShown = true;
    await openProjectExportPaywall(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
    );
    if (mounted) {
      setState(() => _paywallShown = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final statusValue = ref.watch(projectStatusProvider(widget.projectId));
    final billing = ref.watch(billingProvider).asData?.value;

    _statusSettled |= _refreshRequested && !statusValue.isLoading;
    if (!_statusSettled) {
      return const _ReaderScaffold(
        title: 'Reading',
        body: AppLoadingState(message: 'Opening your book'),
      );
    }

    return statusValue.when(
      loading: () => const _ReaderScaffold(
        title: 'Reading',
        body: AppLoadingState(message: 'Opening your book'),
      ),
      error: (error, _) => _ReaderScaffold(
        title: 'Reading',
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
      return _ReaderScaffold(
        title: 'Reading',
        body: AppEmptyState(
          icon: Icons.menu_book_outlined,
          title: 'Still being written',
          message: projectExportStateText(export, credits),
        ),
      );
    }

    if (projectExportNeedsCredits(export, credits) && loader.document == null) {
      // Scheduled rather than called inline: this runs during build.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _offerUnlock(export);
      });
      return _ReaderScaffold(
        title: 'Reading',
        body: AppEmptyState(
          icon: Icons.lock_outline,
          title: 'Unlock to read',
          message: projectExportStateText(export, credits),
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
    );
  }
}

class _ReaderScaffold extends StatelessWidget {
  const _ReaderScaffold({required this.title, required this.body});

  final String title;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(child: body),
    );
  }
}

/// Builds the widget that renders a PDF file.
///
/// Overridable so widget tests can exercise the reader's chrome and state
/// machine without PDFium, whose native libraries are not loaded under
/// `flutter test`.
typedef ReaderViewerBuilder =
    Widget Function(
      BuildContext context,
      String path,
      PdfViewerController controller,
      PdfViewerParams params,
      int initialPageNumber,
    );

Widget defaultReaderViewerBuilder(
  BuildContext context,
  String path,
  PdfViewerController controller,
  PdfViewerParams params,
  int initialPageNumber,
) {
  return PdfViewer.file(
    path,
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
