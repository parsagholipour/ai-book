import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

class GenerationProgressScreen extends ConsumerStatefulWidget {
  const GenerationProgressScreen({
    required this.projectId,
    this.initialMessage,
    super.key,
  });

  final String projectId;
  final String? initialMessage;

  @override
  ConsumerState<GenerationProgressScreen> createState() =>
      _GenerationProgressScreenState();
}

class _GenerationProgressScreenState
    extends ConsumerState<GenerationProgressScreen> {
  Timer? _pollTimer;
  String? _busyAction;
  final Map<String, ProjectExportFile> _downloadedFiles = {};

  @override
  void initState() {
    super.initState();
    _pollTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      _refresh();
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final statusValue = ref.watch(projectStatusProvider(widget.projectId));
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));
    final billingValue = ref.watch(billingProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book progress'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: statusValue.when(
        data: (status) => ProjectGenerationView(
          status: status,
          project: projectValue.asData?.value,
          billing: billingValue.asData?.value,
          initialMessage: widget.initialMessage,
          busyAction: _busyAction,
          downloadedFiles: _downloadedFiles,
          onRefresh: () async => _refresh(),
          onResume: status.retryAvailable ? _resumeGeneration : null,
          onDownload: _downloadExport,
          onShare: _shareExport,
          onOpenPaywall: _openExportPaywall,
        ),
        loading: () => const AppLoadingState(message: 'Checking book progress'),
        error: (error, stackTrace) => AppErrorState(
          title: 'Progress unavailable',
          message: userFacingError(error),
          onRetry: _refresh,
        ),
      ),
    );
  }

  void _refresh() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  Future<void> _resumeGeneration() async {
    setState(() => _busyAction = 'resume');
    try {
      final recovery = await ref
          .read(projectsRepositoryProvider)
          .resumeProject(widget.projectId);
      _refresh();
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(recovery.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _downloadExport(MobileExportAvailability export) async {
    await _runExportAction(
      action: 'download-${export.format}',
      export: export,
      task: () => ref
          .read(projectsRepositoryProvider)
          .downloadExport(projectId: widget.projectId, export: export),
      onComplete: (file) {
        _downloadedFiles[export.format] = file;
        ref.invalidate(billingProvider);
        _refresh();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Saved ${file.filename} for sharing.')),
        );
      },
    );
  }

  Future<void> _shareExport(MobileExportAvailability export) async {
    await _runExportAction<void>(
      action: 'share-${export.format}',
      export: export,
      task: () => ref
          .read(projectsRepositoryProvider)
          .shareExport(projectId: widget.projectId, export: export),
      onComplete: (_) {
        ref.invalidate(billingProvider);
        _refresh();
      },
    );
  }

  Future<void> _openExportPaywall(MobileExportAvailability export) async {
    await showBillingPaywall(
      context,
      projectId: widget.projectId,
      title: 'Unlock exports',
      message:
          'This ${export.format.toUpperCase()} is ready. Add credits to unlock protected downloads for this book.',
    );
    ref.invalidate(billingProvider);
    _refresh();
  }

  Future<void> _runExportAction<T>({
    required String action,
    required MobileExportAvailability export,
    required Future<T> Function() task,
    required void Function(T value) onComplete,
  }) async {
    setState(() => _busyAction = action);
    try {
      final result = await task();
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      onComplete(result);
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}

class ProjectGenerationView extends StatelessWidget {
  const ProjectGenerationView({
    required this.status,
    required this.downloadedFiles,
    required this.onRefresh,
    required this.onDownload,
    required this.onShare,
    required this.onOpenPaywall,
    this.project,
    this.billing,
    this.initialMessage,
    this.busyAction,
    this.onResume,
    super.key,
  });

  final MobileProjectStatus status;
  final MobileProjectDetail? project;
  final MobileBilling? billing;
  final String? initialMessage;
  final String? busyAction;
  final Map<String, ProjectExportFile> downloadedFiles;
  final Future<void> Function() onRefresh;
  final Future<void> Function()? onResume;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onShare;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
        children: [
          _ProgressOverviewCard(
            status: status,
            initialMessage: initialMessage,
            busyAction: busyAction,
            onResume: onResume,
          ),
          const SizedBox(height: 12),
          if (project != null) ...[
            GeneratedBookPreview(project: project!),
            const SizedBox(height: 12),
          ],
          ProjectExportPanel(
            exports: status.exports,
            billing: billing,
            busyAction: busyAction,
            downloadedFiles: downloadedFiles,
            onDownload: onDownload,
            onShare: onShare,
            onOpenPaywall: onOpenPaywall,
          ),
        ],
      ),
    );
  }
}

