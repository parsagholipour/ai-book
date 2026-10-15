import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/motion.dart';
import '../../reader/data/export_cache.dart' show fileHasPdfHeader;
import '../../reader/presentation/book_reader_screen.dart'
    show readerViewerBuilderProvider;
import '../../reader/presentation/reader_links.dart';
import '../../reader/presentation/reader_overlays.dart'
    show ReaderOpenErrorState;

/// Whether the server publishes a try-before-signup sample book
/// (`GET /api/mobile/sample-book`, unauthenticated; the operator opts in with
/// `SAMPLE_PROJECT_ID`). Probed once per session; any failure means the
/// affordance simply is not drawn — never an error surfaced to someone who
/// has not even signed up yet.
final sampleBookAvailableProvider = FutureProvider<bool>((ref) async {
  final dio = ref.watch(dioProvider);
  try {
    final response = await dio.head<void>('/api/mobile/sample-book');
    return response.statusCode == 200;
  } catch (_) {
    return false;
  }
});

/// The sample's PDF, downloaded to the temp directory and named by path.
///
/// A provider rather than screen state so the retry is just a refresh and a
/// test can hand the screen a file without a network.
final sampleBookFileProvider = FutureProvider.autoDispose<String>((ref) async {
  final directory = await getTemporaryDirectory();
  return downloadSampleBook(ref.read(dioProvider), directory);
});

/// Downloads the sample into [directory] and returns the file's path.
///
/// The bytes land beside the file and take its place only once they start
/// like a PDF, the same check the reader's export cache makes: a captive
/// portal or a proxy answers the request with a 200 and a page of its own,
/// which would otherwise reach the viewer as a book that will not open. A
/// refusal is an ordinary failure, so the screen offers its retry.
Future<String> downloadSampleBook(Dio dio, Directory directory) async {
  final path = '${directory.path}/tomeza-sample-book.pdf';
  final part = File('$path.part');
  try {
    await dio.download('/api/mobile/sample-book', part.path);
    if (!await fileHasPdfHeader(part)) {
      throw const FormatException('The sample book is not a PDF.');
    }
    await part.rename(path);
    return path;
  } finally {
    if (await part.exists()) {
      try {
        await part.delete();
      } on FileSystemException {
        // Temp-directory litter; the next download overwrites it.
      }
    }
  }
}

/// A finished book, readable before creating an account.
///
/// Deliberately lean next to [BookReaderScreen]: no selections, no markup,
/// no chat — the sample exists to show what a generated book looks like, and
/// to end on the one action a convinced reader wants. That action is pinned
/// under the book, so it is on screen whether the sample is loading, reading,
/// or could not be fetched at all.
class SampleBookScreen extends ConsumerStatefulWidget {
  const SampleBookScreen({super.key});

  @override
  ConsumerState<SampleBookScreen> createState() => _SampleBookScreenState();
}

class _SampleBookScreenState extends ConsumerState<SampleBookScreen> {
  final PdfViewerController _controller = PdfViewerController();
  int? _pageNumber;
  int? _pageCount;

  /// The sample's links work, and here the viewer is allowed to own them: this
  /// screen lays nothing over the page, so there is no second tap owner to
  /// collide with the way there is in the reader. Nothing is painted over a
  /// link — the book prints its own citations blue and underlined — and the
  /// address still goes through the reader's policy before anything opens.
  ///
  /// Held in a field because [PdfViewerParams] compares by value: rebuilt
  /// inside `build`, every `setState` would read as a reason to relayout. Only
  /// the backdrop follows the theme, so it is rebuilt when that changes.
  PdfViewerParams? _params;
  Color? _paramsBackdrop;

  /// Bumped by "Download again". Every download lands at the same path, and
  /// pdfrx keys a file document on its name and will not reopen one it has
  /// already failed on, so the fresh copy needs an identity of its own (the
  /// reader's `readerDocumentRef` does the same for its cache).
  int _download = 0;

  void _onLinkTap(PdfLink link) {
    unawaited(
      followPdfLink(
        context: context,
        ref: ref,
        controller: _controller,
        link: link,
      ),
    );
  }

  void _onPageChanged(int? page) {
    if (!mounted || page == _pageNumber) return;
    setState(() => _pageNumber = page);
  }

  void _onViewerReady(PdfDocument document, PdfViewerController controller) {
    if (!mounted) return;
    setState(() => _pageCount = document.pages.length);
  }

  PdfViewerParams _paramsFor(Color backdrop) {
    if (_params == null || _paramsBackdrop != backdrop) {
      _paramsBackdrop = backdrop;
      _params = PdfViewerParams(
        backgroundColor: backdrop,
        onPageChanged: _onPageChanged,
        onViewerReady: _onViewerReady,
        // pdfrx's default is a developer's screen with a stack trace.
        errorBannerBuilder: _buildOpenError,
        linkHandlerParams: PdfLinkHandlerParams(
          onLinkTap: _onLinkTap,
          linkColor: Colors.transparent,
        ),
      );
    }
    return _params!;
  }

  /// Drawn by the viewer in place of a sample it could not open: the reader's
  /// own state, whose one action fetches the file again.
  Widget _buildOpenError(
    BuildContext context,
    Object error,
    StackTrace? stackTrace,
    PdfDocumentRef documentRef,
  ) {
    return ReaderOpenErrorState(topInset: 0, onDownloadAgain: _downloadAgain);
  }

