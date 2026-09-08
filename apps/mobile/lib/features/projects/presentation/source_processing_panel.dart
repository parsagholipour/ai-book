import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../shared/api/api_client.dart';
import '../domain/creation_message_models.dart';

/// Processing updates have their own endpoint and never overwrite chat revisions.
class SourceProcessingPanel extends ConsumerStatefulWidget {
  const SourceProcessingPanel({
    super.key,
    required this.draftId,
    required this.ids,
  });
  final String draftId;
  final Set<String> ids;
  @override
  ConsumerState<SourceProcessingPanel> createState() =>
      _SourceProcessingPanelState();
}

class _SourceProcessingPanelState extends ConsumerState<SourceProcessingPanel> {
  Timer? _timer;
  List<MobileCreationAttachment> _files = [];
  bool _loading = false;
  String? _error;
  final Map<String, String> _retryKeys = {};
  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void didUpdateWidget(SourceProcessingPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.draftId != widget.draftId ||
        oldWidget.ids.length != widget.ids.length ||
        !oldWidget.ids.containsAll(widget.ids)) {
      _timer?.cancel();
      unawaited(_refresh());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_loading || !mounted) return;
    _loading = true;
    final draftId = widget.draftId;
    try {
      final result = await ref
          .read(apiClientProvider)
          .getMap('/api/mobile/creation-sessions/$draftId/attachments');
      if (!mounted || draftId != widget.draftId) return;
      setState(() {
        _files = (result['attachments'] as List<dynamic>)
            .map(
              (value) => MobileCreationAttachment.fromJson(
                value as Map<String, dynamic>,
              ),
            )
            .where(
              (file) => file.processing != null && widget.ids.contains(file.id),
            )
            .toList();
        _error = null;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not refresh file reading status.');
      }
    } finally {
      _loading = false;
      if (mounted) {
        _timer?.cancel();
        _timer = Timer(
          Duration(seconds: _files.any((file) => file.isProcessing) ? 4 : 30),
          () => unawaited(_refresh()),
        );
      }
    }
  }

  Future<void> _act(MobileCreationAttachment file, String action) async {
    final key = _retryKeys.putIfAbsent(
      '${file.id}:$action:${file.extractionVersion}',
      () => DateTime.now().microsecondsSinceEpoch.toString(),
    );
    try {
      await ref
          .read(apiClientProvider)
          .postMap(
            '/api/mobile/creation-sessions/${widget.draftId}/attachments/${file.id}/$action',
            data: {'requestId': key, 'version': file.extractionVersion},
          );
      await _refresh();
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not update this file. Please try again.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_files.isEmpty && _error == null) return const SizedBox.shrink();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 180),
      child: SingleChildScrollView(
        child: Column(
          children: [
            if (_error != null) Text(_error!),
            for (final file in _files)
              ListTile(
                dense: true,
                title: Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(file.processingLabel),
                    if (file.isProcessing)
                      LinearProgressIndicator(
                        value:
                            ((file.processing?['progress'] as num?) ?? 0) / 100,
                      ),
                    if (file.processing?['error'] is String)
                      Text(file.processing!['error'] as String),
                    if ((file.processing?['unreadable'] as List<dynamic>?)
                            ?.isNotEmpty ??
                        false)
                      Text(
                        (file.processing!['unreadable'] as List<dynamic>).join(
                          '\n',
                        ),
                      ),
                    if (file.processing?['retryable'] == true)
                      Wrap(
                        children: [
                          TextButton(
                            onPressed: () => _act(file, 'retry'),
                            child: const Text('Retry reading'),
                          ),
                          if ([
                                'partial',
                                'limited',
                              ].contains(file.processing?['status']) &&
                              file.processing?['acceptedPartial'] != true)
                            TextButton(
                              onPressed: () => _act(file, 'use-readable'),
                              child: const Text('Use readable content'),
                            ),
                        ],
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