class _ProgressOverviewCard extends StatelessWidget {
  const _ProgressOverviewCard({
    required this.status,
    required this.busyAction,
    this.initialMessage,
    this.onResume,
  });

  final MobileProjectStatus status;
  final String? initialMessage;
  final String? busyAction;
  final Future<void> Function()? onResume;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final progress = status.progressPercent.clamp(0, 100).toInt();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              status.statusLabel,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              status.currentAction,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            if (initialMessage != null &&
                initialMessage != status.currentAction) ...[
              const SizedBox(height: 4),
              Text(
                initialMessage!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(child: LinearProgressIndicator(value: progress / 100)),
                const SizedBox(width: 12),
                Text(
                  '$progress%',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ],
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _MetricChip(
                  icon: Icons.menu_book_outlined,
                  label:
                      '${status.pageProgress.completed}/${status.pageProgress.target} pages',
                ),
                _MetricChip(
                  icon: Icons.image_outlined,
                  label: '${status.imageCount} visuals',
                ),
              ],
            ),
            const SizedBox(height: 16),
            for (final step in status.steps) _ProgressStepTile(step: step),
            if (status.hasFailure) ...[
              const SizedBox(height: 12),
              DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        status.failureMessage!,
                        style: TextStyle(color: colors.onErrorContainer),
                      ),
                      if (onResume != null) ...[
                        const SizedBox(height: 10),
                        FilledButton.icon(
                          onPressed: busyAction == 'resume'
                              ? null
                              : () => onResume!(),
                          icon: busyAction == 'resume'
                              ? const SizedBox.square(
                                  dimension: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.replay_outlined),
                          label: const Text('Retry generation'),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ProgressStepTile extends StatelessWidget {
  const _ProgressStepTile({required this.step});

  final MobileProjectStatusStep step;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final icon = step.isDone
        ? Icons.check_circle
        : step.isFailed
        ? Icons.error
        : step.isActive
        ? Icons.radio_button_checked
        : Icons.radio_button_unchecked;
    final color = step.isDone
        ? colors.primary
        : step.isFailed
        ? colors.error
        : step.isActive
        ? colors.tertiary
        : colors.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  step.label,
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
                if (step.detail != null)
                  Text(
                    step.detail!,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class GeneratedBookPreview extends StatelessWidget {
  const GeneratedBookPreview({required this.project, super.key});

  final MobileProjectDetail project;

  @override
  Widget build(BuildContext context) {
    final pages = project.pages
        .where(
          (page) =>
              page.previewText.trim().isNotEmpty || page.summary.isNotEmpty,
        )
        .toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Book preview',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 12),
            if (project.coverImage != null) ...[
              _AuthenticatedProjectImage(image: project.coverImage!),
              const SizedBox(height: 12),
            ],
            if (pages.isEmpty)
              Text(
                'Generated pages will appear here as soon as writing starts.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              )
            else
              for (final page in pages) ...[
                _GeneratedPagePreview(page: page),
                if (page != pages.last) const Divider(height: 22),
              ],
          ],
        ),
      ),
    );
  }
}

class _GeneratedPagePreview extends StatelessWidget {
  const _GeneratedPagePreview({required this.page});

  final MobileProjectPage page;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final preview = page.previewText.trim().isNotEmpty
        ? page.previewText
        : page.summary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'Page ${page.index}',
              style: Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: colors.primary),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                page.title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
        if (page.image != null) ...[
          const SizedBox(height: 10),
          _AuthenticatedProjectImage(image: page.image!),
        ],
        const SizedBox(height: 8),
        Text(preview, maxLines: 8, overflow: TextOverflow.ellipsis),
      ],
    );
  }
}

class _AuthenticatedProjectImage extends ConsumerWidget {
  const _AuthenticatedProjectImage({required this.image});

  final MobileProjectImage image;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(image.url).toString();
    return AspectRatio(
      aspectRatio: image.role == 'cover' ? 3 / 4 : 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: headersValue.when(
          data: (headers) => Image.network(
            uri,
            headers: headers,
            fit: BoxFit.cover,
            semanticLabel: image.altText,
            errorBuilder: (context, error, stackTrace) =>
                const _ImageUnavailable(),
          ),
          loading: () => const ColoredBox(
            color: Color(0xFFE6E0D7),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (error, stackTrace) => const _ImageUnavailable(),
        ),
      ),
    );
  }
}