  /// Fetches the sample again. Unlike the reader's cache there is no copy to
  /// discard first: [downloadSampleBook] always downloads, and its rename
  /// replaces the file that would not open.
  void _downloadAgain() {
    if (!mounted) return;
    setState(() {
      _download++;
      _pageNumber = null;
      _pageCount = null;
    });
    ref.invalidate(sampleBookFileProvider);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final file = ref.watch(sampleBookFileProvider);
    final maxPanelHeight = MediaQuery.sizeOf(context).height * 0.5;

    return Scaffold(
      appBar: AppBar(title: const Text('Sample book')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: file.when(
                skipLoadingOnRefresh: false,
                loading: () => const _SampleSkeleton(),
                error: (_, _) => Center(
                  child: SingleChildScrollView(
                    child: AppErrorState(
                      title: 'Sample unavailable',
                      message: 'The sample book could not be loaded.',
                      onRetry: () => ref.invalidate(sampleBookFileProvider),
                    ),
                  ),
                ),
                data: (path) => _SampleReader(
                  pageNumber: _pageNumber,
                  pageCount: _pageCount,
                  viewer: ref.watch(readerViewerBuilderProvider)(
                    context,
                    // The sample is one fixed file that is never recompiled
                    // under the reader; only "Download again" replaces it.
                    PdfDocumentRefFile(
                      path,
                      key: PdfDocumentRefKey(path, [_download]),
                    ),
                    _controller,
                    _paramsFor(colors.surfaceContainerHigh),
                    1,
                  ),
                ),
              ),
            ),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxPanelHeight),
              child: SingleChildScrollView(
                child: _MakeYourOwnPanel(
                  onPressed: () => context.go('/auth/sign-up'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The book in a frame: a page-shaped surface on a soft backdrop, with the
/// reader's place in it floated over the bottom edge.
class _SampleReader extends StatelessWidget {
  const _SampleReader({
    required this.viewer,
    required this.pageNumber,
    required this.pageCount,
  });

  final Widget viewer;
  final int? pageNumber;
  final int? pageCount;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final place = pageNumber == null
        ? null
        : pageCount == null
        ? 'Page $pageNumber'
        : 'Page $pageNumber of $pageCount';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpacing.lg,
            AppSpacing.xxs,
            AppSpacing.lg,
            AppSpacing.xs,
          ),
          child: Text(
            'A finished book, made with Tomeza. Scroll to read.',
            style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(
              AppSpacing.md,
              0,
              AppSpacing.md,
              AppSpacing.sm,
            ),
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(AppRadii.card),
                border: Border.all(color: colors.outlineVariant),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(
                      alpha: colors.brightness == Brightness.light ? 0.08 : 0.4,
                    ),
                    blurRadius: 18,
                    offset: const Offset(0, 6),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AppRadii.card),
                child: Stack(
                  children: [
                    Positioned.fill(child: viewer),
                    if (place != null)
                      PositionedDirectional(
                        bottom: AppSpacing.sm,
                        start: 0,
                        end: 0,
                        child: IgnorePointer(
                          child: Center(child: _PagePill(label: place)),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _PagePill extends StatelessWidget {
  const _PagePill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: false,
      label: label,
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.inverseSurface.withValues(alpha: 0.82),
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: AppSpacing.xxs + 2,
            ),
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colors.onInverseSurface,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A page-shaped placeholder while the file downloads: the same frame the book
/// will sit in, with the outline of a title page, so the wait reads as the book
/// being opened rather than as a spinner on a blank screen.
class _SampleSkeleton extends StatelessWidget {
  const _SampleSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final block = colors.surfaceContainerHigh;

    Widget bar(double widthFactor, double height) => FractionallySizedBox(
      widthFactor: widthFactor,
      alignment: AlignmentDirectional.centerStart,
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: block,
          borderRadius: BorderRadius.circular(AppRadii.compact / 2),
        ),
      ),
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Opening the sample',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpacing.md,
            AppSpacing.md,
            AppSpacing.md,
            AppSpacing.sm,
          ),
          child: AppShimmer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colors.surfaceContainerLowest,
                borderRadius: BorderRadius.circular(AppRadii.card),
                border: Border.all(color: colors.outlineVariant),
              ),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const SizedBox(height: AppSpacing.xl),
                    bar(0.7, 28),
                    const SizedBox(height: AppSpacing.xs),
                    bar(0.45, 28),
                    const SizedBox(height: AppSpacing.lg),
                    bar(0.3, 12),
                    const SizedBox(height: AppSpacing.xl),
                    Expanded(
                      child: Container(
                        decoration: BoxDecoration(
                          color: block,
                          borderRadius: BorderRadius.circular(AppRadii.control),
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    bar(0.9, 10),
                    const SizedBox(height: AppSpacing.xs),
                    bar(0.8, 10),
                    const SizedBox(height: AppSpacing.xs),
                    bar(0.6, 10),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The reason to be here, pinned under the book.
class _MakeYourOwnPanel extends StatelessWidget {
  const _MakeYourOwnPanel({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(
          AppSpacing.lg,
          AppSpacing.md,
          AppSpacing.lg,
          AppSpacing.md,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Describe your idea in a chat and Tomeza turns it into a '
              'finished book like this one.',
              style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.sm),
            AppButton.primary(
              onPressed: onPressed,
              leading: const Icon(Icons.auto_stories_outlined),
              label: 'Make my own',
              expanded: true,
            ),
          ],
        ),
      ),
    );
  }
}
