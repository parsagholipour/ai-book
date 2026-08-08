import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../reader/presentation/book_reader_screen.dart'
    show readerViewerBuilderProvider;

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
      await ref
          .read(dioProvider)
          .download('/api/mobile/sample-book', path);
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
                      path,
                      _controller,
                      const PdfViewerParams(),
                      1,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                    child: FilledButton.icon(
                      onPressed: () => context.go('/auth/sign-up'),
                      icon: const Icon(Icons.auto_stories_outlined),
                      label: const Text('Create a book like this'),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
