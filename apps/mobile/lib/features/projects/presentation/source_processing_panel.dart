import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../shared/api/api_client.dart';
import '../../../shared/ui/app_components.dart';
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
    final colors = Theme.of(context).colorScheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 220),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    _error!,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: colors.error),
                  ),
                ),
              ),
            for (final file in _files) ...[
              _SourceFileRow(
                file: file,
                onRetry: () => _act(file, 'retry'),
                onUseReadable: () => _act(file, 'use-readable'),
              ),
              const SizedBox(height: AppSpacing.xs),
            ],
          ],
        ),
      ),
    );
  }
}

/// One uploaded file and how far the server has got with reading it: its name,
/// one line of state, a bar while it is moving, and the way out when it is not.
class _SourceFileRow extends StatelessWidget {
  const _SourceFileRow({
    required this.file,
    required this.onRetry,
    required this.onUseReadable,
  });

  final MobileCreationAttachment file;
  final VoidCallback onRetry;
  final VoidCallback onUseReadable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final semantic = AppSemanticColors.of(context);
    final processing = file.processing;
    final status = processing?['status'];
    final failed = status == 'failed';
    final partial = status == 'partial' || status == 'limited';
    final accent = failed
        ? colors.error
        : partial
        ? semantic.warning
        : colors.primary;
    final icon = file.isProcessing
        ? Icons.hourglass_top_rounded
        : failed
        ? Icons.error_outline
        : partial
        ? Icons.info_outline
        : Icons.check_circle_outline;
    final progress = ((processing?['progress'] as num?) ?? 0) / 100;
    final unreadable =
        (processing?['unreadable'] as List<dynamic>?) ?? const [];
    final error = processing?['error'];

    return Semantics(
      container: true,
      label: '${file.name}. ${file.processingLabel}',
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surfaceContainerLow,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          border: Border.all(color: colors.outlineVariant),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  ExcludeSemantics(child: Icon(icon, size: 20, color: accent)),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      file.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Padding(
                padding: const EdgeInsetsDirectional.only(
                  start: 20 + AppSpacing.xs,
                ),
                child: Text(
                  file.processingLabel,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
              if (file.isProcessing) ...[
                const SizedBox(height: AppSpacing.xs),
                ExcludeSemantics(
                  child: LinearProgressIndicator(
                    value: progress.clamp(0.0, 1.0).toDouble(),
                    minHeight: 4,
                  ),
                ),
              ],
              if (error is String) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  error,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.error,
                  ),
                ),
              ],
              if (unreadable.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  unreadable.join('\n'),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
              if (processing?['retryable'] == true)
                Wrap(
                  children: [
                    AppButton.text(onPressed: onRetry, label: 'Retry reading'),
                    if (partial && processing?['acceptedPartial'] != true)
                      AppButton.text(
                        onPressed: onUseReadable,
                        label: 'Use readable content',
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
