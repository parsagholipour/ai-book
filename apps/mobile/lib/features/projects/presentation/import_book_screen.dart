import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';

/// "Bring your own book": upload a finished manuscript and continue working
/// on it — AI edits, continuation in the author's voice, and exports.
class ImportBookScreen extends ConsumerStatefulWidget {
  const ImportBookScreen({super.key, this.pickFileOverride});

  /// Test seam: replaces the platform file picker in widget tests.
  final Future<XFile?> Function()? pickFileOverride;

  @override
  ConsumerState<ImportBookScreen> createState() => _ImportBookScreenState();
}

class _ImportBookScreenState extends ConsumerState<ImportBookScreen> {
  static const _maxImportBytes = 20 * 1024 * 1024;

  /// Importable manuscript formats; photos and PDFs are not accepted yet.
  static const _manuscriptTypeGroup = XTypeGroup(
    label: 'Manuscripts',
    extensions: ['docx', 'epub', 'txt', 'md', 'markdown', 'html', 'htm', 'rtf'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/epub+zip',
      'application/rtf',
      'text/*',
    ],
    uniformTypeIdentifiers: [
      'org.openxmlformats.wordprocessingml.document',
      'org.idpf.epub-container',
      'public.text',
      'public.html',
      'public.rtf',
      'net.daringfireball.markdown',
    ],
  );

  final _titleController = TextEditingController();
  XFile? _pickedFile;
  List<int>? _pickedBytes;
  bool _importing = false;
  String? _errorText;
  int _requestSequence = 0;
  String? _pendingRequestId;

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  Future<void> _pickManuscript() async {
    try {
      final file = await (widget.pickFileOverride?.call() ??
          openFile(acceptedTypeGroups: const [_manuscriptTypeGroup]));
      if (file == null || !mounted) return;
      final bytes = await file.readAsBytes();
      if (!mounted) return;
      if (bytes.isEmpty) {
        setState(() => _errorText = 'That file is empty.');
        return;
      }
      if (bytes.length > _maxImportBytes) {
        setState(
          () => _errorText =
              'That file is larger than 20 MB. Try a smaller export of your manuscript.',
        );
        return;
      }
      setState(() {
        _pickedFile = file;
        _pickedBytes = bytes;
        _errorText = null;
        // A new file is a new import attempt.
        _pendingRequestId = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _errorText = 'Could not open that file. Try again.');
    }
  }

  Future<void> _import() async {
    final file = _pickedFile;
    final bytes = _pickedBytes;
    if (file == null || bytes == null || _importing) return;
    // Reuse the requestId across retries so the server never duplicates the book.
    _pendingRequestId ??= _newRequestId();
    setState(() {
      _importing = true;
      _errorText = null;
    });
    try {
      final result = await ref
          .read(projectsRepositoryProvider)
          .importBook(
            bytes: bytes,
            filename: file.name,
            requestId: _pendingRequestId!,
            mimeType: file.mimeType,
            title: _titleController.text,
          );
      if (!mounted) return;
      context.go(
        '/projects/${result.project.id}',
        extra: 'Importing your book…',
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _importing = false);
      if (error.code == 'SUBSCRIPTION_REQUIRED') {
        await showBillingPaywall(
          context,
          title: 'Import your book',
          message:
              'Bring your finished manuscript into Tomeza — improve it with AI, '
              'keep writing in your own voice, and export it. Included with the '
              'Creator plan.',
        );
        if (mounted) {
          ref.invalidate(billingProvider);
        }
        return;
      }
      setState(() => _errorText = error.message);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _importing = false;
        _errorText = userFacingError(error);
      });
    }
  }

  String _newRequestId() {
    _requestSequence += 1;
    return 'import-${DateTime.now().microsecondsSinceEpoch}-$_requestSequence';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final file = _pickedFile;
    return Scaffold(
      appBar: AppBar(title: const Text('Import your book')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              'Bring a book you already wrote',
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Upload your manuscript and it becomes a full Tomeza book: ask for '
              'improvements in chat, keep writing new chapters in your own voice, '
              'and export polished PDF or EPUB copies.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              key: const ValueKey('import-pick-file'),
              onPressed: _importing ? null : _pickManuscript,
              icon: const Icon(Icons.upload_file_outlined),
              label: Text(
                file == null ? 'Choose manuscript' : 'Choose a different file',
              ),
            ),
            if (file != null) ...[
              const SizedBox(height: 12),
              Card(
                child: ListTile(
                  leading: const Icon(Icons.description_outlined),
                  title: Text(file.name, overflow: TextOverflow.ellipsis),
                  subtitle: Text(_fileSizeLabel(_pickedBytes?.length ?? 0)),
                ),
              ),
            ],
            const SizedBox(height: 20),
            TextField(
              key: const ValueKey('import-title-field'),
              controller: _titleController,
              enabled: !_importing,
              maxLength: 160,
              decoration: const InputDecoration(
                labelText: 'Book title (optional)',
                helperText: 'Leave empty to detect it from the manuscript.',
                border: OutlineInputBorder(),
                counterText: '',
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'Word (.docx), EPUB, plain text, Markdown, HTML, and RTF files up '
              'to 20 MB are supported. PDF is not supported yet.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (_errorText != null) ...[
              const SizedBox(height: 16),
              Text(
                _errorText!,
                key: const ValueKey('import-error'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton.icon(
              key: const ValueKey('import-submit'),
              onPressed: file == null || _importing ? null : _import,
              icon: _importing
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.auto_stories_outlined),
              label: Text(_importing ? 'Importing…' : 'Import book'),
            ),
          ],
        ),
      ),
    );
  }
}

String _fileSizeLabel(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) {
    return '${(bytes / 1024).toStringAsFixed(0)} KB';
  }
  return '$bytes B';
}