class _ImageUnavailable extends StatelessWidget {
  const _ImageUnavailable();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: Icon(Icons.image_not_supported_outlined, color: colors.outline),
      ),
    );
  }
}

class ProjectExportPanel extends StatelessWidget {
  const ProjectExportPanel({
    required this.exports,
    required this.downloadedFiles,
    required this.onDownload,
    required this.onShare,
    required this.onOpenPaywall,
    this.billing,
    this.busyAction,
    super.key,
  });

  final MobileExportSet exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Map<String, ProjectExportFile> downloadedFiles;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onShare;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Exports',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              'Downloads stay protected by your account and project unlock.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            _ExportFormatTile(
              export: exports.pdf,
              availableCredits: billing?.credits.available,
              icon: Icons.picture_as_pdf_outlined,
              busyAction: busyAction,
              downloadedFile: downloadedFiles['pdf'],
              onDownload: onDownload,
              onShare: onShare,
              onOpenPaywall: onOpenPaywall,
            ),
            const Divider(height: 22),
            _ExportFormatTile(
              export: exports.epub,
              availableCredits: billing?.credits.available,
              icon: Icons.menu_book_outlined,
              busyAction: busyAction,
              downloadedFile: downloadedFiles['epub'],
              onDownload: onDownload,
              onShare: onShare,
              onOpenPaywall: onOpenPaywall,
            ),
          ],
        ),
      ),
    );
  }
}

class _ExportFormatTile extends StatelessWidget {
  const _ExportFormatTile({
    required this.export,
    required this.availableCredits,
    required this.icon,
    required this.busyAction,
    required this.onDownload,
    required this.onShare,
    required this.onOpenPaywall,
    this.downloadedFile,
  });

  final MobileExportAvailability export;
  final int? availableCredits;
  final IconData icon;
  final String? busyAction;
  final ProjectExportFile? downloadedFile;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onShare;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final format = export.format.toUpperCase();
    final downloadAction = 'download-${export.format}';
    final shareAction = 'share-${export.format}';
    final isDownloading = busyAction == downloadAction;
    final isSharing = busyAction == shareAction;
    final needsCredits =
        export.available &&
        !export.unlocked &&
        availableCredits != null &&
        availableCredits! < export.creditsRequired;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: colors.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    format,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _exportStateText(export),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  if (downloadedFile != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Saved: ${downloadedFile!.filename}',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: export.available && !isDownloading && !isSharing
                  ? () => needsCredits
                        ? onOpenPaywall(export)
                        : onDownload(export)
                  : null,
              icon: isDownloading
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(
                      export.unlocked
                          ? Icons.download_outlined
                          : needsCredits
                          ? Icons.add_card_outlined
                          : Icons.lock_open_outlined,
                    ),
              label: Text(_downloadLabel(export, needsCredits)),
            ),
            OutlinedButton.icon(
              onPressed:
                  export.available &&
                      export.unlocked &&
                      !isDownloading &&
                      !isSharing
                  ? () => onShare(export)
                  : null,
              icon: isSharing
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.ios_share_outlined),
              label: const Text('Share'),
            ),
          ],
        ),
      ],
    );
  }

  String _exportStateText(MobileExportAvailability export) {
    if (!export.available) {
      return 'Preparing this file after generation finishes.';
    }
    if (export.unlocked) {
      return 'Ready to download and share.';
    }
    if (availableCredits != null &&
        availableCredits! < export.creditsRequired) {
      return 'Ready after export unlock. You need ${export.creditsRequired} credits and have $availableCredits.';
    }
    return 'Ready after export unlock. This uses ${export.creditsRequired} credits if not already included.';
  }

  String _downloadLabel(MobileExportAvailability export, bool needsCredits) {
    final format = export.format.toUpperCase();
    if (!export.available) {
      return 'Preparing $format';
    }
    if (export.unlocked) {
      return 'Download $format';
    }
    if (needsCredits) {
      return 'Get credits';
    }
    return 'Unlock $format';
  }
}

class _MetricChip extends StatelessWidget {
  const _MetricChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: colors.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(label, style: Theme.of(context).textTheme.labelMedium),
        ],
      ),
    );
  }
}
