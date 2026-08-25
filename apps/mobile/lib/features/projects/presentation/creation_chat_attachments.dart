part of 'creation_chat_screen.dart';

// Attachment picking and validation are UI coordination only. Upload state
// and retries remain owned by CreationChatController.
extension _CreationChatAttachments on _CreationChatScreenState {
  Future<void> _openAttachMenu(CreationChatState state) async {
    final action = await showAppActionSheet<String>(
      context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Photo library'),
            subtitle: const Text('Use a photo as inspiration or notes'),
            onTap: () => Navigator.of(sheetContext).pop('gallery'),
          ),
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take a photo'),
            onTap: () => Navigator.of(sheetContext).pop('camera'),
          ),
          ListTile(
            leading: const Icon(Icons.description_outlined),
            title: const Text('Document'),
            subtitle: const Text('PDF, Word, EPUB, text, or Markdown'),
            onTap: () => Navigator.of(sheetContext).pop('document'),
          ),
          ListTile(
            leading: Icon(
              state.hasSourceNotes
                  ? Icons.sticky_note_2
                  : Icons.sticky_note_2_outlined,
            ),
            title: const Text('Paste text notes'),
            subtitle: state.hasSourceNotes
                ? const Text('Source notes added')
                : null,
            onTap: () => Navigator.of(sheetContext).pop('notes'),
          ),
          ListTile(
            key: const ValueKey('attach-characters'),
            leading: const Icon(Icons.people_outline),
            title: const Text('My characters'),
            subtitle: const Text(
              'Reusable characters you can @-mention in any book',
            ),
            onTap: () => Navigator.of(sheetContext).pop('characters'),
          ),
          const Divider(height: 1),
          ListTile(
            key: const ValueKey('attach-import-book'),
            leading: const Icon(Icons.auto_stories_outlined),
            title: const Text('Import a finished manuscript'),
            subtitle: const Text(
              'Bring your own book in to improve or continue it',
            ),
            onTap: () => Navigator.of(sheetContext).pop('import'),
          ),
        ],
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case 'gallery':
        await _pickPhoto(ImageSource.gallery);
      case 'camera':
        await _pickPhoto(ImageSource.camera);
      case 'document':
        await _pickDocument();
      case 'notes':
        await openSourceNotesSheet(ref.read(creationChatControllerProvider));
      case 'characters':
        await _openCharacterLibrary();
      case 'import':
        if (mounted) context.push('/books/import');
    }
  }

  Future<void> _pickPhoto(ImageSource source) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: source,
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      );
      if (picked == null || !mounted) return;
      final bytes = await picked.readAsBytes();
      await ref
          .read(creationChatControllerProvider.notifier)
          .attachFile(
            filename: picked.name,
            bytes: bytes,
            isPhoto: true,
            mimeType: picked.mimeType,
            localPath: picked.path,
          );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showAppSnackBar(
        SnackBar(
          content: Text(
            source == ImageSource.camera
                ? 'Could not open the camera.'
                : 'Could not open your photos.',
          ),
        ),
      );
    }
  }

  static const _documentTypeGroup = XTypeGroup(
    label: 'Documents',
    extensions: [
      'pdf',
      'docx',
      'epub',
      'txt',
      'md',
      'markdown',
      'csv',
      'tsv',
      'json',
      'html',
      'htm',
      'rtf',
      'yaml',
      'yml',
      'srt',
      'log',
    ],
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/epub+zip',
      'application/rtf',
      'application/json',
      'text/*',
    ],
    uniformTypeIdentifiers: [
      'com.adobe.pdf',
      'org.openxmlformats.wordprocessingml.document',
      'org.idpf.epub-container',
      'public.text',
      'public.html',
      'public.rtf',
      'public.json',
      'net.daringfireball.markdown',
      'public.comma-separated-values-text',
    ],
  );

  Future<void> _pickDocument() async {
    try {
      final file = await openFile(
        acceptedTypeGroups: const [_documentTypeGroup],
      );
      if (file == null || !mounted) return;
      final bytes = await file.readAsBytes();
      if (bytes.isEmpty) {
        _showAttachError('Could not read that file.');
        return;
      }
      if (bytes.length > 20 * 1024 * 1024) {
        _showAttachError('That file is too large. Files up to 20 MB work.');
        return;
      }
      if (!mounted) return;
      await ref
          .read(creationChatControllerProvider.notifier)
          .attachFile(
            filename: file.name,
            bytes: bytes,
            isPhoto: false,
            localPath: file.path,
          );
    } catch (_) {
      _showAttachError('Could not open that file.');
    }
  }

  void _showAttachError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(message)));
  }
}
