import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../reader/presentation/book_reader_screen.dart'
    show readerViewerBuilderProvider;
import '../../reader/presentation/reader_links.dart';

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

/// A finished book, readable before creating an account.
///
/// Deliberately lean next to [BookReaderScreen]: no selections, no markup,
/// no chat — the sample exists to show what a generated book looks like, and
/// to end on the one action a convinced reader wants.
class SampleBookScreen extends ConsumerStatefulWidget {
  const SampleBookScreen({super.key});

  @override
  ConsumerState<SampleBookScreen> createState() => _SampleBookScreenState();
}

class _SampleBookScreenState extends ConsumerState<SampleBookScreen> {
  final PdfViewerController _controller = PdfViewerController();
  String? _path;
  bool _failed = false;

  /// The sample's links work, and here the viewer is allowed to own them: this
  /// screen lays nothing over the page, so there is no second tap owner to
  /// collide with the way there is in the reader. Nothing is painted over a
  /// link — the book prints its own citations blue and underlined — and the
  /// address still goes through the reader's policy before anything opens.
  ///
  /// Held in a field because [PdfViewerParams] compares by value: rebuilt
  /// inside `build`, every `setState` would read as a reason to relayout.
  late final PdfViewerParams _params = PdfViewerParams(
    linkHandlerParams: PdfLinkHandlerParams(
      onLinkTap: _onLinkTap,
      linkColor: Colors.transparent,
    ),
  );

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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final directory = await getTemporaryDirectory();
      final path = '${directory.path}/tomeza-sample-book.pdf';
      await ref.read(dioProvider).download('/api/mobile/sample-book', path);
      if (mounted) setState(() => _path = path);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final path = _path;
    return Scaffold(
      appBar: AppBar(title: const Text('Sample book')),
      body: SafeArea(
        child: _failed
            ? AppErrorState(
                title: 'Sample unavailable',
                message: 'The sample book could not be loaded.',
                onRetry: _load,
              )
            : path == null
            ? const AppLoadingState(message: 'Opening the sample')
            : Column(
                children: [
                  Expanded(
                    child: ref.watch(readerViewerBuilderProvider)(
                      context,
                      // The sample is one fixed file that is never recompiled
                      // under the reader, so its path is a whole identity.
                      PdfDocumentRefFile(path),
                      _controller,
                      _params,
                      1,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                    child: AppButton.primary(
                      onPressed: () => context.go('/auth/sign-up'),
                      leading: const Icon(Icons.auto_stories_outlined),
                      label: 'Create a book like this',
                      expanded: true,
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
